/**
 * The admin console's data (S6 4.13), read from the referee's admin routes (S5 5.5): the budget rows of
 * `ops.v_budget_status` (ceiling, liability, open reservations, headroom, kill switch), the tournaments with their
 * lifecycle, the transitions each state allows, and the reveal preconditions as the server computes them. Reveal
 * is offered only when every precondition is reported and true (FE-ADM-2). The kill switch is read-only here: the
 * owner runs `scripts/kill_switch.sh`. No infra control appears anywhere.
 */

export interface BudgetRow {
  readonly bucket: string;
  readonly ceiling: string;
  readonly liability: string;
  readonly open: string;
  readonly headroom: string;
  readonly killSwitch: boolean | null;
}

export type TournamentStatus = "draft" | "frozen" | "running" | "sealed" | "scoring" | "revealed";

export interface AdminTournament {
  readonly id: string;
  readonly name: string;
  readonly split: "dev" | "hidden";
  readonly status: TournamentStatus;
}

export interface Precondition {
  readonly name: string;
  readonly passed: boolean;
}

export type AdminAction = "freeze" | "open" | "close" | "scoring" | "reveal";

type Json = Readonly<Record<string, unknown>>;

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A Postgres numeric as published (a JSON number or a decimal string), as dollars text, or null. */
function money(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return `$${v.toFixed(2)}`;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return `$${Number(v).toFixed(2)}`;
  return null;
}

function rows(v: unknown, key: string): readonly unknown[] | null {
  if (Array.isArray(v)) return v as unknown[];
  if (isRecord(v) && Array.isArray(v[key])) return v[key] as unknown[];
  return null;
}

/** `GET /api/admin/budget`: an array of budget rows, or `{buckets: [...]}`; null when not one. */
export function parseBudget(v: unknown): readonly BudgetRow[] | null {
  const list = rows(v, "buckets");
  if (list === null) return null;
  const out: BudgetRow[] = [];
  for (const r of list) {
    if (!isRecord(r) || typeof r["bucket"] !== "string") return null;
    const ceiling = money(r["ceiling_usd"]);
    const liability = money(r["liability_usd"]);
    const open = money(r["open_usd"]);
    const headroom = money(r["headroom_usd"]);
    if (ceiling === null || liability === null || open === null || headroom === null) return null;
    out.push({ bucket: r["bucket"], ceiling, liability, open, headroom, killSwitch: typeof r["kill_switch"] === "boolean" ? r["kill_switch"] : null });
  }
  return out;
}

/** The kill switch across the rows (every row reads the same flag); null when no row says. */
export function killSwitchOf(budget: readonly BudgetRow[]): boolean | null {
  return budget.find((r) => r.killSwitch !== null)?.killSwitch ?? null;
}

const STATUSES: readonly TournamentStatus[] = ["draft", "frozen", "running", "sealed", "scoring", "revealed"];

function parseTournament(v: unknown): AdminTournament | null {
  if (!isRecord(v)) return null;
  const { id, name, split, status } = v;
  const st = STATUSES.find((s) => s === status);
  if (typeof id !== "string" || typeof name !== "string" || (split !== "dev" && split !== "hidden") || st === undefined) return null;
  return { id, name, split, status: st };
}

/** `GET /api/admin/tournaments`: an array or `{tournaments: [...]}`; null when not one. */
export function parseTournaments(v: unknown): readonly AdminTournament[] | null {
  const list = rows(v, "tournaments");
  if (list === null) return null;
  const out = list.map(parseTournament);
  return out.some((t) => t === null) ? null : (out as AdminTournament[]);
}

/** The reveal preconditions in `GET /api/admin/tournaments/{id}`, or null when the server reports none. */
export function parsePreconditions(v: unknown): readonly Precondition[] | null {
  if (!isRecord(v) || !Array.isArray(v["preconditions"])) return null;
  const out: Precondition[] = [];
  for (const p of v["preconditions"] as unknown[]) {
    if (!isRecord(p) || typeof p["name"] !== "string" || typeof p["passed"] !== "boolean") return null;
    out.push({ name: p["name"], passed: p["passed"] });
  }
  return out;
}

/** The one transition each state allows (S4 lifecycle): draft -> frozen -> running -> sealed -> scoring -> revealed. */
export function nextAction(status: TournamentStatus): { readonly action: AdminAction; readonly label: string } | null {
  switch (status) {
    case "draft":
      return { action: "freeze", label: "Freeze the roster" };
    case "frozen":
      return { action: "open", label: "Open the tournament" };
    case "running":
      return { action: "close", label: "Close the run" };
    case "sealed":
      return { action: "scoring", label: "Begin scoring" };
    case "scoring":
      return { action: "reveal", label: "Reveal" };
    case "revealed":
      return null;
  }
}

