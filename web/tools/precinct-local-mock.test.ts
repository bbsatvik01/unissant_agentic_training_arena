import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createArenaApi, parseBrief, parseStarted } from "../src/lib/api/arena";
import { createApiClient } from "../src/lib/api/client";
import { isWire } from "../src/lib/contracts/validate";
import type { InvestigatorFinding } from "../src/lib/contracts/generated/types";
import { initialTrialState, trialReducer } from "../src/lib/trial/trialReducer";
import { parseRecording } from "../src/lib/world/parseRecording";
import { cliOptions, createLocalMock } from "./precinct-local-mock.ts";
import { checked, createLocalModel, FIXTURE_NOTICE, LIMITS, localRendered, MockRefusal } from "./precinct-local-model.ts";

const ORIGIN = "http://127.0.0.1:5173";
function withOrigin(input: HeadersInit | undefined): Headers { const headers = new Headers(input); headers.set("Origin", ORIGIN); return headers; }
const finding: InvestigatorFinding = { label: "insufficient_evidence", likelihood: "roughly_even_chance", confidence: "low", basis_flag_refs: [], cited_turns: [], cited_records: [], corroboration_needed: ["A real interview is required"], rationale: "My actual typed finding, preserved without a computed outcome." };
function start(model: ReturnType<typeof createLocalModel>, mode: "practice" | "assessment" = "practice") {
  model.acknowledge();
  const result = parseStarted(model.start({ case_id: model.card.case_id, mode, voice: false, idem_key: randomUUID() }));
  if (result === null) throw new Error("invalid started fixture");
  return model.requireRun(result.trial_id);
}
function turn(model: ReturnType<typeof createLocalModel>, id: string, question = "My exact typed question?", releaseIds: readonly string[] = []) {
  return model.turn(id, { question, release_ids: releaseIds, expected_version: model.requireRun(id).version, idem_key: randomUUID() });
}
/** Audit calls structurally: RegExp.exec is not a subprocess capability. */
function prohibitedCalls(ast: ts.SourceFile): string[] {
  const forbidden = new Set(["fetch", "WebSocket", "XMLHttpRequest", "exec", "spawn", "connect"]);
  const regexes = new Set<string>();
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      const value = declaration.initializer;
      if (ts.isIdentifier(declaration.name) && value !== undefined && (ts.isRegularExpressionLiteral(value) || (ts.isNewExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === "RegExp"))) regexes.add(declaration.name.text);
    }
  }
  const rejected: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && forbidden.has(callee.text)) rejected.push(callee.text);
      if (ts.isPropertyAccessExpression(callee) && forbidden.has(callee.name.text)) {
        const regexExec = callee.name.text === "exec" && ts.isIdentifier(callee.expression) && regexes.has(callee.expression.text);
        if (!regexExec) rejected.push(callee.getText(ast));
      }
      if (ts.isElementAccessExpression(callee) && ts.isStringLiteral(callee.argumentExpression) && forbidden.has(callee.argumentExpression.text)) rejected.push(callee.getText(ast));
    }
    ts.forEachChild(node, visit);
  };
  visit(ast); return rejected;
}
const servers: ReturnType<typeof createLocalMock>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const server of servers.splice(0)) await server.close(); });

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error("fixture lifecycle exceeded two seconds")); }, 2000); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

async function http() {
  const mock = createLocalMock({ port: 0 }); servers.push(mock);
  const { origin, port } = await mock.listen();
  const api = createArenaApi(createApiClient({ fetch: (path, init) => fetch(`${origin}${path}`, { ...init, headers: withOrigin(init.headers) }) }));
  const me = await api.me();
  const send = (path: string, method = "GET", value?: unknown, headers: Record<string, string> = {}) => fetch(`${origin}${path}`, { method, headers: { Origin: ORIGIN, "X-Arena-CSRF": me.csrf_token, ...(value === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  return { mock, origin, port, api, me, send };
}

function raw(port: number, path: string, headers: Record<string, string>, method = "GET", payload = ""): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => { res.resume(); res.on("end", () => { resolve(res.statusCode ?? 0); }); });
    req.on("error", reject); req.end(payload);
  });
}
async function sseText(response: Response, count: number): Promise<string> {
  if (response.body === null) throw new Error("no SSE body");
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let output = "";
  try {
    while ((output.match(/\ndata: /g) ?? []).length < count) {
      const chunk = await reader.read(); if (chunk.done) throw new Error("SSE ended before expected frames");
      output += decoder.decode(chunk.value, { stream: true });
    }
  } finally { await reader.cancel(); }
  return output;
}

