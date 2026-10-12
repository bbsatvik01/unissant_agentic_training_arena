/**
 * The trainer console's review tasks (S3 7.3, S6 4.12): a blank draft for each task kind, built only from what the
 * item shows; whether the draft is complete (FE-REV-3: Submit needs every field the kind requires); and the
 * submission body, which carries only the proxy's own binary fields and never a 0-4 dimension score. The body is
 * checked against the shared `review-submission` schema before it is sent.
 */
import type { FlagItem, FollowupVerdict, LabelItem, LabelVerdict, ReviewItem, ReviewSubmission, RubricItem } from "../contracts/generated/types";
import { isWire } from "../contracts/validate";
import { RUBRIC } from "../copy/rubric";

/** `t01`..`t12`, the turn id form the submission uses. */
export function turnId(turnNo: number): string {
  return `t${String(turnNo).padStart(2, "0")}`;
}

/** The five per-question checks: answered per question, never as sub-checks (S3 2.3, 2.4). */
export const PER_QUESTION = ["1a", "1c", "1d", "2c", "2d"] as const;

/** Every other rubric sub-check, in rubric order (S3 1.3.2: subchecks[] holds all but the five). */
export const OTHER_SUBCHECKS: readonly string[] = Object.values(RUBRIC)
  .flatMap((d) => Object.keys(d.checks))
  .filter((id) => !(PER_QUESTION as readonly string[]).includes(id));

type Maybe<T> = T | null;
type Draft<T> = { -readonly [K in keyof T]: T[K] extends boolean ? Maybe<boolean> : T[K] extends string ? Maybe<T[K]> : T[K] };

export type FollowupDraft = Draft<FollowupVerdict> & { readonly turn_id: string };
export interface SubcheckDraft {
  readonly id: string;
  result: Maybe<"pass" | "fail" | "na">;
  turn_ids: string[];
}
export interface CitationDraft {
  readonly cite: string;
  supports_basis: Maybe<boolean>;
}
export type LabelDraft = Omit<Draft<LabelVerdict>, "eva_subtype" | "pfq_reason"> & { readonly turn_id: string; eva_subtype: LabelVerdict["eva_subtype"]; pfq_reason: LabelVerdict["pfq_reason"] };
export interface FlagDraft {
  readonly flag_ref: string;
  quote_relevant: Maybe<boolean>;
  claim_holds: Maybe<boolean>;
  content_based: Maybe<boolean>;
  no_outside_facts: Maybe<boolean>;
}

export type ReviewDraft =
  | { readonly task: "T-RUB"; followups: FollowupDraft[]; subchecks: SubcheckDraft[]; citations: CitationDraft[] }
  | { readonly task: "T-LAB"; turns: LabelDraft[] }
  | { readonly task: "T-FLAG"; flags: FlagDraft[] };

function rubricDraft(item: RubricItem): ReviewDraft {
  const finding = item.finding;
  const cites = finding === null ? [] : [...finding.cited_turns.map(turnId), ...finding.cited_records];
  return {
    task: "T-RUB",
    followups: item.questions.map((q) => ({ turn_id: turnId(q.turn_no), question_type: null, not_leading: null, well_framed: null, no_loaded_wording: null, on_objective: null, builds_on_previous: null })),
    subchecks: OTHER_SUBCHECKS.map((id) => ({ id, result: null, turn_ids: [] })),
    citations: [...new Set(cites)].map((cite) => ({ cite, supports_basis: null })),
  };
}

function labelDraft(item: LabelItem): ReviewDraft {
  return {
    task: "T-LAB",
    turns: item.transcript.map((t) => ({
      turn_id: turnId(t.turn_no),
      label: null,
      eva_subtype: null,
      pfq_reason: null,
      no_contradiction: null,
      no_invention: null,
      uncertainty_respected: null,
      disclosure_policy_respected: null,
      in_character: null,
      platform_attack: null,
    })),
  };
}

function flagDraft(item: FlagItem): ReviewDraft {
  return { task: "T-FLAG", flags: item.flags.map((f) => ({ flag_ref: f.flag_ref, quote_relevant: null, claim_holds: null, content_based: null, no_outside_facts: null })) };
}

export function blankDraft(item: ReviewItem): ReviewDraft {
  if (item.task === "T-RUB") return rubricDraft(item);
  if (item.task === "T-LAB") return labelDraft(item);
  return flagDraft(item);
}

const filled = (o: object) => Object.values(o).every((v) => v !== null);

/** What still needs an answer, in words; empty when the draft can be submitted (FE-REV-3). */
export function missing(draft: ReviewDraft): readonly string[] {
  const out: string[] = [];
  if (draft.task === "T-RUB") {
    for (const f of draft.followups) if (!filled(f)) out.push(`Question ${f.turn_id.toUpperCase()}`);
    for (const s of draft.subchecks) {
      if (s.result === null) out.push(`Check ${s.id}`);
      else if (s.turn_ids.length > 4) out.push(`Check ${s.id}: at most four deciding turns`);
    }
    for (const c of draft.citations) if (c.supports_basis === null) out.push(`Citation ${c.cite}`);
  } else if (draft.task === "T-LAB") {
    for (const t of draft.turns) {
      const { eva_subtype: eva, pfq_reason: pfq, ...rest } = t;
      if (!filled(rest)) out.push(`Turn ${t.turn_id.toUpperCase()}`);
      else if (t.label === "evasion" && eva === null) out.push(`Turn ${t.turn_id.toUpperCase()}: evasion kind`);
      else if (t.label === "poorly_framed_question" && pfq === null) out.push(`Turn ${t.turn_id.toUpperCase()}: framing problem`);
    }
  } else {
    for (const f of draft.flags) if (!filled(f)) out.push(`Flag ${f.flag_ref}`);
  }
  return out;
}

/** The submission body for a complete draft, checked against the shared schema; null when incomplete or invalid. */
export function toSubmission(draft: ReviewDraft): ReviewSubmission | null {
  if (missing(draft).length > 0) return null;
  let body: unknown;
  if (draft.task === "T-RUB") {
    body = { task: "T-RUB", followups: draft.followups, subchecks: draft.subchecks.map((s) => ({ id: s.id, result: s.result, turn_ids: s.turn_ids })), citations: draft.citations };
  } else if (draft.task === "T-LAB") {
    body = {
      task: "T-LAB",
      turns: draft.turns.map((t) => ({ ...t, eva_subtype: t.label === "evasion" ? t.eva_subtype : null, pfq_reason: t.label === "poorly_framed_question" ? t.pfq_reason : null })),
    };
  } else {
    body = { task: "T-FLAG", flags: draft.flags };
  }
  return isWire("review-submission", body) ? body : null;
}
