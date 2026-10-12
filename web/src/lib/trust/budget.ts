/**
 * The trust center's budget (S6 4.11 Budget, FE-TRUST-4): the D-009 cap and target, and the server's applied
 * `global` ceiling and spend by purpose from the reservation ledger, shown as the server reports them. With every
 * ceiling at $0 the plan is not applied and no model spend is possible; the client holds no ceiling of its own.
 */

/** D-009: the hard cap and the target (cost_model.CAP and the target), fixed text. */
export const CAP_USD = 75;
export const TARGET_USD = 50;

export interface TrustBudget {
  readonly ceiling: string;
  readonly spent: string;
  readonly byPurpose: readonly { readonly purpose: string; readonly spent: string }[];
  readonly plannedCases: number | null;
  readonly applied: boolean;
}

type Json = Readonly<Record<string, unknown>>;

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function amount(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return null;
}

const dollars = (n: number) => `$${n.toFixed(2)}`;

/** `GET /api/trust/budget`: `{ceiling_usd, spent_usd, by_purpose: [{purpose, spent_usd}], planned_n}`; null when not one. */
export function parseTrustBudget(v: unknown): TrustBudget | null {
  if (!isRecord(v)) return null;
  const ceiling = amount(v["ceiling_usd"]);
  const spent = amount(v["spent_usd"]);
  if (ceiling === null || spent === null) return null;
  const purposes = Array.isArray(v["by_purpose"]) ? (v["by_purpose"] as unknown[]) : [];
  const byPurpose = purposes.flatMap((p) => {
    if (!isRecord(p) || typeof p["purpose"] !== "string") return [];
    const s = amount(p["spent_usd"]);
    return s === null ? [] : [{ purpose: p["purpose"], spent: dollars(s) }];
  });
  const n = v["planned_n"];
  return { ceiling: dollars(ceiling), spent: dollars(spent), byPurpose, plannedCases: typeof n === "number" && Number.isInteger(n) ? n : null, applied: ceiling > 0 };
}
