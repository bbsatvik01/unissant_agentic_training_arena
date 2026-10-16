/** Public speech projection only. No draft, card lookup, stored-answer guessing, or audio clock. */
import type { SpokenCaption } from "../voice/speechCaption";
import type { VoiceState } from "../voice/voiceMachine";

export interface PrecinctSpeechCaption {
  readonly role: SpokenCaption["role"];
  readonly speaker: string;
  readonly text: string;
  readonly label: string;
}

interface CaptionInput {
  /** The parent room/source/pause gate, independent of microphone consent and read-aloud opt-in. */
  readonly active: boolean;
  readonly assessment: boolean;
  readonly spoken: SpokenCaption | null;
  readonly voice: { readonly state: VoiceState; readonly captureAboveFloor: boolean } | null;
  readonly subjectName: string;
}

/** Live transcription is role-tagged but unordered against playback. Never pair it to an utterance. */
export function precinctSpeechCaption({ active, assessment, spoken, voice, subjectName }: CaptionInput): PrecinctSpeechCaption | null {
  if (!active) return null;
  if (voice === null) {
    return spoken === null || (assessment && spoken.role === "coach") ? null : {
      role: spoken.role, speaker: spoken.speaker, text: spoken.text, label: "Read-aloud · synthesized speech",
    };
  }
  const { state, captureAboveFloor } = voice;
  if (state.connection !== "open" && state.connection !== "draining") return null;
  const latest = state.captions.findLast((line) => line.text.trim() !== "");
  if (latest !== undefined) return {
    role: latest.role,
    speaker: latest.role === "subject" ? subjectName : "You · trainee",
    text: latest.text,
    label: `Live transcript${latest.done ? "" : " · partial"} · timing may differ from audio`,
  };
  // Activity can be certain while matching text is unavailable. Do not substitute old exchanges or "...".
  if (state.audible !== null) return {
    role: "subject", speaker: subjectName,
    text: "Audio is playing. Transcript text is not available yet.", label: "Live voice · transcript pending",
  };
  if (state.connection === "open" && (captureAboveFloor || state.investigatorActive)) return {
    role: "investigator", speaker: "You · trainee",
    text: "Microphone activity. Transcript text is not available yet.", label: "Live voice · transcript pending",
  };
  return null;
}
