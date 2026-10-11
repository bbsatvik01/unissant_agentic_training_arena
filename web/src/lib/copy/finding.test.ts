import { describe, expect, it } from "vitest";

import type { StoredFinding } from "../contracts/generated/types";
import { allowedLikelihoods, corroborationItems, draftProblems, EMPTY_DRAFT, flagPhrase, LIKELIHOODS, renderFinding, type FindingDraft } from "./finding";

const base: StoredFinding = {
  label: "truthful",
  likelihood: "very_unlikely",
  confidence: "moderate",
  basis_flag_refs: [],
  cited_turns: [1, 3, 4],
  cited_records: ["rec-02", "rec-03"],
  corroboration_needed: [],
  rationale: "r",
  alternative_explanations: null,
  last_revised_turn: 4,
};

describe("finding templates (S2 4.5)", () => {
  it("renders a truthful or deceptive finding as the two template sentences", () => {
    expect(renderFinding(base)).toEqual([
      "Truthful. It is very unlikely (05-20%) that the subject is concealing involvement in the matter under review.",
      "Confidence: moderate, based on turns 1, 3 and 4 and records rec-02 and rec-03. Last revised at turn 4.",
    ]);
    const deceptive = renderFinding({ ...base, label: "deceptive", likelihood: "likely", cited_turns: [2], cited_records: [], last_revised_turn: null });
    expect(deceptive).toEqual([
      "Deceptive. It is likely (55-80%) that the subject is concealing involvement in the matter under review.",
      "Confidence: moderate, based on turns 2 and no records.",
    ]);
    expect(renderFinding({ ...base, cited_turns: [] })[1]).toContain("based on no turns");
  });

  it("renders the insufficient template beginning 'More evidence is needed.' and naming each item (FE-COACH-2)", () => {
    const lines = renderFinding({ ...base, label: "insufficient_evidence", likelihood: "roughly_even_chance", confidence: "low", corroboration_needed: ["the work order", "the timeline"], last_revised_turn: 1 });
    expect(lines).toEqual([
      "More evidence is needed. It is roughly even chance (45-55%) that the subject is concealing involvement.",
      "Verify the work order; the timeline before reaching a finding. Confidence: low. Last revised at turn 1.",
    ]);
  });

  it("names every flag kind in words", () => {
    expect(["gap", "non_responsive", "possible_evasion", "contradiction", "evidence_conflict"].map((k) => flagPhrase(k as never))).toEqual([
      "gap",
      "non-responsive",
      "possible evasion",
      "contradiction",
      "conflicts with a record",
    ]);
  });
});

describe("finding draft (S6 4.6, FE-FIND-1)", () => {
  it("offers per label the likelihood terms S2 4.2 allows", () => {
    expect(allowedLikelihoods("deceptive")).toEqual(["likely", "very_likely", "almost_certain"]);
    expect(allowedLikelihoods("truthful")).toEqual(["almost_no_chance", "very_unlikely", "unlikely"]);
    expect(allowedLikelihoods("insufficient_evidence")).toEqual(LIKELIHOODS.map((l) => l.id));
  });

  const ready: FindingDraft = { ...EMPTY_DRAFT, label: "truthful", likelihood: "unlikely", confidence: "low", citedTurns: [1], rationale: "Corroborated." };

  it("blocks Confirm until each required field for the label is present", () => {
    expect(draftProblems(EMPTY_DRAFT)).toHaveLength(4);
    expect(draftProblems(ready)).toEqual([]);
    expect(draftProblems({ ...ready, likelihood: "likely" })).toEqual(["Choose a likelihood the finding allows."]);
    expect(draftProblems({ ...ready, citedTurns: [] })).toEqual(["Cite at least one turn or record."]);
    expect(draftProblems({ ...ready, citedTurns: [], citedRecords: ["rec-01"] })).toEqual([]);
    expect(draftProblems({ ...ready, rationale: "x".repeat(601) })).toEqual(["Write a rationale (1-600 characters)."]);
  });

  it("needs one to three corroboration items for insufficient evidence, and no citation", () => {
    const insufficient: FindingDraft = { ...ready, label: "insufficient_evidence", likelihood: "roughly_even_chance", citedTurns: [] };
    expect(draftProblems(insufficient)).toHaveLength(1);
    expect(draftProblems({ ...insufficient, corroboration: "the work order\n\nthe timeline" })).toEqual([]);
    expect(draftProblems({ ...insufficient, corroboration: "a\nb\nc\nd" })).toHaveLength(1);
    expect(draftProblems({ ...insufficient, corroboration: "ab" })).toHaveLength(1);
    expect(corroborationItems("  one \n\n two ")).toEqual(["one", "two"]);
  });
});
