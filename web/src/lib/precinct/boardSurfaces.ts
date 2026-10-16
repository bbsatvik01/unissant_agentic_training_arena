/** Public wall projections only. No fetching, scoring, reranking, unlock inference or session mutation. */
import { rankStatus, type Board, type BoardsState } from "../arena/leaderboard";
import type { LocalBackendState } from "./session";
import type { CaseBoardEntry } from "./trainingStations";

export interface BoardSurface {
  readonly key: string; readonly eyebrow: string; readonly heading: string;
  readonly lines: readonly string[]; readonly footer: string; readonly target: "case_board" | "trophies";
}
export interface BoardSurfaceModel { readonly cases: readonly BoardSurface[]; readonly recognition: BoardSurface }
export interface RecognitionRead {
  readonly scope: string;
  readonly tournamentId: string | null;
  readonly label: "original" | null;
  readonly ledger: "pending" | "revealed" | "sealed" | "missing" | "error";
  readonly state: BoardsState | null;
  readonly assistant: Board | null;
}
export interface BoardSurfaceContext { readonly scope: string; readonly backend: LocalBackendState; readonly userId: string | null; readonly assessment: boolean }
function surface(scope: string, target: BoardSurface["target"], eyebrow: string, heading: string, lines: readonly string[], footer: string): BoardSurface {
  // Content is part of the key: any publication, gate or identity change synchronously mounts a blank new material.
  return { key: JSON.stringify([scope, target, eyebrow, heading, lines, footer]), target, eyebrow, heading, lines, footer };
}
export function projectCaseSurfaces(context: BoardSurfaceContext, entries: readonly CaseBoardEntry[], selectedId: string | null, pending: boolean): readonly BoardSurface[] {
  const waiting = context.assessment ? "Assessment in progress" : pending || context.backend === "connecting" ? "Public source pending" : context.backend === "error" ? "Public source unavailable" : context.backend === "connected" && context.userId === null ? "Public source unavailable" : null;
  return [0, 1, 2].map((slot) => {
    const scope = `${context.scope}:case:${String(slot)}`;
    if (waiting !== null) return surface(scope, "case_board", "PUBLIC CASE BOARD", waiting, ["Open the accessible case board.", "No previous selection is displayed."], "Case selection never starts an interview.");
    const entry = entries[slot];
    if (entry === undefined) return surface(scope, "case_board", "PUBLIC CASE BOARD", "Explore the case board", ["No additional supplied case in this slot.", "Open the board for its complete public list."], "No completion or unlock is assumed.");
    const { card, availability } = entry;
    const source = context.backend === "connected" ? "LOCAL OFFER" : "OFFLINE PUBLIC METADATA";
    return surface(scope, "case_board", `${source} · ${card.case_id}`, card.title,
      [`${card.domain} · Level ${String(card.difficulty_level)}`, availability.kind === "available" ? "Available public case" : availability.kind === "preview" ? "Preview only · session unavailable" : "Locked by the supplied source", availability.detail, selectedId === card.case_id ? "Selected public case" : "Open the board to inspect this case"],
      "Supplied order · complete list in case board");
  });
}
export function projectRecognitionSurface(context: BoardSurfaceContext, read: RecognitionRead | null): BoardSurface {
  const waiting = (heading: string, lines: readonly string[]) => surface(context.scope, "trophies", "RECOGNITION · ELIGIBILITY BEFORE RANK", heading, lines, "Open the trophy wall for the complete source.");
  if (context.assessment) return waiting("Assessment in progress", ["Prior tournament feedback is withheld.", "Return after this run publishes its debrief."]);
  if (context.backend !== "connected" || context.userId === null) return waiting(context.backend === "connecting" ? "Publication source pending" : "No connected publication", ["Connect explicitly in interview controls.", "No example ranks or scores are displayed."]);
  if (read === null || read.scope !== context.scope || read.tournamentId === null) return waiting("Choose a supplied tournament", ["Open the trophy wall to select a source.", "No tournament results are assumed."]);
  if (read.ledger === "error" || read.state?.kind === "error") return waiting("Publication unavailable", ["The selected source could not be read.", "No earlier result is displayed here."]);
  if (read.ledger === "missing" || read.state?.kind === "missing") return waiting("No supplied publication", ["No published board is available from this source."]);
  if (read.ledger === "sealed" || read.state?.kind === "sealed") return waiting("Publication sealed", ["No names, ranks or scores before reveal."]);
  if (read.ledger !== "revealed" || read.state === null) return waiting("Publication pending", ["Waiting for the selected canonical publication."]);
  if (read.state.kind !== "published" || read.state.tournamentId !== read.tournamentId || read.state.label !== read.label) return waiting("Publication unavailable", ["No matching selected publication is supplied."]);
  const board = read.assistant;
  if (board === null || board.board !== "assistant") return waiting("Assistant board unavailable", ["No substitute or subject rank is displayed."]);
  if (board.notRanked) return waiting("Not ranked", [board.status, "No rank is shown even if a row supplies one."]);
  const lines = board.rows.slice(0, 2).flatMap((row) => {
    const ranked = row.eligible === true && row.eligibilityStatus?.startsWith("insufficient") !== true && row.rank !== null;
    const interval = row.rankInterval === null ? "interval unavailable" : `interval ${String(row.rankInterval.lo)}–${String(row.rankInterval.hi)}`;
    return ranked ? [`Rank ${String(row.rank)} · ${row.display_name}`, `${rankStatus(board, row)} · ${interval}`]
      : [`${row.display_name} · not ranked`, row.reason ?? row.eligibilityStatus ?? "Eligibility not supplied"];
  });
  return surface(context.scope, "trophies", read.label === "original" ? "ORIGINAL PUBLISHED SNAPSHOT" : "SELECTED PUBLISHED SNAPSHOT", "Published assistant board", lines.length === 0 ? ["The supplied board contains no candidates."] : lines, "Supplied order · rank is not certification");
}

/** build_precinct.py uses Blender [x,y,z] -> runtime [x,z,-y]. Thin faces overlay existing authored props only. */
export const CASE_BOARD_SURFACES = [
  { position: [5.03, 1.58, -9.63] as const, size: [2.46, 1.38] as const },
  { position: [7.83, 1.58, -9.63] as const, size: [2.46, 1.38] as const },
  { position: [10.63, 1.58, -9.63] as const, size: [2.46, 1.38] as const },
] as const;
// Above the sculptural awards, over the recognition heading/subtitle; no shelf/collider is rebuilt.
export const RECOGNITION_SURFACE = { position: [0, 2.79, -35.70] as const, size: [3.52, 1.08] as const };
