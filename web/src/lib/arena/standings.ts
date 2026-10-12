/**
 * The standings board on the precinct wall (S6 4.10, drawn in 3D): the assistant board's ranked coaches in the
 * server's order with their rank intervals, the ineligible listed apart with their reason, and the manifest it is
 * bound to. Nothing is re-ranked or recomputed here. Before reveal it reads "Sealed until reveal." with no numbers
 * (FE-LB-5); the bundled example is labeled as such; with no board to show there is no standings board.
 */
import type { Board, BoardsState } from "./leaderboard";

export interface StandingsRow {
  readonly rank: string;
  readonly name: string;
  readonly detail: string;
}

export interface Standings {
  readonly heading: string;
  readonly note: string;
  readonly rows: readonly StandingsRow[];
  readonly excluded: readonly string[];
}

function pct(v: number): string {
  return `${String(Math.round(v * 100))}%`;
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
      const recall = r.metrics["M01_deceptive_recall"]?.point ?? null;
      const parts = [recall === null ? null : `Recall ${pct(recall)}`, r.rankInterval === null ? null : `ranks ${String(r.rankInterval.lo)}-${String(r.rankInterval.hi)}`].filter((x) => x !== null);
      return { rank: String(r.rank), name: r.display_name, detail: parts.join(", ") };
    });
  const excluded = board.rows.filter((r) => r.rank === null).map((r) => `${r.display_name}: ${r.reason ?? r.eligibilityStatus ?? "not eligible"}`);
  return { heading: "Standings", note, rows, excluded };
}
