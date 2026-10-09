/**
 * The one fetch wrapper of the web app (S6 1.3, FE-TECH-3, FE-TECH-5; D10, S5 10.3). Every request the
 * browser makes goes through here; a lint rule forbids `fetch` everywhere else.
 *
 * - Same origin only: a path must be a relative `/api/...` path of the origin that served the page (no
 *   scheme, no host, no `..` segment); cookies travel `same-origin` and redirects are refused, so nothing is
 *   ever sent to, or followed to, another origin.
 * - CSRF: the token comes from `GET /api/me` (which also sets the `arena_csrf` cookie) and is kept in memory
 *   only. Every POST, bodyless ones included, carries `X-Arena-CSRF`; no POST is sent before the token is
 *   known. On a 403 the wrapper re-reads `/api/me` once and retries once.
 * - `X-Requested-With: XMLHttpRequest` on every request, so a hosted IAP front answers an expired session with
 *   401 instead of a redirect (S6 1.4); harmless locally.
 * - Errors: a non-2xx answer is an `ApiError` carrying the status and the server's `code` (`paused`,
 *   `turn_in_progress`, `stream_closed`, ...); a 2xx body that is not JSON is a `ContractError`.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** A non-2xx answer. `code` is the server's machine-readable reason when it sent one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly path: string,
  ) {
    super(`${path} answered ${String(status)}${code === null ? "" : ` (${code})`}`);
    this.name = "ApiError";
  }
}

/** A payload that does not match its contract: dropped, never rendered (S6 5.2). */
export class ContractError extends Error {
  constructor(
    readonly path: string,
    readonly contract: string,
  ) {
    super(`${path}: the payload does not match ${contract}`);
    this.name = "ContractError";
  }
}

/** The fields of `GET /api/me` (S5 5.5) this layer relies on; the rest arrive with their screens. */
export interface Me {
  readonly user_id: string;
  readonly display_name: string;
  readonly roles: readonly string[];
  readonly ex4_acknowledged: string | null;
  readonly csrf_token: string;
}

export interface PostOptions {
  /** Let the request outlive the page (`keepalive`), for acknowledgements (S6 5.6). */
  readonly keepalive?: boolean;
}

export interface ApiClient {
  /** Read `/api/me`; keeps its CSRF token for later POSTs. */
  me(): Promise<Me>;
  /** GET a same-origin `/api/` path; resolves to the parsed JSON body (null for an empty body). */
  get(path: string): Promise<unknown>;
  /** POST with the CSRF header; `body` is sent as JSON when given. */
  post(path: string, body?: unknown, options?: PostOptions): Promise<unknown>;
}

export interface ApiClientOptions {
  /** The transport, a test seam. Defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
}

const API_PATH = /^\/api\/[^\\]*$/;

/** Refuse anything but a relative path under `/api/` on this origin. */
function checkPath(path: string): void {
  const route = path.split(/[?#]/, 1)[0] ?? "";
  if (!API_PATH.test(path) || route.split("/").some((segment) => segment === ".." || segment === ".")) {
    throw new Error(`not a same-origin /api/ path: ${JSON.stringify(path)}`);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMe(value: unknown): Me | null {
  if (!isRecord(value)) return null;
  const { user_id: userId, display_name: name, roles, ex4_acknowledged: ack, csrf_token: token } = value;
  if (typeof userId !== "string" || userId === "" || typeof name !== "string") return null;
  if (!Array.isArray(roles) || !roles.every((role) => typeof role === "string")) return null;
  if (ack !== null && typeof ack !== "string") return null;
  if (typeof token !== "string" || token === "") return null;
  return { user_id: userId, display_name: name, roles, ex4_acknowledged: ack, csrf_token: token };
}

/** The server's reason in an error body: `{code}`, `{detail: "<code>"}` or `{detail: {code}}`. */
function errorCode(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (typeof body["code"] === "string") return body["code"];
  const detail = body["detail"];
  if (typeof detail === "string") return detail;
  if (isRecord(detail) && typeof detail["code"] === "string") return detail["code"];
  return null;
}

async function readJson(response: Response): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const text = await response.text();
  if (text === "") return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const transport: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  let token: string | null = null;
  let meInFlight: Promise<Me> | null = null;

  const send = (method: "GET" | "POST", path: string, body: unknown, keepalive: boolean, csrf: string | null) => {
    const headers: Record<string, string> = { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" };
    if (csrf !== null) headers["X-Arena-CSRF"] = csrf;
    const init: RequestInit = { method, headers, credentials: "same-origin", redirect: "error", cache: "no-store" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    if (keepalive) init.keepalive = true;
    return transport(path, init);
  };

  const settle = async (path: string, response: Response): Promise<unknown> => {
    const parsed = await readJson(response);
    if (!response.ok) throw new ApiError(response.status, parsed.ok ? errorCode(parsed.value) : null, path);
    if (!parsed.ok) throw new ContractError(path, "JSON");
    return parsed.value;
  };

  const readMe = async (): Promise<Me> => {
    const value = await settle("/api/me", await send("GET", "/api/me", undefined, false, null));
    const me = parseMe(value);
    if (me === null) throw new ContractError("/api/me", "the /api/me profile");
    token = me.csrf_token;
    return me;
  };

  /** One `/api/me` read at a time; concurrent callers share it. */
  const me = (): Promise<Me> => {
    meInFlight ??= readMe().finally(() => {
      meInFlight = null;
    });
    return meInFlight;
  };

  const csrfToken = async (): Promise<string> => token ?? (await me()).csrf_token;

  return {
    me,
    async get(path) {
      checkPath(path);
      return settle(path, await send("GET", path, undefined, false, null));
    },
    async post(path, body, postOptions = {}) {
      checkPath(path);
      const keepalive = postOptions.keepalive === true;
      const first = await send("POST", path, body, keepalive, await csrfToken());
      if (first.status !== 403) return settle(path, first);
      // A stale token (the cookie rotated, another tab re-read /api/me): re-read once, retry once.
      const fresh = (await me()).csrf_token;
      return settle(path, await send("POST", path, body, keepalive, fresh));
    },
  };
}
