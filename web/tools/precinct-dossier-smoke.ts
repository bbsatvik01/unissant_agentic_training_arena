/**
 * Developer smoke: node tools/precinct-dossier-smoke.ts
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
const output = `${screenshotRoot}slice-03/`;
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
  page.on("requestfailed", (request) => { result.failedRequests.push({ url: request.url(), error: request.failure()?.errorText ?? null }); });
  page.on("response", (response) => {
    const url = response.url();
    if (response.status() >= 400) result.httpErrors.push({ url, status: response.status() });
    if (/\.(glb|gltf|png|webp|jpg)(?:\?|$)/u.test(url)) result.assets.push({ url, status: response.status() });
  });
  const travel = async (key: string, label: string) => {
    if (await page.getByRole("dialog").count() > 0) await page.getByRole("button", { name: "Close panel", exact: true }).click();
    await page.locator("canvas").focus();
    await page.keyboard.press(`Digit${key}`);
    await expect(page.getByRole("button", { name: new RegExp(`E\\s*${label}`, "u") })).toBeVisible({ timeout: frameTimeout });
    await page.locator("canvas").focus();
    await page.keyboard.press("KeyE");
    await expect(page.getByRole("dialog")).toBeVisible();
  };
  const top = async () => { await page.getByRole("dialog").evaluate((dialog) => { dialog.scrollTop = 0; }); };
  const notebookKeys = async () => await page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes("notebook")));
  try {
    const ready = await check(result, "actual precinct renderer and local-only startup", async () => {
      await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await expect(page.getByRole("button", { name: "Enter the precinct", exact: true })).toBeEnabled({ timeout: 90_000 });
      await page.getByRole("button", { name: "Comfort and accessibility settings", exact: true }).click();
      await page.getByRole("combobox", { name: /Rendering quality/u }).selectOption("low");
      await page.getByRole("button", { name: "Close panel", exact: true }).click();
      await page.getByRole("button", { name: "Skip arrival", exact: true }).click();
      result.renderMode = await renderMode(page);
      if (result.renderMode !== "live-webgl") throw new Error("Actual WebGL is required for dossier-in-world acceptance.");
      result.webgl = await page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
        const gl = canvas.getContext("webgl2");
        if (gl === null) return null;
        const debug = gl.getExtension("WEBGL_debug_renderer_info");
        return { version: String(gl.getParameter(gl.VERSION)), renderer: String(gl.getParameter(gl.RENDERER)), unmaskedRenderer: debug === null ? null : String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)), width: canvas.width, height: canvas.height };
      });
      await groundRule(page);
      expect(await notebookKeys()).toEqual([]);
    });
    if (!ready) return;
    await check(result, "empty desk asks for an explicit assignment", async () => {
      await travel("4", "Your dossier");
      await expect(page.getByRole("heading", { name: "Choose a public assignment", exact: true })).toBeVisible();
      await expect(page.locator(".dossier-panel")).toHaveCount(0);
      await page.getByRole("button", { name: "Choose a case at the board", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Case board", exact: true })).toBeVisible();
    });
    await check(result, "public case selection loads no interview or score", async () => {
      await page.getByRole("button", { name: "Select Records vault entry during a busy shift", exact: true }).click();
      await expect(page.getByText("Your public packet is ready at your desk.", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Select Records vault entry during a busy shift", exact: true })).toHaveAttribute("aria-pressed", "true");
      expect(await notebookKeys()).toEqual([]);
      await top();
    });
    await screenshot(page, result, "01-public-case-selection");
    await check(result, "check-in and evidence-first briefing use the selected public case", async () => {
      await travel("1", "Reception");
      await page.getByRole("button", { name: "Check in for this shift", exact: true }).click();
      await travel("5", "Start briefing");
      await expect(page.locator(".npc-assignment")).toContainText("Records vault entry during a busy shift");
      await expect(page.locator(".npc-assignment")).toContainText(EX4_TEXT);
      await page.getByRole("button", { name: "Acknowledge the briefing and ground rule", exact: true }).click();
      await expect(page.locator(".shift-progress")).toHaveAttribute("aria-valuenow", "2");
    });
    await check(result, "dossier overview contains public facts and six accessible tabs", async () => {
      await travel("4", "Your dossier");
      await expect(page.getByRole("dialog", { name: "Your desk", exact: true })).toBeVisible();
      await expect(page.locator(".dossier-panel")).toContainText("C-7Q2MXK4D");
      for (const name of ["Overview", "Documents", "Subject", "Evidence", "Timeline", "Notebook"]) {
        await expect(page.getByRole("tab", { name: new RegExp(name, "u") })).toBeVisible();
      }
      await expect(page.locator(".dossier-ground-rule")).toContainText(EX4_TEXT);
      await expect(page.getByText("Released records", { exact: true }).locator("..")).toContainText("0");
      await top();
    });
    await screenshot(page, result, "02-dossier-overview");
    await check(result, "keyboard tabs and source table preserve original document text", async () => {
      await page.getByRole("tab", { name: /Overview/u }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByRole("tab", { name: /Documents/u })).toBeFocused();
      await expect(page.getByRole("tab", { name: /Documents/u })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("table")).toContainText("14:07:12");
      await expect(page.getByRole("table")).toContainText("14:12:05");
      await expect(page.locator(".dossier-document-body")).toContainText("no exit time is recorded");
      await expect(page.getByRole("button", { name: "Previous", exact: true })).toBeDisabled();
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(page.locator(".dossier-paper h4")).toHaveText("Records Vault B-12 access rules (Facility Security Standard 4.2)");
      await page.getByRole("button", { name: "Previous", exact: true }).click();
      await top();
    });
    await screenshot(page, result, "03-original-public-document");
    await check(result, "profile and evidence expose only public supplied materials", async () => {
      await page.getByRole("tab", { name: /Subject/u }).click();
      await expect(page.locator(".dossier-profile")).toContainText("Jordan Pell");
      await expect(page.locator(".dossier-profile")).toContainText("Nervousness, demeanor, accent and stress are never evidence.");
      await page.getByRole("tab", { name: /Evidence/u }).click();
      await expect(page.locator(".dossier-evidence-list > li")).toHaveCount(3);
      await expect(page.locator(".dossier-evidence-list")).not.toContainText("Released at turn");
    });
    await check(result, "timeline uses explicit source cells and never infers missing chronology", async () => {
      await page.getByRole("tab", { name: /Timeline/u }).click();
      await expect(page.locator(".dossier-timeline > li")).toHaveCount(3);
      await expect(page.locator(".dossier-timeline")).toContainText("14:07:12");
      await expect(page.getByRole("tabpanel", { name: /Timeline/u })).toContainText("Dates, time zones, and gaps are not inferred.");
      await top();
    });
    await screenshot(page, result, "04-source-led-timeline");
    await check(result, "notebook accepts a cited question without moving or saving automatically", async () => {
      await page.getByRole("tab", { name: /Notebook/u }).click();
      const before = await marker(page);
      await page.getByLabel("Note type", { exact: true }).selectOption("question");
      await page.getByLabel("New note", { exact: true }).fill("Which task record explains the 14:07 entry? Check a work order or radio dispatch before drawing a conclusion.");
      await page.locator(".dossier-citation-picker input").first().check();
      await page.getByRole("button", { name: "Add note", exact: true }).click();
      await expect(page.getByLabel("Saved working notes", { exact: true })).toContainText("Which task record explains the 14:07 entry?");
      await expect(page.locator(".dossier-note-citations")).toContainText("doc-01");
      expect(await notebookKeys()).toEqual([]);
      expect(await marker(page)).toBe(before);
      await expect(page.locator(".shift-progress")).toHaveAttribute("aria-valuenow", "2");
      await top();
    });
    await screenshot(page, result, "05-cited-working-notebook");
    await check(result, "notes survive close/reopen and citations reopen the source", async () => {
      await page.getByRole("button", { name: "Close panel", exact: true }).click();
      await page.locator("canvas").focus();
      await page.keyboard.press("KeyE");
      await page.getByRole("tab", { name: /Notebook/u }).click();
      await expect(page.getByLabel("Saved working notes", { exact: true })).toContainText("Which task record explains the 14:07 entry?");
      await page.getByRole("button", { name: /^Open cited source doc-01:/u }).click();
      await expect(page.getByRole("tab", { name: /Documents/u })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("table")).toContainText("14:07:12");
    });
    await check(result, "device notebook save and forget are explicit and scoped", async () => {
      await page.getByRole("tab", { name: /Notebook/u }).click();
      await page.getByRole("button", { name: "Save on this device", exact: true }).click();
      await expect(page.getByText("Device saving is on", { exact: true })).toBeVisible();
      expect(await notebookKeys()).toHaveLength(1);
      await page.getByRole("button", { name: "Forget saved copy", exact: true }).click();
      await page.getByRole("button", { name: "Confirm forget", exact: true }).click();
      expect(await notebookKeys()).toEqual([]);
      await expect(page.getByLabel("Saved working notes", { exact: true })).toContainText("Which task record explains the 14:07 entry?");
    });
    await check(result, "larger text high contrast and 150-percent reading stay within the viewport", async () => {
      await page.getByRole("button", { name: "Close panel", exact: true }).click();
      await page.getByRole("button", { name: "Comfort and accessibility settings", exact: true }).click();
      await page.getByRole("checkbox", { name: /Larger text/u }).check();
      await page.getByRole("checkbox", { name: /High contrast/u }).check();
      await page.getByRole("button", { name: "Close panel", exact: true }).click();
      await travel("4", "Your dossier");
      await page.getByLabel("Dossier reading size", { exact: true }).selectOption("150");
      await page.getByRole("tab", { name: /Documents/u }).click();
      const dimensions = await page.getByRole("dialog").evaluate((dialog) => ({ scroll: dialog.scrollWidth, width: dialog.clientWidth, left: dialog.getBoundingClientRect().left, right: dialog.getBoundingClientRect().right, viewport: innerWidth }));
      if (dimensions.scroll > dimensions.width + 1 || dimensions.left < 0 || dimensions.right > dimensions.viewport + 1) throw new Error(JSON.stringify(dimensions));
      await expect(page.locator(".dossier-panel")).toHaveAttribute("data-reading-scale", "150");
    });
    await check(result, "only explicit file-review confirmation advances the shift", async () => {
      await page.getByRole("button", { name: "Mark case file reviewed", exact: true }).click();
      await expect(page.locator(".shift-progress")).toHaveAttribute("aria-valuenow", "3");
      await expect(page.locator(".precinct-objective h1")).toHaveText("Prepare your interview");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await groundRule(page);
    });
    await check(result, "no page overflow or remote/API requests", async () => {
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
for (const [source, label] of [[output, "slice-03"]] as const) {
  const previous = (await readdir(source)).filter((name) => name === "smoke-report.json" || /^0[1-5]-.+-(?:1440x900|1920x1080)\.png$/u.test(name));
  if (previous.length === 0) continue;
  const archive = `${fileURLToPath(new URL("../../../precinct-qa-history/", import.meta.url))}${new Date().toISOString().replaceAll(":", "-")}-${label}/`;
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
