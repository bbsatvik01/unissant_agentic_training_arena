/** Explicit developer CLI only: node tools/precinct-local-mock.ts. Never imported by the app. */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checked, createLocalModel, FIXTURE_NOTICE, LIMITS, MockRefusal } from "./precinct-local-model.ts";
import { createLocalSpeech, SPEECH_LIMITS } from "./precinct-local-speech.ts";
import type { TrialFrame } from "../src/lib/contracts/generated/types.ts";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TRIAL = new RegExp(`^/api/trials/(${UUID})/(snapshot|turns|evidence-requests|finding|stream-tickets|events|recording)$`);
const SESSION = new RegExp(`^/api/sessions/(${UUID})(/debrief)?$`);
const CASE = /^\/api\/cases\/(C-[0-9A-HJKMNP-TV-Z]{8})$/;
const BROWSER_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost):([1-9][0-9]{0,4})$/;

export interface MockOptions { readonly port?: number; readonly browserOrigin?: string; readonly now?: () => number; readonly localTts?: boolean }
interface Stream { readonly trialId: string; readonly response: ServerResponse; readonly timer: ReturnType<typeof setInterval>; readonly end: ReturnType<typeof setTimeout> }
interface Ticket { readonly trialId: string; readonly expires: number }

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(value));
}
function body(request: IncomingMessage, maxBytes: number = LIMITS.bodyBytes): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let size = 0, refused = false;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > maxBytes) { refused = true; chunks.length = 0; reject(new MockRefusal(413, "request_too_large")); return; }
      chunks.push(chunk);
    });
    request.on("error", () => { reject(new MockRefusal(400, "invalid_request")); });
    request.on("aborted", () => { chunks.length = 0; reject(new MockRefusal(400, "invalid_request")); });
    request.on("end", () => {
      if (refused) return;
      if (size === 0) { resolveBody(undefined); return; }
      if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) { reject(new MockRefusal(415, "json_required")); return; }
      try { resolveBody(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown); }
      catch { reject(new MockRefusal(422, "invalid_json")); }
    });
  });
}
function noBody(value: unknown): void { if (value !== undefined) throw new MockRefusal(422, "body_not_allowed"); }
function method(request: IncomingMessage, expected: string): void { if (request.method !== expected) throw new MockRefusal(405, "method_not_allowed"); }

