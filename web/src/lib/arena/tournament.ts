/**
 * The tournament arena's state (S6 4.9; stage 2): poll responses folded into a matrix of trials. A dev or revealed
 * tournament answers `{visibility: "events", frames, last}` on the global ledger cursor; a hidden tournament before
 * reveal answers `{visibility: "counts", progress}` and nothing else (D9): the fold then holds only the progress
 * rows, never a trial id, text or count of flags (FE-SSE-4). Frames are absolute and idempotent, so the fold is
 * order-independent and duplicate-safe: each frame applies to the attempt current at its ledger seq, so a retried
 * trial, which keeps its `trial_ref` (the planned position), starts clean. When the visibility switches from counts
 * to events, the caller restarts at `after=0` (S6 4.9).
 */
import type { ProgressRow, TournamentPoll, TrialExecution, TrialStarted } from "../contracts/generated/types";

export interface TournamentState {
  readonly visibility: "events" | "counts" | "none";
  readonly state: "draft" | "frozen" | "running" | "sealed" | "scoring" | "revealed" | null;
  /** The ledger cursor for the next poll (`after=`). */
  readonly last: number;
  /** The ledger seq of the `tournament.status` frame `state` came from, so a re-folded older one never reverts it. */
  readonly stateSeq: number;
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
  /** The ledger seq of this attempt's `trial.started`. A retried planned trial keeps its `trial_ref` and starts a new
   * attempt (a new `trial_id`, D-027): frames older than this belong to an earlier attempt and never touch the cell. */
  readonly since: number;
}

export const EMPTY_TOURNAMENT: TournamentState = { visibility: "none", state: null, last: 0, stateSeq: 0, trials: new Map(), progress: [] };

/** Fold one poll response into the state. A counts response replaces everything with its progress rows. */
export function foldPoll(state: TournamentState, poll: TournamentPoll): TournamentState {
  if (poll.visibility === "counts") return { visibility: "counts", state: state.state, last: 0, stateSeq: 0, trials: new Map(), progress: poll.progress };
  const base = state.visibility === "counts" ? EMPTY_TOURNAMENT : state;
  const trials = new Map(base.trials);
  let tournamentState = base.state;
  let stateSeq = base.stateSeq;
  // Frames apply in ledger order, each to the attempt current at its seq: a retry's `trial.started` starts the cell
  // clean, and an earlier attempt's end (in this poll, or folded again as a duplicate) never lands on the retry.
  const patch = (ref: number, seq: number, change: Partial<TrialCell>) => {
    const held = trials.get(ref);
    if (held !== undefined && seq > held.since) trials.set(ref, { ...held, ...change });
  };
  for (const frame of [...poll.frames].sort((a, b) => a.seq - b.seq)) {
    switch (frame.type) {
      case "tournament.status":
        if (frame.seq >= stateSeq) {
          tournamentState = frame.data.state;
          stateSeq = frame.seq;
        }
        break;
      case "trial.started": {
        const d = frame.data;
        const held = trials.get(d.trial_ref);
        // An older attempt's start, or this attempt's again, changes nothing.
        if (held !== undefined && held.since >= frame.seq) break;
        trials.set(d.trial_ref, { trial_ref: d.trial_ref, trial_id: d.trial_id, pairing: d.pairing, track: d.track, block: d.block, execution: null, commitment_hash: null, since: frame.seq });
        break;
      }
      case "trial.execution":
        patch(frame.data.trial_ref, frame.seq, { execution: frame.data.state });
        break;
      case "trial.finalized":
        patch(frame.data.trial_ref, frame.seq, { commitment_hash: frame.data.commitment_hash });
        break;
      default:
        // replay.turn frames move no cell (a corpus turn copied into a replay trial).
        break;
    }
  }
  return { visibility: "events", state: tournamentState, last: Math.max(base.last, poll.last), stateSeq, trials, progress: [] };
}

export type Track = TrialCell["track"];

/** The tracks in the sponsor's order (S6 4.9: the replay track, then the interactive track; the replay corpus last). */
const TRACK_ORDER: readonly Track[] = ["replay", "interactive", "replay_corpus"];

/** The tracks the tournament has trials on, in the sponsor's order. */
export function tracks(state: TournamentState): readonly Track[] {
  const present = new Set([...state.trials.values()].map((c) => c.track));
  return TRACK_ORDER.filter((t) => present.has(t));
}

/** One track's matrix: its pairings as rows, each with that track's trials in `trial_ref` order. */
export function matrix(state: TournamentState, track: Track): readonly { readonly pairing: string; readonly cells: readonly TrialCell[] }[] {
  const rows = new Map<string, TrialCell[]>();
  for (const cell of [...state.trials.values()].filter((c) => c.track === track).sort((a, b) => a.trial_ref - b.trial_ref)) {
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
