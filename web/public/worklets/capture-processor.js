/* global AudioWorkletProcessor, registerProcessor */
/**
 * Microphone capture for the voice relay (S5 7.3; lift target: gokbase G11/G13). Runs in a 16 kHz AudioContext and
 * posts 100 ms frames of PCM16 little-endian mono (1,600 samples, 3,200 bytes) with the frame's RMS level, so the
 * page can send at most ten frames a second and drive its capture edges and input meter.
 */
const FRAME = 1600;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(FRAME);
    this.filled = 0;
    this.sumSquares = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i += 1) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.filled] = s < 0 ? s * 0x8000 : s * 0x7fff;
      this.sumSquares += s * s;
      this.filled += 1;
      if (this.filled === FRAME) {
        const pcm = this.buffer.buffer.slice(0);
        this.port.postMessage({ pcm, level: Math.sqrt(this.sumSquares / FRAME) }, [pcm]);
        this.filled = 0;
        this.sumSquares = 0;
      }
    }
    return true;
  }
}

registerProcessor("arena-capture", CaptureProcessor);