/** Constructs but does not listen. All resources and data are owned by this one explicit instance. */
export function createLocalMock(options: MockOptions = {}) {
  const port = options.port ?? 8080, browserOrigin = options.browserOrigin ?? "http://127.0.0.1:5173";
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("port must be an integer from 0 through 65535");
  const originMatch = BROWSER_ORIGIN.exec(browserOrigin);
  if (originMatch === null || Number(originMatch[2]) > 65_535) throw new Error("browserOrigin must be one exact loopback http origin with a port");
  const now = options.now ?? Date.now;
  const model = createLocalModel(now);
  const speechQueue = options.localTts === true ? createLocalSpeech(undefined, now) : null;
  // Synthetic process-local capabilities, not account credentials. Never logged, persisted, or set as cookies.
  const csrf = `local-fixture-${randomBytes(24).toString("hex")}`;
  const tickets = new Map<string, Ticket>();
  const streams = new Set<Stream>();
  let actualPort = port, closed = false;
  const closeStream = (stream: Stream) => { clearInterval(stream.timer); clearTimeout(stream.end); streams.delete(stream); stream.response.end(); };
  const guard = (request: IncomingMessage) => {
    const duplicate = new Set<string>();
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const key = request.rawHeaders[i]?.toLowerCase() ?? "";
      if (!["host", "origin", "x-arena-csrf", "content-type"].includes(key)) continue;
      if (duplicate.has(key)) throw new MockRefusal(400, "duplicate_header"); duplicate.add(key);
    }
    if (![ `127.0.0.1:${String(actualPort)}`, `localhost:${String(actualPort)}` ].includes(request.headers.host ?? "")) throw new MockRefusal(421, "host_refused");
    if (request.headers.authorization !== undefined || request.headers.cookie !== undefined) throw new MockRefusal(403, "local_fixture_no_credentials");
    const origin = request.headers.origin;
    const allowed = [browserOrigin, `http://127.0.0.1:${String(actualPort)}`, `http://localhost:${String(actualPort)}`];
    if (request.headers["sec-fetch-site"] === "cross-site" || (origin !== undefined && !allowed.includes(origin))) throw new MockRefusal(403, "origin_refused");
    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
      if (origin === undefined || !allowed.includes(origin)) throw new MockRefusal(403, "origin_refused");
      if (request.headers["x-arena-csrf"] !== csrf) throw new MockRefusal(403, "csrf_refused");
    }
  };
  const writeFrame = (response: ServerResponse, frame: TrialFrame) => {
    const raw = JSON.stringify(frame);
    if (Buffer.byteLength(raw) > 16_384) throw new Error("fixture emitted an oversized SSE frame");
    return response.write(`${frame.seq === null ? "" : `id: ${String(frame.seq)}\n`}data: ${raw}\n\n`);
  };
  model.setFrameListener((run, frames) => {
    for (const stream of streams) {
      if (stream.trialId !== run.trialId) continue;
      for (const frame of frames) { if (!writeFrame(stream.response, frame) || frame.type === "debrief.ready") { closeStream(stream); break; } }
    }
  });
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    guard(request);
    const raw = request.url ?? "";
    if (!/^\/api\/[A-Za-z0-9/-]+(?:\?[A-Za-z0-9_=&%-]+)?$/.test(raw)) throw new MockRefusal(404, "not_found");
    const url = new URL(raw, `http://127.0.0.1:${String(actualPort)}`), path = url.pathname;
    const trial = TRIAL.exec(path), session = SESSION.exec(path), oneCase = CASE.exec(path);
    const simple = ["/api/me", "/api/me/ack-ex4", "/api/config", "/api/cases", "/api/sessions", "/api/progress", "/api/telemetry/kpi4", "/api/telemetry/contract-violation", "/api/tts", "/api/voice/tickets", "/api/voice/ws"];
    if (!simple.includes(path) && trial === null && session === null && oneCase === null) throw new MockRefusal(404, "not_found");
    if (trial?.[2] !== "events" && url.search !== "") throw new MockRefusal(422, "unexpected_query");
    const post = path === "/api/sessions" || ["/api/me/ack-ex4", "/api/telemetry/kpi4", "/api/telemetry/contract-violation", "/api/tts", "/api/voice/tickets"].includes(path) || ["turns", "evidence-requests", "finding", "stream-tickets"].includes(trial?.[2] ?? "");
    if (session?.[2] === "/debrief") { if (request.method !== "GET" && request.method !== "POST") throw new MockRefusal(405, "method_not_allowed"); }
    else method(request, post ? "POST" : "GET");
    const value = await body(request, path === "/api/tts" && speechQueue !== null ? SPEECH_LIMITS.bodyBytes : LIMITS.bodyBytes);
    if (request.method === "GET") noBody(value);
    if (path === "/api/me") { json(response, 200, model.me(csrf)); return; }
    if (path === "/api/me/ack-ex4") { noBody(value); json(response, 200, model.acknowledge()); return; }
    if (path === "/api/config") { json(response, 200, { voice_available: false, exhibition_enabled: false, phoenix_url: null, question_max_chars: 600, paused: false, quotas: { text_sessions_per_day: LIMITS.runs, voice_sessions_per_day: 0 }, planned_n: 0 }); return; }
    if (path === "/api/cases") { json(response, 200, { cases: [model.card] }); return; }
    if (oneCase !== null) {
      if (oneCase[1] !== model.card.case_id) throw new MockRefusal(404, "not_found");
      json(response, 200, { case: model.card, brief: { initial_documents: model.packet.initial_documents } }); return;
    }
    if (path === "/api/sessions") { json(response, 200, model.start(value)); return; }
    if (path === "/api/progress") { json(response, 200, model.progress()); return; }
    if (session !== null) {
      const run = model.requireSession(session[1] ?? "");
      if (session[2] === undefined) { json(response, 200, model.session(run)); return; }
      noBody(value);
      response.setHeader("X-Arena-Local-Fixture", "authored-unscored-no-referee");
      if (request.method === "POST") { json(response, 200, model.publishDebrief(run.sessionId)); return; }
      json(response, 200, checked("debrief-read", run.debrief ?? { status: "scoring" })); return;
    }
    if (path === "/api/voice/tickets") { checked("voice-ticket-request", value); throw new MockRefusal(503, "local_voice_unavailable"); }
    if (path === "/api/tts") {
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new MockRefusal(422, "invalid_request");
      const speech = value as Record<string, unknown>;
      if (Object.keys(speech).sort().join(",") !== "text,voice" || typeof speech["voice"] !== "string" || Array.from(speech["voice"]).length < 1 || Array.from(speech["voice"]).length > 40 || typeof speech["text"] !== "string" || Array.from(speech["text"]).length < 1 || Array.from(speech["text"]).length > 900) throw new MockRefusal(422, "invalid_request");
      if (speechQueue === null) throw new MockRefusal(503, "local_voice_unavailable");
      const controller = new AbortController();
      const disconnect = () => { if (!response.writableEnded) controller.abort(); };
      response.on("close", disconnect);
      if (request.readableAborted || response.destroyed) controller.abort();
      try {
        const audio = await speechQueue.speak(speech["voice"], speech["text"], controller.signal);
        if (response.destroyed) return;
        response.writeHead(200, { "content-type": "audio/wav", "content-length": audio.length, "cache-control": "no-store", "x-content-type-options": "nosniff", "X-Arena-Local-Fixture": "authored-unscored-local-espeak" });
        response.end(audio);
      } finally { response.removeListener("close", disconnect); }
      return;
    }
    if (path === "/api/voice/ws") throw new MockRefusal(503, "local_voice_unavailable");
    if (path === "/api/telemetry/kpi4") {
      const ack = checked("card-ack", value); const run = model.requireRun(ack.trial_id);
      if (run.snapshot.mode !== "practice" || !run.snapshot.cards.some((c) => c.turn_no === ack.turn_no)) throw new MockRefusal(422, "invalid_request");
      json(response, 200, null); return;
    }
    if (path === "/api/telemetry/contract-violation") {
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new MockRefusal(422, "invalid_request");
      const report = value as Record<string, unknown>;
      if (Object.keys(report).sort().join(",") !== "frame_type,reason,seq,trial_id" || typeof report["trial_id"] !== "string" || typeof report["frame_type"] !== "string" || report["frame_type"].length > 80 || typeof report["reason"] !== "string" || report["reason"].length > 300 || !(report["seq"] === null || (Number.isSafeInteger(report["seq"]) && Number(report["seq"]) >= 0))) throw new MockRefusal(422, "invalid_request");
      model.requireRun(report["trial_id"]); json(response, 200, null); return;
    }
    if (trial === null) throw new MockRefusal(404, "not_found");
    const id = trial[1] ?? "", action = trial[2], run = model.requireRun(id);
    if (action === "snapshot") { json(response, 200, checked("snapshot", run.snapshot)); return; }
    if (action === "recording") { json(response, 200, model.recording(id)); return; }
    if (action === "turns") { json(response, 200, model.turn(id, value)); return; }
    if (action === "evidence-requests") { json(response, 200, model.evidence(id, value)); return; }
    if (action === "finding") { json(response, 200, model.finding(id, value)); return; }
    if (action === "stream-tickets") {
      noBody(value);
      if (run.debrief !== null) throw new MockRefusal(409, "stream_closed");
      for (const [key, ticket] of tickets) if (ticket.expires <= now()) tickets.delete(key);
      if (tickets.size >= LIMITS.tickets) throw new MockRefusal(429, "local_fixture_ticket_limit");
      const ticket = randomBytes(32).toString("hex"); tickets.set(ticket, { trialId: id, expires: now() + LIMITS.ticketMs });
      json(response, 200, { ticket, expires_in_s: 60 }); return;
    }
    noBody(value);
    const keys = [...url.searchParams.keys()];
    if (keys.some((key) => key !== "ticket" && key !== "after") || new Set(keys).size !== keys.length) throw new MockRefusal(422, "invalid_request");
    const ticketValue = url.searchParams.get("ticket") ?? "", afterValue = url.searchParams.get("after") ?? "0";
    if (!/^[0-9a-f]{64}$/.test(ticketValue) || !/^(0|[1-9][0-9]*)$/.test(afterValue) || !Number.isSafeInteger(Number(afterValue))) throw new MockRefusal(422, "invalid_request");
    const ticket = tickets.get(ticketValue); tickets.delete(ticketValue);
    if (ticket === undefined || ticket.trialId !== id || ticket.expires <= now()) throw new MockRefusal(401, "ticket_refused");
    if (streams.size >= LIMITS.streams) throw new MockRefusal(429, "local_fixture_stream_limit");
    const after = Number(afterValue);
    if (after > run.snapshot.last_seq) throw new MockRefusal(422, "invalid_cursor");
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no", "x-content-type-options": "nosniff" });
    response.write(": local scripted fixture; no model, coaching, referee, or score\n\n");
    for (const event of run.events) if (event.frame.seq !== null && event.frame.seq > after && !writeFrame(response, event.frame)) { response.end(); return; }
    if (run.debrief !== null) { response.end(); return; }
    const stream: Stream = { trialId: id, response, timer: setInterval(() => { if (!response.write(": ping\n\n")) closeStream(stream); }, 15_000), end: setTimeout(() => { closeStream(stream); }, LIMITS.streamMs) };
    streams.add(stream); response.on("close", () => { clearInterval(stream.timer); clearTimeout(stream.end); streams.delete(stream); });
  };
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 10_000, keepAliveTimeout: 1000 }, (request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.destroyed) return;
      if (response.headersSent) { response.destroy(); return; }
      response.setHeader("connection", "close");
      json(response, error instanceof MockRefusal ? error.status : 500, { code: error instanceof MockRefusal ? error.code : "local_fixture_failure", detail: FIXTURE_NOTICE });
    });
  });
  server.maxConnections = 32;
  server.on("upgrade", (request, socket) => {
    let status = 503;
    try { guard(request); if (request.url !== "/api/voice/ws") status = 404; }
    catch (error) { status = error instanceof MockRefusal ? error.status : 500; }
    socket.end(`HTTP/1.1 ${String(status)} Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });
  return {
    server,
    async listen() {
      if (closed || server.listening) throw new Error("fixture instance cannot be started twice");
      await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolveListen(); }); });
      const address = server.address(); if (address === null || typeof address === "string") throw new Error("fixture did not bind loopback TCP");
      actualPort = address.port; return { port: actualPort, origin: `http://127.0.0.1:${String(actualPort)}` };
    },
    async close() {
      closed = true;
      for (const stream of streams) closeStream(stream);
      tickets.clear(); model.dispose();
      await speechQueue?.close();
      if (server.listening) { server.closeAllConnections(); await new Promise<void>((resolveClose, reject) => { server.close((error) => { if (error === undefined) resolveClose(); else reject(error); }); }); }
    },
  };
}

