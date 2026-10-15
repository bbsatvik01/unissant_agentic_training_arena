/** Explicit developer CLI: node tools/precinct-interview-smoke.ts --start-local-mock
 * Requires the existing native Vite origin and a matching loopback API proxy target.
 * Owns only newly launched Chromium/mock processes. No import-time startup or user profile access.
 * QA pending until an actual report passes; screenshots still require independent visual review. */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect, type Browser, type BrowserContext, type Page, type Response } from "@playwright/test";
import { EX4_TEXT } from "../src/lib/copy/ex4.ts";
import { WIRE_VALIDATORS } from "../src/lib/contracts/compiled/validators.js";
import { invariantErrors } from "../src/lib/contracts/invariants.ts";

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
export async function runInterviewSmoke(): Promise<void> {
  if (process.argv.slice(2).join(" ") !== "--start-local-mock") throw new Error("Explicit opt-in required: node tools/precinct-interview-smoke.ts --start-local-mock");
  const portText = process.env["ARENA_MOCK_PORT"] ?? "8080";
  const mockPort = Number(portText);
  if (!/^\d{4,5}$/u.test(portText) || !Number.isSafeInteger(mockPort) || mockPort < 1024 || mockPort > 65535) throw new Error("ARENA_MOCK_PORT must name an unprivileged local port (1024–65535).");
  const target = new URL(process.env["ARENA_PREVIEW_URL"] ?? "http://127.0.0.1:5173/");
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(target.hostname) || target.username !== "" || target.password !== "") throw new Error("Preview must be a credential-free loopback HTTP URL.");
  const executablePath = process.env["ARENA_CHROMIUM_PATH"] ?? "/usr/bin/chromium";
  const args = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-background-networking"];
  const output = fileURLToPath(new URL(`../../docs/ui-v2/screenshots/interview-${new Date().toISOString().replaceAll(":", "-")}/`, import.meta.url));
  await mkdir(output, { recursive: true });
  const report = { status: "running", target: target.href, mockPort, browser: "", executablePath, args, verification: "Automated ephemeral browser smoke. Software WebGL captures still require independent visual and real-device review.", viewports: [] as Capture[], fatal: null as string | null };
  const save = async () => { await writeFile(`${output}smoke-report.json`, `${JSON.stringify(report, null, 2)}\n`); };
  const interruption = new AbortController();
  let browser: Browser | null = null, closeMock: (() => Promise<Exit>) | null = null;
  const interrupt = () => { interruption.abort(); void browser?.close(); void closeMock?.().catch(() => undefined); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    // Only derive a seek time from the existing recording. The app loads/validates the actual file itself.
    const recording: unknown = JSON.parse(await readFile(new URL("../src/fixtures/recordings/F01-coached.json", import.meta.url), "utf8"));
    if (!object(recording) || !Array.isArray(recording["events"])) throw new Error("Existing coached recording missing.");
    const card = (recording["events"] as unknown[]).find((event) => object(event) && object(event["frame"]) && event["frame"]["type"] === "coach.card");
    if (!object(card) || typeof card["at_ms"] !== "number") throw new Error("Existing recording has no genuine coach card.");
    const seekMs = Math.ceil(card["at_ms"] / 250) * 250;
    browser = await chromium.launch({ executablePath, headless: true, timeout: 90_000, args }); report.browser = browser.version();
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
      const result: Capture = { viewport, checks: [], screenshots: [], sceneAudits: [], errors: [], shutdownDiagnostics: [], external: [], audio: [], requests: [], failedRequests: [], mockExit: null }; report.viewports.push(result);
      const check = async (name: string, operation: () => void | Promise<void>) => {
        const start = Date.now();
        try { await operation(); result.checks.push({ name, passed: true, detail: "", durationMs: Date.now() - start }); }
        catch (error) { result.checks.push({ name, passed: false, detail: message(error), durationMs: Date.now() - start }); throw error; }
        finally { console.log(`${String(viewport.width)}x${String(viewport.height)}: ${name}: ${String(result.checks.at(-1)?.passed)}`); await save(); }
      };
      let context: BrowserContext | null = null;
      let diagnosticPage: Page | null = null;
      let shuttingDown = false;
      try {
        closeMock = await launchMock(target.origin, mockPort);
        context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: "reduce", serviceWorkers: "block", permissions: [] });
        await networkGuard(context, target.origin, result);
        const page = await context.newPage(); diagnosticPage = page; page.setDefaultTimeout(timeout);
        page.on("console", (entry) => { if (entry.type() === "error") (shuttingDown ? result.shutdownDiagnostics : result.errors).push(entry.text()); });
        page.on("pageerror", (error) => { (shuttingDown ? result.shutdownDiagnostics : result.errors).push(message(error)); });
        page.on("request", (request) => { result.requests.push({ method: request.method(), url: safeUrl(request.url()) }); });
        page.on("requestfailed", (request) => { result.failedRequests.push({ url: safeUrl(request.url()), reason: request.failure()?.errorText ?? null }); });
        page.on("response", (response) => { if (response.status() >= 400) (shuttingDown ? result.shutdownDiagnostics : result.errors).push(`${String(response.status())} ${safeUrl(response.url())}`); });
        const response = (path: string, method = "POST") => {
          const pending = page.waitForResponse((item) => new URL(item.url()).pathname === path && item.request().method() === method);
          // Keep a failed click from leaving an unhandled timer that bypasses owned cleanup.
          // Awaiting the original promise below still propagates every response error.
          void pending.catch(() => undefined); return pending;
        };
        // Fast travel is consumed by the existing render controller, not by a synchronous DOM
        // click. Wait for that actual frame boundary; retain each assertion's normal timeout.
        const rendered = async () => { await deadline(page.evaluate(() => new Promise<void>((done) => {
          requestAnimationFrame(() => { requestAnimationFrame(() => { done(); }); });
        })), timeout, "The software renderer did not produce the next two frames."); };
        const travel = async (key: string, label: string) => {
          if (await page.getByRole("dialog").count() > 0) await page.getByRole("button", { name: "Close panel", exact: true }).click();
          await expect(page.getByRole("dialog")).toHaveCount(0); await rendered();
          await page.locator("canvas").focus(); await page.keyboard.press(`Digit${key}`);
          await rendered();
          await expect(page.getByRole("button", { name: new RegExp(`E\\s*${label}`, "u") })).toBeVisible();
          await page.locator("canvas").focus(); await page.keyboard.press("KeyE"); await expect(page.getByRole("dialog")).toBeVisible();
        };
        const shot = async (name: string) => {
          await requireRenderer(page); const path = `${output}${name}-${String(viewport.width)}x${String(viewport.height)}.png`;
          await page.screenshot({ path, fullPage: false, animations: "disabled", timeout }); result.screenshots.push({ name, path, renderer: "live-webgl" });
        };
        const sceneAudit = async (name: string) => {
          await requireRenderer(page); const path = `${output}audit-${name}-${String(viewport.width)}x${String(viewport.height)}.png`;
          await page.screenshot({ path, fullPage: false, animations: "disabled", timeout });
          result.sceneAudits.push({ name, path, renderer: "live-webgl-needs-independent-visual-review" });
        };
        const silent = async () => { await expect(page.getByRole("checkbox", { name: "Enable local backend read-aloud", exact: true })).not.toBeChecked(); };
        const prep = "Ask what task was assigned before discussing the access exception. Check the radio log against the order.";
        let practice = { session: "", trial: "" };
        await check("actual renderer, explicit mock identity and EX4", async () => {
          await page.goto(target.href, { waitUntil: "domcontentloaded" });
          await expect(page.getByRole("button", { name: "Enter the precinct", exact: true })).toBeEnabled({ timeout: 90_000 });
          await page.getByRole("button", { name: "Comfort and accessibility settings", exact: true }).click();
          await page.getByRole("combobox", { name: /Rendering quality/u }).selectOption("low");
          await page.getByRole("button", { name: "Close panel", exact: true }).click();
          await page.getByRole("button", { name: "Skip arrival", exact: true }).click(); await requireRenderer(page);
          await expect(page.locator(".precinct-ground-rule")).toHaveText(EX4_TEXT);
          expect(result.requests.filter((item) => new URL(item.url).pathname.startsWith("/api/"))).toEqual([]);
          await travel("6", "Enter interview");
          const profile = response("/api/me", "GET");
          await page.getByRole("button", { name: "Connect local backend", exact: true }).click();
          const me = await json(await profile);
          expect(object(me) ? me["display_name"] : null).toBe("Local scripted fixture exercise (unscored)");
          expect(object(me) ? me["ex4_acknowledged"] : false).toBe(null);
          await expect(page.getByRole("button", { name: "Start text practice", exact: true })).toBeDisabled();
          const ack = response("/api/me/ack-ex4");
          await page.getByRole("button", { name: "I understand the ground rule", exact: true }).click(); await json(await ack);
          await travel("2", "Choose a case");
          await page.getByRole("button", { name: /Select Local scripted fixture:/u }).click();
          await travel("4", "Your dossier"); await page.getByRole("tab", { name: /^Notebook(?:\s*\d+)?$/u }).click();
          await page.getByRole("combobox", { name: "Note type", exact: true }).selectOption("question");
          await page.getByRole("textbox", { name: "New note", exact: true }).fill(prep);
          await page.locator(".dossier-citation-picker input").first().check();
          await page.getByRole("button", { name: "Add note", exact: true }).click();
          await expect(page.getByLabel("Saved working notes", { exact: true })).toContainText(prep);
        });
        await check("fresh practice, preparation handoff and explicit call/sit/exit", async () => {
          await travel("6", "Enter interview");
          await page.getByRole("button", { name: "Call subject to room", exact: true }).click();
          await expect(page.getByText("Subject called to the interview room.", { exact: true })).toBeVisible();
          const start = response("/api/sessions");
          await page.getByRole("button", { name: "Start text practice", exact: true }).click(); practice = ids(await json(await start));
          await expect(page.getByRole("textbox", { name: "Your question", exact: true })).toBeEnabled(); await silent();
          await travel("4", "Your dossier");
          await expect(page.getByRole("region", { name: "Preparation notebook handoff", exact: true })).toBeVisible();
          await page.getByRole("button", { name: "Carry preparation notes into this run", exact: true }).click();
          await page.getByRole("tab", { name: /^Notebook(?:\s*\d+)?$/u }).click();
          await expect(page.getByLabel("Saved working notes", { exact: true })).toContainText(prep);
          expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes("notebook")))).toEqual([]);
          await travel("6", "Enter interview"); await page.getByRole("button", { name: "Sit at interview table", exact: true }).click();
          await expect(page.getByRole("dialog")).toHaveCount(0);
          await expect(page.getByRole("button", { name: "Leave interview seat", exact: true })).toBeVisible();
          await shot("01-seated-scripted-interview");
          await page.getByRole("button", { name: "Leave interview seat", exact: true }).click();
          await expect(page.locator(".precinct-seat-controls")).toHaveCount(0); await travel("6", "Enter interview");
        });
        let count = 0;
        const ask = async (question: string) => {
          await page.getByRole("tab", { name: "Transcript", exact: true }).click();
          await page.getByRole("textbox", { name: "Your question", exact: true }).fill(question);
          const post = response(`/api/trials/${practice.trial}/turns`);
          await page.getByRole("button", { name: "Send", exact: true }).click(); const sent = await post; await json(sent);
          const body: unknown = JSON.parse(sent.request().postData() ?? "null"); expect(object(body) ? body["question"] : null).toBe(question);
          count += 1; await expect(page.getByRole("tabpanel").filter({ visible: true })).toContainText(`AUTHORED SCRIPTED BEAT ${String(count)}/12`);
          await expect(page.getByRole("textbox", { name: "Your question", exact: true })).toBeEnabled();
        };
        const evidence = async () => {
          await page.getByRole("tab", { name: "Evidence table", exact: true }).click();
          const catalogue = page.locator(".precinct-evidence-catalogue"); if (await catalogue.getAttribute("open") === null) await catalogue.locator("summary").first().click();
        };
        const requestRecord = async (id: string) => {
          await evidence(); const post = response(`/api/trials/${practice.trial}/evidence-requests`);
          await page.locator(".requestable").filter({ has: page.locator(".mono", { hasText: new RegExp(`^${id}$`, "u") }) }).getByRole("button", { name: "Request", exact: true }).click(); await json(await post);
          await expect(page.getByRole("combobox", { name: "Public source", exact: true }).locator("option").filter({ hasText: `Released record · ${id} ·` })).toHaveCount(1);
        };
        await check("typed exchanges, release thresholds, public table and cited draft", async () => {
          await evidence(); const gate = page.locator(".requestable").filter({ hasText: "rec-01" }).getByRole("button");
          await expect(gate).toHaveText("After 2 exchanges"); await expect(gate).toBeDisabled();
          await ask("Please describe the task you were assigned that afternoon.");
          await ask("Who sent you to the room, and how was that instruction given?"); await requestRecord("rec-01");
          await ask("What did you do when you entered the vault?"); await requestRecord("rec-02");
          const source = page.getByRole("combobox", { name: "Public source", exact: true });
          const value = await source.locator("option").filter({ hasText: "Released record · rec-02 ·" }).getAttribute("value");
          if (value === null) throw new Error("Released radio log is absent."); await source.selectOption(value);
          await expect(page.locator(".precinct-selected-source table")).toBeVisible();
          await page.getByRole("button", { name: "Lay selected source on table", exact: true }).click();
          await expect(page.locator(".precinct-table-status")).toContainText("On the table: rec-02");
          await page.getByRole("button", { name: "Sit at interview table", exact: true }).click();
          await expect(page.getByRole("dialog")).toHaveCount(0); await page.locator("canvas").focus(); await page.keyboard.press("KeyV");
          await expect(page.locator(".precinct-controls")).toContainText("Third person");
          await sceneAudit("presented-paper-third-person");
          await page.getByRole("button", { name: "Leave interview seat", exact: true }).click();
          await page.locator("canvas").focus(); await page.keyboard.press("KeyV");
          await expect(page.locator(".precinct-controls")).toContainText("First person"); await travel("6", "Enter interview");
          const before = result.requests.filter((item) => item.method === "POST" && item.url.endsWith("/turns")).length;
          await page.getByRole("button", { name: "Use source in question draft", exact: true }).click();
          const cited = await page.getByRole("textbox", { name: "Your question", exact: true }).inputValue(); expect(cited).toContain("rec-02");
          expect(result.requests.filter((item) => item.method === "POST" && item.url.endsWith("/turns"))).toHaveLength(before);
          await page.locator(".precinct-selected-source table").evaluate((table) => { table.scrollIntoView({ block: "center" }); });
          await expect(page.locator(".precinct-selected-source table")).toBeInViewport();
          await shot("02-released-evidence-and-cited-draft"); await ask(cited);
          await ask("Please describe the equipment and doorway while you moved the tank.");
          await ask("When was the work order entered, as far as you know?");
          await ask("Did you handle any boxes or seals while completing the task?"); await requestRecord("rec-03"); await requestRecord("rec-04");
          await expect(page.getByRole("combobox", { name: "Public source", exact: true }).locator("option").filter({ hasText: "Released record · rec-05 ·" })).toHaveCount(1);
          await page.getByRole("tab", { name: "Practice coach", exact: true }).click();
          await expect(page.getByText("Coaching for this turn was not available.", { exact: true })).toBeVisible();
          await expect(page.locator(".card-title")).toHaveCount(0); await silent();
        });
        await check("committed trainee finding and own authored unscored debrief", async () => {
          await page.getByRole("tab", { name: "Finding", exact: true }).click();
          await page.getByRole("radio", { name: "Insufficient evidence", exact: true }).check();
          await page.getByRole("combobox", { name: "Likelihood that the subject is concealing involvement", exact: true }).selectOption("roughly_even_chance");
          await page.getByRole("radio", { name: "moderate", exact: true }).check();
          await page.getByRole("checkbox", { name: "T1", exact: true }).check(); await page.getByRole("checkbox", { name: "rec-02", exact: true }).check();
          await page.getByRole("textbox", { name: "What would settle it (one per line, up to three)", exact: true }).fill("Confirm dispatch details with the supervisor");
          const rationale = "My submitted finding remains distinct from the authored scenario outcome. I would corroborate the dispatch before resolving the access exception.";
          await page.getByRole("textbox", { name: "Rationale", exact: true }).fill(rationale);
          const commit = response(`/api/trials/${practice.trial}/finding`), publication = response(`/api/sessions/${practice.session}/debrief`);
          await page.getByRole("button", { name: "Confirm finding", exact: true }).click(); const committed = await commit; await json(committed);
          const body: unknown = JSON.parse(committed.request().postData() ?? "null");
          expect(object(body) && object(body["finding"]) ? body["finding"]["rationale"] : null).toBe(rationale);
          const debrief = await json(await publication);
          expect(WIRE_VALIDATORS["debrief.v1"]?.(debrief)).toBe(true); expect(invariantErrors("debrief.v1", debrief)).toEqual([]);
          expect(object(debrief) ? Object.keys(debrief).sort() : []).toEqual(["outcome", "schema_version", "scored", "session_id"]);
          expect(object(debrief) ? debrief["session_id"] : null).toBe(practice.session); expect(object(debrief) ? debrief["scored"] : null).toBe(false);
          const outcome = object(debrief) && object(debrief["outcome"]) ? debrief["outcome"] : {};
          expect(outcome["committed_label"]).toBe("insufficient_evidence"); expect(outcome["correct_finding"]).toBe("truthful");
          await expect(page.locator(".finding-locked")).toContainText(rationale); await travel("8", "Review a session");
          await expect(page.getByRole("region", { name: "Session debrief", exact: true })).toContainText("Authored fictional resolution; this is not a grade of your interview.");
          await expect(page.getByText("This session is not scored.", { exact: true })).toBeVisible(); await expect(page.locator(".precinct-debrief-total")).toHaveCount(0);
          await page.getByRole("region", { name: "Session debrief", exact: true }).locator(".precinct-session-origin").evaluate((label) => { label.scrollIntoView({ block: "start" }); });
          await expect(page.getByRole("region", { name: "Session debrief", exact: true }).locator(".precinct-session-origin")).toBeInViewport(); await shot("03-authored-unscored-debrief");
        });
        await check("genuine recorded coach and four shared monitor projections", async () => {
          await page.getByRole("button", { name: "Recorded coached interview · Gemini", exact: true }).click();
          await expect(page.getByText(/Loaded run:/u)).toBeVisible(); await travel("6", "Enter interview"); await silent();
          await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
          await expect(page.getByRole("textbox", { name: "Your question", exact: true })).toBeDisabled();
          const seek = page.getByRole("slider", { name: "Position in the recording", exact: true }); await seek.focus(); await seek.press("Home");
          for (let i = 0; i < seekMs / 250; i += 1) await seek.press("ArrowRight"); await expect(seek).toHaveValue(String(seekMs));
          await page.getByRole("tab", { name: "Practice coach", exact: true }).click();
          await expect(page.getByRole("heading", { name: "Card for T1", exact: true })).toBeVisible();
          await expect(page.getByRole("button", { name: "Use this question", exact: true })).toBeDisabled();
          await page.getByRole("heading", { name: "Card for T1", exact: true }).scrollIntoViewIfNeeded(); await shot("04-genuine-recorded-coach-card");
          await travel("7", "Observe interview"); await expect(page.locator(".precinct-observation-grid .awm")).toHaveCount(4);
          for (const style of ["Agent office", "Case board", "Playhouse", "Agent tower"]) {
            const expand = page.getByRole("button", { name: `Expand ${style}`, exact: true }); await expand.click();
            await expect(page.getByLabel(`${style} expanded`, { exact: true })).toBeVisible();
            await expect(page.locator(".awm--full svg desc")).toContainText("1 coaching cards");
            await page.getByRole("button", { name: "Back to four screens", exact: true }).click(); await expect(expand).toBeFocused();
          }
          await page.locator(".precinct-observation-grid").evaluate((grid) => { grid.scrollIntoView({ block: "center" }); });
          for (const monitor of await page.locator(".precinct-observation-grid .awm").all()) await expect(monitor).toBeInViewport({ ratio: 0.99 });
          await shot("05-genuine-recorded-observation-screens");
          await page.getByRole("button", { name: "Close panel", exact: true }).click();
          await sceneAudit("physical-observation-monitor");
          // The authored station faces the physical screen. Click its projected center through
          // the real Canvas raycaster, rather than invoking a route or component callback.
          const monitorY = 0.5 + (1.65 - 1.12) / (2 * Math.hypot(0.6, 1.813) * Math.tan(66 * Math.PI / 360));
          await page.mouse.click(viewport.width * 0.5, viewport.height * monitorY);
          await expect(page.getByRole("button", { name: "Back to four screens", exact: true })).toBeVisible();
          await expect(page.locator(".awm--full svg desc")).toContainText("1 coaching cards");
          await page.getByRole("button", { name: "Back to four screens", exact: true }).click();
        });
        await check("pending and active assessment withhold coaching after recorded review", async () => {
          // The saved F01 case is not offered by this fixture backend. Select its own public case.
          await travel("2", "Choose a case");
          await page.getByRole("button", { name: /Select Local scripted fixture:/u }).click();
          await travel("6", "Enter interview");
          await expect(page.getByRole("button", { name: "Start assessment", exact: true })).toBeEnabled();
          let release: (() => void) | undefined, entered: (() => void) | undefined;
          const held = new Promise<void>((done) => { release = done; }), pending = new Promise<void>((done) => { entered = done; });
          // Delay only the real local POST. No synthetic Playwright API response is introduced.
          await page.route("**/api/sessions", async (route) => {
            if (route.request().method() !== "POST") { await route.fallback(); return; }
            entered?.(); await held; await route.fallback();
          });
          let assessment: { session: string; trial: string };
          try {
            await page.getByRole("button", { name: "Start assessment", exact: true }).click(); await deadline(pending, 15_000, "Assessment POST was not observed.");
            await expect(page.getByRole("tab", { name: "Practice coach", exact: true })).toHaveCount(0); await expect(page.locator(".card-title")).toHaveCount(0);
            await travel("7", "Observe interview");
            await expect(page.getByText("Assessment: coaching activity and content are withheld.", { exact: true })).toBeVisible();
            await expect(page.locator(".awm-scene desc")).toHaveCount(4);
            for (const description of await page.locator(".awm-scene desc").allTextContents()) expect(description).toContain("0 coaching cards");
            await travel("8", "Review a session");
            await expect(page.getByText("Assessment in progress. Recorded runs and review are withheld until this run publishes its debrief.", { exact: true })).toBeVisible();
            await expect(page.getByRole("button", { name: "Recorded coached interview · Gemini", exact: true })).toHaveCount(0);
            // Start the response clock only when the deliberately held request may proceed.
            const start = response("/api/sessions"); release?.();
            assessment = ids(await json(await start));
          } finally { release?.(); }
          expect(assessment.trial).not.toBe(practice.trial); expect(assessment.session).not.toBe(practice.session);
          await page.unroute("**/api/sessions"); await travel("6", "Enter interview");
          await expect(page.getByRole("textbox", { name: "Your question", exact: true })).toBeEnabled(); await silent();
          await expect(page.getByRole("tab", { name: "Practice coach", exact: true })).toHaveCount(0);
          await page.getByRole("textbox", { name: "Your question", exact: true }).fill("Please describe the assignment in your own account.");
          const post = response(`/api/trials/${assessment.trial}/turns`); await page.getByRole("button", { name: "Send", exact: true }).click(); await json(await post);
          await expect(page.getByRole("tabpanel").filter({ visible: true })).toContainText("AUTHORED SCRIPTED BEAT 1/12");
          await travel("7", "Observe interview");
          await expect(page.getByText("Assessment: coaching activity and content are withheld.", { exact: true })).toBeVisible();
          for (const description of await page.locator(".awm-scene desc").allTextContents()) expect(description).toContain("0 coaching cards");
          // Keep this actual live SSE open for the owned-process shutdown check below.
        });
        await check("five captures, zero external/audio attempts and no hidden failures", () => {
          expect(result.screenshots).toHaveLength(5); expect(result.external).toEqual([]); expect(result.audio).toEqual([]); expect(result.errors).toEqual([]);
          expect(result.requests.every((request) => new URL(request.url).origin === target.origin)).toBe(true);
          // EventSource cancellation on an explicit source switch is expected; other failed loads are errors.
          expect(result.failedRequests.filter((request) => !/\/api\/trials\/[^/]+\/events\?/u.test(request.url))).toEqual([]);
        });
      } catch (error) {
        result.checks.push({ name: "viewport completion", passed: false, detail: message(error), durationMs: 0 });
        if (diagnosticPage !== null && !diagnosticPage.isClosed()) {
          const stem = `${output}failure-${String(viewport.width)}x${String(viewport.height)}`;
          try {
            await diagnosticPage.screenshot({ path: `${stem}.png`, fullPage: false, timeout });
            await writeFile(`${stem}.json`, JSON.stringify(await diagnosticPage.evaluate(() => ({
              url: location.href, activeElement: document.activeElement?.tagName ?? null,
              text: document.body.innerText, dialogs: document.querySelectorAll("dialog[open]").length,
            })), null, 2));
          } catch (diagnosticError) { result.shutdownDiagnostics.push(message(diagnosticError)); }
        }
      }
      finally {
        // Stop this server with its SSE still active, then destroy this fresh browser context.
        shuttingDown = true;
        if (closeMock !== null) {
          try { result.mockExit = await closeMock(); } catch (error) { result.checks.push({ name: "owned mock shutdown", passed: false, detail: message(error), durationMs: 0 }); }
          closeMock = null;
        }
        await context?.close(); await save();
      }
      if (interruption.signal.aborted) throw new Error("Smoke interrupted; owned processes were closed.");
    }
    report.status = report.viewports.length === 2 && report.viewports.every((result) => result.screenshots.length === 5 && result.checks.every((check) => check.passed) && result.mockExit?.code === 0) ? "passed" : "failed";
  } catch (error) { report.status = "blocked"; report.fatal = message(error); }
  finally {
    await closeMock?.().catch((error: unknown) => { report.status = "failed"; report.fatal = message(error); }); await browser?.close();
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    await save(); console.log(`Interview smoke ${report.status}: ${output}smoke-report.json`); if (report.status !== "passed") process.exitCode = 1;
  }
}
if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await runInterviewSmoke();
