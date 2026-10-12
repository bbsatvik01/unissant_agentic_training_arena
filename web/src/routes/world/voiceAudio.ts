/**
 * The voice session's audio layer (S6 6.2; lift target: gokbase `audioController.ts`): two contexts, 16 kHz capture
 * and 24 kHz playback, same-origin worklets (`public/worklets/`), a barge-in flush and RMS taps. The subject's level
 * is read from the playback path only (one analyser after the playback worklet), so a flush stops audio, ring and
 * mouth on the same frame. Playback progress stays in the page (D7).
 */

import { PlaybackLedger, type PlaybackReport } from "../../lib/voice/playbackLedger";

export interface VoiceAudioHooks {
  /** One 100 ms PCM16 frame from the microphone, with its RMS level. */
  readonly onFrame: (pcm: ArrayBuffer, level: number) => void;
  /** The utterance now audible, or null when the playback queue ran empty (or was flushed). */
  readonly onPlayback: (utterance: number | null) => void;
}

export interface VoiceAudio {
  /** Queue one PCM16 24 kHz chunk of `utterance`. */
  readonly play: (utterance: number, pcm: ArrayBuffer) => void;
  /** Drop every queued sample at once (barge-in, interruption, any close but the cap). */
  readonly flush: () => void;
  /** Whether a chunk is queued or playing. */
  readonly busy: () => boolean;
  /** The subject's playback amplitude now (0-1). */
  readonly playbackLevel: () => number;
  /** The microphone's level from the last frame (0-1). */
  readonly micLevel: () => number;
  /** Stop the microphone (capture ends, playback goes on). */
  readonly stopCapture: () => void;
  /** Stop everything. */
  readonly close: () => void;
}

export class MicrophoneRefusedError extends Error {}

function rms(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (const s of buffer) sum += s * s;
  return Math.sqrt(sum / buffer.length);
}

/** Open the microphone (the browser asks for permission here, after the consent screen) and both contexts. */
export async function openVoiceAudio(hooks: VoiceAudioHooks): Promise<VoiceAudio> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    throw new MicrophoneRefusedError("The microphone is not available.");
  }
  const capture = new AudioContext({ sampleRate: 16_000 });
  const playback = new AudioContext({ sampleRate: 24_000 });
  await Promise.all([capture.audioWorklet.addModule("/worklets/capture-processor.js"), playback.audioWorklet.addModule("/worklets/playback-processor.js")]);
  // Chrome may start a context suspended until a gesture; the consent click was one.
  await Promise.all([capture.resume(), playback.resume()]);

  let micLevel = 0;
  const source = capture.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(capture, "arena-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const mute = capture.createGain();
  mute.gain.value = 0;
  source.connect(tap).connect(mute).connect(capture.destination);
  tap.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
    micLevel = e.data.level;
    hooks.onFrame(e.data.pcm, e.data.level);
  };

  const player = new AudioWorkletNode(playback, "arena-playback", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
  const analyser = playback.createAnalyser();
  analyser.fftSize = 512;
  const samples = new Float32Array(analyser.fftSize);
  player.connect(analyser).connect(playback.destination);
  const ledger = new PlaybackLedger();
  player.port.onmessage = (e: MessageEvent<PlaybackReport>) => {
    const audible = ledger.report(e.data);
    if (audible !== undefined) hooks.onPlayback(audible);
  };

  let captureOn = true;
  const stopCapture = () => {
    if (!captureOn) return;
    captureOn = false;
    tap.port.onmessage = null;
    micLevel = 0;
    for (const track of stream.getTracks()) track.stop();
    void capture.close().catch(() => undefined);
  };
  return {
    play(utterance, pcm) {
      const ints = new Int16Array(pcm);
      const floats = new Float32Array(ints.length);
      for (let i = 0; i < ints.length; i += 1) floats[i] = (ints[i] ?? 0) / 0x8000;
      ledger.post();
      player.port.postMessage({ type: "chunk", utterance, samples: floats }, [floats.buffer]);
    },
    flush() {
      player.port.postMessage({ type: "flush" });
    },
    busy: () => ledger.busy,
    playbackLevel: () => rms(analyser, samples),
    micLevel: () => micLevel,
    stopCapture,
    close() {
      stopCapture();
      player.port.onmessage = null;
      void playback.close().catch(() => undefined);
    },
  };
}
