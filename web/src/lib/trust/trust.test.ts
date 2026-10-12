import { describe, expect, it } from "vitest";

import csv from "../../../../supabase/tests/fixtures/capability_matrix.csv?raw";
import { parseTrustBudget } from "./budget";
import { csvFields, parseCapabilities } from "./capability";
import { commitmentOf, hexBytes, verifyCommitment } from "./commitment";

const NONCE = "00".repeat(31) + "01";
const PAYLOAD = '{"label": "truthful", "trial_id": "t-1"}';

describe("commitment verification (FE-TRUST-1)", () => {
  it("matches sha256(nonce || payload) and flags one altered byte as a mismatch", async () => {
    const commitment = await commitmentOf(NONCE, PAYLOAD);
    expect(commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyCommitment(NONCE, PAYLOAD, commitment ?? "")).toBe("match");
    expect(await verifyCommitment(NONCE, PAYLOAD.replace("truthful", "truthfuL"), commitment ?? "")).toBe("mismatch");
    expect(await verifyCommitment("00".repeat(31) + "02", PAYLOAD, commitment ?? "")).toBe("mismatch");
  });

  it("is the known value for a fixed input (independent of this module)", async () => {
    // sha256 of 32 zero bytes followed by "abc", computed with Python's hashlib.
    expect(await commitmentOf("00".repeat(32), "abc")).toBe("365aa7d8f7f9402c4b9434502b4cc89ddb09fe50d7cd95b493b834c62d5a5370");
  });

  it("refuses a nonce that is not 32 bytes or a commitment that is not a sha256", async () => {
    expect(await verifyCommitment("00", PAYLOAD, "a".repeat(64))).toBe("invalid");
    expect(await verifyCommitment(NONCE, PAYLOAD, "xyz")).toBe("invalid");
    expect(hexBytes("\\x0aff")).toEqual(new Uint8Array([10, 255]));
    expect(hexBytes("abc")).toBe(null);
    expect(hexBytes("zz")).toBe(null);
  });
});

describe("capability matrix (FE-TRUST-3)", () => {
  it("reads every row of the fixture, quoted fields included", () => {
    const rows = parseCapabilities(csv);
    const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
    expect(rows).toHaveLength(lines.length - 1);
    expect(rows.find((r) => r.object === "arena.advance_replay(uuid,uuid)")?.privilege).toBe("EXECUTE");
    expect(csvFields('a,"b ""c"", d",e')).toEqual(["a", 'b "c", d', "e"]);
    expect(() => parseCapabilities("h\na,b")).toThrow();
  });
});

describe("trust budget (FE-TRUST-4)", () => {
  it("reads the server's values unchanged, and a $0 ceiling as the plan not applied", () => {
    expect(parseTrustBudget({ ceiling_usd: "75.00", spent_usd: 3.25, by_purpose: [{ purpose: "coach", spent_usd: "1.5" }, { purpose: 3 }], planned_n: 30 })).toEqual({
      ceiling: "$75.00",
      spent: "$3.25",
      byPurpose: [{ purpose: "coach", spent: "$1.50" }],
      plannedCases: 30,
      applied: true,
    });
    expect(parseTrustBudget({ ceiling_usd: 0, spent_usd: 0 })?.applied).toBe(false);
    expect(parseTrustBudget({ ceiling_usd: "lots", spent_usd: 0 })).toBe(null);
    expect(parseTrustBudget(null)).toBe(null);
  });
});

describe("trust sections", () => {
  it("reads isolation runs as pass or fail per check, refusing malformed rows", async () => {
    const { parseIsolation } = await import("./sections");
    expect(parseIsolation({ checks: [{ check: "IG-1", candidate: "A1", result: "pass", run_at: "2026-10-20T10:00:00Z", commit_sha: "abc" }, { check: "IG-2", passed: false }] })).toEqual([
      { check: "IG-1", candidate: "A1", passed: true, ranAt: "2026-10-20T10:00:00Z", commitSha: "abc" },
      { check: "IG-2", candidate: null, passed: false, ranAt: null, commitSha: null },
    ]);
    expect(parseIsolation([{ check: "IG-1", result: "maybe" }])).toBe(null);
    expect(parseIsolation("x")).toBe(null);
  });

  it("reads commitments with their reveal fields, and only a loopback Phoenix address", async () => {
    const { parseCommitments, phoenixUrl } = await import("./sections");
    expect(parseCommitments([{ trial_ref: 3, commitment_sha256: "a".repeat(64), payload_text: "{}", nonce: "00" }])?.[0]).toMatchObject({ trial: "#3", payloadText: "{}", nonce: "00", transcriptSha: null });
    expect(parseCommitments([{ trial_ref: 3 }])).toBe(null);
    expect(phoenixUrl({ phoenix_url: "http://127.0.0.1:6006" })).toBe("http://127.0.0.1:6006");
    expect(phoenixUrl({ phoenix_url: "https://evil.example" })).toBe(null);
    expect(phoenixUrl({ phoenix_url: null })).toBe(null);
  });
});

describe("fairness and calibration", () => {
  it("reads the audit's figures as published", async () => {
    const { parseFairness, pText } = await import("./fairness");
    const f = parseFairness({
      style_fpr: [{ candidate: "A1", style: "terse", point: { num: 0, den: 5, value: 0 }, interval: { lo: 0, hi: 0.4 } }, { style: "x" }],
      demeanor: [{ candidate: "A2", flags: 3, findings: 1 }],
      tests: [{ candidate: "A1", test: "FA-5a", p_value: 0.0004, significant_after_holm: true }],
      negative_controls: { caught: true },
    });
    expect(f?.styleRates).toEqual([{ candidate: "A1", style: "terse", fpr: "0%, interval 0%-40%" }]);
    expect(f?.demeanor).toEqual([{ candidate: "A2", flags: 3, findings: 1 }]);
    expect(f?.tests[0]).toMatchObject({ test: "FA-5a", significant: true });
    expect(f?.negativeControlsCaught).toBe(true);
    expect(parseFairness({})?.negativeControlsCaught).toBe(null);
    expect(parseFairness(null)).toBe(null);
    expect(pText(0.0004)).toBe("p < 0.001");
    expect(pText(0.0312)).toBe("p = 0.031");
  });

  it("reads calibration against its thresholds, an uninformative sample as not met", async () => {
    const { parseCalibration } = await import("./fairness");
    expect(parseCalibration({ calibration: [{ instrument: "EVL-7 D1", statistic: "QWK", value: 0.72, threshold: 0.6 }, { instrument: "EVL-7 D2", statistic: "QWK", value: null, threshold: 0.6 }, { statistic: "x" }] })).toEqual([
      { instrument: "EVL-7 D1", statistic: "QWK", value: 0.72, threshold: 0.6, met: true },
      { instrument: "EVL-7 D2", statistic: "QWK", value: null, threshold: 0.6, met: false },
    ]);
    expect(parseCalibration({})).toBe(null);
  });
});
