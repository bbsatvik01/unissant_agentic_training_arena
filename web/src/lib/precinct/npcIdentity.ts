/** Stable local identities. These opaque voice aliases do not invoke or identify a cloud voice. */
import type { StaffId } from "./staff";

export const NPC_IDS = ["receptionist", "sergeant", "analyst", "patrol"] as const satisfies readonly StaffId[];
export type NpcId = typeof NPC_IDS[number];
export const LOCAL_VOICE_IDS = ["local-reception-v1", "local-sergeant-v1", "local-colleague-v1", "local-guide-v1"] as const;
export type LocalVoiceId = typeof LOCAL_VOICE_IDS[number];

export const NPC_IDENTITIES: Readonly<Record<NpcId, { readonly label: string; readonly voice_id: LocalVoiceId }>> = {
  receptionist: { label: "Reception officer", voice_id: "local-reception-v1" },
  sergeant: { label: "Training sergeant", voice_id: "local-sergeant-v1" },
  analyst: { label: "Office analyst", voice_id: "local-colleague-v1" },
  patrol: { label: "Precinct colleague", voice_id: "local-colleague-v1" },
};

export function isNpcId(value: unknown): value is NpcId {
  return typeof value === "string" && NPC_IDS.some((id) => id === value);
}

export function isLocalVoiceId(value: unknown): value is LocalVoiceId {
  return typeof value === "string" && LOCAL_VOICE_IDS.some((id) => id === value);
}

/** JSON-shaped records only; rejects inherited fields, extra fields, arrays, and accessors. */
export function hasExactFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && fields.every((field) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor !== undefined && "value" in descriptor;
  });
}

/** Copies dense JSON arrays without invoking custom iterators or indexed getters. */
export function copyBoundedArray(value: unknown, maximum: number): readonly unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (typeof length !== "number" || !Number.isInteger(length) || length < 0 || length > maximum
    || Reflect.ownKeys(value).length !== length + 1) return null;
  const copy: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) return null;
    copy.push(descriptor.value as unknown);
  }
  return copy;
}
