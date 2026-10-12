/**
 * The trust center's server sections as the page shows them (S6 4.11): the latest isolation gate run per check
 * (`arena.v_isolation_checks`: check, candidate, pass or fail, run time, commit SHA; never the evidence), the
 * commitments of a revealed tournament (with the payload text and nonce after reveal, for "Verify in browser"),
 * and the local Phoenix address. Each is read loosely and refused whole when malformed.
 */

export interface IsolationRun {
  readonly check: string;
  readonly candidate: string | null;
  readonly passed: boolean;
  readonly ranAt: string | null;
  readonly commitSha: string | null;
}

export interface CommitmentRow {
  readonly trial: string;
  readonly commitment: string;
  readonly transcriptSha: string | null;
  readonly evidenceSha: string | null;
  readonly payloadText: string | null;
  readonly nonce: string | null;
}

type Json = Readonly<Record<string, unknown>>;

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function rows(v: unknown, key: string): readonly unknown[] | null {
  if (Array.isArray(v)) return v as unknown[];
  if (isRecord(v) && Array.isArray(v[key])) return v[key] as unknown[];
  return null;
}

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** `GET /api/trust/isolation`: an array or `{checks: [...]}`; null when not one. */
export function parseIsolation(v: unknown): readonly IsolationRun[] | null {
  const list = rows(v, "checks");
  if (list === null) return null;
  const out: IsolationRun[] = [];
  for (const r of list) {
    if (!isRecord(r) || typeof r["check"] !== "string") return null;
    const passed = typeof r["passed"] === "boolean" ? r["passed"] : r["result"] === "pass" ? true : r["result"] === "fail" ? false : null;
    if (passed === null) return null;
    out.push({ check: r["check"], candidate: text(r["candidate"]), passed, ranAt: text(r["run_at"] ?? r["ran_at"]), commitSha: text(r["commit_sha"]) });
  }
  return out;
}

/** `GET /api/trust/commitments`: an array or `{commitments: [...]}`; null when not one. */
export function parseCommitments(v: unknown): readonly CommitmentRow[] | null {
  const list = rows(v, "commitments");
  if (list === null) return null;
  const out: CommitmentRow[] = [];
  for (const r of list) {
    if (!isRecord(r)) return null;
    const trial = text(r["trial_ref"]) ?? (typeof r["trial_ref"] === "number" ? `#${String(r["trial_ref"])}` : null) ?? text(r["trial_id"]);
    const commitment = text(r["commitment_sha256"]);
    if (trial === null || commitment === null) return null;
    out.push({ trial, commitment, transcriptSha: text(r["transcript_sha256"]), evidenceSha: text(r["evidence_sha256"]), payloadText: text(r["payload_text"]), nonce: text(r["nonce"]) });
  }
  return out;
}

/** The local Phoenix address from `GET /api/config` (`phoenix_url`), or null. */
export function phoenixUrl(config: unknown): string | null {
  if (!isRecord(config)) return null;
  const url = config["phoenix_url"];
  return typeof url === "string" && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url) ? url : null;
}
