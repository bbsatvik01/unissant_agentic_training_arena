/** QA-only actual scene+WebAudio recording. No microphone, tab/system capture, overdub or synthesized frames. */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect, type Browser, type BrowserContext, type JSHandle, type Page } from "@playwright/test";
import type { Mesh } from "three";
import { createLocalMock } from "./precinct-local-mock.ts";
import { SCRIPT_LINES } from "./precinct-local-model.ts";
interface SpeechMorphSample { mesh: string; name: string; value: number }
interface RehearsalSceneSample { frame: number; canvasWidth: number; canvasHeight: number; mouthMax: number; morphCount: number; speechMorphs: SpeechMorphSample[]; contextLost: boolean }

interface OverviewScene { frame: number; width: number; height: number; canvasWidth: number; canvasHeight: number; x: number; y: number; z: number; forwardZ: number; courtyard: boolean; contextLost: boolean }
interface OverviewStill { path: string; sha256: string; description: string; scene: OverviewScene }
interface AudioContextDiagnostic { id: number; createdAtMs: number; creator: string; state: AudioContextState; sampleRate: number; currentTime: number; outputTees: number; sourceCount: number; starts: number; ended: number; states: { atMs: number; state: AudioContextState }[] }
interface AudioDiagnostics { observedContexts: number; observedSources: number; truncated: boolean; contexts: AudioContextDiagnostic[] }
interface AudioSample { contextCount: number; starts: number; ended: number; active: number; rms: number; peak: number; recording: boolean; error: string | null }
interface Recording { base64: string; mime: string; bytes: number; elapsedMs: number; samples: { at: number; audio: AudioSample; scene: RehearsalSceneSample }[]; timedOut: boolean }
interface MouthObservation { pageTimeMs: number; audio: AudioSample; scene: RehearsalSceneSample }
interface Harness { diagnostics: () => AudioDiagnostics; start: () => void; scene: () => RehearsalSceneSample; sample: () => AudioSample; stop: () => Promise<Recording>; dispose: () => Promise<void> }
const CAPTURE_MS = 50_000;
const QUIET_MOUTH_MAX = 0.00001;
const ACTIVE_SIGNAL_MIN = 0.0001;
const MORPH_CHANGE_MIN = 0.01;
const MIN_ACTIVE_FRAMES = 5;
const MIN_CHANGED_FRAME_PAIRS = 2;
const SETTLE_MS = 5000;
const QUESTION = "Which record could independently corroborate that account?";
const FIXTURE_TITLE = "Local scripted fixture: Records vault entry during a busy shift";
const BEAT = `[AUTHORED SCRIPTED BEAT 1/12, independent of your question] ${SCRIPT_LINES[0]} This fixed line does not interpret your question.`;
const message = (error: unknown) => error instanceof Error ? error.stack ?? error.message : String(error);
function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error(label)); }, milliseconds); })]).finally(() => { clearTimeout(timer); });
}

