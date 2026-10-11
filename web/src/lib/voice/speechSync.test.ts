import { describe, expect, it } from "vitest";

import { speechDurationMs } from "../world/cadence";
import { timeAtChar } from "../world/visemes";
import { createSpeechSync, QUEUE_GIVE_UP_MS } from "./speechSync";

const line = { turn: 2, text: "I was at the depot until nine.", startedAt: 1000 };

describe("speechSync", () => {
  it("keeps the text cadence for a line the voice has not reported", () => {
    const sync = createSpeechSync();
    expect(sync.elapsedFor(line, 1600)).toBe(600);
    expect(sync.activeFor(line, 1600)).toBe(null);
  });

  it("holds the mouth closed while the voice waits in the queue, and keeps the line on stage", () => {
    const sync = createSpeechSync();
    sync.queue(line, 1000, sync.epoch());
    expect(sync.elapsedFor(line, 4000)).toBeLessThan(0);
    expect(sync.activeFor(line, 4000)).toBe(true);
    // A voice that never starts falls back to the cadence.
    expect(sync.activeFor(line, 1000 + QUEUE_GIVE_UP_MS + 1)).toBe(null);
  });

  it("follows the voice: a late start holds the mouth at the start until the voice begins", () => {
    const sync = createSpeechSync();
    sync.queue(line, 1000, sync.epoch());
    sync.at(line, 0, 1400, sync.epoch());
    expect(sync.elapsedFor(line, 1500)).toBe(100);
  });

  it("re-anchors on each word boundary and runs on from it", () => {
    const sync = createSpeechSync();
    sync.at(line, 0, 1000, sync.epoch());
    const word = line.text.indexOf("depot");
    sync.at(line, word, 3000, sync.epoch());
    expect(sync.elapsedFor(line, 3050)).toBeCloseTo(timeAtChar(line.text, word) + 50, 6);
  });

  it("keeps a speaking line on stage past its cadence, never runs past its end, and closes when the voice ends", () => {
    const sync = createSpeechSync();
    const d = speechDurationMs(line.text);
    sync.at(line, 0, 1000, sync.epoch());
    expect(sync.elapsedFor(line, 1000 + d + 5000)).toBe(d - 1);
    expect(sync.activeFor(line, 1000 + d + 5000)).toBe(true);
    sync.end(line, sync.epoch());
    expect(sync.elapsedFor(line, 1600)).toBe(d);
    expect(sync.activeFor(line, 1600)).toBe(false);
    sync.at(line, 3, 1700, sync.epoch());
    expect(sync.elapsedFor(line, 1800)).toBe(d);
  });

  it("forgets every report on clear and ignores late reports from before it", () => {
    const sync = createSpeechSync();
    const old = sync.epoch();
    sync.end(line, old);
    expect(sync.elapsedFor({ ...line, turn: 3 }, 1600)).toBe(600);
    sync.clear();
    expect(sync.elapsedFor(line, 1600)).toBe(600);
    // A cancelled utterance's callbacks arrive after the clear: ignored.
    sync.end(line, old);
    sync.queue(line, 1000, old);
    sync.at(line, 4, 1100, old);
    expect(sync.activeFor(line, 1600)).toBe(null);
  });
});
