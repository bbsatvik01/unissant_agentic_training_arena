import { afterEach, describe, expect, it, vi } from "vitest";
import { NPC_IDS } from "./npcIdentity";
import { clearNpcVisitMemory, emptyNpcVisitMemory, getNpcMemoryStorage, loadNpcVisitMemory, NPC_MEMORY_KEY, NPC_MEMORY_LIMITS, parseNpcVisitMemory, recordNpcVisit, saveNpcVisitMemory, withNpcDisplayName } from "./npcVisitMemory";
import type { NpcMemoryStorage } from "./npcVisitMemory";
import type { NpcId } from "./npcIdentity";

function fakeStorage(initial: string | null = null) {
  const values = new Map<string, string>();
  if (initial !== null) values.set(NPC_MEMORY_KEY, initial);
  values.set("unrelated-key", "keep");
  const storage: NpcMemoryStorage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
  };
  return { storage, values };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("minimal local NPC visit memory", () => {
  it("starts empty and keeps only version, preferred name and known colleague visit counts", () => {
    const memory = emptyNpcVisitMemory();
    expect(memory).toEqual({ version: 1, displayName: null, colleagues: [] });
    expect(parseNpcVisitMemory(memory)).toEqual(memory);
    expect(parseNpcVisitMemory(memory)).not.toBe(memory);
    expect(emptyNpcVisitMemory()).not.toBe(memory);
  });

  it("accepts short Unicode names, normalizes spaces, and supports explicit name removal", () => {
    for (const name of ["Alex", "D’Arcy", "O'Neill", "Anne-Marie", "李 明", "Zoë", "José"]) {
      expect(withNpcDisplayName(emptyNpcVisitMemory(), name)?.displayName).toBe(name);
    }
    expect(withNpcDisplayName(emptyNpcVisitMemory(), "  Alex  Kim  ")?.displayName).toBe("Alex Kim");
    expect(withNpcDisplayName(emptyNpcVisitMemory(), " ")?.displayName).toBeNull();
    expect(withNpcDisplayName(emptyNpcVisitMemory(), null)?.displayName).toBeNull();
    for (const name of ["<b>Alex</b>", "A\nB", "Alex\u202e", "a@example.com", "123", "a".repeat(41), {}, undefined]) {
      expect(withNpcDisplayName(emptyNpcVisitMemory(), name)).toBeNull();
    }
    expect(withNpcDisplayName(emptyNpcVisitMemory(), "a".repeat(40))?.displayName).toHaveLength(40);
  });

  it("increments only a requested colleague, is immutable and saturates at the fixed bound", () => {
    const source = emptyNpcVisitMemory();
    const visited = recordNpcVisit(source, "sergeant");
    expect(source.colleagues).toEqual([]);
    expect(visited.colleagues).toEqual([{ npc_id: "sergeant", visits: 1 }]);
    expect(recordNpcVisit(visited, "sergeant").colleagues).toEqual([{ npc_id: "sergeant", visits: 2 }]);
    const saturated = { ...source, colleagues: [{ npc_id: "sergeant" as const, visits: 999 }] };
    expect(recordNpcVisit(saturated, "sergeant")).toEqual(saturated);
    expect(recordNpcVisit(source, "unknown" as NpcId)).toEqual(source);
    let all = source;
    for (const id of [...NPC_IDS].reverse()) all = recordNpcVisit(all, id);
    expect(all.colleagues.map((entry) => entry.npc_id)).toEqual(NPC_IDS);
    expect(JSON.stringify({ ...all, displayName: "a".repeat(40) }).length).toBeLessThan(NPC_MEMORY_LIMITS.serializedLength);
  });

  it("rejects malformed versions, extra facts/history, unknown or duplicated colleagues and unsafe counters", () => {
    const valid = emptyNpcVisitMemory();
    for (const input of [null, [], 1, {}, { ...valid, version: 2 }, { ...valid, history: [] }, { ...valid, case: {} },
      { ...valid, displayName: 4 }, { ...valid, colleagues: {} }, { ...valid, colleagues: [null] },
      { ...valid, colleagues: [{ npc_id: "unknown", visits: 1 }] },
      { ...valid, colleagues: [{ npc_id: "sergeant", visits: 1, fact: "secret" }] },
      { ...valid, colleagues: [{ npc_id: "sergeant", visits: 1 }, { npc_id: "sergeant", visits: 2 }] },
      { ...valid, colleagues: Array.from({ length: 5 }, () => ({ npc_id: "sergeant", visits: 1 })) },
      ...[0, -1, 0.5, 1000, NaN, Infinity, "1", null].map((visits) => ({ ...valid, colleagues: [{ npc_id: "sergeant", visits }] })),
      new Proxy({}, { ownKeys: () => { throw new Error("blocked"); } })]) expect(parseNpcVisitMemory(input)).toBeNull();
    const poisoned = { ...valid, version: 2 } as unknown as ReturnType<typeof emptyNpcVisitMemory>;
    expect(withNpcDisplayName(poisoned, "Alex")).toBeNull();
    expect(recordNpcVisit(poisoned, "sergeant")).toEqual(recordNpcVisit(valid, "sergeant"));
  });

  it("rejects accessor/iterator arrays without executing user-provided code", () => {
    const getter = vi.fn(() => ({ npc_id: "sergeant", visits: 1 }));
    const iterator = vi.fn(function* () { yield { npc_id: "sergeant", visits: 1 }; });
    for (const colleagues of [Object.defineProperty([null], "0", { get: getter }), Object.defineProperty([], Symbol.iterator, { value: iterator })]) {
      expect(parseNpcVisitMemory({ ...emptyNpcVisitMemory(), colleagues })).toBeNull();
    }
    expect(getter).not.toHaveBeenCalled();
    expect(iterator).not.toHaveBeenCalled();
  });
});

