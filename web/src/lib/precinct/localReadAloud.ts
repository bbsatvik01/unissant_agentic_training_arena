/** Precinct-only offline synthesis: installed local voices, never a remote or browser-default voice. */
import type { VoiceEngine } from "../voice/gemini";
import { fitRate, pickVoice, utteranceSettings } from "../voice/tts";

export const LOCAL_VOICE_UNAVAILABLE = "No installed local English voice is available. Read-aloud is off. Install an English system voice, then try again.";

function synthesis(): SpeechSynthesis | null {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined" ? window.speechSynthesis : null;
}

function installedVoice(synth: SpeechSynthesis, prefer: readonly string[]): SpeechSynthesisVoice | null {
  return pickVoice(synth.getVoices().filter((voice) => voice.localService), prefer);
}

/** Construction, availability checks and cancellation never enqueue speech or create an audio analyser. */
export function createLocalReadAloud(onUnavailable: () => void): VoiceEngine & { readonly available: () => boolean } {
  const pending = new Set<() => void>();
  return {
    available() {
      const synth = synthesis();
      return synth !== null && installedVoice(synth, []) !== null;
    },
    speak(item, hooks) {
      const synth = synthesis();
      const voice = synth === null ? null : installedVoice(synth, item.voice.prefer);
      if (synth === null || voice === null) {
        onUnavailable();
        hooks.onend();
        return;
      }
      const utterance = new SpeechSynthesisUtterance(item.text);
      utterance.voice = voice;
      const { pitch, rate } = utteranceSettings(item.voice);
      utterance.pitch = pitch;
      utterance.rate = item.line === null ? rate : fitRate(item.text, rate);
      utterance.volume = item.volume;
      let done = false;
      const end = () => {
        if (done) return;
        done = true;
        pending.delete(end);
        hooks.onend();
      };
      pending.add(end);
      utterance.onstart = () => { if (!done) hooks.onstart(); };
      utterance.onboundary = (event) => { if (!done) hooks.onprogress(event.charIndex); };
      utterance.onend = end;
      utterance.onerror = end;
      synth.speak(utterance);
    },
    cancel() {
      synthesis()?.cancel();
      for (const end of [...pending]) end();
    },
  };
}