/** Installed before the app constructs its first room context. Retains native receiver/args/results. */
async function installCapture(page: Page): Promise<JSHandle<Harness>> {
  return page.evaluateHandle(async ({ captureMs }) => {
    const module = await import("@react-three/fiber");
    const readScene = (): RehearsalSceneSample => {
      const canvas = document.querySelector("canvas");
      if (canvas === null) throw new Error("No actual scene canvas.");
      const root = module._roots.get(canvas);
      if (root === undefined) throw new Error("QA handle does not own the actual R3F root; duplicate registries are refused.");
      const state = root.store.getState(), subject = state.scene.getObjectByName("precinct-cast:Jordan Pell");
      if (subject === undefined) throw new Error("Actual authored subject mesh is not ready.");
      const names = ["AA_VI_10_aa", "AA_VI_11_E", "AA_VI_12_I", "AA_VI_13_O", "AA_VI_14_U", "AA_VI_07_SS", "AK_25_JawOpen"];
      let mouthMax = 0, morphCount = 0;
      const speechMorphs: SpeechMorphSample[] = [];
      subject.traverse((node) => {
        const mesh = node as Mesh;
        if (mesh.morphTargetDictionary === undefined || mesh.morphTargetInfluences === undefined) return;
        for (const name of names) {
          const index = mesh.morphTargetDictionary[name];
          if (index === undefined) continue;
          const value = mesh.morphTargetInfluences[index];
          if (value === undefined) continue;
          if (!Number.isFinite(value)) throw new Error("Non-finite actual speech morph value.");
          speechMorphs.push({ mesh: mesh.uuid, name, value });
          morphCount += 1; mouthMax = Math.max(mouthMax, Math.abs(value));
        }
      });
      if (morphCount < names.length || new Set(speechMorphs.map((morph) => morph.name)).size !== names.length) throw new Error("All seven actual subject speech morph names are required.");
      return { frame: state.gl.info.render.frame, canvasWidth: canvas.width, canvasHeight: canvas.height, mouthMax, morphCount, speechMorphs, contextLost: state.gl.getContext().isContextLost() };
    };
    const NativeContext = window.AudioContext;
    const originalConnect = Reflect.get(AudioNode.prototype, "connect") as (this: AudioNode, ...args: unknown[]) => unknown;
    const connectDescriptor = Object.getOwnPropertyDescriptor(AudioNode.prototype, "connect");
    if (connectDescriptor === undefined) throw new Error("Missing native connect descriptor.");
    const contexts: { context: AudioContext; destination: MediaStreamAudioDestinationNode; analyser: AnalyserNode; createdAtMs: number; creator: string; states: { atMs: number; state: AudioContextState }[]; onState: () => void }[] = [];
    const tees: { from: AudioNode; to: AnalyserNode }[] = [];
    const sources: { node: AudioBufferSourceNode; started: boolean; ended: boolean; restore: () => void; onEnd: () => void }[] = [];
    const originalCreate = Reflect.get(AudioContext.prototype, "createBufferSource");
    let error: string | null = null, recorder: MediaRecorder | null = null, stream: MediaStream | null = null;
    let startedAt = 0, totalBytes = 0, timedOut = false, disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined, sampling: ReturnType<typeof setInterval> | undefined;
    let result: Promise<Recording> | null = null;
    const chunks: Blob[] = [], samples: Recording["samples"] = [];
    const connect = (from: AudioNode, to: AudioNode) => { Reflect.apply(originalConnect, from, [to]); };
    const observedContext = new Proxy(NativeContext, {
      construct(target, args: unknown[]) {
        const context = Reflect.construct(target, args) as AudioContext;
        if (contexts.length > 0) error = "More than one page-owned audio context; capture refuses ambiguous mixing.";
        const destination = context.createMediaStreamDestination(), analyser = context.createAnalyser();
        analyser.fftSize = 1024; connect(analyser, destination);
        const createdAtMs = performance.now(), creator = (new Error("Observed native AudioContext construction").stack ?? "Stack unavailable").slice(0, 2000);
        const states = [{ atMs: createdAtMs, state: context.state }];
        const onState = () => { if (states.length < 16) states.push({ atMs: performance.now(), state: context.state }); };
        context.addEventListener("statechange", onState);
        contexts.push({ context, destination, analyser, createdAtMs, creator, states, onState }); return context;
      },
    });
    window.AudioContext = observedContext;
    const patchedConnect = function (this: AudioNode, ...args: unknown[]): unknown {
      const value: unknown = Reflect.apply(originalConnect, this, args);
      const destination = args[0];
      const tracked = contexts.find((entry) => entry.context === this.context);
      if (tracked !== undefined && destination === tracked.context.destination && !tees.some((edge) => edge.from === this)) {
        connect(this, tracked.analyser); tees.push({ from: this, to: tracked.analyser });
      }
      return value;
    };
    Object.defineProperty(AudioNode.prototype, "connect", { configurable: true, writable: true, value: patchedConnect });
    AudioContext.prototype.createBufferSource = function (this: AudioContext) {
      const node = Reflect.apply(originalCreate, this, []);
      const originalStart = Reflect.get(node, "start");
      const record = { node, started: false, ended: false, restore: () => { node.start = originalStart; }, onEnd: () => { record.ended = true; } };
      node.start = function (...args: Parameters<AudioBufferSourceNode["start"]>) { Reflect.apply(originalStart, node, args); record.started = true; };
      node.addEventListener("ended", record.onEnd); sources.push(record); return node;
    };
    const sample = (): AudioSample => {
      let squared = 0, peak = 0, count = 0;
      for (const entry of contexts) {
        const data = new Float32Array(entry.analyser.fftSize); entry.analyser.getFloatTimeDomainData(data);
        for (const value of data) { squared += value * value; peak = Math.max(peak, Math.abs(value)); count += 1; }
      }
      return { contextCount: contexts.length, starts: sources.filter((source) => source.started).length, ended: sources.filter((source) => source.started && source.ended).length,
        active: sources.filter((source) => source.started && !source.ended).length, rms: count === 0 ? 0 : Math.sqrt(squared / count), peak, recording: recorder?.state === "recording", error };
    };
    const diagnostics = (): AudioDiagnostics => ({ observedContexts: contexts.length, observedSources: sources.length,
      truncated: contexts.length > 8 || contexts.some((entry) => entry.states.length >= 16),
      contexts: contexts.slice(0, 8).map((entry, id) => {
        const ownSources = sources.filter((source) => source.node.context === entry.context);
        return { id, createdAtMs: entry.createdAtMs, creator: entry.creator, state: entry.context.state, sampleRate: entry.context.sampleRate, currentTime: entry.context.currentTime,
          outputTees: tees.filter((edge) => edge.from.context === entry.context).length, sourceCount: ownSources.length,
          starts: ownSources.filter((source) => source.started).length, ended: ownSources.filter((source) => source.started && source.ended).length, states: entry.states.slice() };
      }) });
    const cleanupTracks = () => { for (const track of stream?.getTracks() ?? []) track.stop(); };
    const stop = async (): Promise<Recording> => {
      clearTimeout(timer); clearInterval(sampling);
      if (recorder === null || result === null) throw new Error("Recorder never started.");
      if (recorder.state !== "inactive") recorder.stop();
      try { return await result; } finally { cleanupTracks(); }
    };
    return {
      scene: readScene,
      sample,
      diagnostics,
      start() {
        if (recorder !== null || disposed) throw new Error("Capture can start once.");
        const canvas = document.querySelector("canvas"), entry = contexts[0];
        if (canvas === null || entry === undefined || contexts.length !== 1 || entry.context.state !== "running" || error !== null) throw new Error("Scene/native room audio is not ready.");
        readScene();
        const mime = ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus"].find((value) => MediaRecorder.isTypeSupported(value));
        if (mime === undefined) throw new Error("No native WebM audio/video recorder available.");
        const video = canvas.captureStream(20);
        stream = new MediaStream([...video.getVideoTracks(), ...entry.destination.stream.getAudioTracks()]);
        if (stream.getVideoTracks().length !== 1 || stream.getAudioTracks().length !== 1) throw new Error("Capture requires exactly one real scene track and one actual audio output track.");
        recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 1_800_000, audioBitsPerSecond: 128_000 });
        const current = recorder;
        result = new Promise<Recording>((resolveResult, reject) => {
          current.addEventListener("error", () => { error = "Native recording failed."; reject(new Error(error)); cleanupTracks(); }, { once: true });
          current.addEventListener("dataavailable", (event: BlobEvent) => {
            totalBytes += event.data.size;
            if (totalBytes > 16 * 1024 * 1024) { error = "Recording exceeded 16 MiB."; if (current.state !== "inactive") current.stop(); return; }
            if (event.data.size > 0) chunks.push(event.data);
          });
          current.addEventListener("stop", () => {
            clearTimeout(timer); clearInterval(sampling); cleanupTracks();
            if (error !== null) { chunks.length = 0; reject(new Error(error)); return; }
            const elapsedMs = performance.now() - startedAt;
            void new Blob(chunks, { type: mime }).arrayBuffer().then((buffer) => {
              const bytes = new Uint8Array(buffer); let binary = "";
              for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
              chunks.length = 0; resolveResult({ base64: btoa(binary), mime, bytes: bytes.length, elapsedMs, samples, timedOut });
            }, reject);
          }, { once: true });
        });
        void result.catch(() => undefined);
        startedAt = performance.now(); current.start(250);
        sampling = setInterval(() => {
          try {
            if (samples.length >= 520) throw new Error("Capture sample bound exceeded.");
            samples.push({ at: performance.now() - startedAt, audio: sample(), scene: readScene() });
          } catch (failure) { error = String(failure); if (current.state !== "inactive") current.stop(); }
        }, 100);
        timer = setTimeout(() => { timedOut = true; if (current.state !== "inactive") current.stop(); }, captureMs);
      },
      stop,
      async dispose() {
        if (disposed) return;
        disposed = true; clearTimeout(timer); clearInterval(sampling);
        try { if (recorder !== null) await stop(); }
        finally {
          cleanupTracks();
          for (const source of sources) { if (source.started && !source.ended) { try { source.node.stop(); } catch { /* Native source may already have ended. */ } } source.node.removeEventListener("ended", source.onEnd); source.restore(); }
          for (const tee of tees) { try { tee.from.disconnect(tee.to); } catch { /* App cleanup may already have disconnected this tee. */ } }
          for (const entry of contexts) { entry.analyser.disconnect(); entry.destination.disconnect(); if (entry.context.state !== "closed") await entry.context.close(); entry.context.removeEventListener("statechange", entry.onState); }
          Object.defineProperty(AudioNode.prototype, "connect", connectDescriptor); AudioContext.prototype.createBufferSource = originalCreate; window.AudioContext = NativeContext;
          chunks.length = 0;
        }
      },
    };
  }, { captureMs: CAPTURE_MS });
}

