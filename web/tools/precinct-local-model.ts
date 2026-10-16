/** Developer-only in-memory fixture. No model, assessor, credentials, persistence, or network client. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { WIRE_VALIDATORS, wireBytes } from "../src/lib/contracts/compiled/validators.js";
import { invariantErrors } from "../src/lib/contracts/invariants.ts";
import type { EvidenceReleased, EvidenceResult, Debrief, SessionCreate, TextTrialSnapshot, TrialFrame, WireTypes } from "../src/lib/contracts/generated/types.ts";
import type { RecordingCase } from "../src/lib/world/recording.ts";

export const FIXTURE_NOTICE = "LOCAL SCRIPTED, UNSCORED EXERCISE. No model or referee is running. Questions are saved verbatim; subject lines follow fixed authored beats independent of your wording. The final debrief reveals the authored fictional resolution, never a grade of your interview.";
export const LIMITS = { runs: 8, actionsPerRun: 64, bodyBytes: 65_536, tickets: 64, streams: 8, ticketMs: 60_000, streamMs: 600_000 } as const;
export const SCRIPT_LINES = [
  "I was one of the two technicians working that short-staffed afternoon at Halvern Street Annex.",
  "Ines Marrow radioed me about a humidity alarm in B-12. I understood that as my task for the vault.",
  "I used my badge to enter B-12 around 14:07. The vault was not on my daily roster; the radio call sent me there.",
  "The dehumidifier had tripped. I reset it and dealt with its full condensate tank.",
  "I used a cart while emptying the tank into the drain outside. I held the door open and stayed in its doorway.",
  "Ines entered the work order later. I did not create the work order myself.",
  "I did not open a records box, replace a seal, or take a seal from the drawer.",
  "I radioed Ines that the B-12 dehumidifier was reset and its tank was emptied after finishing the task.",
  "I left after quarter past two and before half past. I did not check a clock for my exact exit time.",
  "I remember the dispatch as B-12. My work there concerned its humidity alarm and dehumidifier.",
  "I had no custodian release to open boxes and did not open them. My work was at the equipment and doorway.",
  "My account is that I followed the radio dispatch, reset the dehumidifier, emptied the tank while staying at the doorway, and left.",
] as const;

/** Authored scenario content, not a conclusion inferred from this user's questions or finding. */
const AUTHORED_RESOLUTION = "Authored fictional resolution; this is not a grade of your interview. In this fixed scripted scenario, Pell truthfully describes authorized B-12 humidity-alarm work. The radio log assigns B-12; the later work order records the dehumidifier and tank work; the alarm history confirms B-12. The scripted account places Pell at the doorway while moving the tank, matching the equipment exception in the public policy. The seal audit reports intact seals. A late work order, an off-roster room and a door alarm do not by themselves establish an unauthorized entry. Your actual committed label is shown separately; no model, referee or rubric evaluated it.";

export class MockRefusal extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}

export function checked<K extends keyof WireTypes>(name: K, value: unknown): WireTypes[K] {
  if (WIRE_VALIDATORS[name]?.(value) !== true || invariantErrors(name, value).length !== 0) throw new MockRefusal(422, "invalid_request");
  return value as WireTypes[K];
}

/** Mirrors arena_core.contracts.rendered and agents.fence for request bounds only.
 * The returned normalized text is never substituted for the trainee's stored question or finding. */
export function localRendered(text: string): string {
  const sanitize = (value: string) => value.replace(/\r\n?/g, "\n")
    .replace(/[\p{Cc}\p{Cf}\p{Co}]/gu, (character) => character === "\n" || character === "\t" ? character : "")
    .normalize("NFKC").replace(/<!--.*?-->/gs, "")
    .replace(/<\/?\s*(?:system|user|assistant|human|ai|tool|function|developer|sys)\s*>|<\|[^>]{0,40}\|>|\[\/?\s*INST\s*\]|<<\/?\s*SYS\s*>>|<\/?\s*untrusted_[a-z]+[^>]*>/gi, "");
  let current = text;
  for (let pass = 0; pass < 32; pass += 1) {
    const next = sanitize(current);
    if (next === current) return next.replace(/\s+/gu, " ").trim();
    current = next;
  }
  return sanitize(current.replace(/[<>[\]]/g, "")).replace(/\s+/gu, " ").trim();
}
function renderedBound(text: string, min: number, max: number, bytes: number): void {
  const rendered = localRendered(text), length = Array.from(rendered).length;
  if (length < min || length > max || wireBytes(rendered) > bytes) throw new MockRefusal(422, "invalid_request");
}

