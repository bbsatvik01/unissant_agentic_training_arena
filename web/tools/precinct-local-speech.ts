/** Opt-in local formant speech for the unscored TEXT fixture. Never imported by browser code. */
import { spawn } from "node:child_process";
import { MockRefusal } from "./precinct-local-model.ts";

// Authenticated Debian eSpeak NG 1.52.0 installation, external to this repository. No PATH lookup,
// executable flag/environment override, shell, inherited credentials, network client, or output file.
export const ESPEAK_ROOT = "/workspace/shared/creative-tools/espeak-ng/root";
export const ESPEAK_BINARY = `${ESPEAK_ROOT}/usr/bin/espeak-ng`;
const DATA_PARENT = `${ESPEAK_ROOT}/usr/lib/x86_64-linux-gnu`;
export const SPEECH_LIMITS = { bodyBytes: 8192, chars: 900, pending: 4, perMinute: 48, total: 256, deadlineMs: 10_000, cleanupMs: 1000, wavBytes: 4 * 1024 * 1024, stderrBytes: 4096 } as const;
/** Only public speakers in this fixture. Identical native en-us settings are independent of truth/role. */
export const LOCAL_SPEAKERS: readonly string[] = Object.freeze(["investigator", "subject:Jordan Pell"]);

/** eSpeak's stdout RIFF uses placeholder lengths. Finalize exactly the bounded mono PCM actually received. */
export function finalizeSpeechWav(raw: Buffer): Buffer {
  if (raw.length <= 44 || raw.length > SPEECH_LIMITS.wavBytes || (raw.length - 44) % 2 !== 0 ||
      raw.toString("ascii", 0, 4) !== "RIFF" || raw.toString("ascii", 8, 12) !== "WAVE" ||
      raw.toString("ascii", 12, 16) !== "fmt " || raw.readUInt32LE(16) !== 16 ||
      raw.readUInt16LE(20) !== 1 || raw.readUInt16LE(22) !== 1 || raw.readUInt32LE(24) !== 22_050 ||
      raw.readUInt32LE(28) !== 44_100 || raw.readUInt16LE(32) !== 2 || raw.readUInt16LE(34) !== 16 ||
      raw.toString("ascii", 36, 40) !== "data") throw new MockRefusal(503, "local_speech_invalid_audio");
  let peak = 0;
  for (let offset = 44; offset < raw.length; offset += 2) peak = Math.max(peak, Math.abs(raw.readInt16LE(offset)));
  if (peak < 32) throw new MockRefusal(503, "local_speech_invalid_audio");
  raw.writeUInt32LE(raw.length - 8, 4); raw.writeUInt32LE(raw.length - 44, 40);
  return raw;
}

function abortReason(signal: AbortSignal): MockRefusal {
  return signal.reason instanceof MockRefusal ? signal.reason : new MockRefusal(499, "local_speech_cancelled");
}

/** One fixed process, with UTF-8 text on stdin (never argv). Resolves only after the process closes. */
export function runEspeak(text: string, signal: AbortSignal): Promise<Buffer> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const child = spawn(ESPEAK_BINARY, [`--path=${DATA_PARENT}`, "--stdout", "--stdin", "-b", "1", "-v", "en-us", "-s", "165", "-p", "50", "-a", "100"], {
      shell: false, windowsHide: true, cwd: ESPEAK_ROOT,
      env: { LANG: "C.UTF-8", LD_LIBRARY_PATH: `${DATA_PARENT}:${ESPEAK_ROOT}/lib/x86_64-linux-gnu`, ESPEAK_DATA_PATH: DATA_PARENT },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0, stderrBytes = 0, finished = false;
    let failure: MockRefusal | null = null;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: MockRefusal | null) => {
      if (finished) return;
      finished = true; clearTimeout(cleanupTimer); signal.removeEventListener("abort", abort);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (error !== null) { chunks.length = 0; reject(error); return; }
      try { resolve(finalizeSpeechWav(Buffer.concat(chunks, bytes))); }
      catch { reject(new MockRefusal(503, "local_speech_invalid_audio")); }
      chunks.length = 0;
    };
    const stop = (error: MockRefusal) => {
      if (finished || failure !== null) return;
      failure = error; chunks.length = 0;
      child.stdin.destroy(); child.kill("SIGKILL");
      // Never launch a replacement if termination cannot be confirmed. The queue fails closed.
      cleanupTimer = setTimeout(() => { child.unref(); finish(new MockRefusal(503, "local_speech_cleanup_failed")); }, SPEECH_LIMITS.cleanupMs);
    };
    const abort = () => { stop(abortReason(signal)); };
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", () => {
      const error = new MockRefusal(503, "local_speech_unavailable");
      if (child.pid === undefined) finish(error);
      else stop(error);
    });
    child.stdin.on("error", () => { stop(new MockRefusal(503, "local_speech_unavailable")); });
    child.stdout.on("error", () => { stop(new MockRefusal(503, "local_speech_unavailable")); });
    child.stderr.on("error", () => { stop(new MockRefusal(503, "local_speech_unavailable")); });
    child.stdout.on("data", (chunk: Buffer) => {
      if (finished || failure !== null) return;
      bytes += chunk.length;
      if (bytes > SPEECH_LIMITS.wavBytes) { stop(new MockRefusal(503, "local_speech_response_limit")); return; }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > SPEECH_LIMITS.stderrBytes) stop(new MockRefusal(503, "local_speech_response_limit"));
    });
    child.on("close", (code: number | null) => { finish(failure ?? (code === 0 ? null : new MockRefusal(503, "local_speech_unavailable"))); });
    if (signal.aborted) abort();
    else child.stdin.end(text, "utf8");
  });
}

