/** Exact authored speech, finite WAVs, one owner. No device voice, model, mic, storage or text timing. */
import { readLocalStaffAudio } from "../api/localStaffAudio";
import { analyserSource, audioMouth } from "../world/audioLips";
import { localStaffPlaybackActivity, type createLocalStaffPlaybackActivity } from "./localStaffPlaybackActivity";
import manifest from "./localStaffVoiceManifest.json";

export interface LocalStaffClip {
  readonly id: string;
  readonly voice_id: string;
  readonly text: string;
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly duration_seconds: number;
}
export type LocalStaffVoiceStatus = "idle" | "loading" | "speaking" | "unavailable" | "error";
export interface LocalStaffPlayback { readonly stop: () => void; readonly setMuted: (muted: boolean) => void }
export const LOCAL_SPEECH_STARTED = "arena-local-speech-started";
export const LOCAL_STAFF_CLIPS: readonly LocalStaffClip[] = manifest.clips;
export function findLocalStaffClip(voice: string, text: string): LocalStaffClip | undefined {
  return LOCAL_STAFF_CLIPS.find((clip) => clip.voice_id === voice && clip.text === text);
}

export function createLocalStaffPlayer(deps: {
  readonly context: () => AudioContext;
  readonly read: typeof readLocalStaffAudio;
  readonly attach: typeof audioMouth.attach;
  readonly activity?: ReturnType<typeof createLocalStaffPlaybackActivity>;
} = { context: () => new AudioContext(), read: readLocalStaffAudio, attach: audioMouth.attach }) {
  let current: LocalStaffPlayback | null = null;
  const activity = deps.activity ?? localStaffPlaybackActivity;
  return {
    play(clip: LocalStaffClip | undefined, onStatus: (status: LocalStaffVoiceStatus) => void): LocalStaffPlayback {
      current?.stop();
      const abort = new AbortController();
      let context: AudioContext | null = null;
      let source: AudioBufferSourceNode | null = null;
      let gain: GainNode | null = null;
      let analyser: AnalyserNode | null = null;
      let detach: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let finished = false;
      let muted = false;
      let started = false;
      const isFinished = () => finished;
      const isMuted = () => muted;
      const clearDeadline = () => { if (timer !== null) clearTimeout(timer); timer = null; };
      const disconnect = (node: AudioNode | null) => { try { node?.disconnect(); } catch { /* Already disconnected. */ } };
      const finish = (status: LocalStaffVoiceStatus) => {
        if (finished) return;
        finished = true;
        abort.abort();
        clearDeadline();
        detach?.(); detach = null;
        activity.set(false);
        if (source !== null) { source.onended = null; try { source.stop(); } catch { /* Not started or already ended. */ } disconnect(source); }
        disconnect(gain); disconnect(analyser);
        try { if (context !== null) { context.onstatechange = null; void context.close().catch(() => undefined); } } catch { /* Partially initialized context. */ }
        if (current === handle) current = null;
        onStatus(status);
      };
      const handle: LocalStaffPlayback = {
        stop: () => { finish("idle"); },
        setMuted(value) {
          if (finished) return;
          muted = value;
          if (gain !== null) gain.gain.value = isMuted() ? 0 : 1;
          detach?.(); detach = null;
          if (!muted && started && analyser !== null && clip !== undefined) detach = deps.attach(clip.voice_id, analyserSource(analyser));
          activity.set(started && !muted);
        },
      };
      current = handle;
      if (clip === undefined) { finish("unavailable"); return handle; }
      onStatus("loading");
      // Context creation and resume occur during the explicit click, before any fetch await.
      try {
        context = deps.context();
        const c = context;
        const resume = c.resume();
        c.onstatechange = () => { if (source !== null && c.state !== "running") finish("error"); };
        timer = setTimeout(() => { finish("error"); }, 10_000);
        void (async () => {
          try {
            const [bytes] = await Promise.all([deps.read(clip, abort.signal), resume]);
            if (isFinished()) return;
            if (c.state !== "running") throw new Error("Audio output is blocked.");
            const buffer = await c.decodeAudioData(bytes);
            if (isFinished()) return;
            if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > 60 || Math.abs(buffer.duration - clip.duration_seconds) > 0.05) throw new Error("Unexpected local voice duration.");
            source = c.createBufferSource(); source.buffer = buffer;
            gain = c.createGain(); gain.gain.value = isMuted() ? 0 : 1;
            analyser = c.createAnalyser(); analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.5;
            // The actual post-gain output drives the existing mouth registry.
            source.connect(gain).connect(analyser).connect(c.destination);
            source.onended = () => { finish("idle"); };
            source.start(); started = true;
            if (!isMuted()) detach = deps.attach(clip.voice_id, analyserSource(analyser));
            clearDeadline();
            activity.set(!isMuted());
            onStatus("speaking");
          } catch { finish("error"); }
        })();
      } catch { finish("error"); }
      return handle;
    },
    stop() { current?.stop(); },
  };
}
export const localStaffPlayer = createLocalStaffPlayer();