describe("honest local scripted model", () => {
  it("uses only public fixture metadata and exact original release gates/documents", () => {
    const source = JSON.parse(readFileSync(new URL("../src/fixtures/recordings/F01-truthful.json", import.meta.url), "utf8")) as { case: { initial_documents: unknown }; snapshot: { requestable: unknown }; events: { frame: { type: string; data: unknown } }[] };
    const fixture = JSON.parse(readFileSync(new URL("./precinct-local-fixture.json", import.meta.url), "utf8")) as Record<string, unknown>;
    expect(Object.keys(fixture).sort()).toEqual(["case", "releases", "requestable"]);
    const model = createLocalModel(); const run = start(model);
    expect(model.packet.initial_documents).toEqual(source.case.initial_documents);
    expect(run.snapshot.requestable).toEqual(source.snapshot.requestable);
    expect(fixture["releases"]).toEqual(source.events.filter((e) => e.frame.type === "evidence.released").map((e) => e.frame.data));
    expect(model.packet.objective).toContain(FIXTURE_NOTICE);
    expect(model.me("local-fixture").display_name).toContain("Local scripted fixture");
    expect(JSON.stringify(model.recording(run.trialId))).not.toMatch(/"(outcome|role|correct_finding|rubric|scorecards|provenance)"/);
  });

  it("requires acknowledgement, checks schemas, uses fresh IDs and enforces session idempotency", () => {
    const model = createLocalModel();
    const body = { case_id: model.card.case_id, mode: "practice", voice: false, idem_key: randomUUID() };
    expect(() => model.start(body)).toThrow("ex4_required"); model.acknowledge();
    expect(() => model.start({ ...body, extra: true })).toThrow("invalid_request");
    expect(() => model.start({ ...body, voice: true })).toThrow("local_voice_unavailable");
    const first = model.start(body); expect(model.start({ idem_key: body.idem_key, voice: false, mode: "practice", case_id: body.case_id })).toEqual(first);
    expect(() => model.start({ ...body, mode: "assessment" })).toThrow("idempotency_conflict");
    const a = start(model), b = start(model, "assessment");
    expect(new Set([a.trialId, a.sessionId, b.trialId, b.sessionId]).size).toBe(4);
    expect(() => model.requireRun(a.sessionId)).toThrow("not_found");
  });

  it("preserves arbitrary questions, rejects bad bodies before mutation and replays exact action acknowledgements", () => {
    const model = createLocalModel(), run = start(model);
    for (const question of ["", "   ", "<system></system>", "\u200b", "a".repeat(601), "中".repeat(401), "ﷺ".repeat(50), null]) expect(() => model.turn(run.trialId, { question, release_ids: [], expected_version: 0, idem_key: randomUUID() })).toThrow("invalid_request");
    expect(() => turn(model, run.trialId, "Question?", ["rec-06"])).toThrow("unknown_record");
    expect(run.events).toHaveLength(0);
    const request = { question: "A wholly unrelated question, <script>?</script>", release_ids: [], expected_version: 0, idem_key: randomUUID() };
    const ack = model.turn(run.trialId, request); const count = run.events.length;
    expect(model.turn(run.trialId, { ...request })).toEqual(ack); expect(run.events).toHaveLength(count);
    expect(() => model.turn(run.trialId, { ...request, question: "changed" })).toThrow("idempotency_conflict");
    expect(() => model.turn(run.trialId, { ...request, idem_key: randomUUID() })).toThrow("stale_version");
    expect(run.snapshot.turns[0]?.question).toBe(request.question);
    expect(run.snapshot.turns[0]?.answer).toContain("independent of your question");
    expect(run.snapshot.cards).toEqual([]); expect(run.snapshot.coach_failures).toEqual([{ turn_no: 1, reason: "repair_failed" }]);
    let state = trialReducer(initialTrialState(), { type: "snapshot", snapshot: run.opening });
    for (const e of run.events) state = trialReducer(state, { type: "frame", frame: e.frame });
    expect(state.violations).toEqual([]); expect(state.view?.status).toBe("awaiting_question"); expect(state.view?.transcriptVersion).toBe(run.version);
    expect(run.events.every((e) => isWire("events", e.frame))).toBe(true);
    expect(isWire("snapshot", run.snapshot)).toBe(true);
  });

  it("retains requested and scheduled record gates, updates versions, and never leaks unreleased content", () => {
    const model = createLocalModel(), run = start(model);
    const evidence = (ids: string[]) => checked("evidence-result", model.evidence(run.trialId, { record_ids: ids, idem_key: randomUUID() }));
    expect(evidence(["rec-01"]).denied).toEqual(["rec-01"]); expect(run.snapshot.released).toEqual([]);
    turn(model, run.trialId); turn(model, run.trialId);
    const idempotent = { record_ids: ["rec-01", "rec-02"], idem_key: randomUUID() };
    const released = checked("evidence-result", model.evidence(run.trialId, idempotent));
    expect(model.evidence(run.trialId, { ...idempotent, record_ids: ["rec-02", "rec-01"] })).toEqual(released);
    expect(released.released.map((r) => r.record_id)).toEqual(["rec-01"]); expect(released.denied).toEqual(["rec-02"]);
    expect(evidence(["rec-01"]).already_released).toEqual(["rec-01"]);
    turn(model, run.trialId); expect(evidence(["rec-02", "rec-03"]).released).toHaveLength(2);
    expect(evidence(["rec-04"]).denied).toEqual(["rec-04"]);
    turn(model, run.trialId); expect(run.snapshot.released.some((r) => r.record_id === "rec-05")).toBe(false);
    turn(model, run.trialId); expect(run.snapshot.released.some((r) => r.record_id === "rec-05")).toBe(false);
    const afterFive = evidence(["rec-04"]); expect(afterFive.denied).toEqual(["rec-04"]);
    expect(afterFive.released.map((r) => r.record_id)).toEqual(["rec-05"]);
    expect(run.snapshot.released.find((r) => r.record_id === "rec-05")?.released_at_turn).toBe(5);
    turn(model, run.trialId); expect(evidence(["rec-04"]).released).toHaveLength(1);
    expect(run.snapshot.released).toHaveLength(5);
    expect(isWire("snapshot", run.snapshot)).toBe(true);
  });

  it("preserves findings and replay without imported outcomes, and assessment never gets coaching", () => {
    const model = createLocalModel(), practice = start(model), run = start(model, "assessment");
    turn(model, practice.trialId); turn(model, run.trialId, "My assessment wording");
    expect(run.events.some((e) => e.frame.type.startsWith("coach."))).toBe(false);
    expect(run.snapshot.coach_failures).toEqual([]);
    expect(() => model.finding(run.trialId, { finding: { ...finding, cited_turns: [2] }, idem_key: randomUUID() })).toThrow("invalid_request");
    expect(() => model.finding(run.trialId, { finding: { ...finding, cited_records: ["rec-04"] }, idem_key: randomUUID() })).toThrow("invalid_request");
    const body = { finding: { ...finding, cited_turns: [1], cited_records: ["doc-01"] }, idem_key: randomUUID() };
    const ack = model.finding(run.trialId, body); expect(model.finding(run.trialId, { ...body, finding: { ...body.finding, alternative_explanations: null } })).toEqual(ack);
    expect(run.snapshot.finding).toEqual({ ...body.finding, alternative_explanations: null, last_revised_turn: null });
    expect(run.snapshot.commitment_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(() => turn(model, run.trialId)).toThrow("trial_not_running");
    const recording = model.recording(run.trialId); expect(parseRecording(recording).ok).toBe(true);
    expect(recording.debrief).toBeNull(); expect(recording.final_snapshot?.cards).toEqual([]);
    expect(recording.events.some((e) => e.frame.type === "debrief.ready")).toBe(false);
    expect(practice.snapshot.finding).toBeNull(); expect(practice.snapshot.status).toBe("running");
    expect(model.progress().kpi1).toBeNull();
  });

  it("seals actual run data with valid sorted-key JSON rather than an extra-brace encoding", () => {
    const model = createLocalModel(), run = start(model);
    turn(model, run.trialId, "My exact question with {braces} and a quote: \"why\"?");
    model.finding(run.trialId, { finding, idem_key: randomUUID() });
    const data = { trial_id: run.trialId, turns: run.snapshot.turns, released: run.snapshot.released, finding: run.snapshot.finding };
    // Independent JSON.stringify oracle: recursively order objects, retaining array order and strings.
    const ordered = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(ordered);
      if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)]));
      return value;
    };
    const serialized = JSON.stringify(ordered(data));
    expect(JSON.parse(serialized) as unknown).toEqual(data);
    expect(run.snapshot.commitment_hash).toBe(createHash("sha256").update(serialized).digest("hex"));
  });

  it("reveals the authored resolution without grading arbitrary questions or replacing the user's label", () => {
    const model = createLocalModel(), a = start(model), b = start(model, "assessment");
    turn(model, a.trialId, "Explain the moon?"); turn(model, b.trialId, "What did you do at work?");
    expect(a.snapshot.turns[0]?.answer).toBe(b.snapshot.turns[0]?.answer);
    expect(() => model.publishDebrief(a.sessionId)).toThrow("trial_not_finalized");
    model.finding(a.trialId, { finding: { ...finding, label: "deceptive", likelihood: "likely" }, idem_key: randomUUID() });
    model.finding(b.trialId, { finding, idem_key: randomUUID() });
    expect(model.recording(a.trialId).debrief).toBeNull();
    const one = model.publishDebrief(a.sessionId), two = model.publishDebrief(b.sessionId);
    expect(one.scored).toBe(false); expect(two.scored).toBe(false);
    expect(one.outcome.correct_finding).toBe("truthful"); expect(two.outcome.correct_finding).toBe("truthful");
    expect(one.outcome.committed_label).toBe("deceptive"); expect(two.outcome.committed_label).toBe("insufficient_evidence");
    expect(one.outcome.resolution).toBe(two.outcome.resolution); expect(one.session_id).not.toBe(two.session_id);
    expect(JSON.stringify(one)).not.toMatch(/"(rubric|scorecards|provenance|total|dimensions|score)"/);
    expect(model.recording(a.trialId).debrief).toEqual(one); expect(parseRecording(model.recording(a.trialId)).ok).toBe(true);
    const count = a.events.length; expect(model.publishDebrief(a.sessionId)).toEqual(one); expect(a.events).toHaveLength(count);
    expect(a.events.at(-1)?.frame.type).toBe("debrief.ready");
    expect(b.events.some((e) => e.frame.type.startsWith("coach."))).toBe(false);
  });

  it("bounds runs, action ledger and finite responses without evicting idempotency data", () => {
    const model = createLocalModel(), run = start(model);
    for (let i = 0; i < 12; i += 1) turn(model, run.trialId);
    expect(() => turn(model, run.trialId)).toThrow("exchange_cap");
    for (let i = run.actions.size; i < LIMITS.actionsPerRun; i += 1) model.evidence(run.trialId, { record_ids: ["rec-01"], idem_key: randomUUID() });
    expect(() => model.evidence(run.trialId, { record_ids: ["rec-01"], idem_key: randomUUID() })).toThrow("local_fixture_action_limit");
    for (let i = 1; i < LIMITS.runs; i += 1) start(model);
    expect(() => start(model)).toThrow("local_fixture_run_limit");
    expect(run.snapshot.turns).toHaveLength(12); expect(run.events.length).toBeLessThan(50);
    model.dispose(); expect(model.progress().sessions).toEqual([]); expect(() => model.requireRun(run.trialId)).toThrow("not_found");
  });
});

