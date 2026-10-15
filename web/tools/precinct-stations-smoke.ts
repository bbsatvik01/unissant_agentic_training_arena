/** Explicit developer CLI: node tools/precinct-stations-smoke.ts [--assessment-recording /absolute/file.json]
 * Uses an already running loopback preview and one newly launched ephemeral Chromium.
 * Default is completely offline: every /api request, remote request, microphone and audio attempt is refused.
 * No backend, browser profile, fixture response, score, rank, permission, or publication is manufactured.
 * Five screenshots per viewport are automation evidence, still requiring independent visual review. */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { EX4_TEXT } from "../src/lib/copy/ex4.ts";

type Check = { name: string; status: "passed" | "failed" | "unexercised"; detail: string; durationMs: number };
interface Capture {
  viewport: { width: number; height: number }; checks: Check[];
  screenshots: { name: string; path: string; renderer: "live-webgl" }[];
  renderer: { version: string; renderer: string; unmasked: string | null } | null;
  errors: string[]; shutdownDiagnostics: string[]; blocked: string[]; audio: string[];
  requests: { method: string; url: string }[]; failedRequests: { url: string; error: string | null }[];
}
const timeout = 60_000;
const message = (error: unknown): string => error instanceof Error ? error.stack ?? error.message : String(error);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
/** Attach rejection handling as soon as a response/navigation promise is created, before the click can fail. */
function observed<T>(pending: Promise<T>): Promise<T> { void pending.catch(() => undefined); return pending; }
function deadline<T>(pending: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error(label)); }, ms); })]).finally(() => { clearTimeout(timer); });
}
async function assessmentInput(args: readonly string[]): Promise<{ path: string; trialId: string } | null> {
  if (args.length === 0) return null;
  if (args.length !== 2 || args[0] !== "--assessment-recording" || args[1] === undefined || !isAbsolute(args[1])) throw new Error("Use no arguments for offline acceptance, or --assessment-recording /absolute/existing-assessment.json.");
  const path = args[1]; const info = await stat(path);
  if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error("Optional assessment recording must be a regular file within the existing 32 MiB import limit.");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!object(value) || value["format"] !== "arena.recording.v1" || !object(value["snapshot"]) || value["snapshot"]["mode"] !== "assessment" || typeof value["trial_id"] !== "string") throw new Error("Supply an actual v1 assessment recording. This script never edits a practice recording into an assessment.");
  // This is only input identity checking. The app still validates the entire unchanged file on explicit import.
  return { path, trialId: value["trial_id"] };
}
async function guard(context: BrowserContext, origin: string, result: Capture): Promise<void> {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || /^\/api(?:\/|$)/u.test(url.pathname)) { result.blocked.push(url.href); await route.abort("blockedbyclient"); return; }
    await route.continue();
  });
  await context.routeWebSocket("**/*", (socket) => {
    const url = new URL(socket.url());
    if (url.protocol === "ws:" && url.host === new URL(origin).host && !/^\/api(?:\/|$)/u.test(url.pathname)) socket.connectToServer();
    else { result.blocked.push(url.href); void socket.close({ code: 1008, reason: "Only same-origin preview HMR is allowed." }).catch((error: unknown) => { result.errors.push(message(error)); }); }
  });
  await context.addInitScript(() => {
    const refuse = (name: string): never => { console.error(`STATIONS_SMOKE_AUDIO_REFUSED:${name}`); throw new Error(`Offline acceptance refused ${name}`); };
    if (typeof navigator.mediaDevices !== "undefined") navigator.mediaDevices.getUserMedia = () => refuse("microphone");
    if (typeof speechSynthesis !== "undefined") speechSynthesis.speak = () => { refuse("speech synthesis"); };
    HTMLMediaElement.prototype.play = () => refuse("media playback");
    if (typeof window.AudioContext !== "undefined") window.AudioContext = new Proxy(window.AudioContext, { construct() { return refuse("Web Audio context"); } });
  });
}
async function renderer(page: Page): Promise<Capture["renderer"]> {
  expect(await page.locator(".precinct-render-notice").isVisible()).toBe(false);
  await expect(page.locator("canvas")).toHaveCount(1);
  return await page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
    const gl = canvas.getContext("webgl2");
    if (gl === null || gl.isContextLost()) throw new Error("Actual WebGL is required; a fallback image does not pass station-in-world acceptance.");
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    return { version: String(gl.getParameter(gl.VERSION)), renderer: String(gl.getParameter(gl.RENDERER)), unmasked: debug === null ? null : String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) };
  });
}
export async function runStationsSmoke(): Promise<void> {
  const suppliedAssessment = await assessmentInput(process.argv.slice(2));
  const target = new URL(process.env["ARENA_PREVIEW_URL"] ?? "http://127.0.0.1:5173/");
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.username !== "" || target.password !== "" || target.search !== "" || target.hash !== "") throw new Error("Preview must be a credential-free loopback HTTP URL without query or fragment.");
  const executablePath = process.env["ARENA_CHROMIUM_PATH"] ?? "/usr/bin/chromium";
  const launchArgs = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-background-networking"];
  const output = resolve(process.env["ARENA_STATIONS_OUTPUT"] ?? fileURLToPath(new URL(`../../docs/ui-v2/screenshots/stations-${new Date().toISOString().replaceAll(":", "-")}/`, import.meta.url)));
  await mkdir(output, { recursive: true });
  const report = { status: "running", target: target.href, browser: "", executablePath, launchArgs, assessment: suppliedAssessment === null ? "No assessment file supplied; active assessment is explicitly unexercised by the offline browser run." : "Explicit unchanged local v1 assessment import; canonical app validation required.", verification: "Automated ephemeral Chromium, real software WebGL, two viewports. Screenshots need independent visual review. Connected API publication/permissions remain outside this offline script.", viewports: [] as Capture[], fatal: null as string | null };
  const save = async () => { await writeFile(`${output}/smoke-report.json`, `${JSON.stringify(report, null, 2)}\n`); };
  let browser: Browser | null = null; let interrupted = false;
  const wasInterrupted = () => interrupted;
  const interrupt = () => { interrupted = true; void browser?.close().catch((error: unknown) => { report.fatal = message(error); }); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    browser = await chromium.launch({ executablePath, args: launchArgs, headless: true, timeout: 90_000 }); report.browser = browser.version();
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
      const result: Capture = { viewport, checks: [], screenshots: [], renderer: null, errors: [], shutdownDiagnostics: [], blocked: [], audio: [], requests: [], failedRequests: [] }; report.viewports.push(result);
      let context: BrowserContext | null = null; let page: Page | null = null; let shuttingDown = false;
      const check = async (name: string, operation: () => void | Promise<void>) => {
        const start = Date.now();
        try { await operation(); result.checks.push({ name, status: "passed", detail: "", durationMs: Date.now() - start }); }
        catch (error) { result.checks.push({ name, status: "failed", detail: message(error), durationMs: Date.now() - start }); throw error; }
        finally { console.log(`${String(viewport.width)}x${String(viewport.height)} ${result.checks.at(-1)?.status ?? "unknown"}: ${name}`); await save(); }
      };
      try {
        context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: "reduce", serviceWorkers: "block", permissions: [] });
        await guard(context, target.origin, result); const currentPage = await context.newPage(); page = currentPage; currentPage.setDefaultTimeout(timeout);
        currentPage.on("console", (entry) => { if (entry.text().startsWith("STATIONS_SMOKE_AUDIO_REFUSED:")) result.audio.push(entry.text()); if (entry.type() === "error") (shuttingDown ? result.shutdownDiagnostics : result.errors).push(entry.text()); });
        currentPage.on("pageerror", (error) => { (shuttingDown ? result.shutdownDiagnostics : result.errors).push(message(error)); });
        currentPage.on("request", (request) => { result.requests.push({ method: request.method(), url: request.url() }); });
        currentPage.on("requestfailed", (request) => { result.failedRequests.push({ url: request.url(), error: request.failure()?.errorText ?? null }); });
        currentPage.on("response", (response) => { if (response.status() >= 400) result.errors.push(`${String(response.status())} ${response.url()}`); });
        const dialog = () => currentPage.getByRole("dialog");
        const rendered = async () => { await deadline(currentPage.evaluate(() => new Promise<void>((done) => { requestAnimationFrame(() => { requestAnimationFrame(() => { done(); }); }); })), timeout, "Renderer failed to produce two frames."); };
        const closePanel = async () => { if (await dialog().count() > 0) await currentPage.getByRole("button", { name: "Close panel", exact: true }).click(); await expect(dialog()).toHaveCount(0); await rendered(); };
        const travel = async (key: string, label: string) => {
          await closePanel(); await currentPage.locator("canvas").focus(); await currentPage.keyboard.press(`Digit${key}`); await rendered();
          await expect(currentPage.getByRole("button", { name: new RegExp(`E\\s*${label}`, "u") })).toBeVisible();
          await currentPage.locator("canvas").focus(); await currentPage.keyboard.press("KeyE"); await expect(dialog()).toHaveCount(1);
        };
        const navigate = async (title: string) => { await currentPage.getByRole("navigation", { name: "Training resources", exact: true }).getByRole("button", { name: title, exact: true }).click(); await expect(currentPage.getByRole("dialog", { name: title, exact: true })).toBeVisible(); };
        const shot = async (name: string) => {
          result.renderer = await renderer(currentPage); await expect(dialog()).toHaveCount(1);
          await dialog().evaluate((element) => { element.scrollTop = 0; });
          const path = `${output}/${name}-${String(viewport.width)}x${String(viewport.height)}.png`;
          await currentPage.screenshot({ path, fullPage: false, animations: "disabled", timeout }); result.screenshots.push({ name, path, renderer: "live-webgl" });
        };
        const availableCase = async () => {
          await travel("2", "Choose a case");
          const select = dialog().getByRole("button", { name: "Select case", exact: true });
          if (await select.count() > 0) await select.click();
          await expect(dialog().getByText("Your public packet is ready at your desk.", { exact: true })).toBeVisible();
          await expect(dialog().locator(".case-file[data-selected=true]")).toContainText("C-7Q2MXK4D");
        };
        const unmeasuredSkills = async () => {
          await expect(dialog().locator(".skill-node-score")).toHaveCount(5);
          for (const score of await dialog().locator(".skill-node-score").allTextContents()) expect(score).toBe("Not measured");
          await expect(dialog().locator(".skill-progress-panel meter")).toHaveCount(0);
          for (const value of await dialog().locator(".training-kpi dd").allTextContents()) expect(value).toBe("KPI-1 not measured");
          await expect(dialog()).toContainText("Bundled and imported recordings never count as your progress.");
        };
        await check("real renderer and offline-only startup", async () => {
          await currentPage.goto(target.href, { waitUntil: "domcontentloaded", timeout });
          await expect(currentPage.getByRole("button", { name: "Enter the precinct", exact: true })).toBeEnabled({ timeout: 90_000 });
          await currentPage.getByRole("button", { name: "Comfort and accessibility settings", exact: true }).click();
          await currentPage.getByRole("combobox", { name: /Rendering quality/u }).selectOption("low");
          await currentPage.getByRole("button", { name: "Close panel", exact: true }).click();
          await currentPage.getByRole("button", { name: "Skip arrival", exact: true }).click(); result.renderer = await renderer(currentPage);
          await expect(currentPage.locator(".precinct-ground-rule")).toHaveText(EX4_TEXT);
          await expect(currentPage.locator(".shift-progress")).toHaveAttribute("aria-valuenow", "0");
          expect(result.blocked).toEqual([]);
        });
        await check("actual offline case offer, explicit preview availability and selection", async () => {
          await travel("2", "Choose a case");
          await expect(dialog().getByRole("button", { name: "Select case", exact: true })).toHaveCount(1);
          const previews = dialog().getByRole("button", { name: "Session unavailable", exact: true }); expect(await previews.count()).toBeGreaterThan(0);
          for (const preview of await previews.all()) await expect(preview).toBeDisabled();
          await expect(dialog().locator('.training-availability[data-kind="locked"]')).toHaveCount(0);
          await expect(dialog().locator('.training-availability[data-kind="available"]')).toHaveCount(1);
          await dialog().getByRole("button", { name: "Select case", exact: true }).click();
          await expect(dialog().getByText("Your public packet is ready at your desk.", { exact: true })).toBeVisible();
          await expect(dialog().locator(".case-file[data-selected=true]")).toContainText("C-7Q2MXK4D");
          await expect(currentPage.locator(".shift-progress")).toHaveAttribute("aria-valuenow", "0");
          await shot("01-honest-public-case-offer");
        });
        await check("archive labels are actual bundled tapes with no invented dates or own progress", async () => {
          await navigate("Training archive"); const shelf = dialog().getByRole("region", { name: "Bundled demonstration tapes", exact: true });
          await expect(shelf).toContainText("Dates are not supplied in these files."); await expect(shelf).toContainText("They are not your sessions and never count toward your progress.");
          await expect(shelf.locator(".archive-tape")).toHaveCount(2);
          await expect(shelf).toContainText("C-H3N8RW5B"); await expect(shelf).toContainText("C-7Q2MXK4D");
          await expect(shelf.getByRole("heading", { name: "Recorded coached interview · Gemini", exact: true })).toBeVisible();
          await expect(shelf.getByRole("heading", { name: "Bundled example interview", exact: true })).toBeVisible();
          expect(await shelf.innerText()).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b|\b(?:pre_test|post_test|baseline)\b/u);
          await dialog().getByRole("button", { name: "Recorded sessions", exact: true }).click();
          await expect(dialog().locator(".tape-shelf")).toContainText("No recordings are available from this source.");
          await shot("02-archive-demonstrations-and-empty-history");
        });
        await check("explicit bundled loads stay paused and silent, never turning into own skills", async () => {
          for (const label of ["Recorded coached interview · Gemini", "Bundled example interview"]) {
            await dialog().getByRole("button", { name: `Load ${label}`, exact: true }).click();
            await expect(currentPage.getByRole("dialog", { name: "Replay theater", exact: true })).toBeVisible();
            await expect(dialog().getByText(/Loaded run:/u)).toBeVisible();
            await travel("6", "Enter interview"); const playback = dialog().getByRole("group", { name: "Playback", exact: true });
            await expect(playback.getByRole("button", { name: "Play", exact: true })).toHaveAttribute("aria-pressed", "false");
            await expect(dialog().getByRole("checkbox", { name: "Enable installed-voice read-aloud", exact: true })).not.toBeChecked();
            await travel("0", "Browse records");
          }
          await navigate("Your five skills"); await unmeasuredSkills(); await shot("03-five-skills-without-invented-scores");
          await dialog().getByRole("button", { name: "Read the technique primer", exact: true }).nth(3).click();
          await expect(currentPage.getByRole("dialog", { name: "Training archive", exact: true })).toBeVisible();
          await expect(dialog().locator("details[open] summary")).toContainText("testing alternative explanations");
        });
        await check("warm-up needs explicit start, preserves notes, and excludes paused and closed time", async () => {
          await availableCase(); await navigate("Three-minute warm-up");
          const note = "What record can independently check the timing?";
          await dialog().getByRole("textbox", { name: "Your neutral opening question", exact: true }).fill(note);
          const clock = dialog().locator(".drill-clock > span"); await expect(clock).toHaveText("3:00");
          await currentPage.waitForTimeout(1200); await expect(clock).toHaveText("3:00");
          await dialog().getByRole("button", { name: "Start 3-minute warm-up", exact: true }).click(); await expect(clock).not.toHaveText("3:00");
          await dialog().getByRole("button", { name: "Pause timer", exact: true }).click(); const pausedTime = await clock.textContent();
          await currentPage.waitForTimeout(1200); await expect(clock).toHaveText(pausedTime ?? "");
          await dialog().getByRole("button", { name: "Resume timer", exact: true }).click(); await expect(clock).not.toHaveText(pausedTime ?? "");
          await closePanel(); await currentPage.waitForTimeout(1200); await travel("0", "Browse records"); await navigate("Three-minute warm-up");
          await expect(dialog().getByRole("textbox", { name: "Your neutral opening question", exact: true })).toHaveValue(note);
          await expect(dialog().getByRole("button", { name: "Resume timer", exact: true })).toBeVisible();
          const closedTime = await clock.textContent(); await currentPage.waitForTimeout(1200); await expect(clock).toHaveText(closedTime ?? "");
          await expect(currentPage.locator(".shift-progress")).toHaveAttribute("aria-valuenow", "0"); await shot("04-paused-local-writing-warmup");
        });
        await check("trophies stay explicitly unavailable without a connected published source", async () => {
          await navigate("Trophy wall"); await expect(dialog()).toContainText("No local tournament source is connected.");
          await expect(dialog().getByRole("table")).toHaveCount(0); await expect(dialog().getByRole("meter")).toHaveCount(0);
          await expect(dialog().getByRole("link", { name: /Open training session/u })).toHaveCount(0);
        });
        await check("Coach Lab and instructor require explicit local-demo opt-ins and never claim permission", async () => {
          await navigate("Coach Lab"); await expect(dialog().getByRole("heading", { name: "Coach Lab is not connected", exact: true })).toBeVisible();
          await expect(dialog().locator("meter")).toHaveCount(0); await dialog().getByRole("button", { name: "Explore a local demonstration", exact: true }).click();
          await expect(dialog()).toContainText("All coach versions, metric values and source-run IDs below are fictional display examples. They are not results.");
          await expect(dialog()).toContainText("Illustrative values, not measured improvement.");
          await navigate("Instructor workspace"); await expect(dialog().getByRole("heading", { name: "Instructor access is not connected", exact: true })).toBeVisible();
          await expect(dialog().getByRole("textbox")).toHaveCount(0); await dialog().getByRole("button", { name: "Open the local instructor demo", exact: true }).click();
          await expect(dialog()).toContainText("No instructor permission is implied."); await expect(dialog().getByText("No measured progress", { exact: true })).toHaveCount(2);
          await dialog().getByRole("textbox", { name: "Practice objective", exact: true }).fill("Practice one neutral, evidence-led follow-up.");
          await dialog().getByRole("button", { name: "Prepare local assignment draft", exact: true }).click();
          await expect(dialog().getByRole("status")).toHaveText("Local assignment draft prepared. Nothing was assigned or sent.");
          await dialog().getByRole("textbox", { name: "Note for the sample timeline", exact: true }).fill("Ask for a checkable source.");
          await dialog().getByRole("button", { name: "Prepare local timeline draft", exact: true }).click();
          await expect(dialog().getByRole("status")).toHaveText("Local timeline draft prepared. Nothing was posted.");
          await expect(dialog().locator(".instructor-drafts")).toContainText("LOCAL-DEMO-TRIAL"); await shot("05-explicit-local-instructor-drafts");
        });
        await check("offline interview cannot silently start an assessment or enable a backend", async () => {
          await travel("6", "Enter interview");
          await expect(dialog().getByRole("button", { name: "Connect local backend", exact: true })).toBeVisible();
          await expect(dialog().getByRole("button", { name: "Start assessment", exact: true })).toHaveCount(0);
        });
        if (suppliedAssessment === null) result.checks.push({ name: "active assessment resource hiding", status: "unexercised", detail: "Offline start has no backend. Supply an existing assessment recording for explicit browser import coverage; pending live intent and drill pause-before-start remain route/session unit regressions.", durationMs: 0 });
        else await check("optional unchanged assessment import withholds resources while keeping current playback usable", async () => {
          await travel("8", "Review a session");
          await dialog().locator('input[type="file"]').first().setInputFiles(suppliedAssessment.path);
          await travel("6", "Enter interview");
          await expect(dialog()).toContainText("Assessment: coaching withheld");
          await expect(dialog().getByRole("group", { name: "Playback", exact: true })).toBeVisible();
          await expect(dialog().getByRole("checkbox", { name: "Enable installed-voice read-aloud", exact: true })).not.toBeChecked();
          await travel("0", "Browse records"); await expect(dialog()).toContainText("Training resources and prior-session feedback are unavailable during an assessment.");
          await expect(dialog().getByRole("button", { name: /Load Recorded/u })).toHaveCount(0);
          await travel("9", "Open Coach Lab"); await expect(dialog()).toContainText("unavailable during an assessment");
          await expect(dialog().getByRole("button", { name: "Explore a local demonstration", exact: true })).toHaveCount(0);
          await travel("2", "Choose a case"); await expect(dialog()).toContainText("Case changes are unavailable during an assessment.");
          for (const button of await dialog().locator(".case-file button").all()) await expect(button).toBeDisabled();
          await travel("6", "Enter interview"); await dialog().getByRole("button", { name: "Close this session view", exact: true }).click();
          await travel("0", "Browse records"); await navigate("Three-minute warm-up");
          await expect(dialog().getByRole("button", { name: "Pause timer", exact: true })).toHaveCount(0);
        });
        await check("existing trust navigation and clean offline boundaries", async () => {
          await travel("0", "Browse records"); await navigate("Trust & methodology");
          const link = dialog().getByRole("link", { name: "Read trust & methodology", exact: true }); await expect(link).toHaveAttribute("href", "/trust/methodology");
          // No response waits are needed for local assets or imports. This pre-click navigation wait is handled immediately.
          const navigation = observed(currentPage.waitForURL((url) => url.origin === target.origin && url.pathname === "/trust/methodology", { timeout }));
          await link.click(); await navigation;
          expect(result.screenshots).toHaveLength(5); expect(result.blocked).toEqual([]); expect(result.audio).toEqual([]); expect(result.errors).toEqual([]); expect(result.failedRequests).toEqual([]);
          expect(result.requests.every((request) => new URL(request.url).origin === target.origin && !/^\/api(?:\/|$)/u.test(new URL(request.url).pathname))).toBe(true);
          expect(await currentPage.evaluate(() => Object.keys(localStorage).filter((key) => /notebook|drill|assignment|coach/iu.test(key)))).toEqual([]);
        });
      } catch (error) {
        result.checks.push({ name: "viewport completion", status: "failed", detail: message(error), durationMs: 0 });
        if (page !== null && !page.isClosed()) {
          try {
            const stem = `${output}/failure-${String(viewport.width)}x${String(viewport.height)}`;
            await page.screenshot({ path: `${stem}.png`, fullPage: false, timeout });
            await writeFile(`${stem}.json`, JSON.stringify(await page.evaluate(() => ({ url: location.href, activeElement: document.activeElement?.tagName ?? null, text: document.body.innerText, openDialogs: document.querySelectorAll("dialog[open]").length })), null, 2));
          } catch (error) { result.shutdownDiagnostics.push(message(error)); }
        }
      } finally { shuttingDown = true; await context?.close(); await save(); }
      if (wasInterrupted()) throw new Error("Smoke interrupted; its ephemeral browser has been closed.");
    }
    report.status = report.viewports.length === 2 && report.viewports.every((result) => result.screenshots.length === 5 && result.checks.every((check) => check.status !== "failed")) ? suppliedAssessment === null ? "passed-offline-assessment-unexercised" : "passed" : "failed";
  } catch (error) { report.status = "blocked"; report.fatal = message(error); }
  finally {
    try { await browser?.close(); } catch (error) { report.status = "failed"; report.fatal = message(error); }
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    await save(); console.log(`Station smoke ${report.status}: ${output}/smoke-report.json`);
    if (!report.status.startsWith("passed")) process.exitCode = 1;
  }
}
if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await runStationsSmoke();
