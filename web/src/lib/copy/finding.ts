/**
 * Findings and flags as words (S2 4.2 and 4.5; S6 4.5, 4.6): typed fields rendered through fixed templates, never
 * free model prose. Also the finding-commit draft rule (S6 4.6, FE-FIND-1): which likelihood terms each label
 * allows and when Confirm may be pressed.
 */

import type { StoredFinding, StoredFlag } from "../contracts/generated/types";

export type Label = StoredFinding["label"];
export type Likelihood = StoredFinding["likelihood"];
export type Confidence = StoredFinding["confidence"];

/** ICD 203 terms and ranges (S2 4.2), in order. */
export const LIKELIHOODS: readonly { readonly id: Likelihood; readonly term: string; readonly range: string }[] = [
  { id: "almost_no_chance", term: "almost no chance", range: "01-05%" },
  { id: "very_unlikely", term: "very unlikely", range: "05-20%" },
  { id: "unlikely", term: "unlikely", range: "20-45%" },
  { id: "roughly_even_chance", term: "roughly even chance", range: "45-55%" },
  { id: "likely", term: "likely", range: "55-80%" },
  { id: "very_likely", term: "very likely", range: "80-95%" },
  { id: "almost_certain", term: "almost certain", range: "95-99%" },
];

export const LABELS: readonly { readonly id: Label; readonly word: string }[] = [
  { id: "deceptive", word: "Deceptive" },
  { id: "truthful", word: "Truthful" },
  { id: "insufficient_evidence", word: "Insufficient evidence" },
];

export const CONFIDENCES: readonly Confidence[] = ["low", "moderate", "high"];

const ALLOWED: Readonly<Record<Label, readonly Likelihood[]>> = {
  deceptive: ["likely", "very_likely", "almost_certain"],
  truthful: ["almost_no_chance", "very_unlikely", "unlikely"],
  insufficient_evidence: LIKELIHOODS.map((l) => l.id),
};

/** The likelihood terms S2 4.2 allows for `label`, in ICD 203 order. */
export function allowedLikelihoods(label: Label): readonly Likelihood[] {
  return ALLOWED[label];
}

function likelihoodText(id: Likelihood): string {
  const entry = LIKELIHOODS.find((l) => l.id === id);
  return entry === undefined ? id : `${entry.term} (${entry.range})`;
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
}

/** A finding as the two S2 4.5 template sentences. */
export function renderFinding(finding: StoredFinding): readonly [string, string] {
  const revised = finding.last_revised_turn === null ? "" : ` Last revised at turn ${String(finding.last_revised_turn)}.`;
  if (finding.label === "insufficient_evidence") {
    return [
      `More evidence is needed. It is ${likelihoodText(finding.likelihood)} that the subject is concealing involvement.`,
      `Verify ${finding.corroboration_needed.join("; ")} before reaching a finding. Confidence: ${finding.confidence}.${revised}`,
    ];
  }
  const word = finding.label === "deceptive" ? "Deceptive" : "Truthful";
  const turns = finding.cited_turns.length === 0 ? "no turns" : `turns ${list(finding.cited_turns.map(String))}`;
  const records = finding.cited_records.length === 0 ? "no records" : `records ${list([...finding.cited_records])}`;
  return [
    `${word}. It is ${likelihoodText(finding.likelihood)} that the subject is concealing involvement in the matter under review.`,
    `Confidence: ${finding.confidence}, based on ${turns} and ${records}.${revised}`,
  ];
}

const FLAG_PHRASE: Readonly<Record<StoredFlag["kind"], string>> = {
  gap: "gap",
  non_responsive: "non-responsive",
  possible_evasion: "possible evasion",
  contradiction: "contradiction",
  evidence_conflict: "conflicts with a record",
};

/** The flag kind as words. */
export function flagPhrase(kind: StoredFlag["kind"]): string {
  return FLAG_PHRASE[kind];
}

/** A finding the investigator is drafting in the commit dialog (S6 4.6). */
export interface FindingDraft {
  readonly label: Label | null;
  readonly likelihood: Likelihood | null;
  readonly confidence: Confidence | null;
  readonly citedTurns: readonly number[];
  readonly citedRecords: readonly string[];
  readonly corroboration: string;
  readonly rationale: string;
}

export const EMPTY_DRAFT: FindingDraft = {
  label: null,
  likelihood: null,
  confidence: null,
  citedTurns: [],
  citedRecords: [],
  corroboration: "",
  rationale: "",
};

/** One corroboration item per line, trimmed, blank lines dropped. */
export function corroborationItems(text: string): readonly string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** What still blocks Confirm, in words; empty when the draft can be committed (FE-FIND-1). */
export function draftProblems(draft: FindingDraft): readonly string[] {
  const problems: string[] = [];
  if (draft.label === null) problems.push("Choose a finding.");
  if (draft.likelihood === null || (draft.label !== null && !allowedLikelihoods(draft.label).includes(draft.likelihood))) {
    problems.push("Choose a likelihood the finding allows.");
  }
  if (draft.confidence === null) problems.push("Choose a confidence.");
  if (draft.label !== null && draft.label !== "insufficient_evidence" && draft.citedTurns.length + draft.citedRecords.length === 0) {
    problems.push("Cite at least one turn or record.");
  }
  const items = corroborationItems(draft.corroboration);
  if (draft.label === "insufficient_evidence" && (items.length < 1 || items.length > 3 || items.some((i) => i.length < 3 || i.length > 120))) {
    problems.push("List one to three items that would settle it (3-120 characters each).");
  }
  const rationale = draft.rationale.trim();
  if (rationale.length < 1 || rationale.length > 600) problems.push("Write a rationale (1-600 characters).");
  return problems;
}
