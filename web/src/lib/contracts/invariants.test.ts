import { describe, expect, it } from "vitest";

import { invariantErrors } from "./invariants";

type Obj = Record<string, unknown>;

const files = import.meta.glob<unknown>("../../../../contracts/fixtures/wire.json", { eager: true, import: "default" });

function validValue(id: string): Obj {
  const fixture = Object.values(files)[0] as { valid: readonly { id: string; value: Obj }[] } | undefined;
  const found = fixture?.valid.find((c) => c.id === id);
  if (found === undefined) throw new Error(`fixture ${id} not found`);
  return structuredClone(found.value);
}

function card(): Obj {
  return validValue("training-card");
}

function deep(): Obj {
  const frame = validValue("frame:coach.update");
  return (frame["data"] as Obj)["update"] as Obj;
}

function errorsOf(name: string, value: unknown): string {
  return invariantErrors(name, value).join("; ");
}

describe("card invariants (coaching._CardFields)", () => {
  it("accepts the fixture card", () => {
    expect(invariantErrors("training-card", card())).toEqual([]);
  });

  it("refuses a conflict turn after the card's turn", () => {
    const c = card();
    const flags = c["flags"] as Obj[];
    flags[0] = { ...flags[0], kind: "contradiction", missing_fact: null, conflict_turn_id: "t03", conflict_quote: "x y z" };
    expect(errorsOf("training-card", c)).toMatch(/conflict_turn_id is after/);
  });

  it("refuses a finding citing a later turn or a basis flag the card does not have", () => {
    const c = card();
    c["finding"] = { ...(c["finding"] as Obj), cited_turns: [2], basis_flag_refs: ["t01.f2", "t03.f1"] };
    const found = errorsOf("training-card", c);
    expect(found).toMatch(/cited_turns is after/);
    expect(invariantErrors("training-card", c).filter((e) => e.includes("basis_flag_refs"))).toHaveLength(2);
  });

  it("accepts a basis flag of an earlier card or of this card", () => {
    const c = validValue("frame:coach.card");
    const inner = (c["data"] as Obj)["card"] as Obj;
    inner["finding"] = { ...(inner["finding"] as Obj), basis_flag_refs: ["t01.f1"] };
    expect(invariantErrors("events", c)).toEqual([]);
  });

  it("refuses flag references out of emission order even when the validation map matches", () => {
    const c = card();
    const flags = c["flags"] as Obj[];
    const first = flags[0] as Obj;
    c["flags"] = [
      { ...first, flag_ref: "t01.f2" },
      { ...first, quote: "a busy shift", flag_ref: "t01.f1" },
    ];
    const check = { citation_ok: true, demeanor_based: false, duplicate: false };
    c["validation"] = { ...(c["validation"] as Obj), flags: { "t01.f1": check, "t01.f2": check } };
    expect(invariantErrors("training-card", c)).toEqual([
      "card: flags[0].flag_ref is not t01.f1",
      "card: flags[1].flag_ref is not t01.f2",
    ]);
  });

  it("refuses a revised turn after the card's turn", () => {
    const c = card();
    c["finding"] = { ...(c["finding"] as Obj), last_revised_turn: 4 };
    expect(errorsOf("training-card", c)).toMatch(/last_revised_turn is after/);
  });
});

describe("deep update invariants (coaching.StoredDeepUpdate)", () => {
  it("accepts the fixture update", () => {
    expect(invariantErrors("events", deep())).toEqual([]);
  });

  it("refuses citations, revisions, coverage and gaps after as_of_turn", () => {
    const d = deep();
    d["finding"] = { ...(d["finding"] as Obj), last_revised_turn: 5 };
    d["evidence_coverage"] = [{ record_id: "rec-02", status: "raised_not_tested", turn_ids: ["t04"] }];
    d["open_gaps"] = [{ missing_fact: "the task", first_seen_turn: "t05" }];
    const found = errorsOf("events", d);
    expect(found).toMatch(/last_revised_turn is after/);
    expect(found).toMatch(/coverage turn_ids after/);
    expect(found).toMatch(/first_seen_turn after/);
  });
});

describe("snapshot invariants (snapshot)", () => {
  it("refuses more exchanges than the cap", () => {
    const s = validValue("snapshot:voice");
    s["exchanges_cap"] = 1;
    expect(errorsOf("snapshot", s)).toMatch(/exceeds exchanges_cap/);
  });

  it("refuses text turns that are not numbered from 1", () => {
    const s = validValue("snapshot:text");
    s["turns"] = (s["turns"] as Obj[]).map((t) => ({ ...t, turn_no: 2 }));
    expect(errorsOf("snapshot", s)).toMatch(/turns not numbered/);
  });

  it("refuses a voice count that is not the stored exchanges", () => {
    const s = validValue("snapshot:voice");
    s["exchanges_used"] = 1;
    expect(errorsOf("snapshot", s)).toMatch(/not the stored exchanges/);
  });

  it("ignores values that are not objects", () => {
    expect(invariantErrors("snapshot", null)).toEqual([]);
    expect(invariantErrors("events", [1, "x", null])).toEqual([]);
  });
});
