/**
 * Checking a recording file (D-021) against the format and the wire contracts (S6 5.2): a recording that fails any
 * check is refused whole, never partly played. Kept apart from the playback cursor so the compiled validators load
 * with the recording, not with the page.
 */

import type { Debrief, TrialSnapshot } from "../contracts/generated/types";
import { isWire } from "../contracts/validate";
import { END_TAIL_MS, RECORDING_FORMAT, type Recording } from "./recording";

export type RecordingResult = { readonly ok: true; readonly recording: Recording } | { readonly ok: false; readonly errors: readonly string[] };

type Json = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** S1's Content: a non-empty body and, when present, a table whose every row has one text cell per column. */
function contentOk(value: unknown): boolean {
  if (!isObject(value) || !isText(value["body"])) return false;
  const table = value["table"];
  if (table === undefined || table === null) return true;
  if (!isObject(table)) return false;
  const columns = table["columns"];
  const rows = table["rows"];
  if (!Array.isArray(columns) || !columns.every((c) => typeof c === "string") || !Array.isArray(rows)) return false;
  return rows.every((row) => Array.isArray(row) && row.length === columns.length && row.every((cell) => typeof cell === "string"));
}

/** Keys a recording's case block may carry; anything else (a role, a style) refuses the recording. */
const CASE_KEYS = new Set(["case_id", "title", "objective", "domain", "difficulty_level", "subject", "setting", "initial_documents"]);

function caseErrors(value: unknown): string[] {
  if (!isObject(value)) return ["case: not an object"];
  const errors: string[] = [];
  for (const key of Object.keys(value)) if (!CASE_KEYS.has(key)) errors.push(`case: unexpected field ${key}`);
  for (const key of ["case_id", "title", "objective", "domain", "setting"]) {
    if (!isText(value[key])) errors.push(`case: ${key} must be a non-empty string`);
  }
  if (typeof value["difficulty_level"] !== "number") errors.push("case: difficulty_level must be a number");
  const subject = value["subject"];
  if (!isObject(subject) || !isText(subject["display_name"]) || !isText(subject["position"])) {
    errors.push("case: subject needs display_name and position");
  }
  const docs = value["initial_documents"];
  if (!Array.isArray(docs)) errors.push("case: initial_documents must be a list");
  else {
    docs.forEach((doc: unknown, i) => {
      const ok = isObject(doc) && isText(doc["doc_id"]) && isText(doc["kind"]) && isText(doc["title"]) && contentOk(doc["content"]);
      if (!ok) errors.push(`case: initial_documents[${String(i)}] needs doc_id, kind, title and whole content (body, table rows as wide as its columns)`);
    });
  }
  return errors;
}

/** Check a parsed recording file against the format and the wire contracts. */
export function parseRecording(raw: unknown): RecordingResult {
  if (!isObject(raw)) return { ok: false, errors: ["recording: not an object"] };
  const errors: string[] = [];
  if (raw["format"] !== RECORDING_FORMAT) errors.push(`recording: format must be ${RECORDING_FORMAT}`);
  const trialId = raw["trial_id"];
  if (!isText(trialId)) errors.push("recording: trial_id must be a non-empty string");
  errors.push(...caseErrors(raw["case"]));
  if (!isWire("snapshot", raw["snapshot"])) errors.push("snapshot: fails the snapshot wire schema");
  const events = raw["events"];
  if (!Array.isArray(events) || events.length === 0) errors.push("events: must be a non-empty list");
  else {
    let last = 0;
    events.forEach((event: unknown, i) => {
      const where = `events[${String(i)}]`;
      if (!isObject(event)) {
        errors.push(`${where}: not an object`);
        return;
      }
      const at = event["at_ms"];
      if (typeof at !== "number" || !Number.isFinite(at) || at < last) errors.push(`${where}: at_ms must be a number at or after the previous one`);
      else last = at;
      const frame = event["frame"];
      if (!isWire("events", frame)) errors.push(`${where}: frame fails the events wire schema`);
      else if (frame.scope_id !== trialId) errors.push(`${where}: frame belongs to another trial`);
    });
  }
  const debrief = raw["debrief"] ?? null;
  if (debrief !== null) {
    if (!isWire("debrief.v1", debrief)) errors.push("debrief: fails the debrief.v1 wire schema");
    else {
      // The debrief belongs to this run: the session its readiness frame names.
      const ready = Array.isArray(events)
        ? events.map((e: unknown) => (isObject(e) && isObject(e["frame"]) && e["frame"]["type"] === "debrief.ready" && isObject(e["frame"]["data"]) ? e["frame"]["data"]["session_id"] : undefined)).find((id) => id !== undefined)
        : undefined;
      if (ready !== debrief.session_id) errors.push("debrief: its session is not the one this run's debrief.ready names");
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  // The end-of-trial snapshot (absent or null while the trial ran): in assessment mode it holds the coaching the
  // session withheld, shown once the recording reaches the end (FE-DEB-4).
  const finalSnapshot = raw["final_snapshot"] ?? null;
  if (finalSnapshot !== null) {
    if (!isWire("snapshot", finalSnapshot)) errors.push("final_snapshot: fails the snapshot wire schema");
    else if (finalSnapshot.status === "running") errors.push("final_snapshot: the trial had not ended");
  }
  if (errors.length > 0) return { ok: false, errors };
  const checked = raw as unknown as Omit<Recording, "durationMs" | "debrief" | "final_snapshot"> & {
    readonly debrief?: Debrief | null;
    readonly final_snapshot?: TrialSnapshot | null;
  };
  const durationMs = (checked.events.at(-1)?.at_ms ?? 0) + END_TAIL_MS;
  return { ok: true, recording: { ...checked, debrief: checked.debrief ?? null, final_snapshot: checked.final_snapshot ?? null, durationMs } };
}

