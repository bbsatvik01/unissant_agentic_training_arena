/**
 * Developer smoke: node tools/precinct-smoke.ts
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
const output = `${screenshotRoot}slice-01/`;
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
    failedRequests: [], httpErrors: [], assets: [], webgl: null, frameTiming: null,
  };
  report.viewports.push(result);
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(frameTimeout);
  page.on("console", (entry) => { result.console.push({ type: entry.type(), text: entry.text(), location: entry.location() }); });
  page.on("pageerror", (error) => { result.pageErrors.push(message(error)); });
  page.on("requestfailed", (request) => {
    result.failedRequests.push({ url: request.url(), error: request.failure()?.errorText ?? null });
  });
  page.on("response", (response) => {
    const url = response.url();
    if (response.status() >= 400) result.httpErrors.push({ url, status: response.status() });
    if (/\.(glb|gltf|png|webp|jpg)(?:\?|$)/u.test(url)) result.assets.push({ url, status: response.status() });
  });
  try {
    const ready = await check(result, "welcome loads and entry enables", async () => {
      await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await expect(page.getByRole("heading", { name: "Start your shift.", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Enter the precinct", exact: true })).toBeEnabled({ timeout: 90_000 });
      result.renderMode = await renderMode(page);
      if (result.renderMode === "unverified") throw new Error("Neither a live WebGL surface nor the explicit fallback was verified.");
    });
    if (ready) {
      await check(result, "low rendering tier selected through actual settings", async () => {
        await page.getByRole("button", { name: "Comfort and accessibility settings", exact: true }).click();
        const quality = page.getByRole("combobox", { name: /Rendering quality/u });
        await quality.selectOption("low");
        await expect(quality).toHaveValue("low");
        await page.getByRole("button", { name: "Close panel", exact: true }).click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        return "Supported Low tier selected in the app; exact browser viewport dimensions are unchanged.";
      });
    }
    await screenshot(page, result, "01-welcome");
    await check(result, "welcome ground rule", async () => { await groundRule(page); });
    if (!ready) return;

    if (result.renderMode === "live-webgl") {
      await check(result, "live WebGL context and authored world asset", async () => {
        result.webgl = await page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
          const gl = canvas.getContext("webgl2");
          if (gl === null || gl.isContextLost()) return null;
          const version: unknown = gl.getParameter(gl.VERSION);
          const renderer: unknown = gl.getParameter(gl.RENDERER);
          const debug = gl.getExtension("WEBGL_debug_renderer_info");
          const unmasked: unknown = debug === null ? null : gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);
          return { version: String(version), renderer: String(renderer), unmaskedRenderer: typeof unmasked === "string" ? unmasked : null, width: canvas.width, height: canvas.height };
        });
        if (result.webgl === null) throw new Error("WebGL context is absent or lost.");
        if (!result.assets.some((asset) => asset.url.endsWith("/world/precinct.glb") && asset.status === 200)) {
          throw new Error("No successful precinct.glb response was observed.");
        }
      });
    } else {
      result.checks.push({ name: "live WebGL scene", status: "blocked", detail: "The app explicitly reports 3D rendering unavailable. Captures are fallback UI, not a live 3D pass." });
    }

    if (result.renderMode === "live-webgl") {
      await check(result, "software renderer frame timing recorded", async () => {
        result.frameTiming = await page.evaluate(async () => await new Promise<{ frames: number; elapsedMs: number; averageMs: number | null }>((resolve) => {
          const started = performance.now();
          let frames = 0;
          let request = 0;
          const finish = () => {
            cancelAnimationFrame(request);
            const elapsedMs = performance.now() - started;
            resolve({ frames, elapsedMs, averageMs: frames === 0 ? null : elapsedMs / frames });
          };
          const deadline = setTimeout(finish, 15_000);
          const tick = () => {
            frames += 1;
            if (frames >= 6) { clearTimeout(deadline); finish(); }
            else request = requestAnimationFrame(tick);
          };
          request = requestAnimationFrame(tick);
        }));
        if (result.frameTiming.frames === 0) throw new Error("No rendering-frame callback arrived within 15 seconds.");
        return JSON.stringify(result.frameTiming);
      });
    }

    const entered = await check(result, "enter precinct", async () => {
      await page.getByRole("button", { name: "Enter the precinct", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Check in at reception", exact: true })).toBeVisible();
      await expect(page.locator(".precinct-controls")).toContainText("First person");
      if (result.renderMode === "live-webgl") await expect.poll(async () => await marker(page), { timeout: frameTimeout }).toContain("translate(0 -4.2)");
      await groundRule(page);
    });
    await screenshot(page, result, "02-entered-first-person");
    if (!entered) return;

    if (result.renderMode === "live-webgl") {
      await check(result, "keyboard walk changes player position", async () => {
        await page.locator("canvas").focus();
        const before = await marker(page);
        try {
          await page.keyboard.down("KeyW");
          await expect.poll(async () => await marker(page), { timeout: frameTimeout }).not.toBe(before);
        } finally { await page.keyboard.up("KeyW"); }
        return `Before: ${before}; after: ${await marker(page)}`;
      });
      await check(result, "arrow-key look changes heading", async () => {
        await page.locator("canvas").focus();
        const before = (await marker(page)).split("rotate(")[1];
        try {
          await page.keyboard.down("ArrowRight");
          await expect.poll(async () => (await marker(page)).split("rotate(")[1], { timeout: frameTimeout }).not.toBe(before);
        } finally { await page.keyboard.up("ArrowRight"); }
        return `Heading before: ${before ?? "missing"}; after: ${await marker(page)}`;
      });
    } else {
      result.checks.push({ name: "keyboard walk and look", status: "blocked", detail: "Fallback has no live camera or walking; number-key/map navigation is tested separately." });
    }
    const thirdPerson = await check(result, "third-person toggle", async () => {
      await page.keyboard.press("KeyV");
      await expect(page.locator(".precinct-controls")).toContainText("Third person");
      if (result.renderMode === "live-webgl") {
        await expect.poll(() => result.assets.some((asset) => asset.url.endsWith("/avatars/Business_Male_02/avatar.glb") && asset.status === 200), { timeout: frameTimeout }).toBe(true);
      }
      return result.renderMode === "flat-fallback" ? "UI mode changed only; no third-person rendering is claimed." : "Live WebGL is present and the UI switched to third person; inspect the screenshot for avatar framing.";
    });
    if (thirdPerson) await screenshot(page, result, "03-third-person");
    else result.checks.push({ name: "screenshot 03-third-person", status: "blocked", detail: "The requested camera mode did not verify; no mislabeled capture was saved." });

    const mapOpened = await check(result, "keyboard map opens ten stations", async () => {
      await page.keyboard.press("KeyM");
      await expect(page.getByRole("dialog", { name: "Find your way." })).toBeVisible();
      await expect(page.locator(".station-directory button")).toHaveCount(10);
    });
    await screenshot(page, result, "04-map");
    if (mapOpened) {
      await check(result, "map fast travel to case board", async () => {
        await page.getByRole("button", { name: /Case board/u }).click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect.poll(async () => await marker(page), { timeout: frameTimeout }).toContain("translate(8.2 -7.4)");
        return await marker(page);
      });
    }
    await check(result, "number-key fast travel to reception", async () => {
      if (await page.getByRole("dialog").count() > 0) await page.getByRole("button", { name: "Close panel", exact: true }).click();
      if (await page.locator("canvas").count() > 0) await page.locator("canvas").focus();
      else await page.locator("body").click({ position: { x: 720, y: 400 } });
      await page.keyboard.press("Digit1");
      await expect.poll(async () => await marker(page), { timeout: frameTimeout }).toContain("translate(-6.2 -5.7)");
      return await marker(page);
    });

    const settingsOpened = await check(result, "settings controls update app state", async () => {
      await page.getByRole("button", { name: "Comfort and accessibility settings", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Make yourself comfortable." })).toBeVisible();
      await page.getByRole("checkbox", { name: /Reduced motion/u }).check();
      await page.getByRole("checkbox", { name: /Larger text/u }).check();
      await page.getByRole("checkbox", { name: /High contrast/u }).check();
      await page.getByRole("combobox", { name: /Rendering quality/u }).selectOption("low");
      await expect(page.locator(".precinct-root")).toHaveClass(/large-text/u);
      await expect(page.locator(".precinct-root")).toHaveClass(/high-contrast/u);
      await expect(page.getByRole("combobox", { name: /Rendering quality/u })).toHaveValue("low");
    });
    if (settingsOpened) await screenshot(page, result, "05-settings");
    else result.checks.push({ name: "screenshot 05-settings", status: "blocked", detail: "The requested settings state did not verify; no mislabeled capture was saved." });
    await check(result, "settings Escape dismissal", async () => {
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await groundRule(page);
    });
    await check(result, "pause and resume", async () => {
      await page.getByRole("button", { name: /^Pause/u }).click();
      await expect(page.getByRole("heading", { name: "Take your time.", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Resume", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Take your time.", exact: true })).toHaveCount(0);
    });
    await check(result, "no horizontal page overflow", async () => {
      const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
      if (dimensions.scroll > dimensions.width) throw new Error(JSON.stringify(dimensions));
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
for (const [source, label] of [[screenshotRoot, "legacy"], [output, "slice-01"]] as const) {
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