async function guards(context: BrowserContext, origin: string, blocked: string[], violations: string[]): Promise<void> {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname.startsWith("/api/voice")) { blocked.push(`${url.origin}${url.pathname}`); await route.abort("blockedbyclient"); return; }
    await route.continue();
  });
  await context.routeWebSocket("**/*", (socket) => {
    const url = new URL(socket.url());
    if (url.protocol === "ws:" && url.host === new URL(origin).host && !url.pathname.startsWith("/api/")) socket.connectToServer();
    else { blocked.push(`${url.origin}${url.pathname}`); void socket.close({ code: 1008, reason: "Only same-origin development HMR allowed." }).catch((error: unknown) => { violations.push(message(error)); }); }
  });
  await context.addInitScript(() => {
    const refuse = (name: string): never => { console.error(`REHEARSAL_CAPTURE_REFUSED:${name}`); throw new Error(`Capture refused ${name}`); };
    const devices = Reflect.get(navigator, "mediaDevices") as MediaDevices | undefined;
    if (devices !== undefined) { devices.getUserMedia = () => refuse("microphone"); devices.getDisplayMedia = () => refuse("display/system capture"); }
    if (typeof speechSynthesis !== "undefined") speechSynthesis.speak = () => { refuse("browser fallback synthesis"); };
    HTMLMediaElement.prototype.play = () => refuse("media-element playback");
  });
}

