/**
 * Checking a recording file (D-021) against the format and the wire contracts (S6 5.2): a recording that fails any
 * check is refused whole, never partly played. Kept apart from the playback cursor so the compiled validators load
 * with the recording, not with the page.
 */

import { clientEventOrder, isClientCaptureMetadata, MAX_CLIENT_FRAMES, MAX_CLIENT_FRAME_BYTES, MAX_CLIENT_DOCUMENT_BYTES, publicationErrors } from "./clientCaptureSchema";
import { isWire } from "../contracts/validate";
import { knownReplayScene } from "./sceneContext";
import { END_TAIL_MS, RECORDING_FORMAT, RECORDING_FORMAT_V2, type Recording } from "./recording";
import { isWorldTime, notebookSourceKey, parseWorldEvents } from "./worldEvents";

export type RecordingResult = { readonly ok: true; readonly recording: Recording } | { readonly ok: false; readonly errors: readonly string[] };

type Json = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function onlyKeys(value: Json, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** S1's Content: a non-empty body and, when present, a table whose every row has one text cell per column. */
function contentOk(value: unknown): boolean {
  if (!isObject(value) || !onlyKeys(value, ["body", "table"]) || !isText(value["body"])) return false;
  const table = value["table"];
  if (table === undefined || table === null) return true;
  if (!isObject(table) || !onlyKeys(table, ["columns", "rows"])) return false;
  const columns = table["columns"];
  const rows = table["rows"];
  if (!Array.isArray(columns) || !Array.from(columns).every((c) => typeof c === "string") || !Array.isArray(rows)) return false;
  return Array.from(rows).every((row: unknown) => Array.isArray(row) && row.length === columns.length && Array.from(row).every((cell) => typeof cell === "string"));
}

/** Keys a recording's case block may carry; anything else (a role, a style) refuses the recording. */
const CASE_KEYS = new Set(["case_id", "title", "objective", "domain", "difficulty_level", "subject", "setting", "initial_documents"]);

export function recordingCaseErrors(value: unknown): string[] {
  if (!isObject(value)) return ["case: not an object"];
  const errors: string[] = [];
  for (const key of Object.keys(value)) if (!CASE_KEYS.has(key)) errors.push("case: unexpected field");
  for (const key of ["case_id", "title", "objective", "domain", "setting"]) {
    if (!isText(value[key])) errors.push(`case: ${key} must be a non-empty string`);
  }
  if (typeof value["difficulty_level"] !== "number" || !Number.isFinite(value["difficulty_level"])) errors.push("case: difficulty_level must be a number");
  const subject = value["subject"];
  if (!isObject(subject) || !onlyKeys(subject, ["display_name", "position"]) || !isText(subject["display_name"]) || !isText(subject["position"])) {
    errors.push("case: subject needs display_name and position");
  }
  const docs = value["initial_documents"];
  if (!Array.isArray(docs)) errors.push("case: initial_documents must be a list");
  else {
    for (let i = 0; i < docs.length; i += 1) {
      const doc: unknown = docs[i];
      const ok = isObject(doc) && onlyKeys(doc, ["doc_id", "kind", "title", "content"]) && isText(doc["doc_id"]) && isText(doc["kind"]) && isText(doc["title"]) && contentOk(doc["content"]);
      if (!ok) errors.push(`case: initial_documents[${String(i)}] needs doc_id, kind, title and whole content (body, table rows as wide as its columns)`);
    }
  }
  return errors;
}

/** Check a parsed recording file against the format and the wire contracts. */
export function parseRecording(raw: unknown): RecordingResult {
  if (!isObject(raw)) return { ok: false, errors: ["recording: not an object"] };
  const errors: string[] = [];
  const version2 = raw["format"] === RECORDING_FORMAT_V2;
  if (raw["format"] !== RECORDING_FORMAT && !version2) errors.push(`recording: format must be ${RECORDING_FORMAT} or ${RECORDING_FORMAT_V2}`);
  const sceneContext = raw["scene_context"];
  const scene = sceneContext === undefined ? null : knownReplayScene(sceneContext);
  if (sceneContext !== undefined && (!version2 || scene === null)) return { ok: false, errors: ["scene_context: requires a known bundled v2 scene tuple"] };
  const world = parseWorldEvents(version2 ? raw["world_events"] : []);
  if (!version2 && raw["world_events"] !== undefined && !(Array.isArray(raw["world_events"]) && raw["world_events"].length === 0)) errors.push("world_events: requires arena.recording.v2");
  if (!world.ok) errors.push(...world.errors);
  const trialId = raw["trial_id"];
  if (!isText(trialId)) errors.push("recording: trial_id must be a non-empty string");
  errors.push(...recordingCaseErrors(raw["case"]));
  if (!isWire("snapshot", raw["snapshot"])) errors.push("snapshot: fails the snapshot wire schema");
  const events = raw["events"];
  if (raw["client_capture"] !== undefined && Array.isArray(events) && events.length > MAX_CLIENT_FRAMES)
    return { ok: false, errors: ["client_capture: too many accepted frames"] };
  // A harness (tournament) trial's export also carries a replay trial's own `source_unavailable` end (C-45).
  const frameSchema = isObject(raw["snapshot"]) && raw["snapshot"]["mode"] === "harness" ? "harness-events" : "events";
  if (!Array.isArray(events) || (events.length === 0 && !(version2 && world.ok && world.events.length > 0))) errors.push("events: must be a non-empty list unless v2 world events are present");
  else {
    let last = 0;
    for (let i = 0; i < events.length; i += 1) {
      const event: unknown = events[i];
      const where = `events[${String(i)}]`;
      if (!isObject(event) || !onlyKeys(event, ["at_ms", "frame"])) {
        errors.push(`${where}: needs only at_ms and frame`);
        continue;
      }
      const at = event["at_ms"];
      if (!isWorldTime(at) || at < last) errors.push(`${where}: at_ms must be a number at or after the previous one`);
      else last = at;
      const frame = event["frame"];
      if (!isWire(frameSchema, frame)) errors.push(`${where}: frame fails the ${frameSchema} wire schema`);
      else if (frame.scope_id !== trialId) errors.push(`${where}: frame belongs to another trial`);
    }
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
  if (errors.length > 0 || !world.ok) return { ok: false, errors };
  // The end-of-trial snapshot (absent or null while the trial ran): in assessment mode it holds the coaching the
  // session withheld, shown once the recording reaches the end (FE-DEB-4).
  const finalSnapshot = raw["final_snapshot"] ?? null;
  if (finalSnapshot !== null) {
    if (!isWire("snapshot", finalSnapshot)) errors.push("final_snapshot: fails the snapshot wire schema");
    else if (finalSnapshot.status === "running") errors.push("final_snapshot: the trial had not ended");
  }
  if (errors.length > 0) return { ok: false, errors };
  // Select only the declared public recording fields. Unknown top-level metadata is never propagated.
  // Optional input documents normalize to null only in the returned Recording.
  const checked = raw as unknown as Omit<Recording, "debrief" | "final_snapshot"> & Partial<Pick<Recording, "debrief" | "final_snapshot">>;
  // Boundary validation, not a second replay reducer: a note can cite only a source public by
  // its capture time. Requestable/final-snapshot sources are deliberately not made available early.
  const publicAt = new Map<string, number>();
  for (const doc of checked.case.initial_documents) publicAt.set(notebookSourceKey({ kind: "document", id: doc.doc_id }), 0);
  for (const release of checked.snapshot.released) publicAt.set(notebookSourceKey({ kind: "record", id: release.record_id }), 0);
  for (const event of checked.events) {
    if (event.frame.type === "evidence.released") {
      const key = notebookSourceKey({ kind: "record", id: event.frame.data.record_id });
      if (!publicAt.has(key)) publicAt.set(key, event.at_ms);
    }
  }
  for (const event of world.events) {
    if (event.kind !== "input" || event.data.action !== "notebook") continue;
    const data = event.data;
    const refs = data.operation === "upsert" ? data.metadata?.citations : data.operation === "draft" ? data.draft.citations : [];
    if (refs?.some((ref) => (publicAt.get(notebookSourceKey(ref)) ?? Infinity) > event.t_ms) === true) {
      return { ok: false, errors: ["world_events: notebook citation was not public at capture time"] };
    }
  }
  const metadata = raw["client_capture"];
  const publishedAt = raw["published_at_ms"];
  if ((!version2 && (metadata !== undefined || publishedAt !== undefined))
    || (metadata !== undefined && !isClientCaptureMetadata(metadata))) return { ok: false, errors: ["client_capture: invalid v2-only provenance"] };
  const publication = publicationErrors(publishedAt, checked.debrief, checked.events);
  if (publication.length > 0) return { ok: false, errors: publication };
  const finding = world.events.some((event) => event.kind === "input" && event.data.action === "finding");
  if (finding && metadata === undefined) return { ok: false, errors: ["world_events: local finding actions require versioned client_capture"] };
  const clientOrder = metadata === undefined ? undefined : clientEventOrder(checked.events, world.events);
  if (clientOrder === null) return { ok: false, errors: ["client_capture: inconsistent finding order"] };
  if (isClientCaptureMetadata(metadata)) {
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    let acceptedSeq = 0;
    for (const event of checked.events) {
      if (event.frame.seq !== null && event.frame.seq !== ++acceptedSeq) return { ok: false, errors: ["client_capture: sequence gaps/dispositions are unsupported"] };
      if (event.frame.type === "debrief.ready" && event.frame.data.session_id !== metadata.session_id) return { ok: false, errors: ["client_capture: readiness belongs to another session"] };
    }
    if (checked.events.length > MAX_CLIENT_FRAMES || bytes(checked.events) > MAX_CLIENT_FRAME_BYTES
      || bytes([checked.snapshot, checked.case]) > MAX_CLIENT_DOCUMENT_BYTES || bytes(checked.debrief) > MAX_CLIENT_DOCUMENT_BYTES)
      return { ok: false, errors: ["client_capture: bounded journal exceeded"] };
    if (checked.snapshot.channel !== "text" || checked.snapshot.mode === "harness" || checked.snapshot.last_seq !== 0
      || checked.snapshot.status !== "running" || checked.snapshot.turns.length !== 0 || checked.snapshot.released.length !== 0
      || checked.snapshot.cards.length !== 0 || checked.snapshot.updates.length !== 0 || checked.snapshot.finding !== null
      || checked.snapshot.commitment_hash !== null || checked.snapshot.exchanges_used !== 0
      || checked.snapshot.coach_failures.length !== 0 || checked.snapshot.voice_exchanges.length !== 0)
      return { ok: false, errors: ["client_capture: requires a fresh empty text opening"] };
    if (checked.final_snapshot !== null && checked.final_snapshot !== undefined) return { ok: false, errors: ["client_capture: terminal snapshot replacement is unsupported"] };
    if (checked.debrief !== null && checked.debrief !== undefined && publishedAt === undefined) return { ok: false, errors: ["client_capture: debrief needs actual publication time"] };
    if (metadata.status === "complete" && (publishedAt === undefined || checked.debrief?.session_id !== metadata.session_id))
      return { ok: false, errors: ["client_capture: complete requires timed publication for this session"] };
  }
  const durationMs = Math.max(typeof publishedAt === "number" ? publishedAt : 0, checked.events.at(-1)?.at_ms ?? 0, world.events.at(-1)?.t_ms ?? 0) + END_TAIL_MS;
  return { ok: true, recording: structuredClone({ format: checked.format, trial_id: checked.trial_id,
    case: checked.case, snapshot: checked.snapshot, events: checked.events, world_events: world.events,
    debrief: checked.debrief ?? null, final_snapshot: checked.final_snapshot ?? null, durationMs,
    ...(typeof publishedAt === "number" ? { published_at_ms: publishedAt } : {}),
    ...(scene === null ? {} : { scene_context: scene.context }),
    ...(isClientCaptureMetadata(metadata) ? { client_capture: metadata } : {}),
    ...(clientOrder === undefined ? {} : { client_order: clientOrder }) }) };
}

