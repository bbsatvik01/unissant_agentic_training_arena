import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createArenaApi } from "../src/lib/api/arena";
import { createApiClient } from "../src/lib/api/client";
import { cliOptions, createLocalMock } from "./precinct-local-mock.ts";
import { MockRefusal, SCRIPT_LINES } from "./precinct-local-model.ts";
import { createLocalSpeech, ESPEAK_BINARY, ESPEAK_ROOT, finalizeSpeechWav, LOCAL_SPEAKERS, runEspeak, SPEECH_LIMITS } from "./precinct-local-speech.ts";

// No external executable runs in these tests. Native eSpeak is a separately authorized smoke check.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const spawned = vi.mocked(spawn);
const ORIGIN = "http://127.0.0.1:5173";
const signal = () => new AbortController().signal;
function wav(): Buffer {
  const raw = Buffer.alloc(48);
  raw.write("RIFF", 0); raw.writeUInt32LE(0x7fff_f024, 4); raw.write("WAVEfmt ", 8);
  raw.writeUInt32LE(16, 16); raw.writeUInt16LE(1, 20); raw.writeUInt16LE(1, 22);
  raw.writeUInt32LE(22_050, 24); raw.writeUInt32LE(44_100, 28); raw.writeUInt16LE(2, 32); raw.writeUInt16LE(16, 34);
  raw.write("data", 36); raw.writeUInt32LE(0x7fff_f000, 40); raw.writeInt16LE(1234, 44); raw.writeInt16LE(-1234, 46);
  return raw;
}
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 12345;
  readonly unref = vi.fn();
  readonly kill = vi.fn(() => { if (this.closeOnKill) queueMicrotask(() => this.emit("close", null)); return true; });
  text = "";
  closeOnKill = true;
  constructor() { super(); this.stdin.on("data", (chunk: Buffer) => { this.text += chunk.toString("utf8"); }); }
  complete(raw = wav(), code = 0) { this.stdout.write(raw); this.emit("close", code); }
}
const children: FakeChild[] = [];
const queues: ReturnType<typeof createLocalSpeech>[] = [];
const servers: ReturnType<typeof createLocalMock>[] = [];
let automaticallyComplete = false;
beforeEach(() => {
  automaticallyComplete = false;
  spawned.mockImplementation(() => {
    const child = new FakeChild(); children.push(child);
    if (automaticallyComplete) queueMicrotask(() => { child.complete(); });
    return child as unknown as ReturnType<typeof spawn>;
  });
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const queue of queues.splice(0)) await queue.close();
  children.splice(0); vi.useRealTimers(); vi.clearAllMocks();
});
function service(...args: Parameters<typeof createLocalSpeech>) { const queue = createLocalSpeech(...args); queues.push(queue); return queue; }
function latest(): FakeChild { const child = children.at(-1); if (child === undefined) throw new Error("no child"); return child; }
async function tick() { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }
async function http(localTts = true) {
  const mock = createLocalMock({ port: 0, localTts }); servers.push(mock);
  const { origin } = await mock.listen();
  const api = createArenaApi(createApiClient({ fetch: (path, init) => { const headers = new Headers(init.headers); headers.set("Origin", ORIGIN); return fetch(`${origin}${path}`, { ...init, headers }); } }));
  const me = await api.me();
  const send = (value: unknown, extra: Record<string, string> = {}, abort?: AbortSignal) => fetch(`${origin}/api/tts`, { method: "POST", headers: { Origin: ORIGIN, "X-Arena-CSRF": me.csrf_token, "Content-Type": "application/json", ...extra }, body: JSON.stringify(value), ...(abort === undefined ? {} : { signal: abort }) });
  return { mock, api, origin, send };
}