interface Fixture {
  readonly case: RecordingCase;
  readonly requestable: TextTrialSnapshot["requestable"];
  readonly releases: readonly EvidenceReleased[];
}
interface SavedAction { readonly signature: string; readonly result: unknown }
interface Recorded { readonly at_ms: number; readonly frame: TrialFrame }
export interface Run {
  readonly sessionId: string;
  readonly trialId: string;
  readonly createdAt: string;
  readonly startMs: number;
  readonly opening: TextTrialSnapshot;
  snapshot: TextTrialSnapshot;
  version: number;
  readonly events: Recorded[];
  readonly actions: Map<string, SavedAction>;
  debrief: Debrief | null;
}

/** Stable JSON comparison: object key order never changes idempotency semantics. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  if (value === undefined) return "null";
  return JSON.stringify(value);
}

/** Called only by explicit server construction, never during module import. Reads one public-only fixture. */
export function createLocalModel(now: () => number = Date.now) {
  const fixture = JSON.parse(readFileSync(new URL("./precinct-local-fixture.json", import.meta.url), "utf8")) as Fixture;
  const packet: RecordingCase = { ...fixture.case, title: `Local scripted fixture: ${fixture.case.title}`, objective: `${FIXTURE_NOTICE} Public packet objective: ${fixture.case.objective}` };
  const card = { case_id: packet.case_id, title: packet.title, objective: packet.objective, domain: packet.domain, difficulty_level: packet.difficulty_level, subject: packet.subject, facility: packet.setting, initial_documents: packet.initial_documents.length, requestable_records: fixture.requestable.length };
  const runs = new Map<string, Run>();
  const starts = new Map<string, SavedAction>();
  let acknowledgement: string | null = null;
  let onFrames: (run: Run, frames: readonly TrialFrame[]) => void = () => undefined;
  const timestamp = () => new Date(now()).toISOString();
  const requireRun = (id: string) => { const run = runs.get(id); if (run === undefined) throw new MockRefusal(404, "not_found"); return run; };
  const requireSession = (id: string) => { const run = [...runs.values()].find((r) => r.sessionId === id); if (run === undefined) throw new MockRefusal(404, "not_found"); return run; };

  const emit = (run: Run, type: TrialFrame["type"], data: unknown): TrialFrame => {
    const frame = checked("events", { v: 1, scope: "trial", scope_id: run.trialId, ts: timestamp(), transcript_version: run.version, seq: run.snapshot.last_seq + 1, type, data });
    run.snapshot = { ...run.snapshot, last_seq: frame.seq ?? run.snapshot.last_seq };
    run.events.push({ at_ms: Math.max(0, now() - run.startMs), frame });
    return frame;
  };
  const ensureOpen = (run: Run) => { if (run.snapshot.status !== "running") throw new MockRefusal(409, "trial_not_running"); };
  const requested = (ids: readonly string[]) => { if (ids.some((id) => !fixture.requestable.some((r) => r.record_id === id))) throw new MockRefusal(422, "unknown_record"); };
  const perform = (run: Run, route: string, body: { readonly idem_key: string }, fn: () => unknown): unknown => {
    const signature = `${route}:${canonical(body)}`;
    const saved = run.actions.get(body.idem_key);
    if (saved !== undefined) { if (saved.signature !== signature) throw new MockRefusal(409, "idempotency_conflict"); return structuredClone(saved.result); }
    if (run.actions.size >= LIMITS.actionsPerRun) throw new MockRefusal(429, "local_fixture_action_limit");
    const before = run.events.length;
    const result = fn();
    checked("snapshot", run.snapshot);
    run.actions.set(body.idem_key, { signature, result: structuredClone(result) });
    onFrames(run, run.events.slice(before).map((e) => e.frame));
    return structuredClone(result);
  };
  const release = (run: Run, ids: readonly string[]): EvidenceResult => {
    const already_released: string[] = [], denied: string[] = [];
    const newly = fixture.releases.filter((record) => {
      if (record.trigger === "scheduled") return record.released_at_turn <= run.snapshot.exchanges_used && !run.snapshot.released.some((r) => r.record_id === record.record_id);
      if (!ids.includes(record.record_id)) return false;
      if (run.snapshot.released.some((r) => r.record_id === record.record_id)) { already_released.push(record.record_id); return false; }
      const threshold = fixture.requestable.find((r) => r.record_id === record.record_id)?.requestable_after_exchanges;
      if (threshold === undefined || run.snapshot.exchanges_used < threshold) { denied.push(record.record_id); return false; }
      return true;
    });
    newly.sort((a, b) => a.record_id.localeCompare(b.record_id));
    if (newly.length > 0) run.version += 1;
    for (const record of newly) {
      const data = { ...record, released_at_turn: run.snapshot.exchanges_used };
      const frame = emit(run, "evidence.released", data);
      run.snapshot = { ...run.snapshot, released: [...run.snapshot.released, { ...data, transcript_version: run.version, event_seq: frame.seq ?? 0 }] };
    }
    return checked("evidence-result", { released: newly.map(({ record_id, kind, doc_kind }) => ({ record_id, kind, doc_kind })), already_released, denied, transcript_version: run.version });
  };

  return {
    packet, card, requireRun, requireSession,
    setFrameListener(listener: typeof onFrames) { onFrames = listener; },
    acknowledge() { acknowledgement ??= timestamp(); return { ex4_acknowledged: acknowledgement }; },
    me(csrf: string) { return { user_id: "00000000-0000-4000-8000-000000000001", display_name: "Local scripted fixture exercise (unscored)", roles: ["investigator"], ex4_acknowledged: acknowledgement, study: null, csrf_token: csrf }; },
    start(value: unknown) {
      const body: SessionCreate = checked("session-create", value);
      if (acknowledgement === null) throw new MockRefusal(403, "ex4_required");
      if (body.case_id !== packet.case_id) throw new MockRefusal(404, "not_found");
      if (body.voice) throw new MockRefusal(503, "local_voice_unavailable");
      const signature = canonical(body), saved = starts.get(body.idem_key);
      if (saved !== undefined) { if (saved.signature !== signature) throw new MockRefusal(409, "idempotency_conflict"); return structuredClone(saved.result); }
      if (runs.size >= LIMITS.runs) throw new MockRefusal(429, "local_fixture_run_limit");
      const trialId = randomUUID(), sessionId = randomUUID();
      const opening: TextTrialSnapshot = { status: "running", reason_code: null, mode: body.mode, split: "dev", exchanges_used: 0, exchanges_cap: 12, released: [], requestable: structuredClone(fixture.requestable), finding: null, commitment_hash: null, last_seq: 0, channel: "text", turns: [], voice_exchanges: [], cards: [], updates: [], coach_failures: [] };
      checked("snapshot", opening);
      runs.set(trialId, { sessionId, trialId, createdAt: timestamp(), startMs: now(), opening: structuredClone(opening), snapshot: opening, version: 0, events: [], actions: new Map(), debrief: null });
      const result = { session_id: sessionId, trial_id: trialId, mode: body.mode, case_id: body.case_id, phase: "practice" };
      starts.set(body.idem_key, { signature, result }); return structuredClone(result);
    },
    turn(id: string, value: unknown) {
      const input = checked("turn-submit", value), run = requireRun(id);
      const body = { ...input, release_ids: [...input.release_ids].sort() };
      return perform(run, "turns", body, () => {
        ensureOpen(run); requested(body.release_ids);
        renderedBound(body.question, 1, 600, 2400);
        if (body.expected_version !== run.version) throw new MockRefusal(409, "stale_version");
        if (run.snapshot.exchanges_used >= 12) throw new MockRefusal(409, "exchange_cap");
        const n = run.snapshot.exchanges_used + 1;
        run.version += 1;
        const question = emit(run, "question.accepted", { turn_no: n, text: body.question, source: "investigator", channel: "text" });
        release(run, body.release_ids);
        run.version += 1;
        const answer = `[AUTHORED SCRIPTED BEAT ${String(n)}/12, independent of your question] ${SCRIPT_LINES[n - 1] ?? "Script complete."} This fixed line does not interpret your question.`;
        const committed_at = timestamp();
        emit(run, "subject.answer", { turn_no: n, text: answer, channel: "text", partial: false, committed_at });
        run.snapshot = { ...run.snapshot, exchanges_used: n, turns: [...run.snapshot.turns, { turn_no: n, question: body.question, source: "investigator", answer, partial: false, committed_at, answer_version: run.version, question_seq: question.seq ?? 0 }] };
        if (run.snapshot.mode === "practice") {
          // No arbitrary question receives an invented classification, flag, or finding. The existing
          // failure contract closes the coaching step; the public fixture notice explains the reason.
          const failure = { turn_no: n, reason: "repair_failed" as const };
          emit(run, "coach.failed", failure);
          run.snapshot = { ...run.snapshot, coach_failures: [...run.snapshot.coach_failures, failure] };
        }
        return { last_seq: run.snapshot.last_seq, version: run.version, status: run.snapshot.status };
      });
    },
    evidence(id: string, value: unknown) {
      const input = checked("evidence-request", value), run = requireRun(id);
      const body = { ...input, record_ids: [...input.record_ids].sort() };
      return perform(run, "evidence-requests", body, () => { ensureOpen(run); requested(body.record_ids); return release(run, body.record_ids); });
    },
    finding(id: string, value: unknown) {
      const input = checked("finding-commit", value), run = requireRun(id);
      const body = { ...input, finding: { ...input.finding, alternative_explanations: input.finding.alternative_explanations ?? null } };
      return perform(run, "finding", body, () => {
        ensureOpen(run);
        renderedBound(body.finding.rationale, 1, 600, 1200);
        for (const text of body.finding.corroboration_needed) renderedBound(text, 3, 120, 240);
        for (const text of body.finding.alternative_explanations ?? []) renderedBound(text, 3, 160, 320);
        if (body.finding.cited_turns.some((n) => !run.snapshot.turns.some((t) => t.turn_no === n && t.answer !== null && !t.partial))) throw new MockRefusal(422, "invalid_request");
        if (body.finding.cited_records.some((id) => !packet.initial_documents.some((d) => d.doc_id === id) && !run.snapshot.released.some((r) => r.record_id === id))) throw new MockRefusal(422, "invalid_request");
        const finding = { ...body.finding, alternative_explanations: body.finding.alternative_explanations ?? null, last_revised_turn: null };
        const hash = createHash("sha256").update(canonical({ trial_id: run.trialId, turns: run.snapshot.turns, released: run.snapshot.released, finding })).digest("hex");
        emit(run, "finding.committed", { by: "investigator", finding, committed_at: timestamp() });
        run.snapshot = { ...run.snapshot, status: "completed", reason_code: "local_scripted_unscored", finding, commitment_hash: hash };
        emit(run, "trial.finalized", { commitment_hash: hash });
        emit(run, "trial.status", { status: "completed", reason_code: "local_scripted_unscored" });
        return { last_seq: run.snapshot.last_seq, commitment_hash: hash };
      });
    },
    publishDebrief(sessionId: string): Debrief {
      const run = requireSession(sessionId);
      if (run.debrief !== null) return structuredClone(run.debrief);
      if (run.snapshot.status !== "completed" || run.snapshot.finding === null || run.snapshot.commitment_hash === null) throw new MockRefusal(409, "trial_not_finalized");
      const debrief = checked("debrief.v1", { schema_version: "debrief.v1", session_id: run.sessionId, scored: false,
        outcome: { role: "truthful", correct_finding: "truthful", committed_label: run.snapshot.finding.label, resolution: AUTHORED_RESOLUTION } });
      run.debrief = debrief;
      const frame = emit(run, "debrief.ready", { session_id: run.sessionId });
      checked("snapshot", run.snapshot); onFrames(run, [frame]); return structuredClone(debrief);
    },
    session(run: Run) { return { session_id: run.sessionId, trial_id: run.trialId, phase: "practice", voice: false, mode: run.snapshot.mode, status: run.snapshot.status, exchanges: run.snapshot.exchanges_used, created_at: run.createdAt }; },
    progress() { return { sessions: [...runs.values()].map((run) => ({ session_id: run.sessionId, trial_id: run.trialId, phase: "practice", mode: run.snapshot.mode, voice: false, status: run.snapshot.status, created_at: run.createdAt, case_title: packet.title })), kpi1: null }; },
    recording(id: string) { const run = requireRun(id); return structuredClone({ format: "arena.recording.v1", trial_id: id, case: packet, snapshot: run.opening, events: run.events, debrief: run.debrief, final_snapshot: run.snapshot.status === "running" ? null : run.snapshot }); },
    dispose() { runs.clear(); starts.clear(); acknowledgement = null; onFrames = () => undefined; },
  };
}
