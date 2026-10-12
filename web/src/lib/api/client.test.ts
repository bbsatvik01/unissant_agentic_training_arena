import { describe, expect, it } from "vitest";

import { ApiError, ContractError, createApiClient, type FetchLike } from "./client";

interface Sent {
  readonly url: string;
  readonly init: RequestInit;
}

const ME = { user_id: "u1", display_name: "Dana", roles: ["investigator"], ex4_acknowledged: null, csrf_token: "tok-1" };

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A fake transport: `routes` answers by "METHOD path", each a queue (the last answer repeats). */
function transport(routes: Record<string, readonly (() => Response)[]>) {
  const sent: Sent[] = [];
  const calls = new Map<string, number>();
  const fetch: FetchLike = (url, init) => {
    sent.push({ url, init });
    const key = `${init.method ?? "GET"} ${url}`;
    const queue = routes[key];
    if (queue === undefined) return Promise.reject(new Error(`unexpected ${key}`));
    const n = calls.get(key) ?? 0;
    calls.set(key, n + 1);
    const answer = queue[Math.min(n, queue.length - 1)];
    if (answer === undefined) return Promise.reject(new Error(`no answer for ${key}`));
    return Promise.resolve(answer());
  };
  return { fetch, sent };
}

function header(s: Sent, name: string): string | null {
  return new Headers(s.init.headers).get(name);
}

