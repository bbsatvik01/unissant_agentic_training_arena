/** Read-only local browser visual acceptance. Real UI input; no backend, audio, microphone or fabricated frames. */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect, type Browser, type JSHandle, type Page } from "@playwright/test";
import { parseMinimapPosition } from "./precinct-capture-position.ts";
import type { PrecinctPerformanceApi, PrecinctPerformanceReport } from "../src/components/precinct/precinctPerformanceTypes.ts";

const target = new URL(process.env["ARENA_PREVIEW_URL"] ?? "http://127.0.0.1:5185/");
if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.username !== "" || target.password !== "" || target.search !== "" || target.hash !== "") throw new Error("Credential-free loopback URL required.");
if (process.argv.slice(2).join(" ") !== "--capture-overview") throw new Error("Use --capture-overview in the authorized local browser lane.");
target.searchParams.set("precinctPerf", "1"); target.searchParams.set("precinctPerfPinned", "1");
const output = resolve(process.env["ARENA_SCENE_OUTPUT"] ?? "/tmp/arena-precinct-overview");
await mkdir(output, { recursive: true });
const report = { status: "running", description: "Actual cloud browser screenshots and real keyboard/settings interactions; Low quality. No hardware FPS, backend, audio or replay acceptance is implied.", errors: [] as string[], blocked: [] as string[], cleanupErrors: [] as string[], routeReached: false, movement: null as PrecinctPerformanceReport | null, progress: [] as { at: number; x: number; z: number; focused: boolean; activeTag: string; visible: boolean; continuous: boolean; frameCount: number }[], inputEvents: [] as { at: number; event: string; code: string | null; focused: boolean; activeTag: string }[], screenshots: [] as { path: string; sha256: string; label: string; state: ReturnType<PrecinctPerformanceApi["status"]> }[] };
type InputObservation = { at: number; event: string; code: string | null; focused: boolean; activeTag: string };
let browser: Browser | null = null, page: Page | null = null;
let inputObservation: JSHandle<{ read: () => InputObservation[]; dispose: () => void }> | null = null;
const message = (error: unknown) => error instanceof Error ? error.stack ?? error.message : String(error);
async function status(p: Page) {
  return p.evaluate(() => { if (window.__arenaPrecinctPerformance === undefined) throw new Error("Actual scene probe missing."); return window.__arenaPrecinctPerformance.status(); });
}
async function position(p: Page) {
  const transform = await p.locator(".precinct-minimap g").getAttribute("transform");
  return parseMinimapPosition(transform);
}
try {
  browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, timeout: 60_000,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-background-networking"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, permissions: [], serviceWorkers: "block" });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== target.origin || url.pathname.startsWith("/api/")) { report.blocked.push(`${url.origin}${url.pathname}`); await route.abort("blockedbyclient"); }
    else await route.continue();
  });
  await context.routeWebSocket("**/*", (socket) => {
    const url = new URL(socket.url());
    if (url.protocol === "ws:" && url.host === target.host && !url.pathname.startsWith("/api/")) socket.connectToServer();
    else { report.blocked.push(`${url.origin}${url.pathname}`); void socket.close().catch((error: unknown) => { report.errors.push(message(error)); }); }
  });
  page = await context.newPage(); const owned = page; page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => { report.errors.push(message(error)); });
  page.on("console", (entry) => { if (entry.type() === "error") report.errors.push(entry.text()); });
  await page.goto(target.href, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Enter the precinct", exact: true })).toBeEnabled({ timeout: 90_000 });
  await page.getByRole("button", { name: "Comfort and accessibility settings", exact: true }).click();
  await page.getByRole("combobox", { name: /Rendering quality/u }).selectOption("low");
  await page.getByRole("radio", { name: "Studio", exact: true }).check();
  await page.getByRole("combobox", { name: /^Architecture/u }).selectOption("courtyard");
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Enter the precinct", exact: true })).toBeEnabled({ timeout: 90_000 });
  await page.getByRole("button", { name: "Enter the precinct", exact: true }).click();
  await expect.poll(async () => (await status(owned)).sceneAsset).toBe("/world/precinct-courtyard.glb");
  const capture = async (name: string, label: string, width: number, height: number) => {
    await owned.setViewportSize({ width, height });
    await expect(owned.locator(".precinct-root")).toHaveAttribute("data-theme", "studio");
    await expect.poll(async () => (await status(owned)).drawingBuffer).toEqual({ width: Math.floor(width * 0.75), height: Math.floor(height * 0.75) });
    const scene = await status(owned); expect(scene.calls).toBeGreaterThan(0); expect(scene.triangles).toBeGreaterThan(0);
    const path = `${output}/${name}.png`, pixels = await owned.screenshot({ path, fullPage: true, timeout: 10_000 });
    expect(pixels.readUInt32BE(16)).toBe(width); expect(pixels.readUInt32BE(20)).toBe(height);
    report.screenshots.push({ path, sha256: createHash("sha256").update(pixels).digest("hex"), label, state: scene });
  };
  await expect.poll(async () => (await status(owned)).cameraPosition[1]).toBeLessThan(2);
  await capture("00-studio-courtyard-interior-1440x900", "Studio theme, selected courtyard interior before the walking route", 1440, 900);
  await page.bringToFront(); await page.locator("canvas").focus();
  await expect.poll(() => owned.evaluate(() => document.hasFocus() && document.activeElement?.tagName === "CANVAS")).toBe(true);
  inputObservation = await page.evaluateHandle(() => {
    const events: InputObservation[] = [];
    const observe = (event: Event) => {
      const code = event instanceof KeyboardEvent ? event.code : null;
      if (code !== null && !["KeyS", "KeyV"].includes(code)) return;
      if (events.length < 128) events.push({ at: performance.now(), event: event.type, code, focused: document.hasFocus(), activeTag: document.activeElement?.tagName ?? "" });
    };
    for (const name of ["keydown", "keyup", "blur", "focus"]) window.addEventListener(name, observe, true);
    return { read: () => [...events], dispose: () => { for (const name of ["keydown", "keyup", "blur", "focus"]) window.removeEventListener(name, observe, true); } };
  });
  await page.evaluate(() => { window.__arenaPrecinctPerformance?.start(); });
  await page.keyboard.down("KeyS");
  try {
    await expect.poll(async () => {
      const pos = await position(owned);
      const observed = await owned.evaluate(() => ({ at: performance.now(), focused: document.hasFocus(), activeTag: document.activeElement?.tagName ?? "", visible: !document.hidden,
        continuous: window.__arenaPrecinctPerformance?.status().continuous === true, frameCount: window.__arenaPrecinctPerformance?.snapshot().framesRendered ?? -1 }));
      if (report.progress.length < 128) report.progress.push({ ...pos, ...observed });
      return pos.z;
    }, { timeout: 60_000, intervals: [500] }).toBeGreaterThanOrEqual(16.3);
    report.routeReached = true;
  } catch (error) {
    // Preserve the failed route gate and nonzero result, but retain independent views from the actual reached position.
    report.errors.push(message(error));
  } finally {
    await page.keyboard.up("KeyS");
    report.movement = await page.evaluate(() => window.__arenaPrecinctPerformance?.stop() ?? null);
  }
  if (report.routeReached) await expect(page.locator(".precinct-location")).toContainText("South Arrival Arcade");
  const routeLabel = report.routeReached ? "actual South Arrival endpoint" : "actual reached position; timed arrival gate failed";
  await capture("01-studio-courtyard-first-person-1440x900", `Studio courtyard, first person, ${routeLabel}`, 1440, 900);
  await page.locator("canvas").focus(); await page.keyboard.press("KeyV");
  await expect(page.locator(".precinct-controls")).toContainText("Third person");
  await expect.poll(async () => (await status(owned)).cameraPosition[1]).toBeGreaterThan(2);
  await capture("02-studio-courtyard-third-person-1440x900", `Studio courtyard, third person, ${routeLabel}`, 1440, 900);
  await capture("03-studio-courtyard-third-person-1920x1080", `Studio courtyard, third person, ${routeLabel}`, 1920, 1080);
  await page.getByRole("button", { name: "Open precinct map and fast travel", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await capture("04-studio-courtyard-map-1920x1080", "Actual courtyard station map and accessible navigation", 1920, 1080);
  expect(report.blocked).toEqual([]); expect(report.errors).toEqual([]); report.status = "passed";
} catch (error) {
  report.status = "failed"; report.errors.push(message(error));
  if (page !== null && !page.isClosed()) {
    await page.screenshot({ path: `${output}/failure.png`, fullPage: true, timeout: 5000 }).catch((failure: unknown) => { report.errors.push(message(failure)); });
    await writeFile(`${output}/failure-ui.txt`, (await page.locator("body").innerText()).slice(0, 20_000)).catch((failure: unknown) => { report.errors.push(message(failure)); });
  }
} finally {
  if (inputObservation !== null) {
    try { report.inputEvents = await inputObservation.evaluate((handle) => handle.read()); await inputObservation.evaluate((handle) => { handle.dispose(); }); await inputObservation.dispose(); }
    catch (error) { report.cleanupErrors.push(message(error)); }
  }
  await browser?.close().catch((error: unknown) => { report.cleanupErrors.push(message(error)); });
  if (report.cleanupErrors.length > 0) report.status = "failed";
  await writeFile(`${output}/scene-capture-report.json`, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Actual overview capture ${report.status}: ${output}/scene-capture-report.json\n`);
  if (report.status !== "passed") process.exitCode = 1;
}
