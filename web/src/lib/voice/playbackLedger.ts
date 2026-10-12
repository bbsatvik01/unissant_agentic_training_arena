/**
 * Playback reports reconciled with what the page queued (S6 6.2). The playback worklet reports, with every message,
 * how many chunks it has consumed (played to the end or flushed). A `drained` report counts only when the worklet has
 * consumed every chunk the page posted: a report posted before a newer chunk reached the worklet is stale, and
 * acting on it would end a 4410 drain while the final answer is still playing.
 */
export type PlaybackReport = { readonly type: "playing"; readonly utterance: number; readonly consumed: number } | { readonly type: "drained"; readonly consumed: number };

export class PlaybackLedger {
  private posted = 0;
  private consumed = 0;

  /** The page queued one more chunk. */
  post(): void {
    this.posted += 1;
  }

  /** The playback event a report means: the utterance now audible, null when everything queued has played, or
   * undefined for a stale report the page ignores. */
  report(r: PlaybackReport): number | null | undefined {
    this.consumed = Math.max(this.consumed, r.consumed);
    if (r.type === "playing") return r.utterance;
    return this.consumed >= this.posted ? null : undefined;
  }

  /** Chunks are queued or playing. */
  get busy(): boolean {
    return this.consumed < this.posted;
  }
}
