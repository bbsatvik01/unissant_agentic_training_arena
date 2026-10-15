import { FrontSide } from "three";
import { OBSERVATION_MIRROR } from "../../lib/precinct/observationGlazing";

/** An opaque reflective face on the interview side only. No renderer, clock or camera listener. */
export function ObservationGlazing() {
  return <mesh name="Observation interview-side mirror" position={[...OBSERVATION_MIRROR.position]}>
    <planeGeometry args={[...OBSERVATION_MIRROR.size]} />
    <meshStandardMaterial color={OBSERVATION_MIRROR.color} roughness={OBSERVATION_MIRROR.roughness} metalness={OBSERVATION_MIRROR.metalness} side={FrontSide} />
  </mesh>;
}
