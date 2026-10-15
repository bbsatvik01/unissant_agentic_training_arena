// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePrecinctNpcController } from "./usePrecinctNpcController";
import { emptyNpcVisitMemory, NPC_MEMORY_KEY } from "../lib/precinct/npcVisitMemory";
import type { NpcMemoryStorage } from "../lib/precinct/npcVisitMemory";

afterEach(cleanup);
function storageFixture(initial?: string) {
  const values = new Map(initial === undefined ? [] : [[NPC_MEMORY_KEY, initial]]);
  const storage: NpcMemoryStorage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
  };
  return { values, storage, factory: vi.fn(() => storage) };
}

describe("route-owned NPC controller", () => {
  it("performs no storage IO on mount, strict remount, rerender, opt-in toggle, name change or conversation", () => {
    const { factory, storage } = storageFixture();
    const { result, rerender } = renderHook(() => usePrecinctNpcController(factory), { wrapper: StrictMode });
    rerender();
    act(() => { result.current.setRemember(true); });
    act(() => { result.current.updateName("Alex"); });
    act(() => { result.current.startVisit("receptionist"); });
    act(() => { result.current.setRemember(false); });
    expect(factory).not.toHaveBeenCalled();
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(result.current.notice.text).toContain("previously saved copy is unchanged");
  });

  it("greets from pre-visit memory and remembers colleagues across consecutive openings without stale state", () => {
    const { result } = renderHook(() => usePrecinctNpcController(() => null));
    act(() => { result.current.updateName("Alex"); });
    act(() => {
      const first = result.current.startVisit("sergeant");
      expect(first.greeting.reply).toMatch(/^Welcome, Alex\./u);
      const second = result.current.startVisit("sergeant");
      expect(second.greeting.reply).toMatch(/^Good to see you again, Alex\./u);
      expect(result.current.startVisit("receptionist").greeting.reply).toMatch(/^Welcome, Alex\./u);
      expect(first.reply("evidence").reply).toContain("observations");
    });
    expect(result.current.memory.colleagues).toEqual([{ npc_id: "receptionist", visits: 1 }, { npc_id: "sergeant", visits: 2 }]);
  });

  it("rejects invalid names without losing the previous name", () => {
    const { result } = renderHook(() => usePrecinctNpcController(() => null));
    act(() => { expect(result.current.updateName("Alex")).toBe(true); });
    act(() => { expect(result.current.updateName("<img>")).toBe(false); });
    expect(result.current.memory.displayName).toBe("Alex");
    expect(result.current.notice.tone).toBe("error");
  });

  it("requires opt-in for both explicit load and save", () => {
    const { factory } = storageFixture();
    const { result } = renderHook(() => usePrecinctNpcController(factory));
    act(() => { expect(result.current.loadMemory()).toBeNull(); });
    expect(result.current.notice.text).toContain("Opt in");
    act(() => { expect(result.current.saveMemory()).toBe(false); });
    expect(factory).not.toHaveBeenCalled();
  });

  it("explicitly saves and reloads only local familiarity, and does not hydrate a new route without action", () => {
    const fixture = storageFixture();
    const first = renderHook(() => usePrecinctNpcController(fixture.factory));
    act(() => {
      first.result.current.setRemember(true);
      first.result.current.updateName("Alex");
      first.result.current.startVisit("receptionist");
      expect(first.result.current.saveMemory()).toBe(true);
    });
    expect(fixture.storage.setItem).toHaveBeenCalledOnce();
    first.unmount();
    const second = renderHook(() => usePrecinctNpcController(fixture.factory));
    expect(second.result.current.memory).toEqual(emptyNpcVisitMemory());
    expect(fixture.storage.getItem).not.toHaveBeenCalled();
    act(() => { second.result.current.setRemember(true); second.result.current.loadMemory(); });
    expect(second.result.current.memory.displayName).toBe("Alex");
    act(() => { expect(second.result.current.startVisit("receptionist").greeting.reply).toMatch(/^Good to see you again, Alex\./u); });
  });

  it("preserves current memory when saved data is missing, corrupt or inaccessible", () => {
    for (const initial of [undefined, "{invalid"]) {
      const { factory, storage } = storageFixture(initial);
      const { result, unmount } = renderHook(() => usePrecinctNpcController(factory));
      act(() => { result.current.updateName("Alex"); result.current.setRemember(true); expect(result.current.loadMemory()).toBeNull(); });
      expect(result.current.memory.displayName).toBe("Alex");
      expect(result.current.notice.tone).toBe(initial === undefined ? "info" : "error");
      expect(storage.setItem).not.toHaveBeenCalled();
      unmount();
    }
    const { result } = renderHook(() => usePrecinctNpcController(() => { throw new Error("denied"); }));
    act(() => { result.current.updateName("Alex"); result.current.setRemember(true); result.current.loadMemory(); });
    expect(result.current.memory.displayName).toBe("Alex");
    expect(result.current.notice.text).toContain("unavailable");
  });

  it("shows honest quota failure and clears ephemeral memory even when stored deletion fails", () => {
    const storage: NpcMemoryStorage = { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => { throw new Error("denied"); } };
    const { result } = renderHook(() => usePrecinctNpcController(() => storage));
    act(() => { result.current.setRemember(true); result.current.updateName("Alex"); expect(result.current.saveMemory()).toBe(false); });
    expect(result.current.notice.text).toContain("could not be saved");
    act(() => { expect(result.current.forgetMemory()).toBe(false); });
    expect(result.current.memory).toEqual(emptyNpcVisitMemory());
    expect(result.current.remember).toBe(false);
    expect(result.current.notice.text).toContain("deletion is not confirmed");
  });

  it("forgets only the dedicated key after an explicit action, even when persistence was disabled", () => {
    const { factory, storage, values } = storageFixture(JSON.stringify(emptyNpcVisitMemory()));
    values.set("unrelated", "preserve");
    const { result } = renderHook(() => usePrecinctNpcController(factory));
    act(() => { result.current.updateName("Alex"); expect(result.current.forgetMemory()).toBe(true); });
    expect(storage.removeItem).toHaveBeenCalledWith(NPC_MEMORY_KEY);
    expect(values.has(NPC_MEMORY_KEY)).toBe(false);
    expect(values.get("unrelated")).toBe("preserve");
    expect(result.current.notice.tone).toBe("info");
  });
});
