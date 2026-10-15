/** Public station routing and source labels. No unlock rules, scoring, networking or private packet access. */
import type { Progress, ProgressSession } from "../progress/progress";
import { sessionEnded } from "../progress/progress";
import { RECORDED_CASE_ID, type CaseCard } from "../world/cases";
import type { ArchiveTape, CaseBoardEntry } from "./trainingStations";

export type TrainingStationId = "cases" | "trophies" | "archive" | "skills" | "coach_lab" | "instructor" | "drill" | "methodology";
export const TRAINING_STATION_TITLES: Readonly<Record<TrainingStationId, string>> = {
  cases: "Case board", trophies: "Trophy wall", archive: "Training archive", skills: "Your five skills",
  coach_lab: "Coach Lab", instructor: "Instructor workspace", drill: "Three-minute warm-up", methodology: "Trust & methodology",
};
export const TRAINING_STATION_PANELS: Readonly<Record<TrainingStationId, string>> = {
  cases: "case_board", trophies: "trophies", archive: "archive", skills: "training_progress",
  coach_lab: "coach_lab", instructor: "instructor", drill: "daily_drill", methodology: "methodology",
};

/** Specific hotspots precede their room: instructor must not accidentally open the Coach Lab. */
export function trainingStationForPanel(panel: string | null, roomId?: string): TrainingStationId | null {
  if (panel === null) return null;
  for (const kind of Object.keys(TRAINING_STATION_PANELS) as TrainingStationId[]) {
    if (TRAINING_STATION_PANELS[kind] === panel) return kind;
  }
  if (roomId === "board_wall") return "cases";
  if (roomId === "coach_lab") return "coach_lab";
  if (roomId === "records") return "archive";
  return null;
}

export function stationCaseEntries(cases: readonly CaseCard[], localConnected: boolean): readonly CaseBoardEntry[] {
  return cases.map((card) => ({ card, availability: localConnected
    ? { kind: "available", detail: "Offered to you by the explicitly connected local backend. Interview mode and ground-rule checks still apply." }
    : card.case_id === RECORDED_CASE_ID
      ? { kind: "available", detail: "Bundled public dossier available. Live interviews require an explicitly connected local backend." }
      : { kind: "preview", detail: "Public case metadata only. No offline dossier or live session is connected for this case." } }));
}

export interface BundledStationTape {
  readonly id: "coached" | "example";
  readonly trialId: string;
  readonly caseId: string;
  readonly caseTitle: string;
  readonly mode: "practice";
  readonly channel: "text";
  readonly label: string;
}
/** Only fields verified in the bundled v1 files. Neither file supplies a recording date or study phase. */
export const BUNDLED_STATION_TAPES: readonly BundledStationTape[] = [
  { id: "coached", trialId: "64d80602-285e-4373-b8e8-12427af0c454", caseId: "C-H3N8RW5B", caseTitle: "Records vault entry during a busy shift", mode: "practice", channel: "text", label: "Recorded coached interview · Gemini" },
  { id: "example", trialId: "7d3c9a10-2b4e-4f61-9c8d-5e2f1a0b3c47", caseId: "C-7Q2MXK4D", caseTitle: "Records vault entry during a busy shift", mode: "practice", channel: "text", label: "Bundled example interview" },
];

/** The canonical v1 history view only offers replay for ended text runs. No recording is pre-fetched. */
export function ownArchiveTapes(progress: Progress): readonly ArchiveTape[] {
  return progress.sessions.map((session) => ({ session, replayAvailable: sessionEnded(session) && !session.voice, sourceLabel: "Your local-backend session" }));
}
export function ownSkillSession(progress: Progress, chosenId: string | null): ProgressSession | null {
  const finished = progress.sessions.filter(sessionEnded);
  // Preserve the server's order; do not label this default as the latest or highest score.
  return finished.find((session) => session.session_id === chosenId) ?? finished[0] ?? null;
}
export function canReplayOwnSession(progress: Progress, trialId: string): boolean {
  return progress.sessions.some((session) => session.trial_id === trialId && sessionEnded(session) && !session.voice);
}
