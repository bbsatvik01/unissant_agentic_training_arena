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
