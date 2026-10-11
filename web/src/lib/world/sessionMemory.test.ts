import { describe, expect, it } from "vitest";

import { forgetSession, recallSession, rememberSession } from "./sessionMemory";

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

const STARTED = { session_id: "s-1", trial_id: "t-1", mode: "practice", case_id: "C-7Q2MXK4D" } as const;

describe("session memory", () => {
  it("remembers a session per case and forgets it", () => {
    const s = memory();
    rememberSession(STARTED, s);
    expect(recallSession("C-7Q2MXK4D", s)).toEqual(STARTED);
    expect(recallSession("C-4XVM7HPA", s)).toBe(null);
    forgetSession("C-7Q2MXK4D", s);
    expect(recallSession("C-7Q2MXK4D", s)).toBe(null);
  });

  it("reads malformed, foreign or blocked storage as nothing remembered", () => {
    const s = memory();
    s.m.set("arena.session.C-7Q2MXK4D", "{not json");
    expect(recallSession("C-7Q2MXK4D", s)).toBe(null);
    s.m.set("arena.session.C-7Q2MXK4D", JSON.stringify({ ...STARTED, case_id: "C-4XVM7HPA" }));
    expect(recallSession("C-7Q2MXK4D", s)).toBe(null);
    s.m.set("arena.session.C-7Q2MXK4D", JSON.stringify({ ...STARTED, mode: "voice" }));
    expect(recallSession("C-7Q2MXK4D", s)).toBe(null);
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(() => {
      rememberSession(STARTED, blocked);
      forgetSession("C-7Q2MXK4D", blocked);
    }).not.toThrow();
    expect(recallSession("C-7Q2MXK4D", blocked)).toBe(null);
    expect(recallSession("C-7Q2MXK4D", null)).toBe(null);
  });
});
