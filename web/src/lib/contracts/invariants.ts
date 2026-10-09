/**
 * The cross-field rules of the wire contracts that JSON Schema cannot state, checked after the schema
 * (S6 5.2: a payload failing either is dropped and counted, never rendered). Each mirrors a Pydantic
 * validator in `arena_core.contracts` and is proven against the same negative fixtures
 * (`contracts/fixtures/wire.json`, layer `invariant`):
 *
 * - card (`coaching._CardFields`): `turn_no` is the number of `turn_id`; flags, conflicts, finding citations
 *   and basis references are at or before the card's turn; `flag_ref`s are `tNN.f1`.. in emission order;
 *   `validation.flags` has exactly one entry per `flag_ref`; `last_revised_turn` is at or before the turn.
 * - deep update (`coaching.StoredDeepUpdate`): citations, coverage turns, gaps and the revised turn are at or
 *   before `as_of_turn`; each record is covered at most once.
 * - snapshot (`snapshot`): `exchanges_used` within the cap; turns or exchanges numbered 1..n; the count is
 *   the answered turns (text) or the stored exchanges (voice).
 * - table (`events.TableContent`): every row has one cell per column.
 */

type Json = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function turnOf(id: unknown): number {
  return typeof id === "string" ? Number(id.slice(1, 3)) : Number.NaN;
}

function numbered(values: readonly unknown[]): boolean {
  return values.every((v, i) => v === i + 1);
}

function cardErrors(card: Json): string[] {
  const errors: string[] = [];
  const turn = turnOf(card["turn_id"]);
  if (card["turn_no"] !== turn) errors.push("card: turn_no is not the turn of turn_id");
  const flags = list(card["flags"]).filter(isObject);
  const refs = flags.map((_, i) => `${String(card["turn_id"])}.f${String(i + 1)}`);
  flags.forEach((flag, i) => {
    if (turnOf(flag["turn_id"]) > turn) errors.push(`card: flags[${String(i)}].turn_id is after the card's turn`);
    if (flag["conflict_turn_id"] !== null && turnOf(flag["conflict_turn_id"]) > turn)
      errors.push(`card: flags[${String(i)}].conflict_turn_id is after the card's turn`);
    if (flag["flag_ref"] !== refs[i]) errors.push(`card: flags[${String(i)}].flag_ref is not ${refs[i] ?? ""}`);
  });
  const checks = isObject(card["validation"]) ? card["validation"]["flags"] : undefined;
  const keys = isObject(checks) ? Object.keys(checks).sort() : [];
  if (JSON.stringify(keys) !== JSON.stringify([...refs].sort()))
    errors.push("card: validation.flags needs exactly one entry per flag_ref");
  const finding = isObject(card["finding"]) ? card["finding"] : {};
  for (const t of list(finding["cited_turns"])) {
    if (typeof t === "number" && t > turn) errors.push("card: finding.cited_turns is after the card's turn");
  }
  for (const ref of list(finding["basis_flag_refs"])) {
    const refTurn = turnOf(ref);
    if (refTurn > turn || (refTurn === turn && !refs.includes(String(ref))))
      errors.push("card: finding.basis_flag_refs names no flag of this card or an earlier one");
  }
  const last = finding["last_revised_turn"];
  if (typeof last === "number" && last > turn) errors.push("card: finding.last_revised_turn is after the turn");
  return errors;
}

function deepErrors(update: Json): string[] {
  const errors: string[] = [];
  const asOf = turnOf(update["as_of_turn"]);
  const finding = isObject(update["finding"]) ? update["finding"] : {};
  if (list(finding["cited_turns"]).some((t) => typeof t === "number" && t > asOf))
    errors.push("deep: finding.cited_turns is after as_of_turn");
  const last = finding["last_revised_turn"];
  if (typeof last === "number" && last > asOf) errors.push("deep: finding.last_revised_turn is after as_of_turn");
  const coverage = list(update["evidence_coverage"]).filter(isObject);
  const records = coverage.map((c) => c["record_id"]);
  if (new Set(records).size !== records.length) errors.push("deep: evidence_coverage lists a record twice");
  if (coverage.some((c) => list(c["turn_ids"]).some((t) => turnOf(t) > asOf)))
    errors.push("deep: evidence_coverage turn_ids after as_of_turn");
  if (list(update["open_gaps"]).filter(isObject).some((g) => turnOf(g["first_seen_turn"]) > asOf))
    errors.push("deep: open_gaps first_seen_turn after as_of_turn");
  return errors;
}

function snapshotErrors(snapshot: Json): string[] {
  const errors: string[] = [];
  const used = snapshot["exchanges_used"];
  if (typeof used === "number" && typeof snapshot["exchanges_cap"] === "number" && used > snapshot["exchanges_cap"])
    errors.push("snapshot: exchanges_used exceeds exchanges_cap");
  if (snapshot["channel"] === "voice") {
    const exchanges = list(snapshot["voice_exchanges"]).filter(isObject);
    if (!numbered(exchanges.map((e) => e["exchange_no"]))) errors.push("snapshot: voice_exchanges not numbered 1..n");
    if (used !== exchanges.length) errors.push("snapshot: exchanges_used is not the stored exchanges");
  } else {
    const turns = list(snapshot["turns"]).filter(isObject);
    if (!numbered(turns.map((t) => t["turn_no"]))) errors.push("snapshot: turns not numbered 1..n");
    if (used !== turns.filter((t) => t["answer"] !== null).length)
      errors.push("snapshot: exchanges_used is not the answered turns");
  }
  return errors;
}

function tableErrors(table: Json): string[] {
  const width = list(table["columns"]).length;
  return list(table["rows"]).some((row) => list(row).length !== width)
    ? ["table: every row needs one cell per column"]
    : [];
}

function walk(value: unknown, errors: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, errors);
    return;
  }
  if (!isObject(value)) return;
  if (value["schema_version"] === "card.v1" && "card_seq" in value) errors.push(...cardErrors(value));
  if (value["schema_version"] === "deep.v1") errors.push(...deepErrors(value));
  if (Array.isArray(value["columns"]) && Array.isArray(value["rows"])) errors.push(...tableErrors(value));
  for (const child of Object.values(value)) walk(child, errors);
}

/** The invariant violations in a payload that already passed its wire schema; empty when it holds. */
export function invariantErrors(name: string, value: unknown): readonly string[] {
  const errors: string[] = [];
  if (name === "snapshot" && isObject(value)) errors.push(...snapshotErrors(value));
  walk(value, errors);
  return errors;
}