/** CLI parsing has no side effects. There is deliberately no host option. */
export function cliOptions(args: readonly string[]): MockOptions {
  let port = 8080, browserOrigin = "http://127.0.0.1:5173", localTts = false;
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (key === "--local-tts" && !localTts) { localTts = true; continue; }
    const value = args[++i];
    if (key === "--port" && value !== undefined && /^\d{1,5}$/.test(value)) port = Number(value);
    else if (key === "--browser-origin" && value !== undefined) browserOrigin = value;
    else throw new Error("Usage: node tools/precinct-local-mock.ts [--port 8080] [--browser-origin http://127.0.0.1:5173] [--local-tts]");
  }
  return { port, browserOrigin, ...(localTts ? { localTts: true } : {}) };
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const options = cliOptions(process.argv.slice(2));
  const mock = createLocalMock(options);
  const address = await mock.listen();
  process.stdout.write(`${FIXTURE_NOTICE}\n${options.localTts === true ? "Optional local eSpeak playback enabled. This remains an unscored TEXT rehearsal, not live AI voice.\n" : ""}Listening only at ${address.origin}. Ctrl-C erases all in-memory runs.\n`);
  const close = () => { void mock.close().catch(() => { process.exitCode = 1; }); };
  process.once("SIGINT", close); process.once("SIGTERM", close);
}
