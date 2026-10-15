/** Explicit developer CLI. Records actual local-browser interactions, never simulated frames.
 * Requires --start-local-mock and an already-running Vite proxy. Output is outside git by default.
 * The recorded walkthrough is silent; local fixed dialogue is not live AI or verified speech. */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect, type Browser, type BrowserContext, type Page, type Response } from "@playwright/test";
import { EX4_TEXT } from "../src/lib/copy/ex4.ts";
type Exit = { code: number | null; signal: string | null };
type Check = { name: string; passed: boolean; detail: string; durationMs: number };
interface Capture {
  viewport: { width: number; height: number }; checks: Check[];
  screenshots: { name: string; path: string; renderer: string }[];
  sceneAudits: { name: string; path: string; renderer: string }[];
  errors: string[]; shutdownDiagnostics: string[]; external: string[]; audio: string[];
  requests: { method: string; url: string }[];
  failedRequests: { url: string; reason: string | null }[];
  mockExit: Exit | null;
}
const timeout = 60_000;
const message = (error: unknown) => error instanceof Error ? error.stack ?? error.message : String(error);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function safeUrl(value: string): string {
  const url = new URL(value); if (url.searchParams.has("ticket")) url.searchParams.set("ticket", "LOCAL_FIXTURE_REDACTED"); return url.href;
}
function deadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error(label)); }, ms); })]).finally(() => { clearTimeout(timer); });
}
async function json(response: Response): Promise<unknown> {
  expect(response.ok(), `${response.request().method()} ${safeUrl(response.url())}`).toBe(true); return await response.json() as unknown;
}
function ids(value: unknown): { session: string; trial: string } {
  if (!object(value) || typeof value["session_id"] !== "string" || typeof value["trial_id"] !== "string") throw new Error("Missing fresh session/trial IDs.");
  expect(value["session_id"]).not.toBe(value["trial_id"]); return { session: value["session_id"], trial: value["trial_id"] };
}
async function launchMock(origin: string, port: number): Promise<() => Promise<Exit>> {
  // Bind failure refuses an occupied port; only this returned child can ever be signalled.
  const child = spawn(process.execPath, [fileURLToPath(new URL("./precinct-local-mock.ts", import.meta.url)), "--port", String(port), "--browser-origin", origin], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(); let out = "", err = "";
  const exit = new Promise<Exit>((done, fail) => { child.once("error", fail); child.once("exit", (code, signal) => { done({ code, signal }); }); });
  const ready = new Promise<void>((done, fail) => {
    child.stdout.on("data", (chunk: Buffer) => { out = `${out}${chunk.toString()}`.slice(-8192); if (out.includes(`Listening only at http://127.0.0.1:${String(port)}.`)) done(); });
    child.stderr.on("data", (chunk: Buffer) => { err = `${err}${chunk.toString()}`.slice(-8192); });
    void exit.then((status) => { fail(new Error(`Owned mock exited before readiness: ${JSON.stringify(status)} ${err}`)); }, fail);
  });
  let closing: Promise<Exit> | null = null;
  const close = (): Promise<Exit> => {
    if (closing !== null) return closing;
    closing = (async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      try { const result = await deadline(exit, 8000, "Mock failed to close its SSE/timers."); expect(result).toEqual({ code: 0, signal: null }); return result; }
      catch (error) { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await deadline(exit, 3000, "Mock cleanup failed.").catch(() => undefined); throw error; }
    })(); return closing;
  };
  try { await deadline(ready, 10_000, "Mock readiness timed out."); } catch (error) { await close().catch(() => undefined); throw error; }
  return close;
}
async function networkGuard(context: BrowserContext, origin: string, result: Capture): Promise<void> {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { result.external.push(safeUrl(url.href)); await route.abort("blockedbyclient"); return; }
    if (/^\/api\/(tts|voice)(?:\/|$)/u.test(url.pathname)) { result.audio.push(url.pathname); await route.abort("blockedbyclient"); return; }
    await route.continue();
  });
  await context.routeWebSocket("**/*", (socket) => {
    const url = new URL(socket.url());
    if (url.protocol === "ws:" && url.host === new URL(origin).host && !url.pathname.startsWith("/api/")) socket.connectToServer();
    else { result.external.push(safeUrl(url.href)); void socket.close({ code: 1008, reason: "Only same-origin Vite HMR is allowed." }).catch((error: unknown) => { result.errors.push(message(error)); }); }
  });
  await context.addInitScript(() => {
    const refuse = (name: string): never => { console.error(`SMOKE_AUDIO_REFUSED:${name}`); throw new Error(`Smoke refused ${name}`); };
    navigator.mediaDevices.getUserMedia = () => refuse("microphone");
    if (typeof speechSynthesis !== "undefined") speechSynthesis.speak = () => { refuse("speech synthesis"); };
    HTMLMediaElement.prototype.play = () => refuse("audio/video playback");
    window.AudioContext = new Proxy(window.AudioContext, { construct() { return refuse("Web Audio context"); } });
  });
}
async function requireRenderer(page: Page): Promise<void> {
  expect(await page.locator(".precinct-render-notice").isVisible()).toBe(false);
  expect(await page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => { const gl = canvas.getContext("webgl2"); return gl !== null && !gl.isContextLost(); })).toBe(true);
}