describe("fetch wrapper (S6 1.3, FE-TECH-5)", () => {
  it("reads /api/me before the first POST and sends its token on every POST, bodyless ones included", async () => {
    const t = transport({
      "GET /api/me": [() => json(200, ME)],
      "POST /api/trials/x/stream-tickets": [() => json(200, { ticket: "a" })],
      "POST /api/me/ack-ex4": [() => new Response(null, { status: 204 })],
    });
    const api = createApiClient({ fetch: t.fetch });
    await api.post("/api/trials/x/stream-tickets");
    await api.post("/api/me/ack-ex4", { any: 1 });
    expect(t.sent.map((s) => `${s.init.method ?? ""} ${s.url}`)).toEqual([
      "GET /api/me",
      "POST /api/trials/x/stream-tickets",
      "POST /api/me/ack-ex4",
    ]);
    for (const s of t.sent.slice(1)) expect(header(s, "X-Arena-CSRF")).toBe("tok-1");
    expect(t.sent[1]?.init.body).toBeUndefined();
    expect(t.sent[2]?.init.body).toBe('{"any":1}');
    expect(header(t.sent[2] as Sent, "Content-Type")).toBe("application/json");
  });

  it("sends nothing before the token is known: a failed /api/me stops the POST", async () => {
    const t = transport({ "GET /api/me": [() => json(500, { code: "boom" })] });
    const api = createApiClient({ fetch: t.fetch });
    await expect(api.post("/api/trials/x/stream-tickets")).rejects.toBeInstanceOf(ApiError);
    expect(t.sent.map((s) => s.url)).toEqual(["/api/me"]);
  });

  it("refuses a /api/me body without a token, and sends nothing else", async () => {
    const t = transport({ "GET /api/me": [() => json(200, { ...ME, csrf_token: "" })] });
    const api = createApiClient({ fetch: t.fetch });
    await expect(api.post("/api/x")).rejects.toBeInstanceOf(ContractError);
    expect(t.sent).toHaveLength(1);
  });

  it("on a 403 re-reads /api/me once and retries once with the new token", async () => {
    const t = transport({
      "GET /api/me": [() => json(200, ME), () => json(200, { ...ME, csrf_token: "tok-2" })],
      "POST /api/x": [() => json(403, { code: "csrf" }), () => json(200, { ok: true })],
    });
    const api = createApiClient({ fetch: t.fetch });
    await expect(api.post("/api/x")).resolves.toEqual({ ok: true });
    expect(t.sent.map((s) => s.url)).toEqual(["/api/me", "/api/x", "/api/me", "/api/x"]);
    expect(header(t.sent[1] as Sent, "X-Arena-CSRF")).toBe("tok-1");
    expect(header(t.sent[3] as Sent, "X-Arena-CSRF")).toBe("tok-2");
  });

  it("retries a 403 only once: a second 403 is the caller's error", async () => {
    const t = transport({ "GET /api/me": [() => json(200, ME)], "POST /api/x": [() => json(403, { code: "csrf" })] });
    const api = createApiClient({ fetch: t.fetch });
    const error = await api.post("/api/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect(t.sent.filter((s) => s.url === "/api/x")).toHaveLength(2);
    expect(t.sent.filter((s) => s.url === "/api/me")).toHaveLength(2);
  });

  it("reuses the known token and shares one /api/me read between concurrent POSTs", async () => {
    const t = transport({ "GET /api/me": [() => json(200, ME)], "POST /api/x": [() => json(200, {})] });
    const api = createApiClient({ fetch: t.fetch });
    await Promise.all([api.post("/api/x"), api.post("/api/x")]);
    await api.post("/api/x");
    expect(t.sent.filter((s) => s.url === "/api/me")).toHaveLength(1);
  });

  it("reads the study status and a console /api/me without acknowledgement or study", async () => {
    const study = { counterbalance: "B", ended: { pre: 2, practice: 1, post: 0 }, next_phase: "practice" };
    const t = transport({ "GET /api/me": [() => json(200, { ...ME, study })] });
    await expect(createApiClient({ fetch: t.fetch }).me()).resolves.toMatchObject({ study });
    const consoleMe = { user_id: "u2", display_name: "Rater", roles: ["trainer"], csrf_token: "tok-2" };
    const c = transport({ "GET /api/me": [() => json(200, consoleMe)] });
    await expect(createApiClient({ fetch: c.fetch }).me()).resolves.toMatchObject({ roles: ["trainer"], ex4_acknowledged: null, study: null, console: true });
  });

  it("returns the validated profile from me() and keeps its token", async () => {
    const t = transport({ "GET /api/me": [() => json(200, ME)], "POST /api/x": [() => json(200, {})] });
    const api = createApiClient({ fetch: t.fetch });
    await expect(api.me()).resolves.toEqual({
      user_id: "u1",
      display_name: "Dana",
      roles: ["investigator"],
      ex4_acknowledged: null,
      study: null,
      console: false,
      csrf_token: "tok-1",
    });
    await api.post("/api/x");
    expect(t.sent.map((s) => s.url)).toEqual(["/api/me", "/api/x"]);
  });

  it.each([
    ["not an object", [1]],
    ["roles not strings", { ...ME, roles: [1] }],
    ["no user id", { ...ME, user_id: 3 }],
    ["no display name", { ...ME, display_name: null }],
    ["ex4 not a time", { ...ME, ex4_acknowledged: 5 }],
    ["a malformed study", { ...ME, study: { counterbalance: "A", ended: { pre: -1, practice: 0, post: 0 }, next_phase: "pre" } }],
    ["an unknown study phase", { ...ME, study: { counterbalance: "A", ended: { pre: 0, practice: 0, post: 0 }, next_phase: "later" } }],
  ])("refuses a /api/me body with %s", async (_why, body) => {
    const t = transport({ "GET /api/me": [() => json(200, body)] });
    await expect(createApiClient({ fetch: t.fetch }).me()).rejects.toBeInstanceOf(ContractError);
  });

  it("GETs carry no CSRF header and need no token", async () => {
    const t = transport({ "GET /api/config": [() => json(200, { paused: false })] });
    const api = createApiClient({ fetch: t.fetch });
    await expect(api.get("/api/config")).resolves.toEqual({ paused: false });
    expect(t.sent).toHaveLength(1);
    expect(header(t.sent[0] as Sent, "X-Arena-CSRF")).toBeNull();
  });

  it("stays same-origin: relative /api/ paths only, cookies same-origin, no redirects followed", async () => {
    const t = transport({ "GET /api/config": [() => json(200, {})] });
    const api = createApiClient({ fetch: t.fetch });
    for (const bad of ["https://evil.example/api/x", "//evil.example/api/x", "/apix", "api/x", "/api/../x", "/api/\\x", ""]) {
      await expect(api.get(bad)).rejects.toThrow(/same-origin/);
      await expect(api.post(bad)).rejects.toThrow(/same-origin/);
    }
    expect(t.sent).toHaveLength(0);
    await api.get("/api/config");
    expect(t.sent[0]?.init.credentials).toBe("same-origin");
    expect(t.sent[0]?.init.redirect).toBe("error");
    expect(header(t.sent[0] as Sent, "X-Requested-With")).toBe("XMLHttpRequest");
  });

  it("passes keepalive through for acknowledgements", async () => {
    const t = transport({ "GET /api/me": [() => json(200, ME)], "POST /api/telemetry/kpi4": [() => new Response(null, { status: 204 })] });
    const api = createApiClient({ fetch: t.fetch });
    await expect(api.post("/api/telemetry/kpi4", { a: 1 }, { keepalive: true })).resolves.toBeNull();
    expect(t.sent[1]?.init.keepalive).toBe(true);
  });

  it.each([
    [{ code: "turn_in_progress" }, "turn_in_progress"],
    [{ detail: "stream_closed" }, "stream_closed"],
    [{ detail: { code: "paused" } }, "paused"],
    [{ detail: [{ msg: "x" }] }, null],
    ["not json", null],
  ])("an error answer %j carries code %s", async (body, code) => {
    const t = transport({
      "GET /api/x": [() => (typeof body === "string" ? new Response(body, { status: 409 }) : json(409, body))],
    });
    const error = await createApiClient({ fetch: t.fetch })
      .get("/api/x")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).code).toBe(code);
    expect((error as ApiError).path).toBe("/api/x");
  });

  it("a 2xx body that is not JSON is a contract error", async () => {
    const t = transport({ "GET /api/x": [() => new Response("<html>", { status: 200 })] });
    await expect(createApiClient({ fetch: t.fetch }).get("/api/x")).rejects.toBeInstanceOf(ContractError);
  });

  it("uses the global fetch by default", async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((url: string) => {
      calls.push(url);
      return Promise.resolve(json(200, {}));
    }) as typeof fetch;
    try {
      await createApiClient().get("/api/config");
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toEqual(["/api/config"]);
  });
});

