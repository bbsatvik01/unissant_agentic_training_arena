/** Owned ephemeral browser, production loopback only. Functional QA, never an FPS benchmark.
 * Stage under final candidate web/tools; see EXECUTION-PLAN.md before running. */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { parseMinimapPosition } from "./precinct-capture-position.ts";
import { collectMinimapStability, minimapStabilityEvidence, type MinimapObservation } from "./precinct-minimap-stability.ts";
import { selectBenchmarkTheme, verifyBenchmarkTheme } from "./precinct-performance-theme.ts";
import { BOARD_POINT, FLOOR_DESTINATION, MATRIX, distance, movementEvidence, projectTarget, routingOptions, routingOutcome, type CameraMode, type Position, type Sample } from "./precinct-floor-routing-model.ts";
import type { PrecinctPerformanceApi } from "../src/components/precinct/precinctPerformanceTypes.ts";

type Probe = ReturnType<PrecinctPerformanceApi["status"]>;
type Check = { name: string; status: "passed" | "failed"; error: string | null };
type ColdEntry = { label: "initial default Office load"; originalGateMs: number; initialReady: boolean; initialFailure: string | null;
  initialGateElapsedMs: number | null; diagnosticOnly: boolean; followupLimitMs: number;
  followupReady: boolean | null; followupElapsedMs: number | null; failureEvidence: string[] };
type CaseReport = { scene: string; camera: CameraMode; status: "pending" | "running" | "cold-start-failed-observing" | "passed" | "functional-completed-cold-start-failed" | "failed";
  coldEntry: ColdEntry; routingComplete: boolean; functionalComplete: boolean;
  theme: { requested: "studio"; beforeEntry: string | null; afterFunctional: string | null };
  checks: Check[]; blocked: string[]; errors: string[]; captureErrors: string[]; screenshots: string[];
  samples: Sample[]; stationarySamples: { phase: string; samples: Sample[]; lateSamples: Sample[]; observation: MinimapObservation | null }[];
  clicks: { label: string; point: readonly [number, number, number]; pixel: ReturnType<typeof projectTarget>; camera: Probe }[];
  assets: { path: string; sha256: string }[]; renderer: unknown; movement: ReturnType<typeof movementEvidence> | null;
  monitor: "pending" | "passed" | "not-in-third-person-scope"; fatal: string | null };
