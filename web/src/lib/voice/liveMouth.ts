/**
 * The seam between live voice audio and the room's mouths (WP-22). The voice session attaches one level source per
 * speaker: the subject's is the Live playback node's amplitude, the investigator's the microphone's. An avatar asks
 * `liveMouth.level(role)` each frame; while a source is attached its mouth follows the amplitude
 * (`mouthFromLevel`) instead of the text cadence. Any audio-driven lip-sync can attach here the same way.
 */
export type VoiceRole = "subject" | "investigator";
export type LevelSource = () => number;

export interface MouthShape {
  /** Jaw opening, 0-1. */
  readonly jaw: number;
  /** Open vowel weight (Oculus `aa`), 0-1. */
  readonly aa: number;
  /** Rounded vowel weight (Oculus `O`), 0-1. */
  readonly O: number;
}

/** Below this amplitude the mouth is closed (room noise, the tail of a word). */
export const MOUTH_FLOOR = 0.01;
/** Amplitude that opens the mouth fully; speech RMS sits well under 1. */
export const MOUTH_FULL = 0.18;

function unit(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

export interface LiveMouth {
  /** Attach `source` for `role`; the returned function detaches it (only if it is still the attached one). */
  readonly attach: (role: VoiceRole, source: LevelSource) => () => void;
  /** The role's amplitude now (0-1), or null when no live voice is attached. */
  readonly level: (role: VoiceRole) => number | null;
}

export function createLiveMouth(): LiveMouth {
  const sources = new Map<VoiceRole, LevelSource>();
  return {
    attach(role, source) {
      sources.set(role, source);
      return () => {
        if (sources.get(role) === source) sources.delete(role);
      };
    },
    level(role) {
      const source = sources.get(role);
      return source === undefined ? null : unit(source());
    },
  };
}

/**
 * The mouth for an amplitude: closed under the floor, then opening with loudness; the vowel alternates slowly
 * between open and rounded with `timeS` so a held sound does not freeze one shape.
 */
export function mouthFromLevel(level: number, timeS: number): MouthShape {
  const open = level <= MOUTH_FLOOR ? 0 : unit((level - MOUTH_FLOOR) / (MOUTH_FULL - MOUTH_FLOOR));
  const round = 0.5 + 0.5 * Math.sin(timeS * 7.3);
  return { jaw: open * 0.6, aa: open * (1 - 0.6 * round), O: open * 0.6 * round };
}

/** The room's one live mouth: the voice session writes it, the avatars read it each frame. */
export const liveMouth = createLiveMouth();
