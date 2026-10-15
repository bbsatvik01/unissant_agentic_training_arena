import type { SnapshotRelease } from "../lib/contracts/generated/types";
import type { RecordingCase } from "../lib/world/recording";

/** Tiny synthetic public-only fixtures; no recording, secret label, or evaluator is imported. */
export const dossierPacket: RecordingCase = {
  case_id: "public-case", title: "A door entry to establish", objective: "Establish the purpose of the recorded entry.",
  domain: "facility_access", difficulty_level: 2,
  subject: { display_name: "Avery Vale", position: "Facilities technician" },
  setting: "A voluntary administrative interview in room two.",
  initial_documents: [
    { doc_id: "doc-01", kind: "door_log", title: "Door log", content: { body: "The exit does not require a badge.\nNo exit time is recorded.", table: { columns: ["Time", "Door", "Event"], rows: [["14:07:12", "Vault B", "Access granted"], ["14:09:40", "Vault B", "Door held open"]] } } },
    { doc_id: "doc-02", kind: "policy_excerpt", title: "Access policy", content: { body: "An assigned task is required. The daily report is generated at 16:00." } },
  ],
};
export const dossierRelease: SnapshotRelease = {
  record_id: "rec-01", title: "Radio log", kind: "record", doc_kind: "dispatch_log", date: "2026-03-12",
  content: { body: "Recorded channel transcript.", table: { columns: ["Time", "Message"], rows: [["14:01", "Check the supply room."]] } },
  released_at_turn: 2, trigger: "requested", transcript_version: 5, event_seq: 7,
};
