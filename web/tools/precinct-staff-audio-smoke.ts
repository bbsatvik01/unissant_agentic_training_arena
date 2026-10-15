/** Explicit developer CLI: real staff clicks, native Web Audio and existing rendered morphs.
 * Requires an already-running merged Vite preview. No server, microphone or audio provider.
 * A passing signal test is not a human listening/hardware-speaker approval. Video is silent. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { chromium, expect, type Browser, type BrowserContext, type JSHandle, type Page } from "@playwright/test";
import type { Mesh } from "three";

interface Clip { id: string; voice_id: string; text: string; url: string; sha256: string; bytes: number; duration_seconds: number; sample_rate: number }
interface Pcm { rms: number; peak: number }
interface AudioSourceObservation {
  id: number; contextState: string; contextTime: number; started: number; stopped: number; ended: boolean;
  decoded: { duration: number; rate: number; channels: number; pcm: Pcm } | null;
  gain: number | null; outputPath: boolean; analyserId: number | null; fftSize: number | null; pcm: Pcm | null;
}
interface AudioObservation { activeSources: number; sources: AudioSourceObservation[]; edges: { from: number; to: number }[] }
interface BrowserProbe { sample: () => AudioObservation; restore: () => void }
interface SceneObservation {
  frameloop: string; actor: string; root: number[]; bones: { name: string; quaternion: number[] }[];
  morphs: { mesh: string; name: string; value: number }[]; mouthMax: number;
}
interface Sample { at: number; audio: AudioObservation; scene: SceneObservation }
interface Result {
  status: string; description: string; target: string; browser: string | null; renderer: string;
  manifestSha256: string; thresholds: { signalRms: number; silentRms: number; mouth: number; pollMs: number };
  checks: { name: string; passed: boolean }[]; observations: { phase: string; samples: Sample[] }[];
  assets: { url: string; status: number; bytes: number; sha256: string }[];
  subtitles: { actor: string; clip: string; text: string }[]; screenshots: string[];
  requests: { method: string; url: string }[]; blocked: string[]; guardViolations: string[];
  errors: string[]; cleanupErrors: string[]; video: string | null; videoHasCapturedAudio: false;
}
const limits = { signalRms: 0.0001, silentRms: 0.0000001, mouth: 0.00001, pollMs: 80 };
const message = (error: unknown) => error instanceof Error ? error.stack ?? error.message : String(error);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function parseClips(value: unknown): Clip[] {
  if (!object(value) || !Array.isArray(value["clips"])) throw new Error("Missing finite staff manifest.");
  const result: Clip[] = [];
  for (const entry of value["clips"] as unknown[]) {
    if (!object(entry)) throw new Error("Invalid staff clip.");
    const id = entry["id"], voice_id = entry["voice_id"], text = entry["text"], url = entry["url"], sha256 = entry["sha256"];
    const bytes = entry["bytes"], duration_seconds = entry["duration_seconds"], sample_rate = entry["sample_rate"];
    if (typeof id !== "string" || typeof voice_id !== "string" || typeof text !== "string" || typeof url !== "string" || !/^\/audio\/staff-v1\/[a-z-]+\.wav$/u.test(url)
      || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256) || typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 44 || bytes >= 5 * 1024 * 1024
      || typeof duration_seconds !== "number" || !Number.isFinite(duration_seconds) || duration_seconds <= 0 || duration_seconds > 60 || sample_rate !== 22050) throw new Error("Invalid bounded staff manifest entry.");
    result.push({ id, voice_id, text, url, sha256, bytes, duration_seconds, sample_rate });
  }
  if (result.length !== 23 || new Set(result.map((clip) => clip.url)).size !== 23) throw new Error("Expected exactly 23 unique authored staff WAVs.");
  return result;
}

/** The handle retains only closure-local observations. Every native call keeps its receiver/args/result. */
async function installAudioProbe(page: Page): Promise<JSHandle<BrowserProbe>> {
  return page.evaluateHandle(() => {
    type Method = (this: object, ...args: unknown[]) => unknown;
    type Hook = (receiver: object, args: unknown[], result: unknown) => void;
    const restores: (() => void)[] = [];
    const nodeIds = new Map<AudioNode, number>();
    const sources: { node: AudioBufferSourceNode; started: number; stopped: number; ended: boolean; decoded: AudioSourceObservation["decoded"] }[] = [];
    const gains: GainNode[] = [], analysers: AnalyserNode[] = [];
    let edges: { from: AudioNode; to: AudioNode }[] = [];
    const id = (node: AudioNode) => { let value = nodeIds.get(node); if (value === undefined) { value = nodeIds.size + 1; nodeIds.set(node, value); } return value; };
    const pcm = (samples: Float32Array): Pcm => {
      let sum = 0, peak = 0; for (const value of samples) { sum += value * value; peak = Math.max(peak, Math.abs(value)); }
      return { rms: samples.length === 0 ? 0 : Math.sqrt(sum / samples.length), peak };
    };
    const wrap = (target: object, name: string, after: Hook) => {
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      const original: unknown = Reflect.get(target, name);
      if (typeof original !== "function") throw new Error(`Missing native method ${name}`);
      const native = original as Method;
      const wrapper = function (this: object, ...args: unknown[]): unknown {
        const result: unknown = Reflect.apply(native, this, args); after(this, args, result); return result;
      };
      Object.defineProperty(target, name, { configurable: true, writable: true, value: wrapper });
      restores.push(() => {
        if (Reflect.get(target, name) !== wrapper) throw new Error(`Probe method replaced unexpectedly: ${name}`);
        if (descriptor === undefined) Reflect.deleteProperty(target, name); else Object.defineProperty(target, name, descriptor);
      });
    };
    const track = (node: AudioNode) => {
      id(node);
      wrap(node, "connect", (receiver, args) => {
        const destination = args[0];
        if (!(receiver instanceof AudioNode) || !(destination instanceof AudioNode)) return;
        id(destination); edges.push({ from: receiver, to: destination });
      });
      wrap(node, "disconnect", (receiver, args) => {
        if (!(receiver instanceof AudioNode)) return;
        // Production cleanup calls disconnect() with no arguments. Other overloads are retained.
        if (args.length === 0) edges = edges.filter((edge) => edge.from !== receiver);
        else if (args[0] instanceof AudioNode) edges = edges.filter((edge) => edge.from !== receiver || edge.to !== args[0]);
      });
    };
    const restore = () => {
      const errors: string[] = [];
      for (const undo of restores.splice(0).reverse()) { try { undo(); } catch (error) { errors.push(String(error)); } }
      edges = []; nodeIds.clear(); sources.length = 0; gains.length = 0; analysers.length = 0;
      if (errors.length > 0) throw new Error(errors.join("; "));
    };
    try {
      wrap(AudioContext.prototype, "createBufferSource", (_receiver, _args, result) => {
        if (!(result instanceof AudioBufferSourceNode)) throw new Error("Native source creation returned an unexpected node.");
        track(result); const record = { node: result, started: 0, stopped: 0, ended: false, decoded: null as AudioSourceObservation["decoded"] }; sources.push(record);
        wrap(result, "start", () => {
          record.started += 1; const buffer = result.buffer;
          if (buffer !== null) record.decoded = { duration: buffer.duration, rate: buffer.sampleRate, channels: buffer.numberOfChannels, pcm: pcm(buffer.getChannelData(0)) };
        });
        wrap(result, "stop", () => { record.stopped += 1; });
        const ended = () => { record.ended = true; }; result.addEventListener("ended", ended);
        restores.push(() => { result.removeEventListener("ended", ended); });
      });
      wrap(AudioContext.prototype, "createGain", (_receiver, _args, result) => { if (!(result instanceof GainNode)) throw new Error("Expected native gain."); track(result); gains.push(result); });
      wrap(AudioContext.prototype, "createAnalyser", (_receiver, _args, result) => { if (!(result instanceof AnalyserNode)) throw new Error("Expected native analyser."); track(result); analysers.push(result); });
    } catch (error) { restore(); throw error; }
    return {
      restore,
      sample(): AudioObservation {
        return {
          activeSources: sources.filter((source) => source.started > 0 && source.stopped === 0 && !source.ended && source.node.context.state !== "closed").length,
          edges: edges.map((edge) => ({ from: id(edge.from), to: id(edge.to) })),
          sources: sources.map((source) => {
            const context = source.node.context;
            const gain = gains.find((node) => node.context === context);
            const analyser = analysers.find((node) => node.context === context);
            const connected = (from: AudioNode, to: AudioNode) => edges.some((edge) => edge.from === from && edge.to === to);
            const outputPath = gain !== undefined && analyser !== undefined && connected(source.node, gain) && connected(gain, analyser) && connected(analyser, context.destination);
            let values: Pcm | null = null;
            if (analyser !== undefined && context.state === "running" && outputPath) { const data = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(data); values = pcm(data); }
            return { id: id(source.node), contextState: context.state, contextTime: context.currentTime, started: source.started, stopped: source.stopped, ended: source.ended,
              decoded: source.decoded, gain: gain?.gain.value ?? null, outputPath, analyserId: analyser === undefined ? null : id(analyser), fftSize: analyser?.fftSize ?? null, pcm: values };
          }),
        };
      },
    };
  });
}