describe("developer loopback HTTP boundary", () => {
  it("does not listen on construction, cannot bind LAN, and accepts only explicit CLI flags", async () => {
    const mock = createLocalMock({ port: 0 }); servers.push(mock); expect(mock.server.listening).toBe(false);
    expect(cliOptions([])).toEqual({ port: 8080, browserOrigin: ORIGIN });
    expect(() => cliOptions(["--host", "0.0.0.0"])).toThrow("Usage");
    for (const browserOrigin of ["https://127.0.0.1:5173", "http://evil.test:5173", "http://127.0.0.1:5173/x", "http://localhost:65536"]) expect(() => createLocalMock({ browserOrigin })).toThrow();
    expect(() => createLocalMock({ port: -1 })).toThrow();
    await mock.listen(); const address = mock.server.address(); expect(typeof address === "object" && address?.address).toBe("127.0.0.1");
    await expect(mock.listen()).rejects.toThrow("cannot be started twice");
    await mock.close(); expect(mock.server.listening).toBe(false); await expect(mock.listen()).rejects.toThrow();
  });

  it("honors API client headers and publishes only an authored unscored debrief after finding closure", async () => {
    const { api, me, send } = await http();
    expect(me.display_name).toContain("unscored"); expect((await send("/api/me")).headers.get("set-cookie")).toBeNull();
    await api.ackEx4(); const cards = await api.listCases(); const card = cards[0]; if (card === undefined) throw new Error("no fixture case");
    const brief = await api.caseBrief(card.case_id); expect(brief.initialDocuments).toHaveLength(3);
    expect(parseBrief(await (await send(`/api/cases/${card.case_id}`)).json())).not.toBeNull();
    const run = await api.startSession({ case_id: card.case_id, mode: "practice", voice: false, idem_key: randomUUID() });
    expect(await api.readDebrief(run.session_id)).toEqual({ status: "scoring" });
    await expect(api.requestDebrief(run.session_id)).rejects.toMatchObject({ status: 409, code: "trial_not_finalized" });
    await api.submitTurn(run.trial_id, { question: "My own wording", release_ids: [], expected_version: 0, idem_key: randomUUID() });
    expect((await api.trialSnapshot(run.trial_id)).turns[0]?.question).toBe("My own wording");
    await api.commitFinding(run.trial_id, { finding, idem_key: randomUUID() });
    expect(await api.readDebrief(run.session_id)).toEqual({ status: "scoring" });
    expect((await send(`/api/sessions/${run.session_id}/debrief`, "POST", {})).status).toBe(422);
    const debrief = await api.requestDebrief(run.session_id);
    expect(debrief.scored).toBe(false); expect(debrief.session_id).toBe(run.session_id);
    expect(debrief.outcome.committed_label).toBe(finding.label);
    expect(debrief.outcome.resolution).toContain("Authored fictional resolution");
    expect(Object.keys(debrief).sort()).toEqual(["outcome", "schema_version", "scored", "session_id"]);
    expect(await api.readDebrief(run.session_id)).toEqual(debrief);
    const last = (await api.trialSnapshot(run.trial_id)).last_seq;
    expect(await api.requestDebrief(run.session_id)).toEqual(debrief);
    expect((await api.trialSnapshot(run.trial_id)).last_seq).toBe(last);
    await expect(api.mintStreamTicket(run.trial_id)).rejects.toMatchObject({ status: 409, code: "stream_closed" });
    await expect(api.speak("voice", "text")).rejects.toMatchObject({ status: 503, code: "local_voice_unavailable" });
    await expect(api.mintVoiceTicket(run.trial_id)).rejects.toMatchObject({ status: 503 });
    expect(parseRecording(await api.recording(run.trial_id)).ok).toBe(true);
  });

  it("refuses foreign Host/Origin, credentials, missing CSRF, wrong methods, unknown routes and oversized JSON", async () => {
    const { origin, port, me, send } = await http();
    expect(await raw(port, "/api/me", { Host: "evil.test" })).toBe(421);
    for (const headers of [{ Origin: "https://evil.test" }, { Authorization: "Bearer local-test-placeholder" }, { Cookie: "arena_csrf=untrusted-local-test" }, { "Sec-Fetch-Site": "cross-site" }]) expect((await fetch(`${origin}/api/me`, { headers })).status).toBe(403);
    expect((await fetch(`${origin}/api/me/ack-ex4`, { method: "POST", headers: { Origin: ORIGIN } })).status).toBe(403);
    expect((await fetch(`${origin}/api/me/ack-ex4`, { method: "POST", headers: { "X-Arena-CSRF": me.csrf_token } })).status).toBe(403);
    expect((await send("/api/me/ack-ex4", "POST", {})).status).toBe(422);
    expect((await send("/api/me", "POST")).status).toBe(405);
    expect((await send("/api/unknown", "POST", {})).status).toBe(404);
    expect((await send("/api/me?bad=1")).status).toBe(422);
    expect(await raw(port, "/api/me/ack-ex4", { Host: `127.0.0.1:${String(port)}`, Origin: ORIGIN, "X-Arena-CSRF": me.csrf_token, "Content-Type": "text/plain" }, "POST", "{}" )).toBe(415);
    expect(await raw(port, "/api/sessions", { Host: `127.0.0.1:${String(port)}`, Origin: ORIGIN, "X-Arena-CSRF": me.csrf_token, "Content-Type": "application/json" }, "POST", "{" )).toBe(422);
    expect((await send("/api/sessions", "POST", { text: "a".repeat(LIMITS.bodyBytes) })).status).toBe(413);
    expect((await send(`/api/trials/${randomUUID()}/snapshot`)).status).toBe(404);
    expect((await send("/api/sessions", "POST", { case_id: "bad" })).status).toBe(422);
  });

  it("replays SSE by sequence with single-use trial-scoped tickets and catches up after disconnect", async () => {
    const { api, send } = await http(); await api.ackEx4();
    const card = (await api.listCases())[0]; if (card === undefined) throw new Error("no case");
    const a = await api.startSession({ case_id: card.case_id, mode: "practice", voice: false, idem_key: randomUUID() });
    const b = await api.startSession({ case_id: card.case_id, mode: "assessment", voice: false, idem_key: randomUUID() });
    const ticket = await api.mintStreamTicket(a.trial_id);
    const response = await send(`/api/trials/${a.trial_id}/events?ticket=${ticket}&after=0`);
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reading = sseText(response, 3);
    const ack = await api.submitTurn(a.trial_id, { question: "SSE question one", release_ids: [], expected_version: 0, idem_key: randomUUID() });
    const first = await reading; expect(first).toContain("SSE question one"); expect(first).toContain(`id: ${String(ack.last_seq)}`);
    expect((await send(`/api/trials/${a.trial_id}/events?ticket=${ticket}&after=0`)).status).toBe(401);
    const cross = await api.mintStreamTicket(a.trial_id);
    expect((await send(`/api/trials/${b.trial_id}/events?ticket=${cross}&after=0`)).status).toBe(401);
    await api.submitTurn(a.trial_id, { question: "SSE question two", release_ids: [], expected_version: 2, idem_key: randomUUID() });
    const reconnect = await api.mintStreamTicket(a.trial_id);
    const text = await sseText(await send(`/api/trials/${a.trial_id}/events?ticket=${reconnect}&after=${String(ack.last_seq)}`), 3);
    expect(text).toContain("SSE question two"); expect(text).not.toContain("SSE question one");
    const malformed = await api.mintStreamTicket(a.trial_id);
    expect((await send(`/api/trials/${a.trial_id}/events?ticket=${malformed}&after=-1`)).status).toBe(422);
    expect((await send(`/api/trials/${a.trial_id}/events?ticket=${malformed}&after=999`)).status).toBe(422);
  });

  it("closes the active catch-up stream when its fresh authored debrief is published", async () => {
    const { api, send } = await http(); await api.ackEx4();
    const card = (await api.listCases())[0]; if (card === undefined) throw new Error("no case");
    const run = await api.startSession({ case_id: card.case_id, mode: "assessment", voice: false, idem_key: randomUUID() });
    await api.submitTurn(run.trial_id, { question: "My closure question", release_ids: [], expected_version: 0, idem_key: randomUUID() });
    await api.commitFinding(run.trial_id, { finding, idem_key: randomUUID() });
    const before = (await api.trialSnapshot(run.trial_id)).last_seq;
    const ticket = await api.mintStreamTicket(run.trial_id);
    const stream = await send(`/api/trials/${run.trial_id}/events?ticket=${ticket}&after=${String(before)}`);
    const ended = stream.text();
    await api.requestDebrief(run.session_id);
    const text = await ended; expect(text).toContain('"type":"debrief.ready"'); expect(text).toContain(run.session_id);
    await expect(api.mintStreamTicket(run.trial_id)).rejects.toMatchObject({ status: 409, code: "stream_closed" });
  });

  it("bounds live streams and closes its listener and all active stream timers explicitly", async () => {
    const { mock, api, send, origin } = await http(); await api.ackEx4();
    const card = (await api.listCases())[0]; if (card === undefined) throw new Error("no case");
    const run = await api.startSession({ case_id: card.case_id, mode: "assessment", voice: false, idem_key: randomUUID() });
    const readings: Promise<unknown>[] = [];
    for (let i = 0; i < LIMITS.streams; i += 1) {
      const ticket = await api.mintStreamTicket(run.trial_id);
      const response = await send(`/api/trials/${run.trial_id}/events?ticket=${ticket}&after=0`);
      expect(response.status).toBe(200); readings.push(response.text());
    }
    const refused = await api.mintStreamTicket(run.trial_id);
    expect((await send(`/api/trials/${run.trial_id}/events?ticket=${refused}&after=0`)).status).toBe(429);
    const done = Promise.allSettled(readings); await mock.close();
    expect(mock.server.listening).toBe(false); expect((await bounded(done)).length).toBe(LIMITS.streams);
    await expect(fetch(`${origin}/api/me`)).rejects.toThrow();
  });

  it("bounds ticket memory and rejects expiry using process-local time", async () => {
    let time = 1_800_000_000_000;
    const mock = createLocalMock({ port: 0, now: () => time }); servers.push(mock); const { origin } = await mock.listen();
    const api = createArenaApi(createApiClient({ fetch: (path, init) => fetch(`${origin}${path}`, { ...init, headers: withOrigin(init.headers) }) }));
    await api.ackEx4(); const card = (await api.listCases())[0]; if (card === undefined) throw new Error("no case");
    const run = await api.startSession({ case_id: card.case_id, mode: "assessment", voice: false, idem_key: randomUUID() });
    const ticket = await api.mintStreamTicket(run.trial_id);
    for (let i = 1; i < LIMITS.tickets; i += 1) await api.mintStreamTicket(run.trial_id);
    await expect(api.mintStreamTicket(run.trial_id)).rejects.toMatchObject({ status: 429 });
    time += LIMITS.ticketMs;
    expect((await fetch(`${origin}/api/trials/${run.trial_id}/events?ticket=${ticket}&after=0`)).status).toBe(401);
    expect(await api.mintStreamTicket(run.trial_id)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("offline and explicit lifecycle guarantees", () => {
  it("has an audited runtime import closure with no external networking or subprocess capability", () => {
    const expected: Record<string, string[]> = {
      "precinct-local-model.ts": ["node:crypto", "node:fs", "../src/lib/contracts/compiled/validators.js", "../src/lib/contracts/invariants.ts"],
      "precinct-local-mock.ts": ["node:crypto", "node:http", "node:path", "node:url", "./precinct-local-model.ts"],
    };
    for (const [file, imports] of Object.entries(expected)) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const runtime = ast.statements.filter(ts.isImportDeclaration).filter((s) => s.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword).map((s) => ts.isStringLiteral(s.moduleSpecifier) ? s.moduleSpecifier.text : "invalid");
      expect(runtime).toEqual(imports);
      expect(prohibitedCalls(ast)).toEqual([]);
      expect(source).not.toContain("process.env");
      const httpImport = ast.statements.filter(ts.isImportDeclaration).find((s) => ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === "node:http");
      const bindings = httpImport?.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) expect(bindings.elements.filter((e) => !e.isTypeOnly).map((e) => e.name.text)).toEqual(["createServer"]);
    }
    const transport = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network prohibited"));
    const model = createLocalModel(), run = start(model); turn(model, run.trialId); model.finding(run.trialId, { finding, idem_key: randomUUID() });
    expect(transport).not.toHaveBeenCalled();
  });

  it("distinguishes regular-expression exec from actual outbound and subprocess calls", () => {
    const source = "const pattern = /x/; pattern.exec('x'); fetch('https://example.invalid'); new WebSocket('wss://example.invalid'); child.exec('command'); globalThis['fetch']('https://example.invalid');";
    expect(prohibitedCalls(ts.createSourceFile("audit.ts", source, ts.ScriptTarget.Latest, true))).toEqual(["fetch", "WebSocket", "child.exec", "globalThis['fetch']"]);
  });

  it("native import exits without listening, and explicit native CLI binds and closes on SIGTERM", async () => {
    const cwd = fileURLToPath(new URL("../", import.meta.url));
    const imported = spawn(process.execPath, ["--input-type=module", "--eval", "import './tools/precinct-local-mock.ts';"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const importExit = new Promise<number | null>((resolve, reject) => { imported.on("error", reject); imported.on("exit", resolve); });
    try { expect(await bounded(importExit)).toBe(0); } finally { imported.kill("SIGTERM"); }
    const child = spawn(process.execPath, ["tools/precinct-local-mock.ts", "--port", "0"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const exit = new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
    try {
      const origin = await bounded(new Promise<string>((resolve, reject) => {
        let output = ""; child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); const match = /Listening only at (http:\/\/127\.0\.0\.1:\d+)/.exec(output); if (match?.[1] !== undefined) resolve(match[1]); });
        child.on("error", reject); child.on("exit", () => { if (!output.includes("Listening only")) reject(new Error("CLI exited before listening")); });
      }));
      const api = createArenaApi(createApiClient({ fetch: (path, init) => fetch(`${origin}${path}`, { ...init, headers: withOrigin(init.headers) }) }));
      await api.ackEx4(); const card = (await api.listCases())[0]; if (card === undefined) throw new Error("no case");
      const run = await api.startSession({ case_id: card.case_id, mode: "assessment", voice: false, idem_key: randomUUID() });
      const ticket = await api.mintStreamTicket(run.trial_id);
      const stream = await fetch(`${origin}/api/trials/${run.trial_id}/events?ticket=${ticket}&after=0`);
      const drained = Promise.allSettled([stream.text()]);
      child.kill("SIGTERM"); expect(await bounded(exit)).toBe(0); await bounded(drained);
      await expect(fetch(`${origin}/api/me`)).rejects.toThrow();
    } finally { child.kill("SIGTERM"); }
  });

  it("normalizes only for bounds while retaining visible prose and reaching a fixpoint", () => {
    expect(localRendered("  A\r\n B\u200b ")).toBe("A B");
    expect(localRendered("<sys<system>tem>kept</system><!-- hidden -->")).toBe("kept");
    expect(localRendered("x < y and [plain] text")).toBe("x < y and [plain] text");
    expect(localRendered("Ｓｙｓｔｅｍ")).toBe("System");
  });

  it("returns a precise error type for invalid wire data", () => { expect(() => checked("turn-submit", {})).toThrow(MockRefusal); });
});
