/**
 * The standings board on the precinct wall (S6 4.10, drawn in 3D): the assistant board's ranked coaches in the
 * server's order with their rank intervals, the ineligible listed apart with their reason, and the manifest it is
 * bound to. Nothing is re-ranked or recomputed here. Before reveal it reads "Sealed until reveal." with no numbers
 * (FE-LB-5); the bundled example is labeled as such; with no board to show there is no standings board.
 */
import { metricText, rankStatus, type Board, type BoardsState } from "./leaderboard";

export interface StandingsRow {
  readonly rank: string;
  readonly name: string;
  /** Recall with its interval as published (or why there is none), then the rank interval. */
  readonly detail: string;
  /** The row's ranking status as the arena panel words it (definitive, or provisional with its reasons). */
  readonly status: string;
}

export interface Standings {
  readonly heading: string;
  readonly note: string;
  readonly rows: readonly StandingsRow[];
  readonly excluded: readonly string[];
}

export function standings(board: Board | null, state: BoardsState): Standings | null {
  if (state.kind === "sealed") return { heading: "Standings", note: "Sealed until reveal.", rows: [], excluded: [] };
  if (state.kind !== "published" && state.kind !== "example") return null;
  if (board === null) return null;
  if (board.notRanked) return { heading: "Standings", note: "Not ranked: the isolation gate failed.", rows: [], excluded: [] };
  const note =
    state.kind === "example" ? "Example data. Not a result." : `${board.manifestHash === null ? "Manifest not published" : `Bound to manifest ${board.manifestHash.slice(0, 12)}`}. Not certification.`;
  const rows = board.rows
    .filter((r) => r.rank !== null)
    .map((r) => {
      const ranks = r.rankInterval === null ? "rank interval unavailable" : `ranks ${String(r.rankInterval.lo)}-${String(r.rankInterval.hi)}`;
      return { rank: String(r.rank), name: r.display_name, detail: `Recall ${metricText(r.metrics["M01_deceptive_recall"])}; ${ranks}`, status: rankStatus(board, r) };
    });
  const excluded = board.rows.filter((r) => r.rank === null).map((r) => `${r.display_name}: ${r.reason ?? r.eligibilityStatus ?? "not eligible"}`);
  return { heading: "Standings", note, rows, excluded };
}

/** What the board says, as one string: equal for equal content, so a re-read of the same board is no change. */
export function standingsKey(s: Standings | null): string {
  return JSON.stringify(s);
}

/** One drawn line of the wall board: a ranked row's first line (rank, name), its detail line, its status line, or
 * an ineligible candidate's line; `y` is its baseline in texture pixels, `size` its font size. */
export type StandingsLine =
  | { readonly kind: "row"; readonly y: number; readonly size: number; readonly rank: string; readonly name: string }
  | { readonly kind: "detail" | "status"; readonly y: number; readonly size: number; readonly text: string }
  | { readonly kind: "excluded"; readonly y: number; readonly size: number; readonly text: string };

/** Lays every ranked row (three lines each) and every ineligible candidate out between `top` and `bottom`: nothing is
 * dropped; when they do not fit at full size, every line shrinks by the same factor. */
export function standingsLayout(s: Standings, top: number, bottom: number): readonly StandingsLine[] {
  const ROW = 56;
  const DETAIL = 34;
  const STATUS = 30;
  const EXCLUDED = 30;
  const need = s.rows.length * (ROW + DETAIL + STATUS + 22) + s.excluded.length * (EXCLUDED + 12);
  // Floored to three decimals so float rounding can never push the last line past `bottom`.
  const f = need === 0 ? 1 : Math.min(1, Math.floor(((bottom - top) / need) * 1000) / 1000);
  const lines: StandingsLine[] = [];
  let y = top;
  for (const r of s.rows) {
    y += ROW * f;
    lines.push({ kind: "row", y, size: ROW * f * 0.86, rank: r.rank, name: r.name });
    y += DETAIL * f;
    lines.push({ kind: "detail", y, size: DETAIL * f * 0.82, text: r.detail });
    y += STATUS * f;
    lines.push({ kind: "status", y, size: STATUS * f * 0.82, text: r.status });
    y += 22 * f;
  }
  for (const text of s.excluded) {
    y += (EXCLUDED + 12) * f;
    lines.push({ kind: "excluded", y, size: EXCLUDED * f * 0.86, text: `Not ranked: ${text}` });
  }
  return lines;
}