describe("bounded native eSpeak adapter", () => {
  it("normalizes streaming lengths to real mono PCM16 WAV without faking silence", () => {
    const audio = finalizeSpeechWav(wav());
    expect(audio.readUInt32LE(4)).toBe(audio.length - 8); expect(audio.readUInt32LE(40)).toBe(audio.length - 44);
    for (const raw of [Buffer.alloc(0), Buffer.alloc(45), Buffer.alloc(SPEECH_LIMITS.wavBytes + 1), Buffer.from("not audio")]) expect(() => finalizeSpeechWav(raw)).toThrow("local_speech_invalid_audio");
    const badRate = wav(); badRate.writeUInt32LE(24_000, 24); expect(() => finalizeSpeechWav(badRate)).toThrow();
    const silent = wav(); silent.fill(0, 44); expect(() => finalizeSpeechWav(silent)).toThrow();
  });

  it("passes hostile text only on stdin with literal argv, one native voice and no inherited environment", async () => {
    const text = '--voice=../../x; $(touch /tmp/nope) `id` <audio src="https://invalid/"> [[x]]';
    const pending = runEspeak(text, signal()); const child = latest();
    expect(child.text).toBe(text);
    expect(spawned).toHaveBeenCalledExactlyOnceWith(ESPEAK_BINARY,
      [`--path=${ESPEAK_ROOT}/usr/lib/x86_64-linux-gnu`, "--stdout", "--stdin", "-b", "1", "-v", "en-us", "-s", "165", "-p", "50", "-a", "100"],
      { shell: false, windowsHide: true, cwd: ESPEAK_ROOT, env: { LANG: "C.UTF-8", LD_LIBRARY_PATH: `${ESPEAK_ROOT}/usr/lib/x86_64-linux-gnu:${ESPEAK_ROOT}/lib/x86_64-linux-gnu`, ESPEAK_DATA_PATH: `${ESPEAK_ROOT}/usr/lib/x86_64-linux-gnu` }, stdio: ["pipe", "pipe", "pipe"] });
    child.complete(); expect(await pending).toEqual(finalizeSpeechWav(wav()));
    expect(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed).toBe(true);
  });

  it("enforces response and stderr limits, kills and waits for close", async () => {
    for (const kind of ["stdout", "stderr"] as const) {
      const pending = runEspeak("A synthetic line.", signal()); const result = expect(pending).rejects.toMatchObject({ status: 503, code: "local_speech_response_limit" });
      const child = latest(); child[kind].write(Buffer.alloc(kind === "stdout" ? SPEECH_LIMITS.wavBytes + 1 : SPEECH_LIMITS.stderrBytes + 1));
      await result; expect(child.kill).toHaveBeenCalledWith("SIGKILL"); expect(child.stdout.destroyed).toBe(true);
    }
  });

  it("rejects abort before launch and nonzero exit without exposing process output", async () => {
    const abort = new AbortController(); abort.abort();
    await expect(runEspeak("A", abort.signal)).rejects.toMatchObject({ status: 499 }); expect(spawned).not.toHaveBeenCalled();
    const pending = runEspeak("A", signal()); latest().stderr.write("private detail"); latest().complete(wav(), 1);
    await expect(pending).rejects.toThrow("local_speech_unavailable");
  });

  it("bounds cleanup and poisons the queue if child termination cannot be confirmed", async () => {
    vi.useFakeTimers(); const queue = service();
    const abort = new AbortController(); const first = queue.speak("investigator", "A", abort.signal);
    const firstCheck = expect(first).rejects.toThrow("local_speech_cleanup_failed");
    const secondCheck = expect(queue.speak("subject:Jordan Pell", "B", signal())).rejects.toThrow("local_speech_cleanup_failed");
    await tick(); const child = latest(); child.closeOnKill = false; abort.abort();
    await vi.advanceTimersByTimeAsync(SPEECH_LIMITS.cleanupMs); await firstCheck; await secondCheck;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL"); expect(child.unref).toHaveBeenCalledOnce();
    expect(child.stdout.destroyed && child.stderr.destroyed).toBe(true); expect(spawned).toHaveBeenCalledTimes(1);
    await expect(queue.speak("investigator", "C", signal())).rejects.toThrow("local_speech_closed");
  });
});

