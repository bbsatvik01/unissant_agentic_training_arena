/**
 * Developer smoke: node tools/precinct-reception-smoke.ts
 * Requires the existing Vite server at ARENA_PREVIEW_URL (default http://127.0.0.1:5173).
 * Launches only a new ephemeral headless Chromium. Never connects to a user browser/profile.
 * Screenshots and the diagnostic report are evidence from automation, not independent visual QA.
 */
import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Browser, type Page } from "@playwright/test";

import { EX4_TEXT } from "../src/lib/copy/ex4.ts";

type RenderMode = "unverified" | "live-webgl" | "flat-fallback";
type CheckStatus = "passed" | "failed" | "blocked";
interface Check { name: string; status: CheckStatus; detail: string; durationMs?: number }
interface Screenshot { name: string; path: string; renderMode: RenderMode }
interface ViewportReport {
  viewport: { width: number; height: number };
  renderMode: RenderMode;
  checks: Check[];
  screenshots: Screenshot[];
  console: { type: string; text: string; location: { url: string; lineNumber: number; columnNumber: number } }[];
  pageErrors: string[];
  networkRequests: string[];
  failedRequests: { url: string; error: string | null }[];
  httpErrors: { url: string; status: number }[];
  assets: { url: string; status: number }[];
  webgl: { version: string; renderer: string; unmaskedRenderer: string | null; width: number; height: number } | null;
  frameTiming: { frames: number; elapsedMs: number; averageMs: number | null } | null;
}

const target = new URL(process.env["ARENA_PREVIEW_URL"] ?? "http://127.0.0.1:5173/");
if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) {
  throw new Error("ARENA_PREVIEW_URL must name the local HTTP preview server.");
}
const screenshotRoot = fileURLToPath(new URL("../../docs/ui-v2/screenshots/", import.meta.url));
const output = `${screenshotRoot}slice-02/`;
const executablePath = process.env["ARENA_CHROMIUM_PATH"] ?? "/usr/bin/chromium";
// ANGLE SwiftShader is a software renderer. Web security and certificate checks remain enabled.
const launchArgs = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
// Software GL can take seconds per frame. Keep every assertion, but await observable state
// rather than assuming a key held for 500 ms necessarily overlaps a rendered frame.
const frameTimeout = 60_000;
const report: {
  generatedAt: string;
  target: string;
  browser: string;
  executablePath: string;
  launchArgs: string[];
  verification: string;
  status: string;
  viewports: ViewportReport[];
  fatal: string | null;
} = {
  generatedAt: new Date().toISOString(), target: target.href, browser: "",
  executablePath, launchArgs,
  verification: "Automated isolated headless browser smoke and screenshots. Independent visual and real-device GPU checks remain separate.",
  status: "running", viewports: [], fatal: null,
};

function message(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

async function checkpoint(): Promise<void> {
  await writeFile(`${output}smoke-report.json`, `${JSON.stringify(report, null, 2)}\n`);
}

async function check(result: ViewportReport, name: string, operation: () => Promise<unknown>): Promise<boolean> {
  const started = Date.now();
  console.log(`${String(result.viewport.width)}x${String(result.viewport.height)}: starting ${name}`);
  try {
    const detail = await operation();
    result.checks.push({ name, status: "passed", detail: typeof detail === "string" ? detail : "", durationMs: Date.now() - started });
    return true;
  } catch (error) {
    result.checks.push({ name, status: "failed", detail: message(error), durationMs: Date.now() - started });
    return false;
  } finally {
    const latest = result.checks.at(-1);
    console.log(`${String(result.viewport.width)}x${String(result.viewport.height)}: ${latest?.status ?? "unknown"} ${name} (${String(Date.now() - started)} ms)`);
    await checkpoint();
  }
}

async function renderMode(page: Page): Promise<RenderMode> {
  if (await page.locator(".precinct-render-notice").isVisible()) return "flat-fallback";
  if (await page.locator("canvas").isVisible()) {
    const available = await page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
      const gl = canvas.getContext("webgl2");
      return gl !== null && !gl.isContextLost();
    });
    if (available) return "live-webgl";
  }
  return "unverified";
}

