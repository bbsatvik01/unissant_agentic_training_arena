/**
 * The dependency exception policy, enforced. Every exception to the supply-chain gates in
 * `pnpm-workspace.yaml` (release-age exclusions, trust exclusions, overrides) must:
 *   - name one exact version, never a whole package or a range of versions it lets through;
 *   - appear in `dependency-exceptions.json` with its reason, the date the evidence was checked,
 *     and the date it must be re-decided, at most 92 days later;
 *   - not be past that date. On the expiry date this test fails by design: re-verify the exception
 *     and record the new evidence and dates, or remove it.
 * The register and the workspace file must list exactly the same exceptions.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const SETTINGS = ["minimumReleaseAgeExclude", "trustPolicyExclude", "overrides"] as const;
type Setting = (typeof SETTINGS)[number];

interface RegisterEntry {
  readonly setting: Setting;
  readonly spec: string;
  readonly reason: string;
  readonly verified: string;
  readonly expires: string;
}

const MAX_WINDOW_DAYS = 92;
const EXACT_VERSION = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*@\d+\.\d+\.\d+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const workspace = readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
const register: unknown = JSON.parse(readFileSync(new URL("../dependency-exceptions.json", import.meta.url), "utf8"));

/** The entries under a top-level key of the (flat, two-level) workspace file, comments skipped. */
function entriesUnder(key: Setting): string[] {
  const lines = workspace.split("\n");
  const start = lines.indexOf(`${key}:`);
  if (start === -1) return [];
  const entries: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (!/^\s/.test(line)) break;
    entries.push(line.trim());
  }
  return entries;
}

const unquote = (text: string): string => text.trim().replace(/^'(.*)'$/, "$1");

function workspaceExceptions(): { setting: Setting; spec: string }[] {
  const lists = (["minimumReleaseAgeExclude", "trustPolicyExclude"] as const).flatMap((setting) =>
    entriesUnder(setting).map((line) => ({ setting, spec: unquote(line.replace(/^-\s+/, "")) })),
  );
  const overrides = entriesUnder("overrides").map((line) => {
    const match = /^('[^']+'|[^:\s]+)\s*:\s*('[^']+'|\S+)$/.exec(line);
    if (match === null) throw new Error(`unreadable override line: ${line}`);
    const [, key = "", value = ""] = match;
    return { setting: "overrides" as const, spec: `${unquote(key)}: ${unquote(value)}` };
  });
  return [...lists, ...overrides];
}

function isEntry(value: unknown): value is RegisterEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    SETTINGS.some((setting) => setting === entry["setting"]) &&
    typeof entry["spec"] === "string" &&
    typeof entry["reason"] === "string" &&
    typeof entry["verified"] === "string" &&
    typeof entry["expires"] === "string"
  );
}

function registerEntries(): RegisterEntry[] {
  if (typeof register !== "object" || register === null) throw new Error("dependency-exceptions.json is not an object");
  const exceptions = (register as Record<string, unknown>)["exceptions"];
  if (!Array.isArray(exceptions)) throw new Error("dependency-exceptions.json has no exceptions array");
  return exceptions.map((value: unknown) => {
    if (!isEntry(value)) throw new Error(`malformed register entry: ${JSON.stringify(value)}`);
    return value;
  });
}

const days = (from: string, to: string): number => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
const today = new Date().toISOString().slice(0, 10);
const key = (e: { setting: Setting; spec: string }): string => `${e.setting} ${e.spec}`;

describe("dependency exceptions", () => {
  it("are each pinned to one exact version", () => {
    for (const { setting, spec } of workspaceExceptions()) {
      if (setting === "overrides") {
        const [, target = ""] = spec.split(": ");
        expect(target, spec).toMatch(/^\d+\.\d+\.\d+$/);
      } else {
        expect(spec, setting).toMatch(EXACT_VERSION);
      }
    }
  });

  it("are the same set in pnpm-workspace.yaml and in the register, with no duplicates", () => {
    const inWorkspace = workspaceExceptions().map(key);
    const inRegister = registerEntries().map(key);
    expect(new Set(inWorkspace).size).toBe(inWorkspace.length);
    expect(new Set(inRegister).size).toBe(inRegister.length);
    expect([...inRegister].sort()).toEqual([...inWorkspace].sort());
  });

  it("each carry a reason, a verification date and an expiry at most 92 days later that has not passed", () => {
    for (const entry of registerEntries()) {
      const label = key(entry);
      expect(entry.reason.trim().length, label).toBeGreaterThan(40);
      expect(entry.verified, label).toMatch(ISO_DATE);
      expect(entry.expires, label).toMatch(ISO_DATE);
      expect(entry.verified <= today, `${label}: verified in the future`).toBe(true);
      expect(days(entry.verified, entry.expires), label).toBeGreaterThan(0);
      expect(days(entry.verified, entry.expires), label).toBeLessThanOrEqual(MAX_WINDOW_DAYS);
      expect(today < entry.expires, `${label}: expired on ${entry.expires}; re-verify it or remove it`).toBe(true);
    }
  });
});
