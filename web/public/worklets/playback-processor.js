/* global AudioWorkletProcessor, registerProcessor */
/**
 * Subject audio playback for the voice relay (S5 7.3; lift target: gokbase G13). Runs in a 24 kHz AudioContext.
 * The page posts `{type: "chunk", utterance, samples}` (Float32) and `{type: "flush"}`; the worklet plays chunks in
 * order and reports `{type: "playing", utterance}` when an utterance becomes audible and `{type: "drained"}` when its
 * queue runs empty. Playback progress stays in the page (D7): nothing here is sent to the server.
 */
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.audible = null;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "chunk") this.queue.push(m);
      else if (m.type === "flush") {
        this.queue = [];
        this.offset = 0;
        if (this.audible !== null) {
          this.audible = null;
          this.port.postMessage({ type: "drained" });
        }
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    let i = 0;
    while (i < out.length && this.queue.length > 0) {
      const head = this.queue[0];
      if (this.audible !== head.utterance) {
        this.audible = head.utterance;
        this.port.postMessage({ type: "playing", utterance: head.utterance });
      }
      const n = Math.min(out.length - i, head.samples.length - this.offset);
      out.set(head.samples.subarray(this.offset, this.offset + n), i);
      i += n;
      this.offset += n;
      if (this.offset >= head.samples.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    if (i < out.length) out.fill(0, i);
    if (this.queue.length === 0 && this.audible !== null) {
      this.audible = null;
      this.port.postMessage({ type: "drained" });
    }
    return true;
  }
}

registerProcessor("arena-playback", PlaybackProcessor);
