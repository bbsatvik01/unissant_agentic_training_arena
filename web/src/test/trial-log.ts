/**
 * Test helper: builds trial frame logs in the server's order (S5 5.2, 6.2): one persisted row per `seq`,
 * synthesized frames with `seq: null`, `transcript_version` moving as S5 5.1 says (+1 per question, release,
 * answer and finalization; coaching never moves it). Every frame is built from the shared wire fixtures, so
 * the tests check that the frames they use pass the compiled validators.
 */

import type {
  CoachCard,
  StoredFinding,
  TextTrialSnapshot,
  TrainingWireCard,
  TrialFrame,
  TrialSnapshot,
} from "../lib/contracts/generated/types";
import { fixture } from "./wire-fixtures";

export const TRIAL_ID = "3f2b8c1e-5a4d-4e8f-9b2a-1c0d7e6f5a41";
export const SESSION_ID = "c4d5e6f7-0a1b-4c2d-8e3f-9a0b1c2d3e4f";
const TS = "2026-10-20T15:04:05.123Z";
const HASH = "b".repeat(64);

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** A valid training wire card for turn `turn`, read at transcript version `version`. */
export function cardFor(turn: number, version: number): TrainingWireCard {
  const base = (fixture("frame:coach.card") as { data: CoachCard }).data.card;
  const tid = `t${two(turn)}`;
  const ref = `${tid}.f1`;
  const [flag] = base.flags;
  if (flag === undefined) throw new Error("fixture card has no flag");
  return {
    ...base,
    turn_id: tid,
    turn_no: turn,
    card_seq: turn,
    transcript_version: version,
    flags: [{ ...flag, turn_id: tid, flag_ref: ref }],
    validation: { ...base.validation, flags: { [ref]: { citation_ok: true, demeanor_based: false, duplicate: false } } },
    finding: { ...base.finding, cited_turns: [turn], last_revised_turn: turn, rationale: `Finding as of turn ${String(turn)}.` },
  };
}

export function snapshot(overrides: Partial<TextTrialSnapshot> = {}): TrialSnapshot {
  return {
    status: "running",
    reason_code: null,
    mode: "practice",
    split: "dev",
    exchanges_used: 0,
    exchanges_cap: 12,
    released: [],
    requestable: [],
    finding: null,
    commitment_hash: null,
    last_seq: 0,
    channel: "text",
    turns: [],
    voice_exchanges: [],
    cards: [],
    updates: [],
    coach_failures: [],
    ...overrides,
  };
}

export function voiceSnapshot(): TrialSnapshot {
  return fixture("snapshot:voice") as TrialSnapshot;
}

type Data<T extends TrialFrame["type"]> = Extract<TrialFrame, { type: T }>["data"];

export function frame<T extends TrialFrame["type"]>(type: T, seq: number | null, version: number, data: Data<T>): TrialFrame {
  return { v: 1, seq, scope: "trial", scope_id: TRIAL_ID, type, ts: TS, transcript_version: version, data } as TrialFrame;
}

const LIKELIHOOD = { insufficient_evidence: "roughly_even_chance", truthful: "very_unlikely", deceptive: "likely" } as const;

/** A valid finding with `label`; a deceptive one rests on the first flag of turn `turn` (S2 4.2 rules). */
export function finding(label: StoredFinding["label"] = "insufficient_evidence", turn = 1): StoredFinding {
  const base = (fixture("frame:finding.committed") as { data: { finding: StoredFinding } }).data.finding;
  const basis = label === "deceptive" ? [`t${two(turn)}.f1`] : [];
  const corroboration = label === "insufficient_evidence" ? ["the work order", "the timeline"] : [];
  return { ...base, label, likelihood: LIKELIHOOD[label], basis_flag_refs: basis, corroboration_needed: corroboration };
}

export interface TurnPlan {
  /** A scheduled release inside the turn's POST, before the answer (S5 5.2). */
  readonly releaseBefore?: string;
  /** A scheduled release after the answer, before the card (SG4-23): the card reads its version. */
  readonly releaseAfter?: string;
  /** How the coach step ends (practice only). Default `card`. */
  readonly coach?: "card" | "failed" | "stale" | "none";
}

