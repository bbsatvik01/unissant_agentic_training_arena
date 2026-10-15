import { describe, expect, it } from "vitest";

import { parseEnvelope, MAX_EVENT_BYTES } from "@/lib/contracts/run-events";
import { verification, warRoomScriptInput } from "@/lib/data/nccs";
import { STANDARD_CAP_USD } from "@/lib/stages";

import { buildScript, cellStateFor, offsetsOf, type ScriptInput } from "./script";
import { emptyStore, reduceAll } from "./state";

const tiny: ScriptInput = {
  runId: "t",
  opportunity: "Test",
  startTs: "2026-09-25T13:00:00Z",
  columns: [
    { key: "a", label: "A" },
    { key: "b", label: "B" },
  ],
  subjects: [
    { slug: "x", label: "X", home: false, rows: [{ id: "x-E1", column: "a", tier: "federal_primary", host: "usaspending.gov", sourceType: "usaspending" }] },
    { slug: "y", label: "Y", home: true, rows: [{ id: "y-E1", column: "b", tier: "news", host: "wt.com", sourceType: "news" }, { id: "y-E2", column: "zzz", tier: "news", host: "wt.com", sourceType: "news" }] },
  ],
  claims: [
    { claimId: "C1", claim: "one", evidenceIds: ["x-E1"], verdict: "partially_supported", sourceUnreachable: false },
    { claimId: "C2", claim: "two", evidenceIds: ["y-E1", "unknown-E9"], verdict: "unsupported", sourceUnreachable: true },
    { claimId: "C3", claim: "three", evidenceIds: ["x-E1"], verdict: "supported", sourceUnreachable: false },
  ],
  capUsd: 9.87,
  concurrency: 1,
};

describe("cellStateFor", () => {
  it("ranks withheld over contested over verified over anchored over pending", () => {
    expect(cellStateFor({ rows: 0, supported: 0, partial: 0, unsupported: 0 })).toBe("pending");
    expect(cellStateFor({ rows: 2, supported: 0, partial: 0, unsupported: 0 })).toBe("anchored");
    expect(cellStateFor({ rows: 2, supported: 1, partial: 0, unsupported: 0 })).toBe("verified");
    expect(cellStateFor({ rows: 2, supported: 1, partial: 1, unsupported: 0 })).toBe("contested");
    expect(cellStateFor({ rows: 2, supported: 1, partial: 1, unsupported: 1 })).toBe("withheld");
  });
});

describe("buildScript (small input)", () => {
  const envs = buildScript(tiny);
  const final = reduceAll(emptyStore(), envs);

  it("numbers seq from 1 without gaps and keeps time monotonic", () => {
    envs.forEach((e, i) => expect(e.seq).toBe(i + 1));
    const offsets = offsetsOf(envs);
    expect(offsets[0]).toBe(0);
    for (let i = 1; i < offsets.length; i += 1) expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1] ?? 0);
    expect(new Set(envs.map((e) => e.idemKey)).size).toBe(envs.length);
  });

  it("round-trips every envelope through the wire parser under the size limit", () => {
    for (const e of envs) {
      const wire = JSON.stringify(e);
      expect(wire.length).toBeLessThanOrEqual(MAX_EVENT_BYTES);
      expect(parseEnvelope(wire)).toEqual(e);
    }
  });

  it("ends awaiting the human decision with every execute stage done", () => {
    expect(final.status).toBe("finished");
    expect(final.finalState).toBe("awaiting_decision");
    expect(Object.values(final.view?.stages ?? {}).every((s) => s === "done")).toBe(true);
    expect(final.rejectedPatches).toBe(0);
  });

  it("moves cells by claim verdicts and ignores rows outside the matrix", () => {
    const cells = final.view?.cells ?? {};
    expect(cells["x:a"]).toMatchObject({ rows: 1, supported: 1, partial: 1, state: "contested" });
    expect(cells["y:b"]).toMatchObject({ rows: 1, unsupported: 1, state: "withheld" });
    expect(cells["x:b"]?.state).toBe("pending");
    expect(final.view?.counters).toMatchObject({ fetches: 3, claimsChecked: 3, supported: 1, partial: 1, unsupported: 1, withheld: 1 });
    expect(final.view?.lanes.y?.status).toBe("done");
  });

  it("stays under the cost cap", () => {
    expect(final.view?.cost.usd ?? 0).toBeLessThan(tiny.capUsd);
    expect(final.view?.cost.usd ?? 0).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    expect(buildScript(tiny)).toEqual(envs);
  });

  it("rejects a bad start time and handles an empty run", () => {
    expect(() => buildScript({ ...tiny, startTs: "yesterday" })).toThrow("bad startTs");
    const empty = buildScript({ ...tiny, subjects: [], claims: [] });
    expect(reduceAll(emptyStore(), empty).status).toBe("finished");
    expect(offsetsOf([])).toEqual([]);
  });
});

describe("buildScript (gold run)", () => {
  const input = warRoomScriptInput();
  const envs = buildScript(input);
  const final = reduceAll(emptyStore(), envs);

  it("replays every verified claim and every in-matrix evidence row", () => {
    const rows = input.subjects.reduce((n, s) => n + s.rows.length, 0);
    expect(rows).toBeGreaterThan(300);
    expect(final.view?.counters.fetches).toBe(rows);
    expect(final.view?.counters.claimsChecked).toBe(verification.length);
    expect(final.view?.counters.supported).toBe(57);
    expect(final.view?.counters.partial).toBe(25);
    expect(final.view?.counters.unsupported).toBe(3);
  });

  it("never lets a running total move backwards or run ahead of the fetches seen so far", () => {
    let fetchesSeen = 0;
    let store = emptyStore();
    let prevCost = 0;
    let prevFetches = 0;
    let prevChecked = 0;
    for (const env of envs) {
      if (env.event.type === "ACTIVITY_SNAPSHOT" && env.event.activityType === "fetch") fetchesSeen += 1;
      store = reduceAll(store, [env]);
      const v = store.view;
      if (!v) continue;
      expect(v.counters.fetches).toBeGreaterThanOrEqual(prevFetches);
      expect(v.counters.fetches).toBeLessThanOrEqual(fetchesSeen);
      expect(v.counters.claimsChecked).toBeGreaterThanOrEqual(prevChecked);
      expect(v.cost.usd).toBeGreaterThanOrEqual(prevCost);
      prevFetches = v.counters.fetches;
      prevChecked = v.counters.claimsChecked;
      prevCost = v.cost.usd;
    }
  });

  it("withholds the meshONE-T cells the verifier found unsupported", () => {
    const withheld = Object.values(final.view?.cells ?? {}).filter((c) => c.state === "withheld").map((c) => c.subject);
    expect(withheld).toContain("entarian");
  });

  it("runs at most three lanes at once and finishes under the Standard cap", () => {
    expect(input.capUsd).toBe(STANDARD_CAP_USD);
    expect(final.view?.cost.usd ?? 99).toBeLessThan(STANDARD_CAP_USD);
    let running = 0;
    let peak = 0;
    for (const env of envs) {
      if (env.event.type !== "STATE_DELTA") continue;
      for (const op of env.event.delta) {
        if (!/^\/lanes\/[^/]+\/status$/.test(op.path)) continue;
        if (op.value === "running") running += 1;
        if (op.value === "done") running -= 1;
        peak = Math.max(peak, running);
      }
    }
    expect(peak).toBe(3);
    expect(running).toBe(0);
  });
});