type Runner = (text: string, signal: AbortSignal) => Promise<Buffer>;
interface Job {
  readonly text: string;
  readonly controller: AbortController;
  readonly resolve: (audio: Buffer) => void;
  readonly reject: (error: unknown) => void;
  readonly cleanup: () => void;
}

/** One serial child across this instance, four total pending jobs, finite rate/lifetime/deadline. */
export function createLocalSpeech(runner: Runner = runEspeak, now: () => number = Date.now) {
  const queue: Job[] = [];
  const recent: number[] = [];
  let active: { readonly job: Job; readonly done: Promise<void> } | null = null;
  let closed = false, accepted = 0;
  const discard = (job: Job, error: MockRefusal) => { job.cleanup(); job.reject(error); };
  const pump = () => {
    if (closed || active !== null) return;
    const job = queue.shift();
    if (job === undefined) return;
    const done = Promise.resolve().then(() => {
      if (job.controller.signal.aborted) throw abortReason(job.controller.signal);
      return runner(job.text, job.controller.signal);
    }).then((audio) => {
      if (job.controller.signal.aborted) job.reject(abortReason(job.controller.signal));
      else job.resolve(audio);
    }, (error: unknown) => {
      if (error instanceof MockRefusal && error.code === "local_speech_cleanup_failed") {
        closed = true;
        for (const waiting of queue.splice(0)) discard(waiting, error);
      }
      job.reject(error instanceof MockRefusal ? error : new MockRefusal(503, "local_speech_unavailable"));
    }).finally(() => { job.cleanup(); active = null; pump(); });
    active = { job, done };
  };
  return {
    speak(voice: string, text: string, signal: AbortSignal): Promise<Buffer> {
      if (!LOCAL_SPEAKERS.includes(voice) || Array.from(text).length > SPEECH_LIMITS.chars || text.trim().length === 0 || text.includes("\u0000")) return Promise.reject(new MockRefusal(422, "invalid_request"));
      if (closed) return Promise.reject(new MockRefusal(503, "local_speech_closed"));
      if (signal.aborted) return Promise.reject(abortReason(signal));
      if (queue.length + (active === null ? 0 : 1) >= SPEECH_LIMITS.pending) return Promise.reject(new MockRefusal(429, "local_speech_queue_limit"));
      const time = now();
      while (recent[0] !== undefined && recent[0] <= time - 60_000) recent.shift();
      if (recent.length >= SPEECH_LIMITS.perMinute || accepted >= SPEECH_LIMITS.total) return Promise.reject(new MockRefusal(429, "local_speech_rate_limit"));
      recent.push(time); accepted += 1;
      return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const cancel = (error: MockRefusal) => {
          controller.abort(error);
          const index = queue.indexOf(job);
          if (index !== -1) { queue.splice(index, 1); discard(job, error); }
        };
        const abort = () => { cancel(abortReason(signal)); };
        const timer = setTimeout(() => { cancel(new MockRefusal(504, "local_speech_deadline")); }, SPEECH_LIMITS.deadlineMs);
        const job: Job = { text, controller, resolve, reject, cleanup: () => { clearTimeout(timer); signal.removeEventListener("abort", abort); } };
        signal.addEventListener("abort", abort, { once: true }); queue.push(job);
        if (signal.aborted) abort();
        pump();
      });
    },
    async close(): Promise<void> {
      closed = true;
      const error = new MockRefusal(503, "local_speech_closed");
      for (const job of queue.splice(0)) discard(job, error);
      active?.job.controller.abort(error);
      await active?.done;
      recent.length = 0;
    },
  };
}
