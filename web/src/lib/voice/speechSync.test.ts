import { describe, expect, it } from "vitest";

import { speechDurationMs } from "../world/cadence";
import { timeAtChar } from "../world/visemes";
import { createSpeechSync } from "./speechSync";

const line = { turn: 2, text: "I was at the depot until nine.", startedAt: 1000 };

describe("speechSync", () => {
  it("keeps the text cadence for a line the voice has not reported", () => {
    expect(createSpeechSync().elapsedFor(line, 1600)).toBe(600);
  });

  it("follows the voice: a late start holds the mouth at the start until the voice begins", () => {
    const sync = createSpeechSync();
    sync.at(line, 0, 1400);
    expect(sync.elapsedFor(line, 1500)).toBe(100);
  });

  it("re-anchors on each word boundary and runs on from it", () => {
    const sync = createSpeechSync();
    sync.at(line, 0, 1000);
    const word = line.text.indexOf("depot");
    sync.at(line, word, 3000);
    expect(sync.elapsedFor(line, 3050)).toBeCloseTo(timeAtChar(line.text, word) + 50, 6);
  });

  it("never runs past the line's end while the voice is going, and closes when the voice ends", () => {
    const sync = createSpeechSync();
    const d = speechDurationMs(line.text);
    sync.at(line, 0, 1000);
    expect(sync.elapsedFor(line, 1000 + d + 5000)).toBe(d - 1);
    sync.end(line, 1500);
    expect(sync.elapsedFor(line, 1600)).toBe(d);
    sync.at(line, 3, 1700);
    expect(sync.elapsedFor(line, 1800)).toBe(d);
  });

  it("forgets every report on clear, and keeps lines apart", () => {
    const sync = createSpeechSync();
    sync.end(line, 1500);
    expect(sync.elapsedFor({ ...line, turn: 3 }, 1600)).toBe(600);
    sync.clear();
    expect(sync.elapsedFor(line, 1600)).toBe(600);
  });
});
