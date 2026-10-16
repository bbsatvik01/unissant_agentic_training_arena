/** Read-only display of an already-published debrief. Never derives a score or unlock. */
import type { Debrief } from "../contracts/generated/types";
import type { TrialView } from "../trial/trialReducer";
import { RUBRIC } from "../copy/rubric";

export interface DebriefWall {
  readonly key: string;
  readonly heading: string;
  readonly origin: string;
  readonly total: string;
  readonly lines: readonly string[];
  readonly published: boolean;
}

export function projectDebriefWall({ scope, recorded, assessment, debrief, view }: {
  readonly scope: string;
  readonly recorded: boolean;
  readonly assessment: boolean;
  readonly debrief: Debrief | null;
  readonly view: TrialView | null;
}): DebriefWall {
  const published = !assessment && debrief !== null && view?.debriefReady === debrief.session_id && view.status === "ended";
  if (!published) return {
    key: `waiting:${scope}:${String(assessment)}`, heading: "A place to reflect", origin: "DEBRIEF / REPLAY", total: "No published score",
    lines: ["Finish a session, then review its own published debrief.", "Recorded results never count as your current progress."], published: false,
  };
  const scored = debrief.scored && debrief.rubric.scorable && debrief.rubric.total !== null;
  return {
    key: `published:${scope}:${debrief.session_id}`, heading: "Review this interview", origin: recorded ? "PUBLISHED RECORDING · ITS OWN RESULT" : "PUBLISHED LOCAL SESSION",
    total: scored ? `${String(debrief.rubric.total)} / 100` : debrief.scored ? "Score unavailable" : "Unscored session",
    lines: scored ? debrief.rubric.dimensions.map((dimension) => `${RUBRIC[dimension.dim_id].name}: ${String(dimension.score)} / 4`) : [debrief.scored ? debrief.rubric.unscorable_reason ?? "This session could not be scored." : "This session has no numeric grade.", "Open the debrief to review the finding and transcript."],
    published: true,
  };
}

export const DEBRIEF_WALL_SURFACE = { position: [8.1, 2.15, -25.685] as const, size: [4.8, 1.9] as const };
