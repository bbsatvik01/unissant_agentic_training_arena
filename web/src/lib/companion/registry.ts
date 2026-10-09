/**
 * @module companion/registry
 *
 * The bundle-discipline seam (S6 6.3 and 13; FE-PET-5): the cast is referenced ONLY here, each
 * character behind `lazy(() => import(...))`, so only the character in use enters the bundle and
 * art never reaches the entry chunk. Lifted from gokbase `kin/registry.ts` (the pet-props contract,
 * lines 17-26, and the lazy loaders, lines 108-137; see web/ATTRIBUTIONS.md).
 *
 * Stub: the arena's character set, names and pose styling come from DESIGN.md (owner decisions
 * OD-4, OD-5) after the 2026-10-18 slice gate. Until then the only character is an unstyled
 * development placeholder, which is not shipped. The donor's `poseStyle` (opacity and transforms
 * per pose) is a visual decision and is not lifted yet.
 */

import { lazy, type ComponentType, type LazyExoticComponent } from "react";

import type { PetMotion, PetState } from "./fsm";

/**
 * Every character's props. `state` and `motion` are React props (they change a few times per
 * session); per-frame values ride CSS variables set outside React, never props.
 */
export interface CompanionPetProps {
  readonly state: PetState;
  readonly motion: PetMotion;
  readonly size: number;
}

export const COMPANION_CHARACTERS = ["placeholder"] as const;

export type CompanionCharacter = (typeof COMPANION_CHARACTERS)[number];

const loaders: Readonly<Record<CompanionCharacter, LazyExoticComponent<ComponentType<CompanionPetProps>>>> = {
  placeholder: lazy(() => import("../../components/companion/pets/placeholder")),
};

/** True for a known character; anything else (an unknown or untrusted value) is refused. */
export function isCompanionCharacter(value: unknown): value is CompanionCharacter {
  return typeof value === "string" && (COMPANION_CHARACTERS as readonly string[]).includes(value);
}

/** The lazy component for a character (the companion layer renders it inside Suspense). */
export function companionLoader(character: CompanionCharacter): LazyExoticComponent<ComponentType<CompanionPetProps>> {
  return loaders[character];
}
