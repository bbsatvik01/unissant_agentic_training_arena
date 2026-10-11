/**
 * The tournament arena's state (S6 4.9; stage 2): poll responses folded into a matrix of trials. A dev or revealed
 * tournament answers `{visibility: "events", frames, last}` on the global ledger cursor; a hidden tournament before
 * reveal answers `{visibility: "counts", progress}` and nothing else (D9): the fold then holds only the progress
 * rows, never a trial id, text or count of flags (FE-SSE-4). Frames are absolute and idempotent, so the fold is
 * order-independent and duplicate-safe; when the visibility switches from counts to events, the caller restarts at
 * `after=0` (S6 4.9) and calls `resetForEvents`.
 */
import type { ProgressRow, TournamentPoll, TrialExecution, TrialStarted } from "../contracts/generated/types";

export interface TournamentState {
  readonly visibility: "events" | "counts" | "none";
  readonly state: "draft" | "frozen" | "running" | "sealed" | "scoring" | "revealed" | null;
  /** The ledger cursor for the next poll (`after=`). */
  readonly last: number;
  readonly trials: ReadonlyMap<number, TrialCell>;
  readonly progress: readonly ProgressRow[];
}

export interface TrialCell {
  readonly trial_ref: number;
  readonly trial_id: string;
  readonly pairing: string;
  readonly track: TrialStarted["track"];
  readonly block: number | null;
  readonly execution: TrialExecution["state"] | null;
  readonly commitment_hash: string | null;
}

export const EMPTY_TOURNAMENT: TournamentState = { visibility: "none", state: null, last: 0, trials: new Map(), progress: [] };

/** Fold one poll response into the state. A counts response replaces everything with its progress rows. */
export function foldPoll(state: TournamentState, poll: TournamentPoll): TournamentState {
  if (poll.visibility === "counts") return { visibility: "counts", state: state.state, last: 0, trials: new Map(), progress: poll.progress };
  const base = state.visibility === "counts" ? EMPTY_TOURNAMENT : state;
  const trials = new Map(base.trials);
  let tournamentState = base.state;
  const pending: { ref: number; patch: Partial<TrialCell> }[] = [];
  for (const frame of [...poll.frames].sort((a, b) => a.seq - b.seq)) {
    switch (frame.type) {
      case "tournament.status":
        tournamentState = frame.data.state;
        break;
      case "trial.started": {
        const d = frame.data;
        const held = trials.get(d.trial_ref);
        trials.set(d.trial_ref, { execution: null, commitment_hash: null, ...held, trial_ref: d.trial_ref, trial_id: d.trial_id, pairing: d.pairing, track: d.track, block: d.block });
        break;
      }
      case "trial.execution":
        pending.push({ ref: frame.data.trial_ref, patch: { execution: frame.data.state } });
        break;
      case "trial.finalized":
        pending.push({ ref: frame.data.trial_ref, patch: { commitment_hash: frame.data.commitment_hash } });
        break;
      default:
        // replay.turn frames move no cell (a corpus turn copied into a replay trial).
        break;
    }
  }
  for (const { ref, patch } of pending) {
    const held = trials.get(ref);
    if (held !== undefined) trials.set(ref, { ...held, ...patch });
  }
  return { visibility: "events", state: tournamentState, last: Math.max(base.last, poll.last), trials, progress: [] };
}

/** The matrix: pairings as rows, each with its trials in `trial_ref` order. */
export function matrix(state: TournamentState): readonly { readonly pairing: string; readonly cells: readonly TrialCell[] }[] {
  const rows = new Map<string, TrialCell[]>();
  for (const cell of [...state.trials.values()].sort((a, b) => a.trial_ref - b.trial_ref)) {
    const list = rows.get(cell.pairing) ?? [];
    list.push(cell);
    rows.set(cell.pairing, list);
  }
  return [...rows.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([pairing, cells]) => ({ pairing, cells }));
}

/** A cell's state in words: its execution state when known, else running or sealed. */
export function cellState(cell: TrialCell): string {
  if (cell.execution !== null) return cell.execution.replaceAll("_", " ");
  return cell.commitment_hash === null ? "running" : "sealed";
}
