/**
 * The room's two voice engines (stage 5; `lib/voice/gemini` defines their shape). The browser engine is the
 * browser's own speech synthesis, a persona's preferred system voice at its pitch, its rate fitted to the line's
 * speaking time. The Gemini engine asks the server for each line's audio (`POST /api/tts`, cached there so a line is
 * paid for once) and plays it with Web Audio; without the server, or when it refuses or answers with silence (its
 * fake mode), the browser engine speaks instead.
 */
import type { ArenaApi } from "../../lib/api/arena";
import { createGeminiEngine, type AudioPort, type Playing, type VoiceEngine } from "../../lib/voice/gemini";
import { fitRate, pickVoice, utteranceSettings } from "../../lib/voice/tts";
import { analyserSource, audioMouth } from "../../lib/world/audioLips";

function synth(): SpeechSynthesis | null {
  return typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
}

/** The browser's speech synthesis as an engine: one utterance per item, the browser's own queue. */
export function browserEngine(): VoiceEngine {
  return {
    speak(item, hooks) {
      const s = synth();
      if (s === null) {
        hooks.onend();
        return;
      }
      const u = new SpeechSynthesisUtterance(item.text);
      const voice = pickVoice(s.getVoices(), item.voice.prefer);
      if (voice !== null) u.voice = voice;
      const { pitch, rate } = utteranceSettings(item.voice);
      u.pitch = pitch;
      u.rate = item.line === null ? rate : fitRate(item.text, rate);
      u.volume = item.volume;
      let done = false;
      const end = () => {
        if (done) return;
        done = true;
        hooks.onend();
      };
      u.onstart = hooks.onstart;
      u.onboundary = (e) => {
        hooks.onprogress(e.charIndex);
      };
      u.onend = end;
      u.onerror = end;
      s.speak(u);
    },
    cancel() {
      synth()?.cancel();
    },
  };
}

/** How long a line waits for the browser to let audio play before the browser's own voice speaks it. */
export const RESUME_WAIT_MS = 1000;

interface WebClip {
  readonly duration: number;
  readonly buffer: AudioBuffer;
  /** Who speaks it (the voice catalogue key): the mouth it drives, and whether it is the coach's earpiece aside. */
  readonly voice: string;
  readonly generation: number;
}

/** The coach speaks in the investigator's earpiece (stage 8): its catalogue keys. */
export function isEarpiece(voice: string): boolean {
  return voice.startsWith("coach:");
}

/** How the earpiece sounds: a small speaker's band (300-3400 Hz), close to one ear (to the right), quieter. */
export const EARPIECE = { lowCutHz: 300, highCutHz: 3400, pan: 0.7, gain: 0.55 } as const;
/** The analyser that lips read: small enough to be cheap, fine enough for the speech bands. */
const LIPS_FFT = 512;

/** Construction is pure; a committed owner activates once and releases its own activation. */
export interface RoomAudioLifecycle { readonly activate: () => () => void }
export type RoomVoiceEngine = VoiceEngine & RoomAudioLifecycle;