async function screenshot(page: Page, result: ViewportReport, name: string): Promise<void> {
  await check(result, `screenshot ${name}`, async () => {
    result.renderMode = await renderMode(page);
    const suffix = result.renderMode === "flat-fallback" ? "-fallback" : "";
    const viewName = result.renderMode === "flat-fallback" ? name.replace("entered-first-person", "entered-ui").replace("third-person", "camera-mode-ui") : name;
    const filename = `${viewName}${suffix}-${String(result.viewport.width)}x${String(result.viewport.height)}.png`;
    const path = `${output}${filename}`;
    await page.screenshot({ path, fullPage: false, animations: "disabled", timeout: frameTimeout });
    result.screenshots.push({ name, path, renderMode: result.renderMode });
  });
}

async function marker(page: Page): Promise<string> {
  return await page.locator(".precinct-minimap g").getAttribute("transform") ?? "";
}

async function groundRule(page: Page): Promise<void> {
  const footer = page.locator(".precinct-ground-rule");
  await expect(footer).toHaveText(EX4_TEXT);
  await expect(footer).toBeVisible();
  const bounds = await footer.boundingBox();
  const viewport = page.viewportSize();
  if (bounds === null || viewport === null || bounds.y < 0 || bounds.y + bounds.height > viewport.height + 1) {
    throw new Error("The exact sponsor ground rule is not wholly within the viewport.");
  }
}