const VIEWPORT = { width: 1440, height: 900 };
const ENTRY_MS = 5000, ACTION_MS = 10_000, MOVE_MS = 30_000, STILL_MS = 1500, CASE_MS = 120_000, FOLLOWUP_MS = 60_000;
const errorText = (error: unknown): string => error instanceof Error ? error.stack ?? error.message : String(error);
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function expectedAssets(root: string, prefix = ""): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlinked production artifact: ${path}`);
    if (entry.isDirectory()) for (const [name, digest] of await expectedAssets(root, path)) result.set(name, digest);
    else if (entry.isFile() && /\.(?:js|css|glb)$/u.test(path)) result.set(`/${path}`, hash(await readFile(join(root, path))));
  }
  if (prefix === "" && ![...result.keys()].some((path) => path.endsWith(".js"))) throw new Error("No production JavaScript artifact found.");
  return result;
}
async function probe(page: Page): Promise<Probe> {
  return await page.evaluate(() => { const value = window.__arenaPrecinctPerformance; if (value === undefined) throw new Error("Existing opt-in read-only probe is absent."); return value.status(); });
}
async function position(page: Page): Promise<Position> { return parseMinimapPosition(await page.locator(".precinct-minimap g").getAttribute("transform")); }
async function still(page: Page, result: CaseReport, phase: string, origin: Position): Promise<void> {
  const entry = { phase, samples: [] as Sample[], lateSamples: [] as Sample[], observation: null as MinimapObservation | null }; result.stationarySamples.push(entry);
  const startedEpochMs = performance.timeOrigin + performance.now();
  const observation = await page.evaluate(collectMinimapStability, { startedEpochMs, durationMs: STILL_MS, intervalMs: 150 });
  entry.observation = observation;
  const evidence = minimapStabilityEvidence(observation, origin);
  entry.samples = evidence.samples; entry.lateSamples = evidence.lateSamples;
  for (const actual of [...entry.samples, ...entry.lateSamples]) {
    expect(distance(origin, actual), `${phase}: unexpected route/movement`).toBeLessThanOrEqual(0.035);
  }
  expect(evidence.errors, `${phase}: public minimap observation failed`).toEqual([]);
  expect(evidence.completed, `${phase}: original observation window did not complete`).toBe(true);
  expect(observation.starved, `${phase}: sampler missed a full 150ms cadence interval`).toBe(false);
  expect(entry.samples.length).toBeGreaterThanOrEqual(3);
  expect(evidence.passed, `${phase}: insufficient stability evidence`).toBe(true);
}
async function closePanel(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0); await page.locator("canvas").focus();
}
async function clickPoint(page: Page, result: CaseReport, label: string, point: readonly [number, number, number], shot: (name: string) => Promise<void>): Promise<void> {
  await expect(page.getByRole("dialog")).toHaveCount(0); await page.locator("canvas").focus();
  const camera = await probe(page), rect = await page.locator("canvas").boundingBox();
  if (rect === null || !camera.production || !camera.visible || !camera.continuous || camera.active) throw new Error("Expected visible live production camera with no performance timing active.");
  const pixel = projectTarget(point, camera, result.camera, rect);
  const unobscured = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y) === document.querySelector("canvas"), pixel);
  expect(unobscured, "A DOM overlay obscures the projected target; refuse guessed fallback coordinates").toBe(true);
  result.clicks.push({ label, point, pixel, camera });
  // Existing app canvas only. Captured outside every performance measurement.
  await shot(`${label}-before`);
  const current = await probe(page);
  expect(Math.hypot(...current.cameraPosition.map((v, i) => v - (camera.cameraPosition[i] ?? 0)))).toBeLessThan(0.001);
  expect(Math.hypot(...current.cameraQuaternion.map((v, i) => v - (camera.cameraQuaternion[i] ?? 0)))).toBeLessThan(0.001);
  await page.mouse.click(pixel.x, pixel.y, { button: "left" });
}
async function guard(context: BrowserContext, origin: string, result: CaseReport): Promise<void> {
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin || /^\/api(?:\/|$)/u.test(decodeURIComponent(url.pathname)) || !["GET", "HEAD"].includes(request.method())) {
      result.blocked.push(`${request.method()} ${url.origin}${url.pathname}`); await route.abort("blockedbyclient");
    } else await route.continue();
  });
  await context.routeWebSocket("**/*", (socket) => { result.blocked.push("websocket"); void socket.close({ code: 1008, reason: "Offline functional acceptance refuses every socket." }).catch((error: unknown) => { result.errors.push(errorText(error)); }); });
}

export async function runFloorRouting(args = process.argv.slice(2)): Promise<0 | 1> {
  const options = routingOptions(args), expected = await expectedAssets(options.dist);
  const caseLimit = CASE_MS + (options.slowStartDiagnostic ? FOLLOWUP_MS : 0);
  await mkdir(options.output, { recursive: true });
  const report = { schema: "arena.precinct-floor-routing-qa.v3", status: "running", startedAt: new Date().toISOString(),
    options: { ...options, url: options.url.href }, requestedTheme: "studio", coldEntryScope: "initial default Office load, before Studio selection", viewport: VIEWPORT, browserVersion: "", checksExecuted: false, coldEntryPassed: false, routingComplete: false, functionalComplete: false,
    limits: { coldStartMs: ENTRY_MS, actionMs: ACTION_MS, routeMs: MOVE_MS, stabilityMs: STILL_MS, caseMs: caseLimit, originalCaseMs: CASE_MS, optionalColdFollowupMs: FOLLOWUP_MS },
    proof: "Real pointer input through R3F, actual minimap intermediate displacement and endpoint, observable board/monitor dialog precedence and post-close stability. No private state access or callbacks invoked.",
    limitsOfProof: "No FPS/GPU/hardware acceptance; no direct handler-invocation count; no guarantee against a hidden floor handler whose destination is rejected. Third-person monitor and dynamic/obstacle navigation remain unexercised.",
    cases: [] as CaseReport[], fatal: null as string | null };
  const save = async () => { await writeFile(join(options.output, "routing-report.json"), `${JSON.stringify(report, null, 2)}\n`); };
  let browser: Browser | null = null;
  const interruption: { occurred: boolean } = { occurred: false };
  const interrupt = () => { interruption.occurred = true; void browser?.close().catch((error: unknown) => { report.fatal = errorText(error); }); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    const executablePath = process.env["ARENA_CHROMIUM_PATH"];
    browser = await chromium.launch({ headless: !options.headed, timeout: ACTION_MS,
      ...(executablePath === undefined ? {} : { executablePath }),
      args: options.software ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-background-networking"] : ["--disable-background-networking"] });
    report.browserVersion = browser.version();
    for (const { scene, camera } of MATRIX) {
      if (interruption.occurred) throw new Error("Interrupted; remaining cases are not passed.");
      const result: CaseReport = { scene, camera, status: "running", coldEntry: {
        label: "initial default Office load", originalGateMs: ENTRY_MS, initialReady: false, initialFailure: null, initialGateElapsedMs: null,
        diagnosticOnly: options.slowStartDiagnostic, followupLimitMs: FOLLOWUP_MS,
        followupReady: null, followupElapsedMs: null, failureEvidence: [],
      }, routingComplete: false, functionalComplete: false, theme: { requested: "studio", beforeEntry: null, afterFunctional: null }, checks: [], blocked: [], errors: [], captureErrors: [], screenshots: [], samples: [], stationarySamples: [], clicks: [], assets: [], renderer: null, movement: null, monitor: camera === "first" ? "pending" : "not-in-third-person-scope", fatal: null }; report.cases.push(result);
      const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: "no-preference", serviceWorkers: "block", permissions: [] });
      let page: Page | null = null;
      const timeoutState: { occurred: boolean } = { occurred: false };
      const timer = setTimeout(() => { timeoutState.occurred = true; result.errors.push(`Case exceeded its fixed ${String(caseLimit)}ms wall-clock limit.`); void context.close().catch((error: unknown) => { result.errors.push(errorText(error)); }); }, caseLimit);
      const assetReads: Promise<void>[] = [];
      const check = async (name: string, operation: () => Promise<void>) => {
        try { await operation(); result.checks.push({ name, status: "passed", error: null }); }
        catch (error) { result.checks.push({ name, status: "failed", error: errorText(error) }); throw error; }
        finally { await save(); }
      };
      try {
        await guard(context, options.url.origin, result);
        const live = await context.newPage(); page = live; live.setDefaultTimeout(ACTION_MS); live.setDefaultNavigationTimeout(ACTION_MS);
        live.on("pageerror", (error) => { result.errors.push(errorText(error)); });
        live.on("console", (entry) => { if (entry.type() === "error") result.errors.push(entry.text()); });
        live.on("requestfailed", (request) => { result.errors.push(`Request failed: ${new URL(request.url()).pathname}: ${request.failure()?.errorText ?? "unknown"}`); });
        live.on("response", (response) => {
          const path = new URL(response.url()).pathname;
          if (response.status() >= 400) result.errors.push(`HTTP ${String(response.status())}: ${path}`);
          if (response.ok() && /\.(?:js|css|glb)$/u.test(path)) assetReads.push(response.body().then((body) => {
            const sha256 = hash(body); result.assets.push({ path, sha256 });
            if (expected.get(path) !== sha256) result.errors.push(`Served bytes differ from final --dist artifact: ${path}`);
          }).catch((error: unknown) => { result.errors.push(errorText(error)); }));
        });
        const shot = async (name: string) => { const filename = `${scene}-${camera}-${name}.png`; await live.screenshot({ path: join(options.output, filename), timeout: ACTION_MS }); result.screenshots.push(filename); };
        await live.goto(options.url.href, { waitUntil: "domcontentloaded" });
        const entryStarted = performance.now();
        let coldStartError: Error | undefined;
        try {
          await expect(live.getByRole("button", { name: "Enter the precinct", exact: true })).toBeEnabled({ timeout: ENTRY_MS });
          result.coldEntry.initialReady = true;
          result.checks.push({ name: "unchanged 5-second entry readiness: initial default Office load", status: "passed", error: null });
        } catch (error) {
          coldStartError = error instanceof Error ? error : new Error(errorText(error));
          result.coldEntry.initialFailure = errorText(error);
          result.checks.push({ name: "unchanged 5-second entry readiness: initial default Office load", status: "failed", error: errorText(error) });
        } finally { result.coldEntry.initialGateElapsedMs = performance.now() - entryStarted; }
        await save();
        if (coldStartError !== undefined) {
          if (!options.slowStartDiagnostic) throw coldStartError;
          result.status = "cold-start-failed-observing";
          // Immutable failure snapshot precedes screenshots and every passive follow-up wait.
          const prefix = `${scene}-${camera}-cold-start-failure`;
          await writeFile(join(options.output, `${prefix}.json`), `${JSON.stringify(result, null, 2)}\n`);
          result.coldEntry.failureEvidence.push(`${prefix}.json`); await save();
          try { await writeFile(join(options.output, `${prefix}.html`), await live.content()); result.coldEntry.failureEvidence.push(`${prefix}.html`); }
          catch (error) { result.captureErrors.push(`Cold-start DOM unavailable: ${errorText(error)}`); }
          try { await shot("cold-start-failure"); result.coldEntry.failureEvidence.push(`${prefix}.png`); }
          catch (error) { result.captureErrors.push(`Cold-start screenshot unavailable: ${errorText(error)}`); }
          const followupStarted = performance.now();
          try {
            await expect(live.getByRole("button", { name: "Enter the precinct", exact: true })).toBeEnabled({ timeout: FOLLOWUP_MS });
            result.coldEntry.followupReady = true;
          } catch {
            result.coldEntry.followupReady = false; throw coldStartError;
          } finally { result.coldEntry.followupElapsedMs = performance.now() - followupStarted; await save(); }
          // Keep the failed initial check and original failure forever. Continue only to collect
          // independent functional evidence; case/overall acceptance cannot become a pass.
        }
        await check("normal settings select Studio, architecture, low quality and reduced motion", async () => {
          await live.getByRole("button", { name: "Comfort and accessibility settings", exact: true }).click();
          await selectBenchmarkTheme(live, "studio");
          const architecture = live.getByRole("combobox", { name: /^Architecture/u }); await architecture.selectOption(scene); await expect(architecture).toHaveValue(scene);
          await live.getByRole("combobox", { name: /Rendering quality/u }).selectOption("low");
          await live.getByRole("checkbox", { name: /^Reduced motion/u }).check();
          await closePanel(live);
          result.theme.beforeEntry = await live.locator(".precinct-root").getAttribute("data-theme");
          verifyBenchmarkTheme(result.theme.beforeEntry, "studio");
          await expect(live.getByRole("button", { name: "Enter the precinct", exact: true })).toBeEnabled({ timeout: ENTRY_MS });
          await live.getByRole("button", { name: "Enter the precinct", exact: true }).click(); await live.bringToFront();
          await expect(live.locator("canvas")).toHaveCount(1); await live.locator("canvas").focus();
          await expect.poll(async () => distance(await position(live), { x: 0, z: -4.2 }), { timeout: ACTION_MS }).toBeLessThan(0.03);
          if (camera === "third") await live.keyboard.press("KeyV");
          await expect(live.locator(".precinct-controls")).toContainText(camera === "third" ? "Third person" : "First person");
          await expect.poll(async () => (await probe(live)).calls, { timeout: ACTION_MS }).toBeGreaterThan(0);
          const diagnostic = await probe(live); expect(diagnostic.production).toBe(true); expect(diagnostic.tier).toBe("low");
          expect(diagnostic.sceneAsset).toBe(scene === "office" ? "/world/precinct.glb" : "/world/precinct-courtyard.glb");
          expect(diagnostic.active).toBe(false);
          result.renderer = await live.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
            const gl = canvas.getContext("webgl2"); if (gl === null || gl.isContextLost()) throw new Error("Live WebGL required.");
            const ext = gl.getExtension("WEBGL_debug_renderer_info"); return { version: String(gl.getParameter(gl.VERSION)), renderer: String(gl.getParameter(gl.RENDERER)), unmasked: ext === null ? null : String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) };
          });
          await still(live, result, "settled-normal-arrival", await position(live));
        });
        await check("board receives actual scene clicks with no movement after each close", async () => {
          const before = await position(live);
          for (const attempt of [1, 2]) {
            await clickPoint(live, result, `board-${String(attempt)}`, BOARD_POINT, shot);
            await expect(live.getByRole("dialog", { name: "Case board", exact: true })).toBeVisible();
            expect(distance(before, await position(live))).toBeLessThanOrEqual(0.035);
            await shot(`board-${String(attempt)}-opened`); await closePanel(live);
            await still(live, result, `board-${String(attempt)}-closed`, before);
          }
        });
        await check("real floor click produces intermediate player movement and arrival", async () => {
          const before = await position(live), destination = { x: FLOOR_DESTINATION[0], z: FLOOR_DESTINATION[2] };
          await still(live, result, "pre-floor-idle", before);
          await clickPoint(live, result, "floor", FLOOR_DESTINATION, shot);
          const started = performance.now();
          await expect.poll(async () => {
            result.samples.push({ ...await position(live), elapsedMs: performance.now() - started });
            result.movement = movementEvidence(before, destination, result.samples); return result.movement.passed && result.movement.endpointError <= 0.01;
          }, { timeout: MOVE_MS, intervals: [150] }).toBe(true);
          await expect(live.getByRole("dialog")).toHaveCount(0);
          await still(live, result, "arrived-floor-endpoint", await position(live)); await shot("floor-arrived");
          result.routingComplete = true;
        });
        if (camera === "first") await check("offline physical monitor opens correct pane and leaves no residual movement", async () => {
          // Only documented UI shortcuts, public dossier selection and scene-only intercom.
          await live.locator("canvas").focus(); await live.keyboard.press("Digit2");
          await expect.poll(async () => distance(await position(live), { x: 8.2, z: -7.4 })).toBeLessThan(0.03);
          await live.keyboard.press("KeyE"); await expect(live.getByRole("dialog", { name: "Case board", exact: true })).toBeVisible();
          await live.getByRole("button", { name: "Select case", exact: true }).click();
          await expect(live.getByText("Your public packet is ready at your desk.", { exact: true })).toBeVisible(); await closePanel(live);
          await live.keyboard.press("Digit6");
          await expect.poll(async () => distance(await position(live), { x: 5.7, z: -12.5 })).toBeLessThan(0.03);
          await live.keyboard.press("KeyE");
          await live.getByRole("button", { name: "Call subject to room", exact: true }).click();
          await expect(live.getByText("Subject called to the interview room.", { exact: true })).toBeVisible(); await closePanel(live);
          await live.keyboard.press("Digit7");
          await expect.poll(async () => distance(await position(live), { x: 10.4, z: -18.6 })).toBeLessThan(0.03);
          const before = await position(live); await still(live, result, "monitor-approach", before);
          // Rotation Y=pi places UV(.25,.75), the Agent office pane, at world +X,+Y.
          await clickPoint(live, result, "monitor-office-pane", [11.154, 1.208, -16.787], shot);
          await expect(live.getByRole("dialog", { name: "Agent office", exact: true })).toBeVisible();
          await expect(live.getByLabel("Agent office expanded", { exact: true })).toBeVisible(); await shot("monitor-expanded");
          await live.getByRole("button", { name: "Back to four screens", exact: true }).click(); await closePanel(live);
          await still(live, result, "monitor-closed", before); result.monitor = "passed";
        });
        await check("fixed Studio theme remains applied after functional checks", async () => {
          result.theme.afterFunctional = await live.locator(".precinct-root").getAttribute("data-theme");
          verifyBenchmarkTheme(result.theme.afterFunctional, "studio");
        });
        await check("zero backend/external/socket attempts and exact served artifact bytes", async () => {
          await Promise.all(assetReads); expect(result.blocked).toEqual([]); expect(result.errors).toEqual([]);
          expect(result.assets.some((asset) => asset.path.endsWith(".js"))).toBe(true);
          expect(result.assets.some((asset) => asset.path === (scene === "office" ? "/world/precinct.glb" : "/world/precinct-courtyard.glb"))).toBe(true);
        });
        result.functionalComplete = true;
        result.status = routingOutcome(result.coldEntry.initialReady, result.functionalComplete).status;
      } catch (error) {
        result.status = "failed"; result.fatal = errorText(error); await save();
        if (page !== null && !timeoutState.occurred) {
          try { await page.screenshot({ path: join(options.output, `${scene}-${camera}-failure.png`), timeout: ACTION_MS }); result.screenshots.push(`${scene}-${camera}-failure.png`); }
          catch (captureError) { result.captureErrors.push(errorText(captureError)); }
          try { await writeFile(join(options.output, `${scene}-${camera}-failure.html`), await page.content()); }
          catch (captureError) { result.captureErrors.push(errorText(captureError)); }
        }
      } finally {
        clearTimeout(timer); await context.close().catch((error: unknown) => { result.status = "failed"; result.errors.push(errorText(error)); });
        await Promise.all(assetReads);
        if (result.errors.length > 0 || result.blocked.length > 0) { result.status = "failed"; result.functionalComplete = false; }
        await save();
      }
    }
    report.checksExecuted = true;
    const allCases = !interruption.occurred && report.cases.length === MATRIX.length;
    report.coldEntryPassed = allCases && report.cases.every((item) => item.coldEntry.initialReady);
    report.routingComplete = allCases && report.cases.every((item) => item.routingComplete);
    report.functionalComplete = allCases && report.cases.every((item) => item.functionalComplete);
    report.status = routingOutcome(report.coldEntryPassed, report.functionalComplete).status;
  } catch (error) { report.status = "failed"; report.fatal = errorText(error); }
  finally {
    if (browser !== null) await browser.close().catch((error: unknown) => { report.status = "failed"; report.fatal = errorText(error); });
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); await save();
  }
  console.log(JSON.stringify({ status: report.status, coldEntryPassed: report.coldEntryPassed, routingComplete: report.routingComplete, functionalComplete: report.functionalComplete, report: join(options.output, "routing-report.json") }));
  return report.status === "passed" ? 0 : 1;
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await runFloorRouting();