describe("fetch wrapper: dispatch timing (S6 5.6)", () => {
  it("with the token known, a POST reaches the transport within the call", async () => {
    const t = transport({ "GET /api/me": [() => json(200, ME)], "POST /api/x": [() => json(200, {})] });
    const api = createApiClient({ fetch: t.fetch });
    await api.me();
    const pending = api.post("/api/x", { a: 1 });
    expect(t.sent.map((s) => s.url)).toEqual(["/api/me", "/api/x"]);
    await pending;
  });
});

describe("fetch wrapper: a transport that throws", () => {
  it("turns a synchronous throw into a rejection", async () => {
    const api = createApiClient({
      fetch: () => {
        throw new TypeError("blocked");
      },
    });
    await expect(api.get("/api/config")).rejects.toBeInstanceOf(TypeError);
  });
});

describe("fetch wrapper: encoded dot segments", () => {
  it.each(["/api/%2e%2e/internal/answer", "/api/.%2E/x", "/api/x/%2e%2e/%2e%2e/internal/answer", "/api/%2e%2e", "/api/x/%2E%2E/%2E%2E/y"])(
    "refuses %s, which the browser would resolve outside /api/",
    async (bad) => {
      const t = transport({ "GET /api/me": [() => json(200, ME)] });
      const api = createApiClient({ fetch: t.fetch });
      await expect(api.get(bad)).rejects.toThrow(/same-origin/);
      await expect(api.post(bad)).rejects.toThrow(/same-origin/);
      expect(t.sent).toHaveLength(0);
    },
  );

  it("keeps a query string that merely mentions dots", async () => {
    const t = transport({ "GET /api/a?b=../c": [() => json(200, {})] });
    await expect(createApiClient({ fetch: t.fetch }).get("/api/a?b=../c")).resolves.toEqual({});
  });
});

describe("fetch wrapper: the body is fixed when post() is called", () => {
  it("a body changed while /api/me is read, or before the 403 retry, does not change what is sent", async () => {
    const t = transport({
      "GET /api/me": [() => json(200, ME)],
      "POST /api/x": [() => json(403, { code: "csrf" }), () => json(200, {})],
    });
    const api = createApiClient({ fetch: t.fetch });
    const draft = { rationale: "first" };
    const pending = api.post("/api/x", draft);
    draft.rationale = "changed during the token read";
    await pending;
    const bodies = t.sent.filter((s) => s.url === "/api/x").map((s) => s.init.body);
    expect(bodies).toEqual(['{"rationale":"first"}', '{"rationale":"first"}']);
  });

  it("posts for audio with the CSRF header and returns the bytes, flagging the server's silence", async () => {
    const wav = new Uint8Array([82, 73, 70, 70]);
    const t = transport({
      "GET /api/me": [() => json(200, ME)],
      "POST /api/tts": [() => new Response(wav, { status: 200, headers: { "Content-Type": "audio/wav" } }), () => new Response(wav, { status: 200, headers: { "X-Arena-Speech": "silent" } })],
    });
    const api = createApiClient({ fetch: t.fetch });
    const first = await api.postAudio("/api/tts", { voice: "Kore", text: "Hi." });
    expect(new Uint8Array(first.audio)).toEqual(wav);
    expect(first.silent).toBe(false);
    expect((await api.postAudio("/api/tts", { voice: "Kore", text: "Hi." })).silent).toBe(true);
    const post = t.sent.find((s) => s.init.method === "POST");
    expect(post === undefined ? null : header(post, "X-Arena-CSRF")).toBe("tok-1");
    expect(post?.init.body).toBe(JSON.stringify({ voice: "Kore", text: "Hi." }));
  });

  it("turns a refused audio request into an ApiError with the server's code, and refuses a foreign path", async () => {
    const t = transport({ "GET /api/me": [() => json(200, ME)], "POST /api/tts": [() => json(503, { detail: "speech unavailable" })] });
    const api = createApiClient({ fetch: t.fetch });
    await expect(api.postAudio("/api/tts", {})).rejects.toMatchObject({ status: 503, code: "speech unavailable" });
    await expect(api.postAudio("https://evil.example/x", {})).rejects.toThrow(/not a same-origin/);
  });
});