/** The speech route and Web Audio: WAVs cached only within the current committed activation. */
export function webAudioPort(api: Pick<ArenaApi, "speak">): AudioPort<WebClip> & RoomAudioLifecycle {
  let context: AudioContext | null = null;
  let owner: object | null = null, generation = 0;
  const playing = new Set<() => void>();
  const isCurrent = (mine: number, audio?: AudioContext) => owner !== null && mine === generation && (audio === undefined || audio === context);
  const ctx = () => {
    if (owner === null) throw new Error("Room audio has no committed owner.");
    context ??= new AudioContext();
    return context;
  };
  const removeUnlock = () => {
    if (typeof window === "undefined") return;
    window.removeEventListener("pointerdown", unlock, true);
    window.removeEventListener("keydown", unlock, true);
  };
  // The first gesture unlocks only the committed engine, and removes both listeners.
  const unlock = () => {
    removeUnlock();
    if (owner === null) return;
    void ctx().resume().catch(() => undefined);
  };
  /** Whether audio can play now. A context the browser keeps suspended (its resume may never settle while playback
   * is blocked) is waited for at most RESUME_WAIT_MS; then the browser's voice speaks instead. */
  const running = async (c: AudioContext) => {
    if (c.state !== "running") {
      const waited = new Promise<void>((r) => setTimeout(r, RESUME_WAIT_MS));
      await Promise.race([c.resume().catch(() => undefined), waited]);
    }
    return c.state === "running";
  };
  const clips = new Map<string, Promise<WebClip | null>>();
  return {
    activate() {
      if (owner !== null) throw new Error("Room audio already has a committed owner.");
      const token = {}; owner = token;
      if (typeof window !== "undefined") {
        window.addEventListener("pointerdown", unlock, { once: true, capture: true });
        window.addEventListener("keydown", unlock, { once: true, capture: true });
      }
      return () => {
        if (owner !== token) return;
        owner = null; generation += 1; removeUnlock(); clips.clear();
        for (const stop of [...playing]) stop();
        const old = context; context = null;
        if (old !== null && old.state !== "closed") void old.close().catch(() => undefined);
      };
    },
    fetchClip(voice, text) {
      if (owner === null) return Promise.resolve(null);
      const mine = generation;
      const key = `${voice}\n${text}`;
      let clip = clips.get(key);
      if (clip === undefined) {
        clip = api.speak(voice, text).then(
          async ({ audio, silent }) => {
            if (silent || !isCurrent(mine)) return null;
            const c = ctx();
            const buffer = await c.decodeAudioData(audio);
            if (!isCurrent(mine, c)) return null;
            const ready = await running(c);
            return ready && isCurrent(mine, c) ? { duration: buffer.duration, buffer, voice, generation: mine } : null;
          },
          () => null,
        );
        clips.set(key, clip);
      }
      return clip;
    },
    play(clip, volume, onended): Playing {
      if (owner === null || clip.generation !== generation) throw new Error("Room audio clip belongs to an inactive owner.");
      const c = ctx();
      const source = c.createBufferSource();
      source.buffer = clip.buffer;
      const gain = c.createGain();
      // The mouth follows this clip's sound while it plays (lips from audio); the text timing is the fallback.
      const analyser = c.createAnalyser();
      analyser.fftSize = LIPS_FFT;
      analyser.smoothingTimeConstant = 0.5;
      const nodes: AudioNode[] = [source, gain, analyser];
      let tail: AudioNode = source;
      if (isEarpiece(clip.voice)) {
        const low = c.createBiquadFilter();
        low.type = "highpass";
        low.frequency.value = EARPIECE.lowCutHz;
        const high = c.createBiquadFilter();
        high.type = "lowpass";
        high.frequency.value = EARPIECE.highCutHz;
        const pan = c.createStereoPanner();
        pan.pan.value = EARPIECE.pan;
        nodes.push(low, high, pan);
        tail = tail.connect(low).connect(high).connect(pan);
        gain.gain.value = volume * EARPIECE.gain;
      } else gain.gain.value = volume;
      tail.connect(analyser);
      tail.connect(gain).connect(c.destination);
      const detach = audioMouth.attach(clip.voice, analyserSource(analyser));
      const started = c.currentTime;
      let finished = false;
      const release = (stopSource: boolean) => {
        if (finished) return;
        finished = true; source.onended = null; detach(); playing.delete(stop);
        if (stopSource) { try { source.stop(); } catch { /* Already ended or never started. */ } }
        for (const node of nodes) { try { node.disconnect(); } catch { /* Already disconnected. */ } }
      };
      const stop = () => { release(true); };
      playing.add(stop);
      source.onended = () => { release(false); onended(); };
      try { source.start(); } catch (error) { release(false); throw error; }
      return { stop, elapsed: () => c.currentTime - started };
    },
  };
}

/** The engine the room uses: Gemini voices through the server when it is there, the browser's own otherwise. */
export function roomEngine(api: Pick<ArenaApi, "speak"> | null): RoomVoiceEngine {
  const browser = browserEngine();
  const port = api === null ? null : webAudioPort(api);
  const engine = port === null ? browser : createGeminiEngine(port, browser);
  let owner: object | null = null;
  return {
    activate() {
      if (owner !== null) throw new Error("Room engine already has a committed owner.");
      const release = port?.activate();
      const token = {}; owner = token;
      return () => {
        if (owner !== token) return;
        owner = null;
        try { engine.cancel(); } finally { release?.(); }
      };
    },
    speak(item, hooks) {
      if (owner === null) { hooks.onend(); return; }
      engine.speak(item, hooks);
    },
    cancel: engine.cancel,
  };
}