/** Builds a session's frames in the order the server emits them. */
export class LogBuilder {
  readonly frames: TrialFrame[] = [];
  seq: number;
  version: number;
  turn = 0;

  constructor(
    readonly mode: "practice" | "assessment" = "practice",
    start: { seq?: number; version?: number; turn?: number } = {},
  ) {
    this.seq = start.seq ?? 0;
    this.version = start.version ?? 0;
    this.turn = start.turn ?? 0;
  }

  private persisted<T extends TrialFrame["type"]>(type: T, bump: boolean, data: Data<T>): TrialFrame {
    this.seq += 1;
    if (bump) this.version += 1;
    const f = frame(type, this.seq, this.version, data);
    this.frames.push(f);
    return f;
  }

  private hint<T extends TrialFrame["type"]>(type: T, data: Data<T>): TrialFrame {
    const f = frame(type, null, this.version, data);
    this.frames.push(f);
    return f;
  }

  release(recordId: string, trigger: "scheduled" | "requested" = "scheduled"): TrialFrame {
    return this.persisted("evidence.released", true, {
      record_id: recordId,
      title: `Record ${recordId}`,
      kind: "record",
      doc_kind: "alarm_log",
      date: null,
      content: { body: `Body of ${recordId}.` },
      released_at_turn: this.turn,
      trigger,
    });
  }

  /** One text turn: question, thinking, optional releases, answer, and in practice the coach step. */
  ask(plan: TurnPlan = {}): this {
    this.turn += 1;
    const n = this.turn;
    this.persisted("question.accepted", true, { turn_no: n, text: `Question ${String(n)}?`, source: "investigator", channel: "text" });
    this.hint("subject.thinking", { turn_no: n });
    if (plan.releaseBefore !== undefined) this.release(plan.releaseBefore);
    this.persisted("subject.answer", true, {
      turn_no: n,
      text: `Answer ${String(n)}.`,
      channel: "text",
      partial: false,
      committed_at: TS,
    });
    const answerVersion = this.version;
    if (plan.releaseAfter !== undefined) this.release(plan.releaseAfter);
    if (this.mode === "practice") {
      const coach = plan.coach ?? "card";
      if (coach !== "none") this.hint("coach.working", { turn_no: n });
      if (coach === "card" || coach === "stale") {
        const v = coach === "card" ? this.version : answerVersion - 1;
        this.persisted("coach.card", false, { turn_no: n, card: cardFor(n, v) });
        // the frame's transcript_version is the card's (invariant: frame and card agree)
        const last = this.frames[this.frames.length - 1] as TrialFrame & { transcript_version: number };
        this.frames[this.frames.length - 1] = { ...last, transcript_version: v };
      }
      if (coach === "failed") this.persisted("coach.failed", false, { turn_no: n, reason: "timeout" });
    }
    return this;
  }

  update(turn: number, label: StoredFinding["label"]): this {
    this.persisted("coach.update", false, {
      turn_no: turn,
      update: {
        schema_version: "deep.v1",
        as_of_turn: `t${two(turn)}`,
        finding: { ...finding(label, turn), cited_turns: [turn], cited_records: [], last_revised_turn: turn },
        evidence_coverage: [],
        open_gaps: [],
        disclosure_plan: { record_id: null, step: "hold" },
      },
    });
    return this;
  }

  /** The investigator's commit, then the completion pair (SG4-02): status without id, finalized with the row's seq. */
  commit(): this {
    this.persisted("finding.committed", false, { by: "investigator", finding: finding(), committed_at: TS });
    this.version += 1;
    this.hint("trial.status", { status: "completed", reason_code: null });
    this.persisted("trial.finalized", false, { commitment_hash: HASH });
    return this;
  }

  /** A terminal status that did not complete: the row's seq rides on `trial.status` itself. */
  end(status: "subject_quarantined" | "infra_failed" | "budget_truncated"): this {
    this.version += 1;
    this.persisted("trial.status", false, { status, reason_code: null });
    return this;
  }

  debriefReady(): this {
    this.persisted("debrief.ready", false, { session_id: SESSION_ID });
    return this;
  }

  notice(kind: "paused" | "quota"): this {
    this.hint("notice", { kind, text: `Notice ${kind}.` });
    return this;
  }
}

export const COMMITMENT_HASH = HASH;
