/**
 * Trial-facing adaptation of the owner's TechnoMile office / pinboard / playhouse / tower models.
 * See web/ATTRIBUTIONS.md. A single projected TrialView is the only trial-data input: raw SSE,
 * private case packets, evaluator fields, findings and demeanor never reach these screens.
 * No timers, random seeds or wall-clock reads. The caller owns the exact session/replay clock.
 */
import type { DebriefScoring, ScoredDebrief, StoredFlag, UnscoredDebrief } from "../contracts/generated/types";
import { contentText, quoteOk } from "../contracts/quote";
import type { TrialView } from "../trial/trialReducer";

export const WORK_STYLES = ["office", "case-board", "playhouse", "tower"] as const;
export type WorkStyle = (typeof WORK_STYLES)[number];
export const STYLE_NAMES: Readonly<Record<WorkStyle, string>> = {
  office: "Agent office", "case-board": "Case board", playhouse: "Playhouse", tower: "Agent tower",
};
export const WORK_ROLES = ["subject", "coach", "evidence", "referee"] as const;
export type WorkRole = (typeof WORK_ROLES)[number];
export type WorkStatus = "waiting" | "working" | "ready" | "withheld" | "failed";
export interface WorkAgent {
  readonly id: WorkRole;
  readonly name: string;
  readonly status: WorkStatus;
  readonly task: string;
  readonly count: number;
}
export interface WorkFlag {
  readonly id: string;
  readonly label: string;
  readonly turn: number;
  readonly quote: string;
  readonly conflictTurn: number | null;
  readonly recordId: string | null;
}
export interface WorkDocument { readonly id: string; readonly title: string; readonly turn: number }
export interface WorkItem {
  readonly id: string;
  readonly kind: "card" | "update" | "evidence" | "flag" | "referee";
  readonly label: string;
  readonly turn: number | null;
  readonly atMs: number | null;
}
export interface WorkTransfer {
  readonly id: string;
  readonly from: WorkRole;
  readonly to: WorkRole;
  readonly progress: number;
}
/** A narrow public progress projection, deliberately incapable of carrying referee outcomes or case facts. */
export type RefereeProgress = DebriefScoring | Pick<ScoredDebrief | UnscoredDebrief, "session_id" | "scored">;
export interface WorkInput {
  readonly view: TrialView | null;
  /** Public arrivals from noteArrival()/PlaybackCursor, on the same clock as nowMs. */
  readonly arrivals: ReadonlyMap<string, number>;
  readonly nowMs: number;
  readonly paused: boolean;
  readonly reducedMotion: boolean;
  readonly referee?: RefereeProgress | null;
}
export interface WorkFrame {
  readonly available: boolean;
  readonly assessment: boolean;
  readonly agents: readonly WorkAgent[];
  readonly cards: number;
  readonly updates: number;
  readonly flags: readonly WorkFlag[];
  readonly documents: readonly WorkDocument[];
  readonly items: readonly WorkItem[];
  readonly transfers: readonly WorkTransfer[];
  readonly caption: string;
  readonly turn: number;
  readonly paused: boolean;
  readonly reducedMotion: boolean;
  /** Fixed phase for reduced motion; otherwise derived only from the supplied clock. */
  readonly phase: number;
  readonly refereeState: WorkStatus;
}

