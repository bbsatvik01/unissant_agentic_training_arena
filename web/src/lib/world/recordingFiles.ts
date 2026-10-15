/** Bounded, whole-file imports. The caller owns last-request-wins and when to install a valid result. */
import { parseRecording, type RecordingResult } from "./parseRecording";
import { RECORDING_FORMAT_V2, type Recording } from "./recording";

export const MAX_RECORDING_FILE_BYTES = 32_000_000;
const tooLarge = (): RecordingResult => ({ ok: false, errors: ["recording: file exceeds the 32 MB import limit"] });
export async function readRecordingFile(file: Pick<File, "size" | "text">): Promise<RecordingResult> {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_RECORDING_FILE_BYTES) return tooLarge();
  try {
    const text = await file.text();
    if (text.length > MAX_RECORDING_FILE_BYTES || new TextEncoder().encode(text).byteLength > MAX_RECORDING_FILE_BYTES) return tooLarge();
    return parseRecording(JSON.parse(text) as unknown);
  } catch { return { ok: false, errors: ["recording: could not read a valid JSON file"] }; }
}
export function recordingJson(recording: Recording): string {
  if (recording.format === "arena.recording.v1" && (recording.world_events.length > 0 || recording.annotations.length > 0))
    throw new TypeError("A v1 recording has no world telemetry or annotations");
  const result = parseRecording(recording.format === "arena.recording.v1"
    ? { ...recording, world_events: undefined, annotations: undefined } : recording);
  if (!result.ok) throw new TypeError("Cannot export an invalid recording");
  const value = result.recording;
  const text = JSON.stringify({ format: value.format, trial_id: value.trial_id, case: value.case, snapshot: value.snapshot,
    events: value.events, ...(value.format === RECORDING_FORMAT_V2 ? { world_events: value.world_events, annotations: value.annotations } : {}),
    ...(value.world_profile === undefined ? {} : { world_profile: value.world_profile }),
    ...(value.published_at_ms === undefined ? {} : { published_at_ms: value.published_at_ms }),
    ...(value.client_capture === undefined ? {} : { client_capture: value.client_capture }),
    ...(value.scene_context === undefined ? {} : { scene_context: value.scene_context }),
    debrief: value.debrief, final_snapshot: value.final_snapshot });
  if (new TextEncoder().encode(text).byteLength > MAX_RECORDING_FILE_BYTES) throw new RangeError("Recording exceeds the 32 MB import/export limit");
  return text;
}