/** Reveal is allowed only when the server reported every precondition and all passed (FE-ADM-2). */
export function revealAllowed(preconditions: readonly Precondition[] | null): boolean {
  return preconditions !== null && preconditions.length > 0 && preconditions.every((p) => p.passed);
}

/** R1's evidence for one subject turn: the quote, the failed checks and the canonical facts it contradicts. */
export interface TurnEvidence {
  readonly turn_id: string;
  readonly evidence_quote: string;
  readonly failed_checks: readonly string[];
  readonly violated_fact_ids: readonly string[];
}

/** One subject-validity review in the admin queue (S6 4.13, S3 4.2 item 2): blinded (no assistant identity, cards
 * or finding), with what a reviewer needs to confirm or reject the automatic proposal: the questions and subject
 * turns, the released records, the private packet's facts, R1's per-turn evidence, and the R1 report hash the
 * verdict cites (`evidence_ref`). */
export interface ValidityReview {
  readonly trial_id: string;
  readonly proposed: "valid" | "subject_invalid" | null;
  readonly reasons: readonly string[];
  readonly evidence_ref: string | null;
  readonly transcript: readonly { readonly turn_no: number; readonly question: string; readonly answer: string | null }[];
  readonly released: readonly { readonly record_id: string; readonly title: string; readonly body: string }[];
  readonly facts: readonly { readonly id: string; readonly text: string }[];
  readonly evidence: readonly TurnEvidence[];
}

function strings(v: unknown): readonly string[] {
  return Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === "string") : [];
}

function list<T>(v: unknown, read: (x: Json) => T | null): readonly T[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).flatMap((x) => {
    const r = isRecord(x) ? read(x) : null;
    return r === null ? [] : [r];
  });
}

/** `GET /api/admin/reviews`: an array or `{reviews: [...]}`; null when not one. */
export function parseValidityReviews(v: unknown): readonly ValidityReview[] | null {
  const items = rows(v, "reviews");
  if (items === null) return null;
  const out: ValidityReview[] = [];
  for (const r of items) {
    if (!isRecord(r) || typeof r["trial_id"] !== "string") return null;
    const p = r["proposed"] ?? r["proposal"] ?? null;
    out.push({
      trial_id: r["trial_id"],
      proposed: p === "valid" || p === "subject_invalid" ? p : null,
      reasons: strings(r["reasons"]),
      evidence_ref: typeof r["evidence_ref"] === "string" && r["evidence_ref"] !== "" ? r["evidence_ref"] : null,
      transcript: list(r["transcript"], (x) =>
        typeof x["turn_no"] === "number" && typeof x["question"] === "string" ? { turn_no: x["turn_no"], question: x["question"], answer: typeof x["answer"] === "string" ? x["answer"] : null } : null,
      ),
      released: list(r["released"], (x) => {
        const content = isRecord(x["content"]) ? x["content"] : null;
        return typeof x["record_id"] === "string" && typeof x["title"] === "string" ? { record_id: x["record_id"], title: x["title"], body: typeof content?.["body"] === "string" ? content["body"] : "" } : null;
      }),
      facts: list(r["facts"], (x) => (typeof x["id"] === "string" && typeof x["text"] === "string" ? { id: x["id"], text: x["text"] } : null)),
      evidence: list(r["evidence"], (x) =>
        typeof x["turn_id"] === "string" ? { turn_id: x["turn_id"], evidence_quote: typeof x["evidence_quote"] === "string" ? x["evidence_quote"] : "", failed_checks: strings(x["failed_checks"]), violated_fact_ids: strings(x["violated_fact_ids"]) } : null,
      ),
    });
  }
  return out;
}

/** Whether a reviewer has what S3 4.2 asks them to look at: the subject turns and the R1 report the verdict cites. */
export function reviewable(review: ValidityReview): boolean {
  return review.transcript.length > 0 && review.evidence_ref !== null;
}

export interface VerdictBody {
  readonly verdict: "valid" | "subject_invalid";
  readonly reason: string;
  readonly evidence_ref: string;
  readonly idem_key: string;
}

/** The verdict body for `POST /api/admin/reviews/{trial_id}` (S5 5.5: verdict, reason, evidence_ref, idem_key), or
 * null when it cannot be sent: the ledger needs a reason for either verdict and the R1 report reference. */
export function verdictBody(review: ValidityReview, verdict: "valid" | "subject_invalid", reason: string, idemKey: string): VerdictBody | null {
  const r = reason.trim();
  if (r === "" || review.evidence_ref === null) return null;
  return { verdict, reason: r, evidence_ref: review.evidence_ref, idem_key: idemKey };
}