/** Imports the exact already-loaded module, then reads the actual scene. No duplicate scene or RAF. */
async function observe(page: Page, probe: JSHandle<BrowserProbe>, actor: string): Promise<Sample> {
  return page.evaluate(async ({ probe, actor }) => {
    const module = await import("@react-three/fiber");
    const canvas = document.querySelector("canvas");
    if (canvas === null || canvas.getClientRects().length === 0) throw new Error("The actual visible Canvas is unavailable.");
    const root = module._roots.get(canvas);
    if (root === undefined) throw new Error("The imported module does not own this Canvas; refuse a duplicate registry.");
    const state = root.store.getState(), figure = state.scene.getObjectByName(`precinct-staff-${actor}`);
    if (figure === undefined) throw new Error(`Actual rendered staff not loaded: ${actor}`);
    const names = ["AA_VI_10_aa", "AA_VI_11_E", "AA_VI_12_I", "AA_VI_13_O", "AA_VI_14_U", "AA_VI_07_SS", "AK_25_JawOpen"];
    const morphs: SceneObservation["morphs"] = [], bones: SceneObservation["bones"] = [];
    figure.traverse((node) => {
      if (node.type === "Bone") bones.push({ name: node.name, quaternion: node.quaternion.toArray() });
      const mesh = node as Mesh; const dictionary = mesh.morphTargetDictionary, values = mesh.morphTargetInfluences;
      if (dictionary === undefined || values === undefined) return;
      for (const name of names) { const index = dictionary[name]; if (index !== undefined) { const value = values[index]; if (value !== undefined) morphs.push({ mesh: mesh.name, name, value }); } }
    });
    if (!names.every((name) => morphs.some((morph) => morph.name === name))) throw new Error("Actual actor lacks required speech/jaw morphs.");
    return { at: performance.now(), audio: probe.sample(), scene: { frameloop: state.frameloop, actor, root: [...figure.position.toArray(), ...figure.quaternion.toArray()], bones, morphs, mouthMax: Math.max(...morphs.map((morph) => Math.abs(morph.value))) } };
  }, { probe, actor });
}