/** Literal import resolves to the exact already-loaded Vite module, including its query identity. */
async function mapLoadedFiber(page: Page, loadedUrl: string, origin: string): Promise<void> {
  await page.evaluate(({ loadedUrl, origin }) => {
    const specifier = "@react-three/fiber", url = new URL(loadedUrl);
    if (url.origin !== origin || url.username !== "" || url.password !== "" || url.hash !== "" || !decodeURIComponent(url.pathname).endsWith("/@react-three_fiber.js")) throw new Error("Refuse an unrecognized or cross-origin R3F import-map target.");
    const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
    const inspect = (value: unknown) => {
      if (value === undefined) return;
      if (!object(value)) throw new Error("Existing import-map entries are malformed.");
      for (const [key, target] of Object.entries(value)) {
        if (key !== specifier && !(key.endsWith("/") && specifier.startsWith(key))) continue;
        if (typeof target !== "string" || new URL(target + (key === specifier ? "" : specifier.slice(key.length)), document.baseURI).href !== loadedUrl) throw new Error("An existing import-map binding conflicts with the loaded R3F module.");
      }
    };
    for (const script of document.querySelectorAll('script[type="importmap"]')) {
      const map: unknown = JSON.parse(script.textContent);
      if (!object(map)) throw new Error("Existing import map is malformed.");
      inspect(map["imports"]);
      const scopes = map["scopes"];
      if (scopes !== undefined) { if (!object(scopes)) throw new Error("Existing scoped import map is malformed."); for (const scope of Object.values(scopes)) inspect(scope); }
    }
    const script = document.createElement("script"); script.type = "importmap"; script.dataset["rehearsalQaMap"] = "true";
    script.textContent = JSON.stringify({ imports: { [specifier]: loadedUrl } }); document.head.append(script);
  }, { loadedUrl, origin });
}

/** Read the existing renderer after a fresh visit. Never writes a camera or creates a frame/audio owner. */
async function inspectOverview(page: Page): Promise<OverviewScene> {
  return page.evaluate(async () => {
    const module = await import("@react-three/fiber");
    const canvas = document.querySelector("canvas");
    if (canvas === null) throw new Error("No actual overview canvas.");
    const root = module._roots.get(canvas);
    if (root === undefined) throw new Error("Overview probe does not own the actual R3F canvas.");
    const state = root.store.getState(); let courtyard = false;
    state.scene.traverse((object) => { if (object.name.startsWith("Courtyard") && object.name.includes("bluestone")) courtyard = true; });
    const direction = state.camera.position.clone().set(0, 0, -1).applyQuaternion(state.camera.quaternion);
    return { frame: state.gl.info.render.frame, width: innerWidth, height: innerHeight, canvasWidth: canvas.width, canvasHeight: canvas.height,
      x: state.camera.position.x, y: state.camera.position.y, z: state.camera.position.z, forwardZ: direction.z, courtyard, contextLost: state.gl.getContext().isContextLost() };
  });
}