describe("finite serial speech queue", () => {
  it("accepts exactly public fixture voice IDs with identical settings, and refuses malformed or overlength text", async () => {
    const runner = vi.fn<(text: string, signal: AbortSignal) => Promise<Buffer>>().mockResolvedValue(wav()); const queue = service(runner);
    expect(LOCAL_SPEAKERS).toEqual(["investigator", "subject:Jordan Pell"]);
    for (const voice of LOCAL_SPEAKERS) await queue.speak(voice, "same neutral text", signal());
    expect(runner.mock.calls.map((call) => call[0])).toEqual(["same neutral text", "same neutral text"]);
    for (const voice of ["en-us", "subject:truthful", "subject:Jordan Pell;id", "__proto__", "../../x"]) await expect(queue.speak(voice, "Text", signal())).rejects.toMatchObject({ status: 422 });
    for (const text of ["", "  ", "a".repeat(901), "x\u0000y"]) await expect(queue.speak("investigator", text, signal())).rejects.toMatchObject({ status: 422 });
    await queue.speak("investigator", "🧪".repeat(900), signal()); expect(runner).toHaveBeenCalledTimes(3);
  });

  it("runs only one process and caps active plus waiting jobs without evicting them", async () => {
    const queue = service();
    const pending = Array.from({ length: SPEECH_LIMITS.pending }, (_, i) => queue.speak("investigator", `line ${String(i)}`, signal()));
    await tick(); expect(spawned).toHaveBeenCalledTimes(1);
    await expect(queue.speak("investigator", "overflow", signal())).rejects.toMatchObject({ status: 429, code: "local_speech_queue_limit" });
    for (const [index, done] of pending.entries()) {
      expect(latest().text).toBe(`line ${String(index)}`); latest().complete(); await done; await tick();
      expect(spawned).toHaveBeenCalledTimes(Math.min(index + 2, SPEECH_LIMITS.pending));
    }
  });

  it("removes queued cancellations and holds the serial slot until an aborted child closes", async () => {
    const queue = service(); const activeAbort = new AbortController(), waitingAbort = new AbortController();
    const first = queue.speak("investigator", "A", activeAbort.signal); const firstCheck = expect(first).rejects.toMatchObject({ status: 499 });
    const waitingCheck = expect(queue.speak("investigator", "B", waitingAbort.signal)).rejects.toMatchObject({ status: 499 });
    const last = queue.speak("investigator", "C", signal());
    await tick(); const child = latest(); child.closeOnKill = false;
    waitingAbort.abort(); await waitingCheck; activeAbort.abort(); await tick(); expect(spawned).toHaveBeenCalledTimes(1);
    child.emit("close", null); await firstCheck; await tick(); expect(latest().text).toBe("C");
    latest().complete(); await last; expect(spawned).toHaveBeenCalledTimes(2);
  });

  it("starts the deadline on admission, including queued time, then clears timers and abort listeners", async () => {
    vi.useFakeTimers(); const queue = service();
    const first = expect(queue.speak("investigator", "A", signal())).rejects.toMatchObject({ status: 504, code: "local_speech_deadline" });
    const second = expect(queue.speak("investigator", "B", signal())).rejects.toMatchObject({ status: 504 });
    await tick(); await vi.advanceTimersByTimeAsync(SPEECH_LIMITS.deadlineMs); await first; await second;
    expect(children[0]?.kill).toHaveBeenCalledWith("SIGKILL"); expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds both rolling-minute and total accepted requests", async () => {
    let time = 0; const runner = vi.fn<(text: string, signal: AbortSignal) => Promise<Buffer>>().mockResolvedValue(wav()); const queue = service(runner, () => time);
    for (let i = 0; i < SPEECH_LIMITS.perMinute; i += 1) await queue.speak("investigator", "A", signal());
    await expect(queue.speak("investigator", "A", signal())).rejects.toMatchObject({ status: 429, code: "local_speech_rate_limit" });
    for (let i: number = SPEECH_LIMITS.perMinute; i < SPEECH_LIMITS.total; i += 1) { time += 60_000; await queue.speak("investigator", "A", signal()); }
    time += 60_000; await expect(queue.speak("investigator", "A", signal())).rejects.toMatchObject({ status: 429 });
    expect(runner).toHaveBeenCalledTimes(SPEECH_LIMITS.total);
  });

  it("shutdown rejects queued work, kills active work, and refuses future requests", async () => {
    const queue = service();
    const checks = ["A", "B", "C"].map((text) => expect(queue.speak("investigator", text, signal())).rejects.toMatchObject({ status: 503, code: "local_speech_closed" }));
    await tick(); await queue.close(); await Promise.all(checks);
    expect(spawned).toHaveBeenCalledTimes(1); expect(latest().kill).toHaveBeenCalledWith("SIGKILL");
    await expect(queue.speak("investigator", "D", signal())).rejects.toThrow("local_speech_closed");
  });
});

