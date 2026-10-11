/**
 * The cast (D-025): which rigged avatar plays each subject persona and each coach desk, with a personality of its
 * own: posture, gesture energy, gaze habits and voice. Avatars are Microsoft Rocketbox characters (MIT; see
 * `public/avatars/LICENSE.md`), converted to glTF with the Oculus visemes and ARKit eye and brow shapes.
 *
 * Personas follow the subject's public presentation (S1: assigned per case family, so both variants of a family share
 * one persona). Nothing here is keyed to role, communication style or anything said: a persona's gestures, gaze and
 * voice are the same whether the subject is truthful or not (PRB-4), and none of them is a nervous or stress tell.
 */

export type ClipSet = "m" | "f";

export interface Persona {
  /** Folder under `/avatars/`. */
  readonly avatar: string;
  /** Which seated clip set fits the rig's proportions. */
  readonly clips: ClipSet;
  /** Forward lean of the upper body, radians (posture). */
  readonly lean: number;
  /** Resting head tilt, radians (a habit, not a state). */
  readonly headTilt: number;
  /** Size of head nods and hand beats while speaking, 0..1 (gesture energy). */
  readonly gesture: number;
  /** Mean ms between eye saccades (gaze habit). */
  readonly saccadeMs: number;
  /** Mean ms between blinks. */
  readonly blinkMs: number;
  /** Voice for a text-to-speech seam (browser or Gemini TTS later): pitch and rate multipliers and a timbre. */
  readonly voice: { readonly pitch: number; readonly rate: number; readonly timbre: string };
}

const SUBJECTS: Readonly<Record<string, Persona>> = {
  "Jordan Pell": { avatar: "Male_Adult_05", clips: "m", lean: 0.05, headTilt: 0.03, gesture: 0.55, saccadeMs: 1800, blinkMs: 3800, voice: { pitch: 0.95, rate: 1.0, timbre: "warm baritone" } },
  "Mara Quell": { avatar: "Female_Adult_14", clips: "f", lean: 0.02, headTilt: -0.04, gesture: 0.35, saccadeMs: 2400, blinkMs: 4200, voice: { pitch: 1.05, rate: 0.95, timbre: "measured alto" } },
  "Avery Lindqvist": { avatar: "Male_Adult_08", clips: "m", lean: 0.08, headTilt: 0.0, gesture: 0.7, saccadeMs: 1400, blinkMs: 3400, voice: { pitch: 1.0, rate: 1.08, timbre: "bright tenor" } },
  "Dana Okafor": { avatar: "Female_Adult_07", clips: "f", lean: 0.04, headTilt: 0.05, gesture: 0.6, saccadeMs: 2000, blinkMs: 3600, voice: { pitch: 1.1, rate: 1.02, timbre: "clear mezzo" } },
  "Rafael Strand": { avatar: "Male_Adult_12", clips: "m", lean: 0.0, headTilt: -0.02, gesture: 0.4, saccadeMs: 2600, blinkMs: 4600, voice: { pitch: 0.9, rate: 0.94, timbre: "low and even" } },
};

/** The subject persona for a display name; an unknown subject gets the first persona's build. */
export function subjectPersona(displayName: string): Persona {
  return SUBJECTS[displayName] ?? (SUBJECTS["Jordan Pell"] as Persona);
}

/** The three coaches at their desks, left to right: question, flags, follow-up. */
export const COACHES: readonly (Persona & { readonly name: string; readonly desk: "question" | "flags" | "follow_up" })[] = [
  { name: "Question desk", desk: "question", avatar: "Business_Female_01", clips: "f", lean: 0.12, headTilt: 0.02, gesture: 0.5, saccadeMs: 1600, blinkMs: 3600, voice: { pitch: 1.05, rate: 1.0, timbre: "crisp" } },
  { name: "Flags desk", desk: "flags", avatar: "Business_Male_04", clips: "m", lean: 0.06, headTilt: -0.03, gesture: 0.35, saccadeMs: 2200, blinkMs: 4400, voice: { pitch: 0.88, rate: 0.92, timbre: "gravelly" } },
  { name: "Follow-up desk", desk: "follow_up", avatar: "Business_Female_02", clips: "f", lean: 0.1, headTilt: 0.04, gesture: 0.6, saccadeMs: 1500, blinkMs: 3200, voice: { pitch: 1.12, rate: 1.05, timbre: "light" } },
];

/** Every avatar folder the world can load. */
export const AVATARS: readonly string[] = [...new Set([...Object.values(SUBJECTS).map((p) => p.avatar), ...COACHES.map((c) => c.avatar)])];

/** A small deterministic random sequence (mulberry32), so idle motion is lively but reproducible per persona. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable seed from a name. */
export function seedOf(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i += 1) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return h >>> 0;
}
