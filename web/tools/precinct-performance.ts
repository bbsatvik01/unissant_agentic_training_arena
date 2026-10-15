/** Production-only, loopback-only render benchmark. Uses real keyboard input, no synthetic FPS.
 * Does not connect a backend, microphone, model, cloud service, or the user's computer. */
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { arch, cpus, platform, release, tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect, type Browser, type Page, type Request } from "@playwright/test";
import type { PrecinctPerformanceReport } from "../src/components/precinct/precinctPerformanceTypes.ts";

export function benchmarkOptions(args: readonly string[]) {
  const values = new Map<string, string>();
  for (const arg of args) {
    const match = /^--([a-z-]+)(?:=(.*))?$/u.exec(arg);
    if (match === null || match[1] === undefined || values.has(match[1])) throw new Error(`Invalid or duplicate option: ${arg}`);
    values.set(match[1], match[2] ?? "true");
  }
  const allowed = new Set(["url", "out", "seconds", "warmup", "scene", "tier", "camera", "software", "headed", "viewport", "dpr", "machine-label", "readiness-diagnostics", "slow-start-diagnostic"]);
  for (const key of values.keys()) if (!allowed.has(key)) throw new Error(`Unknown option: --${key}`);
  const url = new URL(values.get("url") ?? "http://127.0.0.1:4173/");
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw new Error("Use a credential-free loopback URL without query or hash.");
  const number = (name: string, fallback: number, min: number, max: number) => {
    const value = Number(values.get(name) ?? fallback);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid --${name}; allowed ${String(min)}..${String(max)}.`);
    return value;
  };
  const seconds = number("seconds", 60, 60, 600), warmup = number("warmup", 15, 5, 120), dpr = number("dpr", 2, 0.5, 4);
  const scene = values.get("scene") ?? "office", tier = values.get("tier") ?? "medium", camera = values.get("camera") ?? "third";
  if (scene !== "office" && scene !== "courtyard") throw new Error("Invalid --scene.");
  if (!["low", "medium", "high", "adaptive"].includes(tier)) throw new Error("Invalid --tier.");
  if (camera !== "first" && camera !== "third") throw new Error("Invalid --camera.");
  const viewport = /^(\d{3,4})x(\d{3,4})$/u.exec(values.get("viewport") ?? "1440x900");
  if (viewport === null) throw new Error("Use --viewport=WIDTHxHEIGHT.");
  const width = Number(viewport[1]), height = Number(viewport[2]);
  if (width < 800 || width > 3840 || height < 600 || height > 2160) throw new Error("Viewport outside supported benchmark bounds.");
  for (const flag of ["software", "headed", "readiness-diagnostics", "slow-start-diagnostic"]) if (values.has(flag) && values.get(flag) !== "true") throw new Error(`Use --${flag} without a value.`);
  if (values.has("readiness-diagnostics") && values.has("slow-start-diagnostic")) throw new Error("Choose only one startup diagnostic mode.");
  url.searchParams.set("precinctPerf", "1"); if (tier !== "adaptive") url.searchParams.set("precinctPerfPinned", "1");
  return { url, output: resolve(values.get("out") ?? `${tmpdir()}/arena-performance-${new Date().toISOString().replaceAll(":", "-")}`),
    seconds, warmup, dpr, scene, tier, camera, viewport: { width, height }, software: values.has("software"), headed: values.has("headed"), readinessDiagnostics: values.has("readiness-diagnostics"), slowStartDiagnostic: values.has("slow-start-diagnostic"),
    machineLabel: values.get("machine-label") ?? "Not supplied; device model unverified" };
}

export function evaluateRenderBudget(report: PrecinctPerformanceReport, requestedSeconds: number) {
  const frames = report.frameIntervalMs;
  const complete = report.production && report.durationMs >= requestedSeconds * 1000 && report.framesRendered > 1
    && report.hiddenFrames === 0 && report.demandFrames === 0 && report.visibilityInterruptions === 0 && frames.dropped === 0
    && !report.renderer.contextLost && (report.drawCalls.p50 ?? 0) > 0 && (report.triangles.p50 ?? 0) > 0;
  const timingPassed = complete && (report.averageRenderedFps ?? 0) >= 58 && (frames.p50 ?? Infinity) <= 17.5
    && (frames.p95 ?? Infinity) <= 20 && (frames.p99 ?? Infinity) <= 1000 / 30
    && report.intervalsOver33_34Ms <= frames.samples * 0.01;
  return { complete, timingPassed,
    result: report.renderer.softwareRenderer ? "software-renderer diagnostic only; no hardware acceptance" : timingPassed ? "measured frame-pacing budget passed on this renderer" : "measured frame-pacing budget not met",
    targetHardwareAcceptance: "Not inferred. Verify the MacBook Air M5 model, native browser, power/thermal state and a >=300-second run before claiming that target.",
    thresholds: { averageRenderedFpsMin: 58, frameIntervalP50MaxMs: 17.5, frameIntervalP95MaxMs: 20, frameIntervalP99MaxMs: 1000 / 30, over33_34MsFractionMax: 0.01 } };
}

export function steadyStateOutcome(coldStartPassed: boolean): { status: string; exitCode: 0 | 1 } {
  return coldStartPassed ? { status: "completed", exitCode: 0 }
    : { status: "steady-state-completed-cold-start-failed", exitCode: 1 };
}

type Position = { x: number; z: number };
async function playerPosition(page: Page): Promise<Position> {
  const transform = await page.locator(".precinct-minimap g").getAttribute("transform");
  const match = /^translate\(([-\d.]+) ([-\d.]+)\)/u.exec(transform ?? "");
  const x = Number(match?.[1]), z = Number(match?.[2]);
  if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error("Visible player minimap position is missing.");
  return { x, z };
}
async function status(page: Page) {
  return await page.evaluate(() => {
    if (window.__arenaPrecinctPerformance === undefined) throw new Error("Opt-in renderer probe is missing.");
    return window.__arenaPrecinctPerformance.status();
  });
}
const errorText = (error: unknown) => error instanceof Error ? error.stack ?? error.message : String(error);

export async function benchmarkPrecinct(args = process.argv.slice(2)): Promise<0 | 1> {
  const options = benchmarkOptions(args); await mkdir(options.output, { recursive: true });
  const movement: { key: string; before: Position; after: Position; distance: number }[] = [];
  const turns: { key: string; quaternionDistance: number }[] = [];
  const errors: string[] = [], blockedRequests: string[] = [];
  const buildAssets: { path: string; bytes: number; sha256: string }[] = [];
  const assetReads: Promise<void>[] = [];
  let measuring = false;
  const processStarted = performance.now();
  const requests: { path: string; resourceType: string; startedMs: number; responseMs: number | null; finishedMs: number | null;
    status: number | null; failure: string | null; timing: ReturnType<Request["timing"]> | null }[] = [];
  const requestEntries = new Map<Request, (typeof requests)[number]>();
  const readiness = { originalGateMs: 5000, initialReady: false, initialFailure: null as string | null, initialGateElapsedMs: null as number | null,
    diagnosticOnly: options.readinessDiagnostics, slowStartDiagnostic: options.slowStartDiagnostic, captureErrors: [] as string[], followupLimitMs: 60_000, followupReady: null as boolean | null,
    followupElapsedMs: null as number | null, failureEvidence: [] as string[] };
  let phase = "launch";
  let browser: Browser | null = null, page: Page | null = null;
  let report: PrecinctPerformanceReport | null = null;
  const artifact = { status: "running", readiness, requests, buildAssets, loadedArtifactFingerprint: null as string | null, options: { ...options, url: options.url.href }, browserVersion: "", movement, turns, errors, blockedRequests,
    host: { platform: platform(), release: release(), arch: arch(), cpuModels: [...new Set(cpus().map((cpu) => cpu.model))] },
    protocol: "Production app, no video/screenshot during timed interval, warmed assets, real Playwright keyboard holds, visible minimap displacement assertions. This does not validate live backend/model behavior.",
    report: report as PrecinctPerformanceReport | null, evaluation: null as ReturnType<typeof evaluateRenderBudget> | null };
  const save = async () => { await writeFile(`${options.output}/performance-report.json`, `${JSON.stringify(artifact, null, 2)}\n`); };
  try {
    const executablePath = process.env["ARENA_CHROMIUM_PATH"];
    browser = await chromium.launch({ headless: !options.headed, ...(executablePath === undefined ? {} : { executablePath }),
      args: options.software ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-background-networking"] : ["--disable-background-networking"] });
    artifact.browserVersion = browser.version();
    const context = await browser.newContext({ viewport: options.viewport, deviceScaleFactor: options.dpr, reducedMotion: "no-preference", serviceWorkers: "block", permissions: [] });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== options.url.origin || /^\/api(?:\/|$)/u.test(url.pathname)) {
        blockedRequests.push(`${url.origin}${url.pathname}`); await route.abort("blockedbyclient");
      } else await route.continue();
    });
    await context.routeWebSocket("**/*", (socket) => {
      blockedRequests.push("websocket"); void socket.close({ code: 1008, reason: "Production render benchmark allows no sockets." });
    });
    page = await context.newPage(); page.setDefaultTimeout(60_000);
    page.on("request", (request) => {
      if (measuring || requests.length >= 2000) return;
      const entry = { path: new URL(request.url()).pathname, resourceType: request.resourceType(), startedMs: performance.now() - processStarted,
        responseMs: null, finishedMs: null, status: null, failure: null, timing: null };
      requests.push(entry); requestEntries.set(request, entry);
    });
    page.on("requestfinished", (request) => {
      const entry = requestEntries.get(request); if (entry === undefined) return;
      entry.finishedMs = performance.now() - processStarted; entry.timing = request.timing(); requestEntries.delete(request);
    });
    page.on("requestfailed", (request) => {
      const entry = requestEntries.get(request); if (entry === undefined) return;
      entry.finishedMs = performance.now() - processStarted; entry.failure = request.failure()?.errorText ?? "Unknown failure";
      entry.timing = request.timing(); requestEntries.delete(request);
    });
    page.on("pageerror", (error) => { errors.push(errorText(error)); });
    page.on("console", (entry) => { if (entry.type() === "error") errors.push(entry.text()); });
    page.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      const entry = requestEntries.get(response.request());
      if (entry !== undefined) { entry.responseMs = performance.now() - processStarted; entry.status = response.status(); }
      if (response.status() >= 400) errors.push(`${String(response.status())} ${path}`);
      if (response.ok() && /\.(?:js|css|glb|json|png|jpe?g|webp|ktx2|wasm|woff2)$/u.test(path)) {
        if (measuring) errors.push(`Asset arrived during steady-state measurement: ${path}`);
        assetReads.push(response.body().then((body) => { buildAssets.push({ path, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") }); })
          .catch((error: unknown) => { errors.push(`Cannot fingerprint ${path}: ${errorText(error)}`); }));
      }
    });
    await page.goto(options.url.href, { waitUntil: "domcontentloaded" });
    phase = "entry-readiness";
    const entryStarted = performance.now();
    let coldStartError: Error | undefined;
    try { await expect(page.getByRole("button", { name: "Enter the precinct", exact: true })).toBeEnabled({ timeout: readiness.originalGateMs }); readiness.initialReady = true; }
    catch (error) { coldStartError = error instanceof Error ? error : new Error(errorText(error)); readiness.initialFailure = errorText(error); }
    finally { readiness.initialGateElapsedMs = performance.now() - entryStarted; }
    if (coldStartError !== undefined) {
      if (!options.slowStartDiagnostic) throw coldStartError;
      artifact.status = "cold-start-failed-observing";
      await writeFile(`${options.output}/cold-start-failure.json`, `${JSON.stringify(artifact, null, 2)}\n`);
      await save();
      try { await writeFile(`${options.output}/cold-start-failure.html`, await page.content()); readiness.failureEvidence.push("cold-start-failure.html"); }
      catch (captureError) { readiness.captureErrors.push(`Cold-start DOM unavailable: ${errorText(captureError)}`); }
      try { await page.screenshot({ path: `${options.output}/cold-start-failure.png`, timeout: 10_000 }); readiness.failureEvidence.push("cold-start-failure.png"); }
      catch (captureError) { readiness.captureErrors.push(`Cold-start screenshot unavailable: ${errorText(captureError)}`); }
      const followupStarted = performance.now();
      try { await expect(page.getByRole("button", { name: "Enter the precinct", exact: true })).toBeEnabled({ timeout: readiness.followupLimitMs }); readiness.followupReady = true; }
      catch { readiness.followupReady = false; throw coldStartError; }
      finally { readiness.followupElapsedMs = performance.now() - followupStarted; }
    }
    if (options.readinessDiagnostics) {
      await page.screenshot({ path: `${options.output}/ready.png`, timeout: 10_000 });
      await writeFile(`${options.output}/ready.html`, await page.content());
      artifact.status = "readiness-diagnostic-ready"; await save(); return 0;
    }
    phase = "configure-and-warm";
    await page.getByRole("button", { name: "Comfort and accessibility settings", exact: true }).click();
    const architecture = page.getByRole("combobox", { name: /^Architecture/u });
    if (await architecture.count() > 0) await architecture.selectOption(options.scene);
    else if (options.scene !== "office") throw new Error("Courtyard selector is absent from this build.");
    await page.getByRole("combobox", { name: /Rendering quality/u }).selectOption(options.tier === "adaptive" ? "high" : options.tier);
    await page.getByRole("button", { name: "Close panel", exact: true }).click();
    await page.getByRole("button", { name: "Enter the precinct", exact: true }).click();
    await expect(page.locator("canvas")).toHaveCount(1); await page.bringToFront(); await page.locator("canvas").focus();
    await expect.poll(async () => (await status(page as Page)).calls).toBeGreaterThan(0);
    if (!(await status(page)).production) throw new Error("Refusing development-server FPS. Build production and serve dist with vite preview.");
    if (options.camera === "third") { await page.keyboard.press("KeyV"); await expect(page.locator(".precinct-controls")).toContainText("Third person"); }
    await page.waitForLoadState("networkidle"); await Promise.all(assetReads); await page.waitForTimeout(options.warmup * 1000);
    const initial = await page.evaluate(() => window.__arenaPrecinctPerformance?.snapshot());
    if (initial === undefined || initial.renderer.contextLost) throw new Error("Renderer unavailable.");
    expect(initial.sceneAsset).toBe(options.scene === "courtyard" ? "/world/precinct-courtyard.glb" : "/world/precinct.glb");
    if (!options.software && initial.renderer.softwareRenderer) throw new Error("Hardware run resolved to a software renderer. Use --software for an explicitly labelled diagnostic.");
    if (options.tier !== "adaptive" && (await status(page)).tier !== options.tier) throw new Error("Requested pinned tier was not applied.");
    expect(await page.evaluate(() => document.hasFocus())).toBe(true);
    phase = "measurement"; measuring = true;
    await page.evaluate(() => { window.__arenaPrecinctPerformance?.start(); });
    const started = performance.now();
    const walk = async (key: "KeyW" | "KeyS", returnTo?: Position) => {
      if (page === null) throw new Error("Browser closed.");
      const targetPage = page, before = await playerPosition(targetPage);
      await targetPage.keyboard.down(key);
      try {
        await expect.poll(async () => {
          const current = await playerPosition(targetPage);
          if (returnTo === undefined) return Math.hypot(current.x - before.x, current.z - before.z) > 0.75;
          return (current.x - returnTo.x) * (before.x - returnTo.x) + (current.z - returnTo.z) * (before.z - returnTo.z) <= 0;
        }, { timeout: 30_000, intervals: [100] }).toBe(true);
      }
      finally { await targetPage.keyboard.up(key); }
      const after = await playerPosition(targetPage); movement.push({ key, before, after, distance: Math.hypot(after.x - before.x, after.z - before.z) });
    };
    const turn = async (key: "ArrowLeft" | "ArrowRight") => {
      if (page === null) throw new Error("Browser closed.");
      const targetPage = page, before = (await status(targetPage)).cameraQuaternion;
      await targetPage.keyboard.down(key); let distance = 0;
      try { await expect.poll(async () => { const after = (await status(targetPage)).cameraQuaternion; distance = Math.hypot(...after.map((value, index) => value - (before[index] ?? 0))); return distance; }, { timeout: 30_000, intervals: [100] }).toBeGreaterThan(0.15); }
      finally { await targetPage.keyboard.up(key); }
      turns.push({ key, quaternionDistance: distance });
    };
    await turn("ArrowLeft"); await turn("ArrowRight");
    // Reversing the same real walking axis keeps the route away from walls. No fast travel.
    const anchor = await playerPosition(page);
    do { await walk("KeyW"); await walk("KeyS", anchor); } while (performance.now() - started < options.seconds * 1000);
    report = await page.evaluate(() => { if (window.__arenaPrecinctPerformance === undefined) throw new Error("Probe lost during run."); return window.__arenaPrecinctPerformance.stop(); });
    measuring = false; await Promise.all(assetReads);
    buildAssets.sort((a, b) => a.path.localeCompare(b.path));
    artifact.loadedArtifactFingerprint = createHash("sha256").update(JSON.stringify(buildAssets)).digest("hex");
    artifact.report = report; artifact.evaluation = evaluateRenderBudget(report, options.seconds);
    expect(blockedRequests, "The offline render benchmark must not attempt backend/external traffic").toEqual([]);
    expect(errors, "Renderer/runtime errors invalidate measurement").toEqual([]);
    expect(movement.length).toBeGreaterThanOrEqual(2); expect(turns).toHaveLength(2);
    expect(artifact.evaluation.complete, "Insufficient or contaminated production measurement").toBe(true);
    // Evidence capture is deliberately outside the timed sample.
    await page.screenshot({ path: `${options.output}/after-measurement.png` });
    const outcome = steadyStateOutcome(readiness.initialReady); artifact.status = outcome.status; await save();
    console.log(JSON.stringify({ output: options.output, evaluation: artifact.evaluation, frameIntervalMs: report.frameIntervalMs, drawCalls: report.drawCalls, triangles: report.triangles, coldStartPassed: readiness.initialReady, status: outcome.status }, null, 2));
    return outcome.exitCode;
  } catch (error) {
    errors.push(errorText(error)); artifact.status = "failed";
    // Preserve the original failure before any optional, diagnostic-only passive wait.
    await save();
    if (page !== null) {
      try { await writeFile(`${options.output}/failure.html`, await page.content()); readiness.failureEvidence.push("failure.html"); }
      catch (captureError) { errors.push(`Failure DOM unavailable: ${errorText(captureError)}`); }
      try { await page.screenshot({ path: `${options.output}/failure.png`, timeout: 10_000 }); readiness.failureEvidence.push("failure.png"); }
      catch (captureError) { errors.push(`Failure screenshot unavailable: ${errorText(captureError)}`); }
      if (options.readinessDiagnostics && phase === "entry-readiness") {
        const followupStarted = performance.now();
        try { await expect(page.getByRole("button", { name: "Enter the precinct", exact: true })).toBeEnabled({ timeout: readiness.followupLimitMs }); readiness.followupReady = true; }
        catch { readiness.followupReady = false; }
        readiness.followupElapsedMs = performance.now() - followupStarted;
        try {
          await writeFile(`${options.output}/after-readiness-observation.html`, await page.content());
          await page.screenshot({ path: `${options.output}/after-readiness-observation.png`, timeout: 10_000 });
          readiness.failureEvidence.push("after-readiness-observation.html", "after-readiness-observation.png");
        } catch (captureError) { errors.push(`Follow-up evidence unavailable: ${errorText(captureError)}`); }
      }
      try { artifact.report = await page.evaluate(() => window.__arenaPrecinctPerformance?.stop() ?? null); }
      catch (snapshotError) { errors.push(`Final diagnostic unavailable: ${errorText(snapshotError)}`); }
    }
    await save(); throw error;
  } finally { await browser?.close(); }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  benchmarkPrecinct().then((exitCode) => { process.exitCode = exitCode; }).catch((error: unknown) => { console.error(errorText(error)); process.exitCode = 1; });
}
