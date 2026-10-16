import { useCallback, useRef, useState } from "react";
import { createLocalNpcAdapter } from "../lib/precinct/npcLocalAdapter";
import type { NpcResponse } from "../lib/precinct/npcLocalAdapter";
import type { NpcId } from "../lib/precinct/npcIdentity";
import { clearNpcVisitMemory, emptyNpcVisitMemory, getNpcMemoryStorage, loadNpcVisitMemory, recordNpcVisit, saveNpcVisitMemory, withNpcDisplayName } from "../lib/precinct/npcVisitMemory";
import type { NpcMemoryStorage, NpcVisitMemory } from "../lib/precinct/npcVisitMemory";

export interface LocalNpcVisit {
  readonly npcId: NpcId;
  readonly greeting: NpcResponse;
  readonly reply: (message: string) => NpcResponse;
}
interface ControllerView {
  readonly memory: NpcVisitMemory;
  readonly remember: boolean;
  readonly notice: { readonly tone: "info" | "error"; readonly text: string };
}
export interface PrecinctNpcController extends ControllerView {
  readonly setRemember: (enabled: boolean) => void;
  readonly updateName: (name: string) => boolean;
  readonly loadMemory: () => NpcVisitMemory | null;
  readonly saveMemory: () => boolean;
  readonly forgetMemory: () => boolean;
  readonly startVisit: (npcId: NpcId) => LocalNpcVisit;
}

/** Mount once in the route, outside conditional station panels. No effects or implicit storage IO. */
export function usePrecinctNpcController(storageFactory: () => NpcMemoryStorage | null = getNpcMemoryStorage): PrecinctNpcController {
  const [state, setState] = useState<ControllerView>(() => ({
    memory: emptyNpcVisitMemory(), remember: false,
    notice: { tone: "info", text: "Staff familiarity stays in this visit unless you opt in and save it on this device." },
  }));
  // Handlers update this synchronously so rapid explicit actions cannot read stale memory.
  const current = useRef(state);
  const commit = useCallback((next: ControllerView) => { current.current = next; setState(next); }, []);
  const resolveStorage = useCallback(() => {
    try { return storageFactory(); } catch { return null; }
  }, [storageFactory]);

  const setRemember = useCallback((enabled: boolean) => {
    commit({ ...current.current, remember: enabled, notice: { tone: "info", text: enabled
      ? "Local storage is enabled for the buttons below. Choose Load or Save; nothing has been read or written yet."
      : "Saving is off. Any previously saved copy is unchanged; use Forget to remove it." } });
  }, [commit]);

  const updateName = useCallback((name: string): boolean => {
    const memory = withNpcDisplayName(current.current.memory, name);
    if (memory === null) {
      commit({ ...current.current, notice: { tone: "error", text: "Use a preferred name of up to 40 characters: letters, spaces, apostrophes or hyphens. Leave it blank to remove the name." } });
      return false;
    }
    commit({ ...current.current, memory, notice: { tone: "info", text: "Preferred name updated for this visit. No stored copy has changed yet." } });
    return true;
  }, [commit]);

  const loadMemory = useCallback((): NpcVisitMemory | null => {
    if (!current.current.remember) {
      commit({ ...current.current, notice: { tone: "error", text: "Opt in to local storage before loading saved staff familiarity." } });
      return null;
    }
    const loaded = loadNpcVisitMemory(resolveStorage());
    if (loaded.status === "loaded") {
      commit({ ...current.current, memory: loaded.memory, notice: { tone: "info", text: "Saved name and staff visits loaded. This replaces the current visit's familiarity." } });
      return loaded.memory;
    }
    commit({ ...current.current, notice: { tone: loaded.status === "empty" ? "info" : "error", text: loaded.status === "empty"
      ? "There is no saved staff memory on this device. Your current visit is unchanged."
      : loaded.status === "invalid" ? "Saved staff memory is unreadable or from an unsupported version. Your current visit is unchanged; the saved copy was not overwritten."
        : "Local storage is unavailable. Your name and staff visits can still be used for this visit." } });
    return null;
  }, [commit, resolveStorage]);

  const saveMemory = useCallback((): boolean => {
    if (!current.current.remember) {
      commit({ ...current.current, notice: { tone: "error", text: "Opt in to local storage before saving your name and staff visits." } });
      return false;
    }
    const result = saveNpcVisitMemory(resolveStorage(), current.current.memory);
    commit({ ...current.current, notice: result.ok
      ? { tone: "info", text: "Name and staff visits saved on this device. No chat or case information was saved." }
      : { tone: "error", text: "Staff memory could not be saved. It is still available for this visit only." } });
    return result.ok;
  }, [commit, resolveStorage]);

  const forgetMemory = useCallback((): boolean => {
    const result = clearNpcVisitMemory(resolveStorage());
    commit({ memory: emptyNpcVisitMemory(), remember: false, notice: result.ok
      ? { tone: "info", text: "Name and staff visits cleared here and removed from this device's saved staff memory." }
      : { tone: "error", text: "This visit's name and staff memory are cleared, but the saved copy could not be removed. Browser storage is unavailable; deletion is not confirmed." } });
    return result.ok;
  }, [commit, resolveStorage]);

  const startVisit = useCallback((npcId: NpcId): LocalNpcVisit => {
    const talk = createLocalNpcAdapter(current.current.memory);
    const greeting = talk({ npc_id: npcId, message: "hello", history: [] });
    commit({ ...current.current, memory: recordNpcVisit(current.current.memory, npcId), notice: { tone: "info", text:
      "Staff familiarity updated for this visit. Use Save if you want to keep it on this device." } });
    return { npcId, greeting, reply: (message) => talk({ npc_id: npcId, message, history: [] }) };
  }, [commit]);

  return { ...state, setRemember, updateName, loadMemory, saveMemory, forgetMemory, startVisit };
}