describe("existing TTS wire contract and explicit opt-in", () => {
  it("retains default 503 with zero child processes and adds only the explicit boolean CLI flag", async () => {
    const { api, send } = await http(false);
    expect((await send({ voice: "investigator", text: "A" })).status).toBe(503);
    await expect(api.speak("investigator", "A")).rejects.toMatchObject({ status: 503 }); expect(spawned).not.toHaveBeenCalled();
    expect(cliOptions([])).toEqual({ port: 8080, browserOrigin: ORIGIN });
    expect(cliOptions(["--local-tts", "--port", "0"])).toEqual({ port: 0, browserOrigin: ORIGIN, localTts: true });
    for (const args of [["--local-tts", "--local-tts"], ["--local-tts", "false"], ["--espeak", "/tmp/evil"], ["--tool-root", "/tmp/evil"]]) expect(() => cliOptions(args)).toThrow("Usage:");
  });

  it("returns playable raw WAV to the unchanged API client for the actual question and all twelve authored lines", async () => {
    automaticallyComplete = true; const { api, send, origin } = await http();
    const question = "What record could independently corroborate that account?";
    const investigator = await api.speak("investigator", question);
    expect(investigator.silent).toBe(false); expect(Buffer.from(investigator.audio)).toEqual(finalizeSpeechWav(wav()));
    for (const [index, line] of SCRIPT_LINES.entries()) {
      const text = `[AUTHORED SCRIPTED BEAT ${String(index + 1)}/12, independent of your question] ${line} This fixed line does not interpret your question.`;
      const clip = await api.speak("subject:Jordan Pell", text); expect(clip.silent).toBe(false); expect(latest().text).toBe(text);
    }
    const response = await send({ voice: "investigator", text: question });
    expect(response.headers.get("content-type")).toBe("audio/wav"); expect(response.headers.get("X-Arena-Speech")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.headers.get("X-Arena-Local-Fixture")).toBe("authored-unscored-local-espeak");
    expect((await response.arrayBuffer()).byteLength).toBe(48);
    expect(await (await fetch(`${origin}/api/config`)).json()).toMatchObject({ voice_available: false, quotas: { voice_sessions_per_day: 0 } });
  });

  it("refuses schema, voice, text, body, origin, credentials and CSRF violations before synthesis", async () => {
    const { send } = await http();
    for (const value of [null, [], {}, { voice: "investigator", text: "a", extra: 1 }, { voice: "../../x", text: "a" }, { voice: "investigator", text: "a".repeat(901) }]) expect((await send(value)).status).toBe(422);
    expect((await send({ voice: "investigator", text: "a".repeat(SPEECH_LIMITS.bodyBytes) })).status).toBe(413);
    const rejectedHeaders: Record<string, string>[] = [{ Origin: "http://evil.invalid" }, { Authorization: "Bearer test-only" }, { Cookie: "test-only=yes" }, { "X-Arena-CSRF": "bad" }];
    for (const headers of rejectedHeaders) expect((await send({ voice: "investigator", text: "A" }, headers)).status).toBe(403);
    expect(spawned).not.toHaveBeenCalled();
  });

  it("HTTP disconnect kills synthesis and shutdown leaves no active child", async () => {
    const { mock, send } = await http(); const abort = new AbortController();
    const request = send({ voice: "investigator", text: "A" }, {}, abort.signal); const checked = expect(request).rejects.toThrow();
    await vi.waitFor(() => { expect(spawned).toHaveBeenCalledTimes(1); }); abort.abort(); await checked;
    await vi.waitFor(() => { expect(latest().kill).toHaveBeenCalledWith("SIGKILL"); });
    await mock.close(); expect(latest().stdout.destroyed && latest().stderr.destroyed).toBe(true);
  });

  it("keeps all runtime capability in one fixed offline process adapter", () => {
    const source = readFileSync(new URL("./precinct-local-speech.ts", import.meta.url), "utf8");
    expect(source.match(/\bspawn\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/process\.env|\bfetch\(|execFile\(|\bexec\(|\bwriteFile|node:https|node:net|node:tls|\bWebSocket\b/);
    expect(source).toContain('shell: false'); expect(source).toContain('"--stdin"'); expect(source).not.toContain('"-m"');
    const refusal = new MockRefusal(422, "invalid_request"); expect(refusal.status).toBe(422);
  });
});