async function guard(context: BrowserContext, origin: string, allowed: ReadonlySet<string>, result: Result): Promise<void> {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const forbidden = url.origin !== origin || url.pathname.startsWith("/api/") || (url.pathname.startsWith("/audio/") && !allowed.has(url.pathname));
    if (forbidden) { result.blocked.push(url.href); await route.abort("blockedbyclient"); return; }
    await route.continue();
  });
  await context.routeWebSocket("**/*", (socket) => {
    const url = new URL(socket.url());
    if (url.protocol === "ws:" && url.host === new URL(origin).host && !url.pathname.startsWith("/api/")) socket.connectToServer();
    else { result.blocked.push(url.href); void socket.close({ code: 1008, reason: "Only same-origin Vite HMR allowed." }).catch((error: unknown) => { result.errors.push(message(error)); }); }
  });
  await context.addInitScript(() => {
    const refuse = (name: string): never => { console.error(`STAFF_AUDIO_GUARD:${name}`); throw new Error(`Staff audio smoke refused ${name}`); };
    const devices = Reflect.get(navigator, "mediaDevices") as MediaDevices | undefined;
    if (devices !== undefined) {
      devices.getUserMedia = () => refuse("getUserMedia");
      devices.getDisplayMedia = () => refuse("getDisplayMedia");
    }
    if (typeof speechSynthesis !== "undefined") speechSynthesis.speak = () => { refuse("speechSynthesis"); };
    HTMLMediaElement.prototype.play = () => refuse("HTMLMediaElement.play");
    // Native AudioContext is intentionally allowed; it is the subject of the test.
  });
}

