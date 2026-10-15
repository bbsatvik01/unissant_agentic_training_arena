/**
 * Opt-in local visit memory only. No transcripts, case data, timestamps, accounts, or analytics.
 * Importing this module does not read or write storage. Every storage operation is explicit.
 */
import { copyBoundedArray, hasExactFields, isNpcId, NPC_IDS } from "./npcIdentity";
import type { NpcId } from "./npcIdentity";

export const NPC_MEMORY_KEY = "arena.precinct.npc-visits.v1";
export const NPC_MEMORY_LIMITS = { nameLength: 40, visitsPerColleague: 999, serializedLength: 1024 } as const;

export interface NpcVisitMemory {
  readonly version: 1;
  /** An optional user-entered preferred name, never inferred from a chat message or account. */
  readonly displayName: string | null;
  readonly colleagues: readonly { readonly npc_id: NpcId; readonly visits: number }[];
}

export interface NpcMemoryStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}

export function emptyNpcVisitMemory(): NpcVisitMemory {
  return { version: 1, displayName: null, colleagues: [] };
}

/** A short name only, not free-form memory. Unicode letters/marks, spaces, apostrophes and hyphens. */
function normalizedName(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > NPC_MEMORY_LIMITS.nameLength) return undefined;
  const name = value.trim().replace(/ +/g, " ");
  if (name.length === 0) return null;
  return /^[\p{L}\p{M}][\p{L}\p{M} '\u2019-]*$/u.test(name) ? name : undefined;
}

/** Rejects unknown versions, extra data, duplicates, invalid counts and unsafe names. Returns a copy. */
export function parseNpcVisitMemory(value: unknown): NpcVisitMemory | null {
  try {
    if (!hasExactFields(value, ["version", "displayName", "colleagues"]) || value["version"] !== 1) return null;
    const name = normalizedName(value["displayName"]);
    const entries = copyBoundedArray(value["colleagues"], NPC_IDS.length);
    if (name === undefined || entries === null) return null;
    const counts = new Map<NpcId, number>();
    for (const entry of entries) {
      if (!hasExactFields(entry, ["npc_id", "visits"])) return null;
      const id = entry["npc_id"];
      const visits = entry["visits"];
      if (!isNpcId(id) || counts.has(id) || typeof visits !== "number" || !Number.isInteger(visits)
        || visits < 1 || visits > NPC_MEMORY_LIMITS.visitsPerColleague) return null;
      counts.set(id, visits);
    }
    return {
      version: 1,
      displayName: name,
      colleagues: NPC_IDS.flatMap((npc_id) => {
        const visits = counts.get(npc_id);
        return visits === undefined ? [] : [{ npc_id, visits }];
      }),
    };
  } catch {
    return null;
  }
}

/** Call only after the user explicitly chooses a local preferred name. Null/blank removes it. */
export function withNpcDisplayName(memory: NpcVisitMemory, displayName: unknown): NpcVisitMemory | null {
  const current = parseNpcVisitMemory(memory);
  const name = normalizedName(displayName);
  return current === null || name === undefined ? null : { ...current, displayName: name };
}

/** Count one explicitly opened conversation, not every message, animation frame, or nearby pass. */
export function recordNpcVisit(memory: NpcVisitMemory, npcId: NpcId): NpcVisitMemory {
  const current = parseNpcVisitMemory(memory) ?? emptyNpcVisitMemory();
  if (!isNpcId(npcId)) return current;
  const counts = new Map(current.colleagues.map((entry) => [entry.npc_id, entry.visits]));
  counts.set(npcId, Math.min(NPC_MEMORY_LIMITS.visitsPerColleague, (counts.get(npcId) ?? 0) + 1));
  return {
    ...current,
    colleagues: NPC_IDS.flatMap((npc_id) => {
      const visits = counts.get(npc_id);
      return visits === undefined ? [] : [{ npc_id, visits }];
    }),
  };
}

/** Optional explicit browser boundary. Handles SSR and browsers denying localStorage access. */
export function getNpcMemoryStorage(): NpcMemoryStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export interface NpcMemoryLoad {
  readonly memory: NpcVisitMemory;
  readonly status: "loaded" | "empty" | "invalid" | "unavailable";
}

export function loadNpcVisitMemory(storage: NpcMemoryStorage | null): NpcMemoryLoad {
  if (storage === null) return { memory: emptyNpcVisitMemory(), status: "unavailable" };
  try {
    const serialized = storage.getItem(NPC_MEMORY_KEY);
    if (serialized === null) return { memory: emptyNpcVisitMemory(), status: "empty" };
    if (serialized.length > NPC_MEMORY_LIMITS.serializedLength) return { memory: emptyNpcVisitMemory(), status: "invalid" };
    let candidate: unknown;
    try {
      candidate = JSON.parse(serialized) as unknown;
    } catch {
      return { memory: emptyNpcVisitMemory(), status: "invalid" };
    }
    const memory = parseNpcVisitMemory(candidate);
    return memory === null ? { memory: emptyNpcVisitMemory(), status: "invalid" } : { memory, status: "loaded" };
  } catch {
    return { memory: emptyNpcVisitMemory(), status: "unavailable" };
  }
}

export type NpcMemoryWrite = { readonly ok: true } | { readonly ok: false; readonly reason: "invalid" | "unavailable" };

/** The caller must opt in before invoking this. Failure leaves its in-memory copy usable. */
export function saveNpcVisitMemory(storage: NpcMemoryStorage | null, value: unknown): NpcMemoryWrite {
  const memory = parseNpcVisitMemory(value);
  if (memory === null) return { ok: false, reason: "invalid" };
  if (storage === null) return { ok: false, reason: "unavailable" };
  try {
    storage.setItem(NPC_MEMORY_KEY, JSON.stringify(memory));
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** Removes only this feature's key. Clear the caller's in-memory copy separately as well. */
export function clearNpcVisitMemory(storage: NpcMemoryStorage | null): NpcMemoryWrite {
  if (storage === null) return { ok: false, reason: "unavailable" };
  try {
    storage.removeItem(NPC_MEMORY_KEY);
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
