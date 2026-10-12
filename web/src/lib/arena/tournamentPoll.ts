/**
 * The arena's tournament lifecycle (S6 4.9, S5 6.2): which tournaments exist (`GET /api/tournaments`), a
 * tournament's state (`GET /api/tournaments/{id}`), and when the next `GET /api/tournaments/{id}/events?after=`
 * is due. The poll runs every 2 s while the tournament is running, sealed or scoring and the tab is visible, and
 * stops after the response that reports `revealed`; draft, frozen and revealed tournaments are read once. The
 * cursor (`after`) is the fold's `last`, which a counts response resets to 0, so the first events response after
 * reveal starts from the beginning.
 */
import type { TournamentState } from "./tournament";

export const POLL_MS = 2000;
/** The most frames one poll response carries (the tournament-poll schema's `maxItems`): a full page means more are
 * waiting behind it. */
export const POLL_PAGE = 200;

type Status = NonNullable<TournamentState["state"]>;

const STATUSES: readonly Status[] = ["draft", "frozen", "running", "sealed", "scoring", "revealed"];
const LIVE: readonly Status[] = ["running", "sealed", "scoring"];

export interface TournamentListing {
  readonly id: string;
  readonly name: string;
  readonly split: "dev" | "hidden";
  readonly status: Status;
  /** The tournament's seed and roster manifest hash (S6 4.9), null when the server does not send them. */
  readonly seed: number | null;
  readonly rosterHash: string | null;
}

/** When the next poll is due: at once (a full page left more frames behind it, whatever the state), in `POLL_MS`,
 * once the tab is visible again (`hidden`), or never (`stop`). A state no response has reported yet keeps the poll
 * going, as a hidden tournament's counts responses carry none. */
export function nextPoll(state: TournamentState["state"], visible: boolean, more = false): number | "hidden" | "stop" {
  if (!more && state !== null && !LIVE.includes(state)) return "stop";
  if (!visible) return "hidden";
  return more ? 0 : POLL_MS;
}

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function status(v: unknown): Status | null {
  return STATUSES.find((s) => s === v) ?? null;
}

/** `GET /api/tournaments`: an array or `{tournaments: [...]}` of `arena.v_tournaments` rows; a row in another shape
 * is left out. Null when the answer is not a list. */
export function parseTournamentList(v: unknown): readonly TournamentListing[] | null {
  const list = Array.isArray(v) ? (v as unknown[]) : isRecord(v) && Array.isArray(v["tournaments"]) ? (v["tournaments"] as unknown[]) : null;
  if (list === null) return null;
  return list.flatMap((r) => {
    if (!isRecord(r)) return [];
    const { id, name, split } = r;
    const st = status(r["status"]);
    const seed = typeof r["seed"] === "number" && Number.isSafeInteger(r["seed"]) ? r["seed"] : null;
    const roster = r["roster_sha256"];
    const rosterHash = typeof roster === "string" && /^[0-9a-f]{64}$/.test(roster) ? roster : null;
    return typeof id === "string" && typeof name === "string" && (split === "dev" || split === "hidden") && st !== null ? [{ id, name, split, status: st, seed, rosterHash }] : [];
  });
}

/** The tournament's lifecycle state in `GET /api/tournaments/{id}` (top level or under `tournament`), or null. */
export function parseTournamentStatus(v: unknown): Status | null {
  if (!isRecord(v)) return null;
  return status(v["status"]) ?? (isRecord(v["tournament"]) ? status(v["tournament"]["status"]) : null);
}