export const TRANSFER_MS = 1_400;
const FLAG_NAMES: Readonly<Record<StoredFlag["kind"], string>> = {
  gap: "Information gap", non_responsive: "Response needs clarification", possible_evasion: "Possible evasion flag",
  contradiction: "Account conflict", evidence_conflict: "Record conflict",
};
function turnNumber(id: string | null): number | null {
  if (id === null || !/^t\d+$/u.test(id)) return null;
  const number = Number(id.slice(1));
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
function arrival(input: WorkInput, key: string): number | null {
  const value = input.arrivals.get(key);
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= input.nowMs ? value : null;
}
/** Only accepted, non-demeanor flags with citations verified against public projected material. */
function flagsFor(view: TrialView): WorkFlag[] {
  const result: WorkFlag[] = [];
  const seen = new Set<string>();
  const answer = (turn: number | null) => view.turns.find((item) => item.turn_no === turn)?.answer ?? "";
  for (const { card } of view.cards) {
    for (const flag of card.flags) {
      const validation = card.validation.flags[flag.flag_ref];
      const turn = turnNumber(flag.turn_id);
      const conflictTurn = turnNumber(flag.conflict_turn_id);
      if (validation?.citation_ok !== true || validation.demeanor_based || validation.duplicate || turn === null || seen.has(flag.flag_ref)) continue;
      if (!quoteOk(flag.quote, answer(turn))) continue;
      if (flag.kind === "contradiction" && (conflictTurn === null || flag.conflict_quote === null)) continue;
      if (flag.kind === "evidence_conflict" && (flag.conflict_record_id === null || flag.conflict_record_quote === null)) continue;
      if (flag.conflict_turn_id !== null && (conflictTurn === null || flag.conflict_quote === null || !quoteOk(flag.conflict_quote, answer(conflictTurn)))) continue;
      if (flag.conflict_quote !== null && (conflictTurn === null || !quoteOk(flag.conflict_quote, answer(conflictTurn)))) continue;
      if (flag.conflict_record_id !== null || flag.conflict_record_quote !== null) {
        const record = view.released.find((item) => item.record_id === flag.conflict_record_id);
        if (record === undefined || flag.conflict_record_quote === null || !quoteOk(flag.conflict_record_quote, contentText(record.content))) continue;
      }
      seen.add(flag.flag_ref);
      result.push({ id: flag.flag_ref, label: FLAG_NAMES[flag.kind], turn, quote: flag.quote, conflictTurn, recordId: flag.conflict_record_id });
    }
  }
  return result;
}
function refereeFor(input: WorkInput): { status: WorkStatus; task: string } {
  const { view, referee } = input;
  if (view === null || (view.committedFinding === null && view.serverStatus !== "completed")) return { status: "waiting", task: "Waiting for a committed finding" };
  if (referee === undefined || referee === null) return { status: "waiting", task: "Waiting for scoring status" };
  if ("status" in referee) return { status: "working", task: "Scoring the synthetic session" };
  if (view.debriefReady !== referee.session_id || view.serverStatus !== "completed") return { status: "waiting", task: "Waiting for the published debrief" };
  return referee.scored ? { status: "ready", task: "Published scoring ready" } : { status: "failed", task: "Session has no published score" };
}
function subjectFor(view: TrialView | null): WorkAgent {
  const count = view?.turns.filter((turn) => turn.answer !== null).length ?? 0;
  if (view === null) return { id: "subject", name: "Subject", status: "waiting", task: "Waiting for session", count };
  if (view.status === "subject_answering") return { id: "subject", name: "Subject", status: "working", task: "Preparing an answer", count };
  if (view.status === "ended") return { id: "subject", name: "Subject", status: "ready", task: "Interview finished", count };
  return { id: "subject", name: "Subject", status: "waiting", task: "Waiting for a question", count };
}
function coachFor(view: TrialView | null, count: number): WorkAgent {
  const base = { id: "coach" as const, name: "Coach", count };
  if (view === null) return { ...base, status: "waiting", task: "Waiting for session" };
  if (view.mode === "assessment") return { ...base, status: "withheld", task: "Coaching withheld in assessment" };
  if (view.channel === "voice") return { ...base, status: "withheld", task: "Text coaching unavailable in voice" };
  if (view.status === "coach_working") return { ...base, status: "working", task: view.coachReading === null ? "Reviewing the answer" : `Reading turn ${String(view.coachReading)}` };
  const latest = view.turns.at(-1)?.turn_no;
  if (view.coachFailures.some((failure) => failure.turn_no === latest)) return { ...base, status: "failed", task: "Coaching unavailable for this turn" };
  return { ...base, status: count > 0 ? "ready" : "waiting", task: count > 0 ? "Coaching filed" : "Waiting for an answer" };
}
function transfersFor(items: readonly WorkItem[], input: WorkInput): WorkTransfer[] {
  if (input.reducedMotion) return [];
  return items.flatMap((item): WorkTransfer[] => {
    if (item.atMs === null || item.kind === "flag") return [];
    const elapsed = input.nowMs - item.atMs;
    if (elapsed < 0 || elapsed >= TRANSFER_MS) return [];
    const from: WorkRole = item.kind === "evidence" ? "evidence" : item.kind === "referee" ? "referee" : "coach";
    const to: WorkRole = item.kind === "referee" ? "coach" : item.kind === "evidence" ? "coach" : "evidence";
    return [{ id: item.id, from, to, progress: elapsed / TRANSFER_MS }];
  });
}

/** One exact frame for all four styles. Assessment/voice coaching stays absent even in end snapshots. */
export function deriveAgentWork(input: WorkInput): WorkFrame {
  const { view } = input;
  const showCoach = view !== null && view.mode === "practice" && view.channel === "text";
  const cards = showCoach ? view.cards : [];
  const updates = showCoach ? view.updates : [];
  const flags = showCoach ? flagsFor(view) : [];
  const documents = view?.released.map((record) => ({ id: record.record_id, title: record.title, turn: record.released_at_turn })) ?? [];
  const referee = refereeFor(input);
  const items: WorkItem[] = [
    ...cards.map((card): WorkItem => ({ id: `card:${String(card.turn_no)}`, kind: "card", label: `Coaching card · turn ${String(card.turn_no)}`, turn: card.turn_no, atMs: arrival(input, `coach.card:${String(card.turn_no)}`) })),
    ...updates.map((update): WorkItem => ({ id: `update:${String(update.turn_no)}`, kind: "update", label: `Deep review updated · turn ${String(update.turn_no)}`, turn: update.turn_no, atMs: arrival(input, `coach.update:${String(update.turn_no)}`) })),
    ...documents.map((record): WorkItem => ({ id: `evidence:${record.id}`, kind: "evidence", label: record.title, turn: record.turn, atMs: arrival(input, `evidence.released:${record.id}`) })),
    ...flags.map((flag): WorkItem => ({ id: `flag:${flag.id}`, kind: "flag", label: `${flag.label} · turn ${String(flag.turn)}`, turn: flag.turn, atMs: arrival(input, `coach.card:${String(flag.turn)}`) })),
  ];
  if (referee.status === "ready" || referee.status === "failed") items.push({ id: "referee:published", kind: "referee", label: referee.task, turn: null, atMs: arrival(input, "debrief.ready") });
  items.sort((a, b) => (a.atMs ?? -1) - (b.atMs ?? -1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const subject = subjectFor(view);
  const coach = coachFor(view, cards.length + updates.length);
  const evidence: WorkAgent = { id: "evidence", name: "Evidence clerk", status: documents.length > 0 ? "ready" : "waiting", task: documents.length > 0 ? `${String(documents.length)} released records filed` : "Waiting for released records", count: documents.length };
  const agents: WorkAgent[] = [subject, coach, evidence, { id: "referee", name: "Referee", status: referee.status, task: referee.task, count: referee.status === "ready" ? 1 : 0 }];
  const active = agents.filter((agent) => agent.status === "working");
  const caption = view === null ? "No session loaded. Agent work will appear when a session is opened." : active.length > 0 ? active.map((agent) => `${agent.name}: ${agent.task}.`).join(" ") : view.status === "ended" ? "Session finished. Review the recorded work below." : "Waiting for the next recorded activity.";
  return {
    available: view !== null, assessment: view?.mode === "assessment", agents, cards: cards.length, updates: updates.length,
    flags, documents, items, transfers: transfersFor(items, input), caption, turn: view?.turns.at(-1)?.turn_no ?? 0,
    paused: input.paused, reducedMotion: input.reducedMotion,
    phase: input.reducedMotion || !Number.isFinite(input.nowMs) ? 0 : ((Math.max(0, input.nowMs) % 1_600) / 1_600), refereeState: referee.status,
  };
}

export interface Point { readonly x: number; readonly y: number }
/** Adapted from office.ts: the same 2:1 isometric floor, scaled to a monitor's 960×540 viewport. */
export function officePoint(x: number, y: number, z = 0): Point { return { x: 480 + (x - y) * 28, y: 170 + (x + y) * 14 - z }; }
/** Donor pointAlong's deterministic path interpolation, specialized to one leg. */
export function between(from: Point, to: Point, progress: number): Point {
  const t = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}
