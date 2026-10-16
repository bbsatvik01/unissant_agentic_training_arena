/** Owned local-only QA. Explicitly execute with Node only after the shared CPU lane is granted. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createLocalMock } from "./precinct-local-mock.ts";
import { SCRIPT_LINES } from "./precinct-local-model.ts";
import { createLocalSpeech, runEspeak } from "./precinct-local-speech.ts";

const browserOrigin = "http://127.0.0.1:5173";
async function client(mock: ReturnType<typeof createLocalMock>) {
  const { origin } = await mock.listen();
  const me = await (await fetch(`${origin}/api/me`)).json() as { csrf_token: string };
  return {
    origin,
    post: (path: string, body: unknown) => fetch(`${origin}${path}`, { method: "POST", headers: { Origin: browserOrigin, "Content-Type": "application/json", "X-Arena-CSRF": me.csrf_token }, body: JSON.stringify(body) }),
  };
}
function metrics(audio: Buffer) {
  assert.equal(audio.toString("ascii", 0, 4), "RIFF"); assert.equal(audio.toString("ascii", 8, 12), "WAVE");
  assert.equal(audio.readUInt32LE(4), audio.length - 8); assert.equal(audio.readUInt32LE(40), audio.length - 44);
  assert.equal(audio.readUInt32LE(24), 22_050); assert.equal(audio.readUInt16LE(22), 1); assert.equal(audio.readUInt16LE(34), 16);
  let peak = 0, squared = 0;
  for (let offset = 44; offset < audio.length; offset += 2) { const sample = audio.readInt16LE(offset) / 32768; peak = Math.max(peak, Math.abs(sample)); squared += sample * sample; }
  const frames = (audio.length - 44) / 2, rms = Math.sqrt(squared / frames), durationSeconds = frames / 22_050;
  assert.ok(peak > 0.01 && rms > 0.001); assert.ok(durationSeconds > 0 && durationSeconds < 95);
  return { bytes: audio.length, durationSeconds, peak, rms, sha256: createHash("sha256").update(audio).digest("hex") };
}
async function main() {
  const defaults = createLocalMock({ port: 0 });
  try { const { post } = await client(defaults); assert.equal((await post("/api/tts", { voice: "investigator", text: "A synthetic question." })).status, 503); }
  finally { await defaults.close(); }
  const mock = createLocalMock({ port: 0, localTts: true }), clips = [];
  try {
    const { origin, post } = await client(mock);
    const lines = [{ voice: "investigator", text: "Which record could independently corroborate that account?" },
      ...SCRIPT_LINES.map((line, index) => ({ voice: "subject:Jordan Pell", text: `[AUTHORED SCRIPTED BEAT ${String(index + 1)}/12, independent of your question] ${line} This fixed line does not interpret your question.` }))];
    for (const [index, line] of lines.entries()) {
      const response = await post("/api/tts", line);
      assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "audio/wav"); assert.equal(response.headers.get("X-Arena-Speech"), null);
      clips.push({ index, voice: line.voice, textSha256: createHash("sha256").update(line.text).digest("hex"), ...metrics(Buffer.from(await response.arrayBuffer())) });
    }
    const config = await (await fetch(`${origin}/api/config`)).json() as { voice_available: boolean; quotas: { voice_sessions_per_day: number } }; assert.equal(config.voice_available, false); assert.equal(config.quotas.voice_sessions_per_day, 0);
  } finally { await mock.close(); }
  const abort = new AbortController();
  const active = runEspeak("This is a synthetic cancellation check. ".repeat(20), abort.signal);
  abort.abort(); await assert.rejects(active, { code: "local_speech_cancelled" });
  const queue = createLocalSpeech();
  const pending = queue.speak("investigator", "This is a synthetic shutdown check. ".repeat(20), new AbortController().signal);
  const rejected = assert.rejects(pending, { code: "local_speech_closed" });
  await Promise.resolve(); await queue.close(); await rejected;
  process.stdout.write(`${JSON.stringify({ checkedAt: new Date().toISOString(), default503: true, realNativeClips: clips, voiceAvailabilityRemainsFalse: true, nativeAbortClosed: true, nativeShutdownClosed: true, browserPlaybackVerified: false, note: "Actual local API/native PCM validation only; no model, referee, microphone or remote call." }, null, 2)}\n`);
}
if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