export async function recordPrecinctWalkthrough(): Promise<void> {
  const argumentsText = process.argv.slice(2).join(" ");
  if (!["--start-local-mock", "--start-local-mock --arrival-reception"].includes(argumentsText)) throw new Error("Use --start-local-mock, optionally followed by --arrival-reception.");
  const short = argumentsText.endsWith(" --arrival-reception");
  const target = new URL(process.env["ARENA_PREVIEW_URL"] ?? "http://127.0.0.1:5173/");
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(target.hostname) || target.username !== "" || target.password !== "") throw new Error("Only credential-free loopback previews are accepted.");
  const portText = process.env["ARENA_MOCK_PORT"] ?? "8084", port = Number(portText);
  if (!/^\d{4,5}$/u.test(portText) || !Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid local mock port.");
  const output = resolve(process.env["ARENA_VIDEO_OUTPUT"] ?? `${tmpdir()}/arena-walkthrough-${new Date().toISOString().replaceAll(":", "-")}`);
  await mkdir(output, { recursive: true });
  const viewport = { width: 1440, height: 900 };
  const result: Capture = { viewport, checks: [], screenshots: [], sceneAudits: [], errors: [], shutdownDiagnostics: [], external: [], audio: [], requests: [], failedRequests: [], mockExit: null };
  const chapters: { label: string; elapsedMs: number }[] = [];
  const report = { status: "running", scope: short ? "arrival-reception" : "full-interview", description: "Actual browser walkthrough, software WebGL. Local scripted staff and fixed mock text replies; no live AI, microphone, audible speech or hardware-FPS claim.", source: target.origin, video: null as string | null, chapters, result };
  const save = async () => { await writeFile(`${output}/walkthrough-report.json`, `${JSON.stringify(report, null, 2)}\n`); };
  let browser: Browser | null = null, context: BrowserContext | null = null, closeMock: (() => Promise<Exit>) | null = null;
  let shuttingDown = false; let diagnosticPage: Page | null = null;
  const interrupt = () => { void browser?.close(); void closeMock?.().catch(() => undefined); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    closeMock = await launchMock(target.origin, port);
    browser = await chromium.launch({ executablePath: process.env["ARENA_CHROMIUM_PATH"] ?? "/usr/bin/chromium", headless: true, timeout: 90_000, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-background-networking"] });
    context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: "no-preference", serviceWorkers: "block", permissions: [], recordVideo: { dir: output, size: viewport } });
    await networkGuard(context, target.origin, result);
    const page = await context.newPage(); diagnosticPage = page; const video = page.video(); const started = Date.now();
    page.setDefaultTimeout(timeout);
    page.on("pageerror", (error) => { (shuttingDown ? result.shutdownDiagnostics : result.errors).push(message(error)); });
    page.on("console", (entry) => { if (entry.type() === "error") (shuttingDown ? result.shutdownDiagnostics : result.errors).push(entry.text()); });
    page.on("request", (request) => { result.requests.push({ method: request.method(), url: safeUrl(request.url()) }); });
    page.on("requestfailed", (request) => { result.failedRequests.push({ url: safeUrl(request.url()), reason: request.failure()?.errorText ?? null }); });
    page.on("response", (response) => { if (response.status() >= 400) (shuttingDown ? result.shutdownDiagnostics : result.errors).push(`${String(response.status())} ${safeUrl(response.url())}`); });
    // These holds pace the documentary video. They do not replace readiness/assertion checks.
    const hold = async (ms = 2500) => { await page.waitForTimeout(ms); };
    const chapter = async (label: string) => { chapters.push({ label, elapsedMs: Date.now() - started }); console.log(label); await save(); };
    const rendered = async () => { await deadline(page.evaluate(() => new Promise<void>((done) => { requestAnimationFrame(() => { requestAnimationFrame(() => { done(); }); }); })), timeout, "Renderer frame timeout."); };
    const close = async () => { if (await page.getByRole("dialog").count() > 0) await page.getByRole("button", { name: "Close panel", exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0); await rendered(); };
    const travel = async (key: string, label: string, open = true) => {
      await close(); await page.locator("canvas").focus(); await page.keyboard.press(`Digit${key}`); await rendered();
      await expect(page.getByRole("button", { name: new RegExp(`E\\s*${label}`, "u") })).toBeVisible();
      if (open) { await page.locator("canvas").focus(); await page.keyboard.press("KeyE"); await expect(page.getByRole("dialog")).toBeVisible(); }
    };
    const response = (path: string, method = "POST") => { const pending = page.waitForResponse((item) => new URL(item.url()).pathname === path && item.request().method() === method); void pending.catch(() => undefined); return pending; };
    await page.goto(target.href, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Enter the precinct", exact: true })).toBeEnabled({ timeout: 90_000 });
    await page.getByRole("button", { name: "Comfort and accessibility settings", exact: true }).click();
    await page.getByRole("combobox", { name: /Rendering quality/u }).selectOption("low");
    await page.getByRole("button", { name: "Close panel", exact: true }).click();
    await chapter("Arrival: actual walkable precinct, original Office theme"); await hold();
    await page.getByRole("button", { name: "Enter the precinct", exact: true }).click();
    await requireRenderer(page); await expect(page.locator(".precinct-ground-rule")).toHaveText(EX4_TEXT); await hold(4000);
    // The body loads lazily on the first real third-person toggle. Wait for all actual
    // actor assets to finish before demonstrating movement, then inspect the footage visually.
    const bodyFiles = ["avatar.glb", "body.jpg", "body_n.jpg", "head.jpg", "head_n.jpg", "opacity.png"];
    const bodyReady = Promise.all(bodyFiles.map(async (file) => {
      const response = await page.waitForResponse((item) => new URL(item.url()).pathname === `/avatars/Business_Male_02/${file}`, { timeout: 90_000 });
      expect(response.ok()).toBe(true); const error = await response.finished(); if (error !== null) throw error;
    }));
    void bodyReady.catch(() => undefined);
    await page.locator("canvas").focus(); await page.keyboard.press("KeyV"); await expect(page.locator(".precinct-controls")).toContainText("Third person");
    await bodyReady; await rendered(); await hold(5000);
    await chapter("Third-person character movement: keyboard controls");
    await page.keyboard.down("KeyW"); await hold(2800); await page.keyboard.up("KeyW"); await hold(1200);
    await page.keyboard.down("KeyD"); await hold(900); await page.keyboard.up("KeyD"); await hold(1500);
    await page.keyboard.press("KeyV"); await expect(page.locator(".precinct-controls")).toContainText("First person");
    await chapter("Reception: fictional colleague, fixed local dialogue");
    await travel("1", "Reception", false); await hold(2500); await page.keyboard.press("KeyE");
    await page.getByRole("button", { name: "Check in for this shift", exact: true }).click();
    await page.getByRole("button", { name: "Talk to reception officer", exact: true }).click();
    await page.locator(".npc-subtitle").scrollIntoViewIfNeeded(); await hold(3500);
    await page.getByRole("button", { name: "Where do I begin?", exact: true }).click(); await page.locator(".npc-subtitle").scrollIntoViewIfNeeded(); await hold(3500);
    if (!short) {
    await chapter("Explicit connection to the local scripted fixture; no live model");
    await travel("6", "Enter interview"); const me = response("/api/me", "GET");
    await page.getByRole("button", { name: "Connect local backend", exact: true }).click(); await json(await me);
    const ack = response("/api/me/ack-ex4"); await page.getByRole("button", { name: "I understand the ground rule", exact: true }).click(); await json(await ack);
    await travel("2", "Choose a case"); await hold(2500); await page.getByRole("button", { name: /Select Local scripted fixture:/u }).click(); await hold(1500);
    await chapter("Public dossier: readable documents and an explicit working notebook");
    await travel("4", "Your dossier"); await hold(3000);
    await page.getByRole("tab", { name: /^Documents(?:\s*\d+)?$/u }).click(); await hold(3500);
    await page.getByRole("tab", { name: /^Timeline(?:\s*\d+)?$/u }).click(); await hold(3000);
    await page.getByRole("tab", { name: /^Notebook(?:\s*\d+)?$/u }).click();
    await page.getByRole("textbox", { name: "New note", exact: true }).pressSequentially("Clarify the assignment, then compare it with the available records.", { delay: 30 });
    await page.getByRole("button", { name: "Add note", exact: true }).click();
    await expect(page.getByLabel("Saved working notes", { exact: true })).toContainText("Clarify the assignment"); await hold(2500);
    await chapter("Briefing: public objective and evidence-first ground rule");
    await travel("5", "Start briefing"); await hold(3500);
    await page.getByRole("button", { name: "Acknowledge the briefing and ground rule", exact: true }).click(); await close(); await hold(2500);
    await chapter("Interview: explicit call, fresh local practice and seated camera");
    await travel("6", "Enter interview"); await page.getByRole("button", { name: "Call subject to room", exact: true }).click();
    const start = response("/api/sessions"); await page.getByRole("button", { name: "Start text practice", exact: true }).click(); const practice = ids(await json(await start));
    await expect(page.getByRole("textbox", { name: "Your question", exact: true })).toBeEnabled();
    await expect(page.getByRole("checkbox", { name: "Enable local backend read-aloud", exact: true })).not.toBeChecked();
    await page.getByRole("button", { name: "Sit at interview table", exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0); await hold(5000);
    await page.locator("canvas").focus(); await page.keyboard.press("KeyV"); await hold(3500);
    await page.getByRole("button", { name: "Leave interview seat", exact: true }).click(); await page.locator("canvas").focus(); await page.keyboard.press("KeyV");
    await travel("6", "Enter interview"); await page.getByRole("tab", { name: "Transcript", exact: true }).click();
    await page.getByRole("textbox", { name: "Your question", exact: true }).pressSequentially("Please describe the task you were assigned that afternoon.", { delay: 30 });
    const answer = response(`/api/trials/${practice.trial}/turns`); await page.getByRole("button", { name: "Send", exact: true }).click(); await json(await answer);
    await expect(page.getByRole("tabpanel").filter({ visible: true })).toContainText("AUTHORED SCRIPTED BEAT 1/12"); await hold(4000);
    await chapter("Observation: four event-driven views of the same local run");
    await travel("7", "Observe interview", false); await hold(3500); await page.keyboard.press("KeyE");
    await expect(page.locator(".precinct-observation-grid .awm")).toHaveCount(4);
    await page.locator(".precinct-observation-grid").scrollIntoViewIfNeeded(); await hold(4000);
    await page.getByRole("button", { name: "Expand Case board", exact: true }).click(); await hold(3000);
    await page.getByRole("button", { name: "Back to four screens", exact: true }).click(); await close();
    await chapter("Current checkpoint: voice, exact replay and new theme still in development"); await hold(3500);
    } else { await chapter("End of arrival and scripted reception excerpt"); await hold(3500); }
    await requireRenderer(page); expect(result.external).toEqual([]); expect(result.audio).toEqual([]); expect(result.errors).toEqual([]);
    result.checks.push({ name: "Real browser walkthrough completed without external/audio calls or runtime errors", passed: true, detail: "Fixed local text fixture only; actual recorded browser interactions", durationMs: Date.now() - started });
    // Close the browser first to stop its EventSource. Then close only our owned mock.
    shuttingDown = true; await context.close(); context = null;
    if (video === null) throw new Error("Browser video artifact was not created."); report.video = await video.path();
    result.mockExit = await closeMock(); closeMock = null; report.status = "passed";
  } catch (error) {
    report.status = "failed"; result.errors.push(message(error));
    if (diagnosticPage !== null && !diagnosticPage.isClosed()) {
      try {
        await diagnosticPage.screenshot({ path: `${output}/failure.png`, fullPage: false, timeout });
        await writeFile(`${output}/failure.json`, JSON.stringify(await diagnosticPage.evaluate(() => ({ text: document.body.innerText, dialogs: Array.from(document.querySelectorAll("dialog")).map((item) => ({ open: item.open, text: item.innerText })) })), null, 2));
      } catch (diagnosticError) { result.shutdownDiagnostics.push(message(diagnosticError)); }
    }
  }
  finally {
    shuttingDown = true; await context?.close().catch((error: unknown) => { result.shutdownDiagnostics.push(message(error)); });
    if (closeMock !== null) { try { result.mockExit = await closeMock(); } catch (error) { result.shutdownDiagnostics.push(message(error)); report.status = "failed"; } }
    await browser?.close(); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); await save();
    console.log(`Walkthrough ${report.status}: ${output}/walkthrough-report.json`); if (report.status !== "passed") process.exitCode = 1;
  }
}
if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await recordPrecinctWalkthrough();