export async function recordRehearsalScene(): Promise<void> {
  if (process.argv.slice(2).join(" ") !== "--record-local-rehearsal") throw new Error("Use --record-local-rehearsal only in the authorized shared CPU/browser lane.");
  const target = new URL(process.env["ARENA_PREVIEW_URL"] ?? "http://127.0.0.1:5173/");
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(target.hostname) || target.username !== "" || target.password !== "" || target.search !== "" || target.hash !== "") throw new Error("Credential-free loopback preview only.");
  const port = Number(process.env["ARENA_MOCK_PORT"] ?? "8084");
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid owned local mock port.");
  const output = resolve(process.env["ARENA_SCENE_OUTPUT"] ?? `${tmpdir()}/arena-rehearsal-scene-${Date.now().toString()}`);
  await mkdir(output, { recursive: true });
  const report = { status: "running", description: "Actual browser canvas plus actual page-owned Web Audio, captured together. Scene only: DOM controls/subtitles are excluded. Fixed authored unscored TEXT rehearsal; no AI, microphone, overdub or fabricated frames.", blocked: [] as string[], errors: [] as string[], cleanupErrors: [] as string[], tts: [] as { voice: string; text: string; status: number }[], recording: null as Omit<Recording, "base64"> | null, video: null as string | null, sha256: null as string | null, screenshots: [] as { path: string; sha256: string; description: string; captionText: string | null; before: AudioSample | null; after: AudioSample | null }[], voicedEvidence: "pending", overviews: [] as OverviewStill[], audioOwnership: { beforeCapture: null as AudioDiagnostics | null, afterPlayback: null as AudioDiagnostics | null, onFailure: null as AudioDiagnostics | null, afterDisposal: null as AudioDiagnostics | null }, failureDiagnostics: { uiState: null as string | null, screenshot: null as string | null, errors: [] as string[] },
    mouthEvidence: { thresholds: { quietMouthMax: QUIET_MOUTH_MAX, activeSignalMin: ACTIVE_SIGNAL_MIN, morphChangeMin: MORPH_CHANGE_MIN, minActiveFrames: MIN_ACTIVE_FRAMES, minChangedFramePairs: MIN_CHANGED_FRAME_PAIRS, settleMs: SETTLE_MS },
      quiet: [] as MouthObservation[], active: [] as Recording["samples"], changedFramePairs: [] as { from: number; to: number; maxDelta: number }[], settled: [] as MouthObservation[] } };
  const mock = createLocalMock({ port, browserOrigin: target.origin, localTts: true });
  const fiberUrls = new Set<string>();
  let browser: Browser | null = null, context: BrowserContext | null = null, page: Page | null = null, capture: JSHandle<Harness> | null = null;
  const interrupt = () => { report.errors.push("Interrupted"); void browser?.close(); void mock.close(); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    await mock.listen();
    browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, timeout: 60_000, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-background-networking"] });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, reducedMotion: "no-preference", permissions: [], serviceWorkers: "block" });
    await guards(context, target.origin, report.blocked, report.errors);
    page = await context.newPage(); const ownedPage = page; page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => { report.errors.push(message(error)); });
    page.on("console", (entry) => { if (entry.type() === "error") report.errors.push(entry.text()); });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (decodeURIComponent(url.pathname).endsWith("/@react-three_fiber.js")) fiberUrls.add(url.href);
      if (url.pathname !== "/api/tts") return;
      const body: unknown = response.request().postDataJSON();
      if (body !== null && typeof body === "object" && "voice" in body && typeof body.voice === "string" && "text" in body && typeof body.text === "string") report.tts.push({ voice: body.voice, text: body.text, status: response.status() });
    });
    await page.goto(target.href, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Enter the precinct", exact: true })).toBeEnabled({ timeout: 90_000 });
    expect(fiberUrls.size).toBe(1); const fiberUrl = [...fiberUrls][0];
    if (fiberUrl === undefined) throw new Error("No exact loaded R3F module.");
    await mapLoadedFiber(page, fiberUrl, target.origin);
    capture = await installCapture(page);
    const closePanel = async () => { if (await ownedPage.getByRole("dialog").count() > 0) await ownedPage.getByRole("button", { name: "Close panel", exact: true }).click(); };
    const station = async (key: "2" | "5" | "6") => {
      const labels = { "2": "Choose a case", "5": "Start briefing", "6": "Enter interview" };
      await closePanel(); await ownedPage.locator("canvas").focus(); await ownedPage.keyboard.press(`Digit${key}`);
      await expect(ownedPage.getByRole("button", { name: new RegExp(`^E\\s*${labels[key]}$`, "u") })).toBeVisible();
      await ownedPage.locator("canvas").focus(); await ownedPage.keyboard.press("KeyE"); await expect(ownedPage.getByRole("dialog")).toBeVisible();
    };
    await expect(page.getByRole("button", { name: "Enter the precinct", exact: true })).toBeEnabled({ timeout: 90_000 });
    await page.getByRole("button", { name: "Comfort and accessibility settings", exact: true }).click();
    await page.getByRole("combobox", { name: /Rendering quality/u }).selectOption("low"); await closePanel();
    await page.getByRole("button", { name: "Enter the precinct", exact: true }).click();
    await station("6"); await page.getByRole("button", { name: "Connect local backend", exact: true }).click();
    await page.getByRole("button", { name: "I understand the ground rule", exact: true }).click();
    await station("2");
    const fixtureCard = page.getByRole("article").filter({ has: page.getByRole("heading", { name: FIXTURE_TITLE, exact: true }) });
    await expect(fixtureCard).toHaveCount(1); await expect(fixtureCard.locator(".training-availability")).toHaveText("Available");
    await fixtureCard.getByRole("button", { name: "Select case", exact: true }).click();
    await expect(fixtureCard.getByRole("button", { name: "Selected case", exact: true })).toBeDisabled();
    await station("5"); await page.getByRole("button", { name: "Acknowledge the briefing and ground rule", exact: true }).click();
    await station("6"); await page.getByRole("button", { name: "Call subject to room", exact: true }).click();
    await page.getByRole("button", { name: "Start text practice", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Your question", exact: true })).toBeEnabled();
    await page.getByRole("checkbox", { name: "Enable local backend read-aloud", exact: true }).check();
    await page.getByRole("button", { name: "Sit at interview table", exact: true }).click();
    const ownedCapture = capture;
    await expect.poll(() => ownedCapture.evaluate((handle) => { try { return handle.scene().morphCount; } catch { return 0; } })).toBeGreaterThanOrEqual(7);
    const observeMouth = () => ownedCapture.evaluate((handle): MouthObservation => ({ pageTimeMs: performance.now(), audio: handle.sample(), scene: handle.scene() }));
    report.audioOwnership.beforeCapture = await capture.evaluate((handle) => handle.diagnostics());
    let quietFrame = -1;
    for (let index: number = 0; index < 3; index += 1) {
      await expect.poll(async () => (await observeMouth()).scene.frame).toBeGreaterThan(quietFrame);
      const observation = await observeMouth();
      report.mouthEvidence.quiet.push(observation);
      expect(observation.audio).toMatchObject({ contextCount: 1, starts: 0, ended: 0, active: 0, error: null });
      expect(observation.audio.rms).toBeLessThanOrEqual(ACTIVE_SIGNAL_MIN);
      expect(observation.scene.mouthMax).toBeLessThanOrEqual(QUIET_MOUTH_MAX);
      quietFrame = observation.scene.frame;
    }
    await capture.evaluate((handle) => { handle.start(); });
    await page.getByRole("button", { name: "Interview controls", exact: true }).click();
    await page.getByRole("tab", { name: "Transcript", exact: true }).click();
    await page.getByRole("textbox", { name: "Your question", exact: true }).fill(QUESTION);
    const submitted = page.waitForResponse((response) => /\/api\/trials\/[^/]+\/turns$/u.test(new URL(response.url()).pathname) && response.request().method() === "POST");
    await page.getByRole("button", { name: "Send", exact: true }).click(); expect((await submitted).status()).toBe(200); await closePanel();
    // A separate full-page still proves the actual DOM caption during the real authored reply.
    // DOM is deliberately never composited into the canvas/audio recording.
    await expect.poll(() => ownedCapture.evaluate((handle) => handle.sample()), { timeout: CAPTURE_MS, intervals: [100] }).toMatchObject({ starts: 2, ended: 1, active: 1, error: null });
    const caption = page.getByRole("status", { name: "Speech caption", exact: true });
    await expect(caption).toBeVisible();
    await expect(caption.locator("p")).toHaveText(`Jordan Pell: ${BEAT}`);
    await expect(caption).toContainText("Read-aloud · synthesized speech");
    const beforeCaption = await capture.evaluate((handle) => handle.sample());
    expect(beforeCaption).toMatchObject({ starts: 2, ended: 1, active: 1, error: null });
    const captionPath = `${output}/actual-live-subject-caption.png`;
    const captionBytes = await page.screenshot({ path: captionPath, fullPage: true, timeout: 5000 });
    const afterCaption = await capture.evaluate((handle) => handle.sample());
    expect(afterCaption).toMatchObject({ starts: 2, ended: 1, active: 1, error: null });
    await expect(caption.locator("p")).toHaveText(`Jordan Pell: ${BEAT}`);
    report.screenshots.push({ path: captionPath, sha256: createHash("sha256").update(captionBytes).digest("hex"), description: "Actual full page during the authored subject reply; live DOM caption plus scene, captured separately from the scene-only video.", captionText: await caption.innerText(), before: beforeCaption, after: afterCaption });
    await expect.poll(() => ownedCapture.evaluate((handle) => handle.sample()), { timeout: CAPTURE_MS, intervals: [100] }).toMatchObject({ starts: 2, ended: 2, active: 0, error: null });
    const settleDeadline = Date.now() + SETTLE_MS;
    let settledFrame = (await observeMouth()).scene.frame;
    for (let index: number = 0; index < 3; index += 1) {
      await expect.poll(async () => {
        const observation = await observeMouth();
        return observation.scene.frame > settledFrame && observation.scene.mouthMax <= QUIET_MOUTH_MAX && observation.audio.rms <= ACTIVE_SIGNAL_MIN;
      }, { timeout: Math.max(1, settleDeadline - Date.now()), intervals: [100] }).toBe(true);
      const observation = await observeMouth(); report.mouthEvidence.settled.push(observation);
      expect(observation.audio).toMatchObject({ contextCount: 1, starts: 2, ended: 2, active: 0, error: null });
      expect(observation.scene.frame).toBeGreaterThan(settledFrame);
      expect(observation.audio.rms).toBeLessThanOrEqual(ACTIVE_SIGNAL_MIN);
      expect(observation.scene.mouthMax).toBeLessThanOrEqual(QUIET_MOUTH_MAX);
      settledFrame = observation.scene.frame;
    }
    const recorded = await bounded(capture.evaluate((handle) => handle.stop()), 5000, "Recorder finalization exceeded 5 seconds.");
    const { base64, ...details } = recorded; report.recording = details;
    report.audioOwnership.afterPlayback = await capture.evaluate((handle) => handle.diagnostics());
    expect(recorded.timedOut).toBe(false); expect(recorded.elapsedMs).toBeLessThanOrEqual(CAPTURE_MS + 1000); expect(recorded.bytes).toBeGreaterThan(1000);
    expect(recorded.samples.some((sample) => sample.audio.rms > 0.0001)).toBe(true);
    expect(new Set(recorded.samples.map((sample) => sample.scene.frame)).size).toBeGreaterThan(4);
    const activeFrames = new Map<number, Recording["samples"][number]>();
    for (const sample of recorded.samples) if (sample.audio.starts === 2 && sample.audio.active === 1 && sample.audio.rms > ACTIVE_SIGNAL_MIN) activeFrames.set(sample.scene.frame, sample);
    const active = [...activeFrames.values()]; report.mouthEvidence.active = active;
    expect(active.length).toBeGreaterThanOrEqual(MIN_ACTIVE_FRAMES);
    expect(active.some((sample) => sample.scene.mouthMax >= MORPH_CHANGE_MIN)).toBe(true);
    for (let index = 1; index < active.length; index += 1) {
      const before = active[index - 1], after = active[index];
      if (before === undefined || after === undefined) throw new Error("Missing actual active-frame evidence.");
      const previous = new Map(before.scene.speechMorphs.map((morph) => [`${morph.mesh}:${morph.name}`, morph.value]));
      let maxDelta = 0;
      for (const morph of after.scene.speechMorphs) {
        const value = previous.get(`${morph.mesh}:${morph.name}`);
        if (value === undefined) throw new Error("Subject speech morph identity changed during actual playback.");
        maxDelta = Math.max(maxDelta, Math.abs(morph.value - value));
      }
      if (maxDelta >= MORPH_CHANGE_MIN) report.mouthEvidence.changedFramePairs.push({ from: before.scene.frame, to: after.scene.frame, maxDelta });
    }
    expect(report.mouthEvidence.changedFramePairs.length).toBeGreaterThanOrEqual(MIN_CHANGED_FRAME_PAIRS);
    expect(report.mouthEvidence.settled[0]?.scene.frame).toBeGreaterThan(active.at(-1)?.scene.frame ?? Number.POSITIVE_INFINITY);
    expect(recorded.samples.every((sample) => !sample.scene.contextLost && sample.scene.canvasWidth > 0 && sample.scene.canvasHeight > 0)).toBe(true);
    expect(report.tts).toEqual([{ voice: "investigator", text: QUESTION, status: 200 }, { voice: "subject:Jordan Pell", text: BEAT, status: 200 }]);
    expect(report.blocked).toEqual([]); expect(report.errors).toEqual([]);
    const bytes = Buffer.from(base64, "base64"); expect(bytes.length).toBe(recorded.bytes);
    report.video = `${output}/actual-rehearsal-scene-with-audio.webm`; report.sha256 = createHash("sha256").update(bytes).digest("hex"); await writeFile(report.video, bytes);
    await page.screenshot({ path: `${output}/actual-scene.png`, fullPage: true });
    await page.getByRole("button", { name: "Interview controls", exact: true }).click();
    await page.getByRole("tab", { name: "Transcript", exact: true }).click();
    const transcript = page.getByRole("log");
    await expect(transcript).toContainText(QUESTION); await expect(transcript).toContainText(BEAT);
    await expect(page.getByRole("checkbox", { name: "Enable local backend read-aloud", exact: true })).toBeChecked();
    const transcriptPath = `${output}/actual-interview-transcript.png`;
    const transcriptBytes = await page.screenshot({ path: transcriptPath, fullPage: true });
    report.screenshots.push({ path: transcriptPath, sha256: createHash("sha256").update(transcriptBytes).digest("hex"), description: "Actual full-page interview controls and completed canonical TEXT transcript with the submitted question and fixed authored response.", captionText: null, before: null, after: null });
    await page.getByRole("checkbox", { name: "Enable local backend read-aloud", exact: true }).uncheck();
    await bounded(capture.evaluate((handle) => handle.dispose()), 5000, "Voiced capture disposal exceeded 5 seconds.");
    report.audioOwnership.afterDisposal = await capture.evaluate((handle) => handle.diagnostics());
    await capture.dispose(); capture = null;
    await page.evaluate(() => { for (const script of document.querySelectorAll('script[data-rehearsal-qa-map="true"]')) script.remove(); });
    report.voicedEvidence = "Actual scene/audio and caption/transcript verified; recorder, tracks and audio graph disposed. Browser/mock cleanup is recorded in the final report.";
    await writeFile(`${output}/voiced-scene-evidence.json`, `${JSON.stringify({ ...report, status: "capture-verified" }, null, 2)}\n`);

    // Architecture correctly locks during an active interview. A new visit uses real settings and
    // normal backward walking along the authored clear courtyard axis. No second recording is made.
    fiberUrls.clear(); await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Enter the precinct", exact: true })).toBeEnabled({ timeout: 90_000 });
    expect(fiberUrls.size).toBe(1); const overviewFiberUrl = [...fiberUrls][0];
    if (overviewFiberUrl === undefined) throw new Error("No loaded R3F module for the fresh overview visit.");
    await mapLoadedFiber(page, overviewFiberUrl, target.origin);
    await page.getByRole("button", { name: "Comfort and accessibility settings", exact: true }).click();
    await page.getByRole("combobox", { name: /Rendering quality/u }).selectOption("low");
    await page.getByRole("radio", { name: "Studio", exact: true }).check();
    await expect(page.locator(".precinct-root")).toHaveAttribute("data-theme", "studio");
    const architecture = page.getByRole("combobox", { name: /^Architecture/u });
    await expect(architecture).toBeEnabled(); await architecture.selectOption("courtyard"); await expect(architecture).toHaveValue("courtyard");
    await closePanel();
    await expect(page.getByRole("button", { name: "Enter the precinct", exact: true })).toBeEnabled({ timeout: 90_000 });
    await page.getByRole("button", { name: "Enter the precinct", exact: true }).click();
    await expect.poll(() => inspectOverview(ownedPage), { timeout: 30_000 }).toMatchObject({ courtyard: true, contextLost: false, width: 1440, height: 900 });
    await page.locator("canvas").focus(); await page.keyboard.down("KeyS");
    try { await expect.poll(async () => (await inspectOverview(ownedPage)).z, { timeout: 60_000, intervals: [100] }).toBeGreaterThanOrEqual(16.3); }
    finally { await page.keyboard.up("KeyS"); }
    await expect(page.locator(".precinct-location")).toContainText("South Arrival Arcade");
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
      const before = await inspectOverview(page); await page.setViewportSize(viewport);
      await expect.poll(() => inspectOverview(ownedPage)).toMatchObject({ ...viewport, courtyard: true, contextLost: false });
      await expect.poll(async () => (await inspectOverview(ownedPage)).frame).toBeGreaterThan(before.frame + 1);
      const scene = await inspectOverview(page);
      expect(Math.abs(scene.x)).toBeLessThan(0.5); expect(scene.z).toBeGreaterThanOrEqual(16.3); expect(scene.z).toBeLessThan(18.5); expect(scene.forwardZ).toBeLessThan(-0.99);
      expect(scene.canvasWidth).toBeGreaterThan(0); expect(scene.canvasHeight).toBeGreaterThan(0);
      await expect(page.locator(".precinct-root")).toHaveAttribute("data-theme", "studio"); await expect(page.getByRole("dialog")).toHaveCount(0);
      const path = `${output}/actual-courtyard-studio-${String(viewport.width)}x${String(viewport.height)}.png`;
      const pixels = await page.screenshot({ path, fullPage: true });
      expect(pixels.readUInt32BE(16)).toBe(viewport.width); expect(pixels.readUInt32BE(20)).toBe(viewport.height);
      report.overviews.push({ path, sha256: createHash("sha256").update(pixels).digest("hex"), description: "Actual full-page Courtyard + Studio overview from a fresh visit, reached with normal keyboard movement. Separate still; not part of the scene-only voiced WebM.", scene });
    }
    await page.evaluate(() => { for (const script of document.querySelectorAll('script[data-rehearsal-qa-map="true"]')) script.remove(); });
    expect(report.blocked).toEqual([]); expect(report.errors).toEqual([]);
    expect(report.tts).toEqual([{ voice: "investigator", text: QUESTION, status: 200 }, { voice: "subject:Jordan Pell", text: BEAT, status: 200 }]);
    report.status = "passed";
  } catch (error) {
    report.status = "failed"; report.errors.push(message(error));
    if (capture !== null && page !== null && !page.isClosed()) {
      try { report.audioOwnership.onFailure = await bounded(capture.evaluate((handle) => handle.diagnostics()), 2000, "Audio ownership diagnostic exceeded 2 seconds."); }
      catch (failure) { report.failureDiagnostics.errors.push(message(failure)); }
    }
    if (page !== null && !page.isClosed()) {
      try {
        const state = await bounded(page.evaluate(() => ({ url: `${location.origin}${location.pathname}`, title: document.title,
          viewport: { width: innerWidth, height: innerHeight }, bodyText: document.body.innerText.slice(0, 20_000),
          openDialogs: document.querySelectorAll("dialog[open]").length })), 2000, "Failure UI-state observation exceeded 2 seconds.");
        const path = `${output}/failure-ui-state.json`; await writeFile(path, `${JSON.stringify(state, null, 2)}\n`); report.failureDiagnostics.uiState = path;
      } catch (failure) { report.failureDiagnostics.errors.push(message(failure)); }
      try {
        const path = `${output}/failure-full-page.png`; await page.screenshot({ path, fullPage: true, timeout: 5000 }); report.failureDiagnostics.screenshot = path;
      } catch (failure) { report.failureDiagnostics.errors.push(message(failure)); }
    }
  }
  finally {
    if (capture !== null && page !== null && !page.isClosed()) { try { await bounded(capture.evaluate((handle) => handle.dispose()), 5000, "Capture disposal exceeded 5 seconds."); report.audioOwnership.afterDisposal = await bounded(capture.evaluate((handle) => handle.diagnostics()), 2000, "Disposed audio ownership diagnostic exceeded 2 seconds."); await capture.dispose(); await page.evaluate(() => { for (const script of document.querySelectorAll('script[data-rehearsal-qa-map="true"]')) script.remove(); }); } catch (error) { report.cleanupErrors.push(message(error)); } }
    await context?.close().catch((error: unknown) => { report.cleanupErrors.push(message(error)); });
    await browser?.close().catch((error: unknown) => { report.cleanupErrors.push(message(error)); });
    await mock.close().catch((error: unknown) => { report.cleanupErrors.push(message(error)); });
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    if (report.cleanupErrors.length > 0) report.status = "failed";
    await writeFile(`${output}/scene-capture-report.json`, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`Actual scene capture ${report.status}: ${output}/scene-capture-report.json\n`); if (report.status !== "passed") process.exitCode = 1;
  }
}
if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await recordRehearsalScene();
