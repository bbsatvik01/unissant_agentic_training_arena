import { describe, expect, it } from "vitest";

import { PlaybackLedger } from "./playbackLedger";

describe("PlaybackLedger", () => {
  it("ignores a drained report posted before a newer chunk reached the worklet", () => {
    const ledger = new PlaybackLedger();
    ledger.post();
    expect(ledger.report({ type: "playing", utterance: 1, consumed: 0 })).toBe(1);
    ledger.post(); // the final chunk is queued while the worklet's drained report for the first is in flight
    expect(ledger.report({ type: "drained", consumed: 1 })).toBe(undefined);
    expect(ledger.busy).toBe(true);
    expect(ledger.report({ type: "playing", utterance: 1, consumed: 1 })).toBe(1);
    expect(ledger.report({ type: "drained", consumed: 2 })).toBe(null);
    expect(ledger.busy).toBe(false);
  });

  it("counts a flush as consumed and never moves its count backwards", () => {
    const ledger = new PlaybackLedger();
    ledger.post();
    ledger.post();
    expect(ledger.report({ type: "drained", consumed: 2 })).toBe(null);
    expect(ledger.report({ type: "drained", consumed: 1 })).toBe(null);
  });
});
