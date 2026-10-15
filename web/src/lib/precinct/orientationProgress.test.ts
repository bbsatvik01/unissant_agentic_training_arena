import { describe, expect, it } from "vitest";
import { orientationProgress, type OrientationInput } from "./orientationProgress";
const initial: OrientationInput = { checkedIn: false, briefed: false, fileReviewed: false, source: "idle", running: false, hasView: false, atInterviewCap: false, findingCommitted: false, debriefPublished: false };
const prepared = { ...initial, checkedIn: true, briefed: true, fileReviewed: true };
const live = { ...prepared, source: "live" as const, running: true, hasView: true };
describe("authoritative local orientation milestones", () => {
  it("preserves explicit scoped check-in, briefing and file review in order", () => {
    expect(orientationProgress(initial)).toMatchObject({ completed: 0, title: "Check in at reception" });
    expect(orientationProgress({ ...initial, checkedIn: true })).toMatchObject({ completed: 1, title: "Meet your training sergeant" });
    expect(orientationProgress({ ...prepared, fileReviewed: false })).toMatchObject({ completed: 2, title: "Read your case file" });
    expect(orientationProgress(prepared)).toMatchObject({ completed: 3, title: "Prepare your interview" });
    expect(orientationProgress({ ...initial, fileReviewed: true })).toMatchObject({ completed: 0 });
  });
  it("distinguishes an actual interview, cap, closed finding and published debrief", () => {
    expect(orientationProgress(live)).toMatchObject({ completed: 3, title: "Conduct your interview" });
    expect(orientationProgress({ ...live, atInterviewCap: true })).toMatchObject({ completed: 4, title: "Make a supported finding" });
    expect(orientationProgress({ ...live, findingCommitted: true })).toMatchObject({ completed: 5, title: "Finding committed" });
    expect(orientationProgress({ ...live, findingCommitted: true, debriefPublished: true })).toMatchObject({ completed: 6, title: "Review your published debrief" });
    expect(orientationProgress({ ...live, debriefPublished: true })).toMatchObject({ completed: 3 });
  });
  it("awards nothing for a pending start, a missing view, or browsing a completed recording", () => {
    expect(orientationProgress({ ...live, running: false, findingCommitted: true, debriefPublished: true })).toMatchObject({ completed: 3 });
    expect(orientationProgress({ ...live, hasView: false, atInterviewCap: true })).toMatchObject({ completed: 3 });
    expect(orientationProgress({ ...live, source: "recording", findingCommitted: true, debriefPublished: true })).toMatchObject({ completed: 3, title: "Review the saved interview" });
    expect(orientationProgress({ ...initial, source: "recording", hasView: true, findingCommitted: true, debriefPublished: true })).toMatchObject({ completed: 0 });
  });
});