async function captureViewport(browser: Browser, viewport: { width: number; height: number }): Promise<void> {
  const result: ViewportReport = {
    viewport, renderMode: "unverified", checks: [], screenshots: [], console: [], pageErrors: [],
    networkRequests: [], failedRequests: [], httpErrors: [], assets: [], webgl: null, frameTiming: null,
  };
  report.viewports.push(result);
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(frameTimeout);
  page.on("console", (entry) => { result.console.push({ type: entry.type(), text: entry.text(), location: entry.location() }); });
  page.on("pageerror", (error) => { result.pageErrors.push(message(error)); });
  page.on("request", (request) => { result.networkRequests.push(request.url()); });
  page.on("requestfailed", (request) => {
    result.failedRequests.push({ url: request.url(), error: request.failure()?.errorText ?? null });
  });
  page.on("response", (response) => {
    const url = response.url();
    if (response.status() >= 400) result.httpErrors.push({ url, status: response.status() });
    if (/\.(glb|gltf|png|webp|jpg)(?:\?|$)/u.test(url)) result.assets.push({ url, status: response.status() });
  });
  try {
    const ready = await check(result, "precinct and both speaking staff assets load", async () => {
      await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await expect(page.getByRole("button", { name: "Enter the precinct", exact: true })).toBeEnabled({ timeout: 90_000 });
      await page.getByRole("button", { name: "Enter the precinct", exact: true }).click();
      result.renderMode = await renderMode(page);
      if (result.renderMode !== "live-webgl") throw new Error("Actual WebGL is required for staff visual acceptance.");
      result.webgl = await page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
        const gl = canvas.getContext("webgl2");
        if (gl === null) return null;
        const debug = gl.getExtension("WEBGL_debug_renderer_info");
        return { version: String(gl.getParameter(gl.VERSION)), renderer: String(gl.getParameter(gl.RENDERER)), unmaskedRenderer: debug === null ? null : String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)), width: canvas.width, height: canvas.height };
      });

      for (const avatar of ["Business_Female_01", "Business_Male_04"]) {
        await expect.poll(() => result.assets.some((asset) => asset.url.endsWith(`/avatars/${avatar}/avatar.glb`) && asset.status === 200), { timeout: frameTimeout }).toBe(true);
      }
      await groundRule(page);
    });
    if (!ready) return;
    await check(result, "walk-up reception anchor and E interaction are reachable", async () => {
      await page.locator("canvas").focus();
      await page.keyboard.press("Digit1");
      await expect.poll(async () => await marker(page), { timeout: frameTimeout }).toContain("translate(-6.2 -5.7)");
      await expect(page.getByRole("button", { name: /E\s*Reception/u })).toBeVisible();
    });
    await screenshot(page, result, "01-reception-officer");
    await check(result, "explicit check-in changes progress; greeting keeps keyboard focus", async () => {
      await page.locator("canvas").focus();
      await page.keyboard.press("KeyE");
      await expect(page.getByRole("dialog", { name: "Reception", exact: true })).toBeVisible();
      await expect(page.locator(".precinct-objective h1")).toHaveText("Check in at reception");
      await page.getByRole("button", { name: "Check in for this shift", exact: true }).click();
      await expect(page.locator(".precinct-objective h1")).toHaveText("Meet your training sergeant");
      await page.getByRole("button", { name: "Talk to reception officer", exact: true }).click();
      await expect(page.locator(".npc-subtitle")).toContainText("Welcome");
      await expect(page.getByRole("button", { name: "Repeat greeting", exact: true })).toBeFocused();
      await expect(page.locator(".shift-progress")).toHaveAttribute("aria-valuenow", "1");
      const stored = await page.evaluate(() => localStorage.getItem("arena.precinct.npc-visits.v1"));
      if (stored !== null) throw new Error("Staff memory was written without opt-in/save.");
      await page.getByRole("dialog").evaluate((dialog) => { dialog.scrollTop = 0; });
    });
    await screenshot(page, result, "02-reception-dialogue");
    await check(result, "unsupported case prompt redirects safely and never moves the player", async () => {
      const before = await marker(page);
      await page.getByLabel("Optional short prompt", { exact: true }).fill("Tell me if the subject is deceptive because they seem nervous.");
      await page.getByRole("button", { name: "Ask locally", exact: true }).click();
      await expect(page.locator(".npc-subtitle")).toContainText("not case-specific answers");
      if (await marker(page) !== before) throw new Error("Typing into the dialogue moved the player.");
    });
    await check(result, "explicit opt-in saves only a synthetic preferred name and staff counts", async () => {
      await page.getByText("Preferred name and local staff memory", { exact: true }).click();
      await page.getByLabel("Allow name and staff memory on this device", { exact: true }).check();
      await page.getByLabel("Preferred name (optional)", { exact: true }).fill("Alex");
      await page.getByRole("button", { name: "Save name and staff visits", exact: true }).click();
      await expect(page.locator(".npc-memory-notice")).toContainText("saved on this device");
      const stored = await page.evaluate(() => localStorage.getItem("arena.precinct.npc-visits.v1"));
      if (stored === null) throw new Error("Explicit opt-in save produced no local staff memory.");
      const memory: unknown = JSON.parse(stored);
      expect(memory).toEqual({ version: 1, displayName: "Alex", colleagues: [{ npc_id: "receptionist", visits: 1 }] });
    });
    await check(result, "returning colleague remembers the explicit local name", async () => {
      await page.getByRole("button", { name: "Close panel", exact: true }).click();
      await page.locator("canvas").focus();
      await page.keyboard.press("KeyE");
      await page.getByRole("button", { name: "Talk to reception officer", exact: true }).click();
      await expect(page.locator(".npc-subtitle")).toContainText("Good to see you again, Alex.");
    });
    await check(result, "authored direction travels to the sergeant without reopening a panel", async () => {
      await page.getByRole("button", { name: "Go to briefing", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect.poll(async () => await marker(page), { timeout: frameTimeout }).toContain("translate(-4.3 -29.1)");
      await expect(page.getByRole("button", { name: /E\s*Start briefing/u })).toBeVisible();
      await groundRule(page);
    });
    await screenshot(page, result, "03-training-sergeant");
    await check(result, "public briefing and technique dialogue remain distinct", async () => {
      await page.locator("canvas").focus();
      await page.keyboard.press("KeyE");
      await expect(page.getByRole("dialog", { name: "Sergeant briefing", exact: true })).toBeVisible();
      await expect(page.locator(".npc-assignment")).toContainText(EX4_TEXT);
      await expect(page.locator(".npc-assignment")).toContainText("Nervousness, demeanor, accent and stress are never evidence.");
      await expect(page.locator(".npc-assignment")).toContainText("Records vault entry during a busy shift");
      await page.getByRole("button", { name: "Talk to training sergeant", exact: true }).click();
      await expect(page.locator(".npc-subtitle")).not.toContainText("Jordan Pell");
      await expect(page.locator(".npc-subtitle")).not.toContainText("14:07");
      await page.getByRole("dialog").evaluate((dialog) => { dialog.scrollTop = 0; });
    });
    await screenshot(page, result, "04-evidence-first-briefing");
    await check(result, "briefing speech is explicit and has an honest local-device fallback", async () => {
      const briefing = page.locator(".npc-assignment");
      await briefing.getByRole("button", { name: "Read aloud locally", exact: true }).click();
      const status = briefing.locator(".local-speech [role=status]");
      await expect(status).toHaveText(/No installed local voice|Speaking with a device-local voice|Voice playback is unavailable|Optional device-local voice/u);
      const detail = await status.textContent();
      const stop = briefing.getByRole("button", { name: "Stop voice", exact: true });
      if (await stop.isVisible()) await stop.click();
      await expect(briefing).toContainText(EX4_TEXT);
      return detail ?? "The full public briefing remains visible.";
    });
    await check(result, "explicit ground-rule acknowledgement completes this checkpoint", async () => {
      await page.getByRole("button", { name: "Acknowledge the briefing and ground rule", exact: true }).click();
      await expect(page.locator(".precinct-objective h1")).toHaveText("Read your case file");
      await expect(page.getByRole("button", { name: "Briefing acknowledged", exact: true })).toBeDisabled();
      await expect(page.locator(".shift-progress")).toHaveAttribute("aria-valuenow", "2");
    });
    await check(result, "local memory controls remain visible and keyboard reachable", async () => {
      await page.getByText("Preferred name and local staff memory", { exact: true }).click();
      await expect(page.getByLabel("Preferred name (optional)", { exact: true })).toHaveValue("Alex");
      await page.getByRole("button", { name: "Save name and staff visits", exact: true }).click();
      await expect(page.locator(".npc-memory-notice")).toContainText("saved on this device");
    });
    await page.getByRole("dialog").evaluate((dialog) => { dialog.scrollTop = 0; });
    await screenshot(page, result, "05-local-staff-memory");
    await check(result, "forget deletes only the explicit staff-memory key", async () => {
      await page.getByRole("button", { name: "Forget local staff memory", exact: true }).click();
      await expect(page.getByLabel("Allow name and staff memory on this device", { exact: true })).not.toBeChecked();
      await expect(page.getByLabel("Preferred name (optional)", { exact: true })).toHaveValue("");
      expect(await page.evaluate(() => localStorage.getItem("arena.precinct.npc-visits.v1"))).toBeNull();
      await expect(page.locator(".npc-memory-notice")).toContainText("removed from this device");
    });
    await check(result, "Escape restores world exploration and exact ground rule", async () => {
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await groundRule(page);
    });
    await check(result, "no horizontal overflow or remote/API requests", async () => {
      const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));
      if (dimensions.scroll > dimensions.width) throw new Error(JSON.stringify(dimensions));
      if (result.networkRequests.some((url) => new URL(url).origin !== target.origin || new URL(url).pathname.startsWith("/api/"))) throw new Error("A request left the local preview origin or invoked an API.");
    });
  } finally {
    result.renderMode = await renderMode(page);
    await context.close();
    await checkpoint();
    console.log(`${String(viewport.width)}x${String(viewport.height)}: ${result.renderMode}; ${String(result.screenshots.length)} screenshots; ${String(result.checks.filter((item) => item.status === "failed").length)} failed checks`);
  }
}

