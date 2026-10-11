import { describe, expect, it } from "vitest";

import raw from "../../fixtures/recordings/F01-truthful.json";
import { parseRecording } from "./parseRecording";
import { detectionOf, ofText, questionReview } from "./debrief";
import { seek, startCursor } from "./recording";

describe("debrief data", () => {
  const result = parseRecording(structuredClone(raw));
  if (!result.ok) throw new Error("fixture");
  const rec = result.recording;
  const view = seek(rec, startCursor(rec), rec.durationMs).state.view;
  if (view === null) throw new Error("no view");

  it("lines up each question with the coach's reading, its suggestion and the question asked next", () => {
    const review = questionReview(view);
    expect(review.map((r) => r.turn)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(review[0]).toMatchObject({ questionType: "open", answerCategory: "responsive", suggested: review[1]?.question, askedNext: review[1]?.question });
    expect(review[0]?.flags).toEqual([{ kind: "gap", quote: "I left once it was running again." }]);
    expect(review.at(-1)?.askedNext).toBe(null);
    const noCards = questionReview({ ...view, cards: [] });
    expect(noCards[0]).toMatchObject({ questionType: null, suggested: null, flags: [], neutralityIssues: [] });
  });

  it("reads the detection scorecard as the document's own figures", () => {
    expect(detectionOf(rec.debrief ?? (null as never))?.unique_flags).toBe(2);
    expect(detectionOf({ ...(rec.debrief as object), scored: false } as never)).toBe(null);
    expect(ofText(1, 3)).toBe("1 of 3");
    expect(ofText(0, 0)).toBe("undefined");
  });
});
