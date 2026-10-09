import type { CompanionPetProps } from "../../../lib/companion/registry";

/**
 * Development placeholder for the companion character: unstyled, not shipped. It renders the pose
 * name and the S6 11 state hooks so the room can be built before DESIGN.md supplies the character.
 * Decorative, so hidden from assistive technology; the room's status line carries the words.
 */
export default function PlaceholderPet({ state, motion, size }: CompanionPetProps) {
  return (
    <span aria-hidden="true" data-pose={state} data-motion={motion} data-size={size}>
      {state}
    </span>
  );
}
