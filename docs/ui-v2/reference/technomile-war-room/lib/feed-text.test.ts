import { describe, expect, it } from "vitest";

import { eventName, phaseLine } from "./feed-text";

describe("ticker wording", () => {
  it("names phase edges and the gate a finished phase parks at", () => {
    expect(phaseLine({ edge: "started", name: "prepare" })).toBe("Prepare phase started");
    expect(phaseLine({ edge: "started", name: "execute" })).toBe("Research phase started");
    expect(phaseLine({ edge: "finished", state: "awaiting_plan_approval" })).toBe("Phase finished: waiting for plan approval (H1)");
    expect(phaseLine({ edge: "finished", state: "awaiting_decision" })).toBe("Phase finished: waiting for the decision (H2)");
    expect(phaseLine({ edge: "finished", state: "awaiting_review" })).toBe("Phase finished: waiting for review (H2)");
    expect(phaseLine({ edge: "finished", state: "something_new" })).toBe("Phase finished: something new");
    expect(phaseLine({ edge: "failed", code: "vacuous_intake" })).toBe("Phase failed (vacuous_intake)");
  });

  it("shows a recorded event type as words, never its content", () => {
    expect(eventName("AGENT_MESSAGE")).toBe("Agent message");
    expect(eventName("FETCH")).toBe("Fetch");
    expect(eventName("_")).toBe("Event");
  });
});