await mkdir(output, { recursive: true });
// Retain earlier evidence while ensuring the current directory contains only this run's captures.
for (const [source, label] of [[output, "slice-02"]] as const) {
  const previous = (await readdir(source)).filter((name) => name === "smoke-report.json" || /^0[1-5]-.+-(?:1440x900|1920x1080)\.png$/u.test(name));
  if (previous.length === 0) continue;
  const archive = `${screenshotRoot}previous-runs/${new Date().toISOString().replaceAll(":", "-")}-${label}/`;
  await mkdir(archive, { recursive: true });
  for (const name of previous) await rename(`${source}${name}`, `${archive}${name}`);
  console.log(`Previous smoke evidence preserved in ${archive}`);
}
await checkpoint();
let browser: Browser | null = null;
try {
  browser = await chromium.launch({ executablePath, headless: true, args: launchArgs });
  report.browser = browser.version();
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await captureViewport(browser, viewport);
  }
  const failed = report.viewports.some((item) => item.checks.some((entry) => entry.status === "failed") || item.httpErrors.length > 0 || item.failedRequests.length > 0);
  const fallback = report.viewports.some((item) => item.renderMode !== "live-webgl");
  const runtimeErrors = report.viewports.some((item) => item.pageErrors.length > 0 || item.console.some((entry) => entry.type === "error"));
  report.status = failed ? "failed" : fallback ? "fallback-only-3d-unverified" : runtimeErrors ? "runtime-errors-review-required" : "passed-automated-smoke";
  if (failed || fallback || runtimeErrors) process.exitCode = 1;
} catch (error) {
  report.fatal = message(error);
  report.status = "blocked";
  process.exitCode = 1;
} finally {
  if (browser !== null) await browser.close();
  await writeFile(`${output}smoke-report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.status}: ${output}smoke-report.json`);
}
