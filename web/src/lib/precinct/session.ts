/** Public projections and action gates for the walkable precinct's one session runtime. */
import type { Debrief } from "../contracts/generated/types";
import type { RoomStatus, TrialView } from "../trial/trialReducer";
import type { CaseCard } from "../world/cases";
import type { CaseDocument, Recording, RecordingCase } from "../world/recording";
import type { WorldState } from "../world/worldState";

export type PrecinctSessionSource = "idle" | "live" | "recording";
export type SessionPanel = "interview" | "transcript" | "coach" | "evidence" | "finding" | "debrief" | "recordings";
export type LocalBackendState = "offline" | "connecting" | "connected" | "error";

/** No hostname suffixes, arbitrary LAN hosts, user-supplied URLs, or hosted-origin fallback. */
export function isLoopbackOrigin(origin: { readonly protocol: string; readonly hostname: string }): boolean {
  return (origin.protocol === "http:" || origin.protocol === "https:") && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(origin.hostname);
}

/** Only the public packet fields cross the dossier boundary, even if a caller supplied extra keys. */
export function publicPacket(card: CaseCard, documents: readonly CaseDocument[]): RecordingCase {
  return {
    case_id: card.case_id, title: card.title, objective: card.objective, domain: card.domain,
    difficulty_level: card.difficulty_level, subject: { display_name: card.subject.display_name, position: card.subject.position },
    setting: card.facility,
    initial_documents: documents.map((document) => ({
      doc_id: document.doc_id, title: document.title, kind: document.kind,
      content: { body: document.content.body, ...(document.content.table == null ? {} : { table: {
        columns: [...document.content.table.columns], rows: document.content.table.rows.map((row) => [...row]),
      } }) },
    })),
  };
}

export function recordingCaseCard(recording: Recording): CaseCard {
  const packet = recording.case;
  return { case_id: packet.case_id, title: packet.title, objective: packet.objective, domain: packet.domain,
    difficulty_level: packet.difficulty_level, subject: { display_name: packet.subject.display_name, position: packet.subject.position },
    facility: packet.setting, initial_documents: packet.initial_documents.length, requestable_records: recording.snapshot.requestable.length };
}

export function questionDisabledReason(source: PrecinctSessionSource, view: TrialView | null, backend: LocalBackendState): string | null {
  if (source === "recording") return "Recorded run: questions and scores belong to this saved interview.";
  if (backend !== "connected") return "Offline: load a recorded run, or explicitly connect a local backend.";
  if (source !== "live" || view === null) return "Choose a case and start an interview first.";
  if (view.channel === "voice") return "This voice interview uses the microphone controls.";
  if (view.status === "awaiting_question") return null;
  if (view.status === "cap_reached") return "The interview has reached its length limit. Commit your finding.";
  if (view.status === "ended" || view.status === "finalizing") return "The interview is over.";
  return "Wait for the current answer and coaching to finish.";
}

export function canSubmitSessionAction(source: PrecinctSessionSource, view: TrialView | null, backend: LocalBackendState): boolean {
  return source === "live" && backend === "connected" && view !== null && (view.status === "awaiting_question" || view.status === "cap_reached");
}

/** A bundled score is never attached to a new local exercise or shown ahead of its recorded debrief. */
export function visibleRecordedDebrief(recording: Recording | null, view: TrialView | null, world: WorldState | null): Debrief | null {
  return view?.status === "ended" && world?.debriefReady === true ? recording?.debrief ?? null : null;
}

export const SESSION_STATUS: Readonly<Record<RoomStatus, string>> = {
  connecting: "Opening interview", awaiting_question: "Ready for a question", subject_answering: "Subject is answering",
  coach_working: "Coach is reviewing", cap_reached: "Ready for a finding", finalizing: "Sealing the finding", ended: "Interview ended",
};