describe("explicit bounded storage", () => {
  it("reads only when called, distinguishes missing data and does not automatically repair corrupt storage", () => {
    const { storage } = fakeStorage();
    emptyNpcVisitMemory();
    recordNpcVisit(emptyNpcVisitMemory(), "sergeant");
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(loadNpcVisitMemory(storage)).toEqual({ memory: emptyNpcVisitMemory(), status: "empty" });
    expect(storage.getItem).toHaveBeenCalledWith(NPC_MEMORY_KEY);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("round trips a validated local memory snapshot under only its dedicated key", () => {
    const { storage, values } = fakeStorage();
    const memory = withNpcDisplayName(recordNpcVisit(emptyNpcVisitMemory(), "receptionist"), "Alex");
    expect(saveNpcVisitMemory(storage, memory)).toEqual({ ok: true });
    expect(loadNpcVisitMemory(storage)).toEqual({ memory, status: "loaded" });
    expect(values.size).toBe(2);
    expect(values.get("unrelated-key")).toBe("keep");
    expect(values.get(NPC_MEMORY_KEY)?.length).toBeLessThanOrEqual(NPC_MEMORY_LIMITS.serializedLength);
    expect(clearNpcVisitMemory(storage)).toEqual({ ok: true });
    expect(values.has(NPC_MEMORY_KEY)).toBe(false);
    expect(values.get("unrelated-key")).toBe("keep");
  });

  it("safely ignores corrupt, oversized, old-version and pollution-shaped stored data without overwriting it", () => {
    for (const serialized of ["{", "null", "[]", "a".repeat(1025), '{"version":0}',
      '{"version":1,"displayName":null,"colleagues":[],"__proto__":{}}',
      '{"version":1,"displayName":null,"colleagues":[],"history":["secret"]}']) {
      const { storage, values } = fakeStorage(serialized);
      expect(loadNpcVisitMemory(storage)).toEqual({ memory: emptyNpcVisitMemory(), status: "invalid" });
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.removeItem).not.toHaveBeenCalled();
      expect(values.get(NPC_MEMORY_KEY)).toBe(serialized);
    }
  });

  it("rejects invalid memory before touching storage", () => {
    const { storage } = fakeStorage();
    expect(saveNpcVisitMemory(storage, { ...emptyNpcVisitMemory(), history: ["private"] })).toEqual({ ok: false, reason: "invalid" });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(saveNpcVisitMemory(null, {})).toEqual({ ok: false, reason: "invalid" });
  });

  it("survives unavailable storage, quota failures and failed clear operations without throwing or lying about success", () => {
    const unavailable: NpcMemoryStorage = {
      getItem: () => { throw new Error("security"); },
      setItem: () => { throw new Error("quota"); },
      removeItem: () => { throw new Error("security"); },
    };
    for (const storage of [null, unavailable]) {
      expect(loadNpcVisitMemory(storage)).toEqual({ memory: emptyNpcVisitMemory(), status: "unavailable" });
      expect(saveNpcVisitMemory(storage, emptyNpcVisitMemory())).toEqual({ ok: false, reason: "unavailable" });
      expect(clearNpcVisitMemory(storage)).toEqual({ ok: false, reason: "unavailable" });
    }
  });

  it("safely resolves a browser storage port only on an explicit call, including SSR and denied getters", () => {
    vi.stubGlobal("window", undefined);
    expect(getNpcMemoryStorage()).toBeNull();
    const { storage } = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    expect(getNpcMemoryStorage()).toBe(storage);
    const getter = vi.fn(() => { throw new Error("disabled"); });
    const inaccessible = Object.defineProperty({}, "localStorage", { get: getter });
    vi.stubGlobal("window", inaccessible);
    expect(getter).not.toHaveBeenCalled();
    expect(getNpcMemoryStorage()).toBeNull();
    expect(getter).toHaveBeenCalledOnce();
  });
});