export async function smokePrecinctStaffAudio(): Promise<void> {
  if (process.argv.slice(2).join(" ") !== "--allow-local-staff-audio") throw new Error("Use --allow-local-staff-audio only in an authorized test-browser CPU slot.");
  const target = new URL(process.env["ARENA_PREVIEW_URL"] ?? "http://127.0.0.1:5173/");
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(target.hostname) || target.username !== "" || target.password !== "" || target.search !== "" || target.hash !== "") throw new Error("Only credential-free loopback preview URLs without query/hash are accepted.");
  const manifestBytes = await readFile(new URL("../src/lib/precinct/localStaffVoiceManifest.json", import.meta.url));
  const manifest: unknown = JSON.parse(manifestBytes.toString()); const clips = parseClips(manifest);
  const output = resolve(process.env["ARENA_STAFF_AUDIO_OUTPUT"] ?? `${tmpdir()}/arena-staff-audio-${new Date().toISOString().replaceAll(":", "-")}`);
  await mkdir(output, { recursive: true });
  const result: Result = { status: "running", description: "Real native source→gain→analyser→destination signal and existing staff mesh morphs after explicit UI clicks. Synthetic fixed dialogue. No human listening/hardware-speaker approval. Video is silent.", target: target.href, browser: null, renderer: "Chromium software WebGL/SwiftShader; not a hardware FPS benchmark", manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"), thresholds: limits,
    checks: [], observations: [], assets: [], subtitles: [], screenshots: [], requests: [], blocked: [], guardViolations: [], errors: [], cleanupErrors: [], video: null, videoHasCapturedAudio: false };
  let browser: Browser | null = null, context: BrowserContext | null = null, page: Page | null = null, probe: JSHandle<BrowserProbe> | null = null;
  let shuttingDown = false;
  const pendingAssets: Promise<void>[] = [];
  const fiberUrls = new Set<string>();
  const save = async () => { await writeFile(`${output}/staff-audio-report.json`, `${JSON.stringify(result, null, 2)}\n`); };
  const interrupt = () => { void browser?.close().catch(() => undefined); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const watchdog = setTimeout(() => { result.errors.push("Overall 240-second browser budget exceeded."); interrupt(); }, 240_000);
  try {
    browser = await chromium.launch({ executablePath: process.env["ARENA_CHROMIUM_PATH"] ?? "/usr/bin/chromium", headless: true, timeout: 90_000,
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-background-networking"] });
    result.browser = browser.version();
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: "no-preference", permissions: [], serviceWorkers: "block", recordVideo: { dir: output, size: { width: 1440, height: 900 } } });
    await guard(context, target.origin, new Set(clips.map((clip) => clip.url)), result);
    const currentPage = await context.newPage(); page = currentPage; const video = currentPage.video();
    currentPage.setDefaultTimeout(15_000);
    currentPage.on("pageerror", (error) => { (shuttingDown ? result.cleanupErrors : result.errors).push(message(error)); });
    currentPage.on("console", (entry) => {
      if (entry.text().startsWith("STAFF_AUDIO_GUARD:")) result.guardViolations.push(entry.text());
      if (entry.type() === "error") (shuttingDown ? result.cleanupErrors : result.errors).push(entry.text());
    });
    currentPage.on("request", (request) => { result.requests.push({ method: request.method(), url: request.url() }); });
    currentPage.on("response", (response) => {
      const url = new URL(response.url());
      if (decodeURIComponent(url.pathname).endsWith("/@react-three_fiber.js")) fiberUrls.add(url.href);
      const clip = clips.find((item) => item.url === url.pathname);
      if (clip !== undefined) pendingAssets.push((async () => {
        const bytes = await response.body(), hash = createHash("sha256").update(bytes).digest("hex");
        result.assets.push({ url: url.pathname, status: response.status(), bytes: bytes.length, sha256: hash });
        expect(response.ok()).toBe(true); expect(bytes.length).toBe(clip.bytes); expect(hash).toBe(clip.sha256);
      })().catch((error: unknown) => { result.errors.push(message(error)); }));
      else if (response.status() >= 400) result.errors.push(`${String(response.status())} ${url.href}`);
    });
    await currentPage.goto(target.href, { waitUntil: "domcontentloaded" });
    await expect(currentPage.getByRole("button", { name: "Enter the precinct", exact: true })).toBeEnabled({ timeout: 90_000 });
    await currentPage.getByRole("button", { name: "Comfort and accessibility settings", exact: true }).click();
    await currentPage.getByRole("combobox", { name: /Rendering quality/u }).selectOption("low");
    await currentPage.getByRole("checkbox", { name: /^Reduced motion/u }).uncheck();
    await currentPage.getByRole("button", { name: "Close panel", exact: true }).click();
    await currentPage.getByRole("button", { name: "Enter the precinct", exact: true }).click();
    expect(await currentPage.locator(".precinct-render-notice").isVisible()).toBe(false);
    expect(await currentPage.locator("canvas").evaluate((canvas: HTMLCanvasElement) => { const gl = canvas.getContext("webgl2"); return gl !== null && !gl.isContextLost(); })).toBe(true);
    expect(fiberUrls.size, "Exactly one already-loaded R3F dependency URL is required").toBe(1);
    const fiberUrl = [...fiberUrls][0]; if (fiberUrl === undefined) throw new Error("Missing loaded R3F module URL.");
    // Metadata only: a literal import below resolves to the exact already-loaded module URL.
    // Preserve its query identity and fail closed on an existing conflicting global/scoped map.
    await currentPage.evaluate(({ loadedUrl, origin }) => {
      const specifier = "@react-three/fiber";
      const url = new URL(loadedUrl);
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
        if (scopes !== undefined) {
          if (!object(scopes)) throw new Error("Existing scoped import map is malformed.");
          for (const scope of Object.values(scopes)) inspect(scope);
        }
      }
      const script = document.createElement("script"); script.type = "importmap";
      script.textContent = JSON.stringify({ imports: { [specifier]: loadedUrl } });
      document.head.append(script);
    }, { loadedUrl: fiberUrl, origin: target.origin });
    const currentProbe = await installAudioProbe(currentPage); probe = currentProbe;
    const shot = async (name: string) => { const path = `${output}/${name}.png`; await currentPage.screenshot({ path, fullPage: false }); result.screenshots.push(path); };
    const sample = async (actor: string) => observe(currentPage, currentProbe, actor);
    const record = async (phase: string, actor: string, ms = 700): Promise<Sample[]> => {
      const samples: Sample[] = [], until = Date.now() + ms;
      do { samples.push(await sample(actor)); await delay(limits.pollMs); } while (Date.now() < until);
      result.observations.push({ phase, samples }); return samples;
    };
    const until = async (phase: string, actor: string, accept: (value: Sample) => boolean): Promise<Sample> => {
      const samples: Sample[] = []; const deadline = Date.now() + 2500;
      do { const value = await sample(actor); samples.push(value); if (accept(value)) { result.observations.push({ phase, samples }); return value; } await delay(limits.pollMs); } while (Date.now() < deadline);
      result.observations.push({ phase, samples }); throw new Error(`Timed out observing ${phase}`);
    };
    const latest = (value: Sample) => value.audio.sources.at(-1);
    const renderedSignal = (value: Sample) => { const source = latest(value); return value.audio.activeSources === 1 && source?.contextState === "running" && source.outputPath && source.gain === 1 && (source.pcm?.rms ?? 0) > limits.signalRms; };
    const closed = (value: Sample) => value.audio.activeSources === 0 && value.audio.sources.every((source) => source.contextState === "closed") && value.scene.mouthMax <= limits.mouth;
    const closePanel = async () => { if (await currentPage.getByRole("dialog").count() > 0) await currentPage.getByRole("button", { name: "Close panel", exact: true }).click(); await expect(currentPage.getByRole("dialog")).toHaveCount(0); };
    const open = async (actor: "receptionist" | "sergeant"): Promise<Clip> => {
      await closePanel(); await currentPage.locator("canvas").focus(); await currentPage.keyboard.press(actor === "receptionist" ? "Digit1" : "Digit5");
      await expect(currentPage.getByRole("button", { name: actor === "receptionist" ? /E\s*Reception/u : /E\s*Start briefing/u })).toBeVisible({ timeout: 30_000 });
      await currentPage.locator("canvas").focus(); await currentPage.keyboard.press("KeyE");
      await currentPage.getByRole("button", { name: actor === "receptionist" ? "Talk to reception officer" : "Talk to training sergeant", exact: true }).click();
      const text = await currentPage.locator(".npc-subtitle p").textContent();
      const clip = clips.find((item) => item.text === text && item.id.startsWith(`${actor}-`));
      if (clip === undefined) throw new Error(`No exact manifest line for visible ${actor} subtitle.`);
      result.subtitles.push({ actor, clip: clip.id, text: clip.text });
      await currentPage.locator(".npc-subtitle").scrollIntoViewIfNeeded();
      // Architecture readiness does not imply the independent lazy staff rig has finished loading.
      await expect.poll(async () => {
        try { await sample(actor); return true; }
        catch (error) { if (message(error).includes("Actual rendered staff not loaded:")) return false; throw error; }
      }, { timeout: 30_000, intervals: [100, 200, 500] }).toBe(true);
      await until(`${actor}-ready`, actor, (value) => value.scene.mouthMax <= limits.mouth && value.scene.frameloop === "demand");
      return clip;
    };
    const play = async (actor: string, clip: Clip, moving = true) => {
      await currentPage.getByRole("button", { name: "Play scripted staff voice", exact: true }).click();
      await expect(currentPage.getByRole("button", { name: "Mute staff voice", exact: true })).toBeVisible();
      await expect(currentPage.locator(".npc-subtitle p")).toHaveText(clip.text);
      await until(`${actor}-signal-start`, actor, (value) => renderedSignal(value) && (!moving || value.scene.mouthMax > limits.mouth));
      const samples = await record(`${actor}-${moving ? "playing" : "reduced-motion"}`, actor);
      const active = samples.filter(renderedSignal); expect(active.length).toBeGreaterThanOrEqual(2);
      const source = latest(active[0] as Sample); if (source?.decoded === null || source?.decoded === undefined) throw new Error("Missing actual decoded buffer.");
      // Browser resampling can change buffer.sampleRate. Duration/mono/PCM and exact response hash remain authoritative.
      expect(Math.abs(source.decoded.duration - clip.duration_seconds)).toBeLessThan(0.05); expect(source.decoded.channels).toBe(1); expect(source.decoded.pcm.rms).toBeGreaterThan(limits.signalRms);
      expect(samples.every((value) => value.audio.activeSources <= 1)).toBe(true);
      if (moving) {
        expect(active.some((value) => value.scene.mouthMax > limits.mouth)).toBe(true);
        const variations = new Set(active.map((value) => value.scene.morphs.map((morph) => morph.value.toFixed(5)).join(",")));
        expect(variations.size).toBeGreaterThan(1); expect(active.every((value) => value.scene.frameloop === "always")).toBe(true);
      } else { expect(samples.every((value) => value.scene.mouthMax <= limits.mouth && value.scene.frameloop === "demand")).toBe(true); }
      const body = samples.map((value) => JSON.stringify({ root: value.scene.root, bones: value.scene.bones })); expect(new Set(body).size).toBe(1);
    };
    const stop = async (actor: string) => {
      await currentPage.getByRole("button", { name: "Stop staff voice", exact: true }).click();
      await until(`${actor}-stopped`, actor, (value) => closed(value) && value.scene.frameloop === "demand");
    };
    const check = async (name: string, action: () => Promise<void>) => {
      try { await action(); result.checks.push({ name, passed: true }); }
      catch (error) { result.checks.push({ name, passed: false }); throw error; }
      finally { await save(); }
    };

    const reception = await open("receptionist");
    await check("No staff source or audio asset before explicit click", async () => {
      const baseline = await sample("receptionist"); expect(baseline.audio.sources).toEqual([]); expect(result.assets).toEqual([]);
      expect(result.requests.some((request) => new URL(request.url).pathname.startsWith("/audio/staff-v1/"))).toBe(false); await shot("01-exact-reception-subtitle");
    });
    await check("Reception actual output, changing rendered lips, frozen body and Stop cleanup", async () => {
      await play("receptionist", reception); await shot("02-reception-playing"); await stop("receptionist"); await shot("03-reception-stopped");
    });
    await check("Post-gain mute, closed mouth/demand, unmute and one-speaker Stop", async () => {
      await play("receptionist", reception);
      await currentPage.getByRole("button", { name: "Mute staff voice", exact: true }).click();
      await until("receptionist-muted", "receptionist", (value) => { const source = latest(value); return value.audio.activeSources === 1 && source?.contextState === "running" && source.outputPath && source.gain === 0 && source.pcm !== null && source.pcm.rms <= limits.silentRms && value.scene.mouthMax <= limits.mouth && value.scene.frameloop === "demand"; });
      const muted = await record("receptionist-muted-held", "receptionist", 250);
      expect(muted.every((value) => value.audio.activeSources === 1 && latest(value)?.gain === 0 && (latest(value)?.pcm?.rms ?? Infinity) <= limits.silentRms && value.scene.mouthMax <= limits.mouth && value.scene.frameloop === "demand")).toBe(true);
      await shot("04-reception-muted");
      await currentPage.getByRole("button", { name: "Unmute staff voice", exact: true }).click();
      await until("receptionist-unmuted", "receptionist", (value) => renderedSignal(value) && value.scene.mouthMax > limits.mouth && value.scene.frameloop === "always");
      await stop("receptionist");
    });
    await check("Dialog close stops output before genuine exploration pause", async () => {
      await play("receptionist", reception); await closePanel(); await until("receptionist-panel-closed", "receptionist", closed);
      await currentPage.locator("canvas").focus(); await currentPage.keyboard.press("Escape");
      await expect(currentPage.getByText("EXPLORATION PAUSED", { exact: true })).toBeVisible();
      await until("receptionist-paused", "receptionist", (value) => closed(value) && value.scene.frameloop === "demand");
      await currentPage.getByRole("button", { name: "Resume", exact: true }).click();
    });
    const sergeant = await open("sergeant");
    await check("Second actor uses its exact asset, native output and real morphs", async () => {
      await play("sergeant", sergeant); await shot("05-sergeant-playing"); await stop("sergeant");
    });
    await check("Reduced motion retains genuine audio with closed mouth and demand rendering", async () => {
      await closePanel(); await currentPage.getByRole("button", { name: "Comfort and accessibility settings", exact: true }).click();
      await currentPage.getByRole("checkbox", { name: /^Reduced motion/u }).check(); await closePanel();
      const clip = await open("receptionist"); await play("receptionist", clip, false); await shot("06-reduced-motion-audio"); await stop("receptionist");
    });
    await Promise.all(pendingAssets);
    expect(result.assets.some((asset) => asset.url === reception.url)).toBe(true); expect(result.assets.some((asset) => asset.url === sergeant.url)).toBe(true);
    expect(result.blocked).toEqual([]); expect(result.guardViolations).toEqual([]); expect(result.errors).toEqual([]);
    await currentProbe.evaluate((value) => { value.restore(); }); await currentProbe.dispose(); probe = null;
    shuttingDown = true; await context.close(); context = null;
    if (video === null) throw new Error("Missing silent browser video."); result.video = await video.path();
    result.status = "passed-real-signal-and-rendered-morphs";
  } catch (error) {
    result.status = "failed"; result.errors.push(message(error));
    if (page !== null && !page.isClosed()) { try { await page.screenshot({ path: `${output}/failure.png`, fullPage: false, timeout: 5000 }); result.screenshots.push(`${output}/failure.png`); } catch (failure) { result.cleanupErrors.push(message(failure)); } }
  } finally {
    clearTimeout(watchdog); shuttingDown = true;
    if (probe !== null) { try { await probe.evaluate((value) => { value.restore(); }); await probe.dispose(); } catch (error) { result.cleanupErrors.push(message(error)); } }
    await context?.close().catch((error: unknown) => { result.cleanupErrors.push(message(error)); });
    await browser?.close().catch((error: unknown) => { result.cleanupErrors.push(message(error)); });
    await Promise.all(pendingAssets);
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    if (result.errors.length > 0 && result.status.startsWith("passed")) result.status = "failed";
    if (result.cleanupErrors.length > 0 && result.status.startsWith("passed")) result.status = "cleanup-review-required";
    await save(); console.log(`Staff audio ${result.status}: ${output}/staff-audio-report.json`);
    if (result.status !== "passed-real-signal-and-rendered-morphs") process.exitCode = 1;
  }
}
if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await smokePrecinctStaffAudio();
