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
  /** The analyser after the playback worklet (the subject's lips, `audioMouth`) and the microphone's (the
   * investigator's lips). */
  readonly playbackAnalyser: AnalyserNode;
  readonly micAnalyser: AnalyserNode;
  /** Stop the microphone (capture ends, playback goes on). */
  readonly stopCapture: () => void;
  /** Stop everything. */
  readonly close: () => void;
}

export class MicrophoneRefusedError extends Error {}

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
  // Ownership begins immediately after getUserMedia resolves. Every subsequent failure releases it.
  let capture: AudioContext | null = null;
  let playback: AudioContext | null = null;
  let tap: AudioWorkletNode | null = null;
  let player: AudioWorkletNode | null = null;
  const captureNodes: AudioNode[] = [];
  const playbackNodes: AudioNode[] = [];
  let captureOn = true;
  let closed = false;
  const closeContext = (context: AudioContext | null) => {
    try { if (context !== null) void context.close().catch(() => undefined); }
    catch { /* Continue releasing other resources even if a partial context rejects close. */ }
  };
  const disconnect = (nodes: readonly AudioNode[]) => {
    for (const node of nodes) { try { node.disconnect(); } catch { /* Already detached. */ } }
  };
  const closePort = (node: AudioWorkletNode | null) => {
    if (node === null) return;
    node.port.onmessage = null;
    try { node.port.close(); } catch { /* Continue releasing the context. */ }
  };
  const stopCapture = () => {
    if (!captureOn) return;
    captureOn = false;
    // End permission-bearing capture first, even when a later node/port/context cleanup fails.
    for (const track of stream.getTracks()) { try { track.stop(); } catch { /* Stop every track. */ } }
    closePort(tap); disconnect(captureNodes); closeContext(capture);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    stopCapture(); closePort(player); disconnect(playbackNodes); closeContext(playback);
  };
  try {
    capture = new AudioContext({ sampleRate: 16_000 });
    playback = new AudioContext({ sampleRate: 24_000 });
    await Promise.all([capture.audioWorklet.addModule("/worklets/capture-processor.js"), playback.audioWorklet.addModule("/worklets/playback-processor.js")]);
    await Promise.all([capture.resume(), playback.resume()]);
    const source = capture.createMediaStreamSource(stream); captureNodes.push(source);
    const micAnalyser = capture.createAnalyser(); captureNodes.push(micAnalyser);
    micAnalyser.fftSize = 512;
    source.connect(micAnalyser);
    const captureTap = new AudioWorkletNode(capture, "arena-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    tap = captureTap; captureNodes.push(captureTap);
    const mute = capture.createGain(); captureNodes.push(mute);
    mute.gain.value = 0;
    source.connect(captureTap).connect(mute).connect(capture.destination);
    captureTap.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
      if (captureOn) hooks.onFrame(e.data.pcm, e.data.level);
    };
    const playbackPlayer = new AudioWorkletNode(playback, "arena-playback", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    player = playbackPlayer; playbackNodes.push(playbackPlayer);
    const analyser = playback.createAnalyser(); playbackNodes.push(analyser);
    analyser.fftSize = 512;
    playbackPlayer.connect(analyser).connect(playback.destination);
    const ledger = new PlaybackLedger();
    playbackPlayer.port.onmessage = (e: MessageEvent<PlaybackReport>) => {
      if (closed) return;
      const audible = ledger.report(e.data);
      if (audible !== undefined) hooks.onPlayback(audible);
    };
    return {
      play(utterance, pcm) {
        if (closed) return;
        const ints = new Int16Array(pcm);
        const floats = new Float32Array(ints.length);
        for (let i = 0; i < ints.length; i += 1) floats[i] = (ints[i] ?? 0) / 0x8000;
        ledger.post();
        playbackPlayer.port.postMessage({ type: "chunk", utterance, samples: floats }, [floats.buffer]);
      },
      flush() { if (!closed) playbackPlayer.port.postMessage({ type: "flush" }); },
      busy: () => !closed && ledger.busy,
      playbackAnalyser: analyser,
      micAnalyser,
      stopCapture,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
