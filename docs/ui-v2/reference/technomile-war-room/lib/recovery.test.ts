import { describe, expect, it } from "vitest";

import { recoveryLine } from "./recovery";

const base = { needsResync: false, pendingResync: null, resyncFailures: 0, resyncs: 0, gaps: [] as { after: number; got: number }[], rejectedPatches: 0 };
const gap = [{ after: 2, got: 5 }];

describe("recoveryLine", () => {
  it("is silent when nothing went wrong", () => {
    expect(recoveryLine(base)).toBeNull();
  });

  it("never claims a re-sync before a snapshot was applied", () => {
    expect(recoveryLine({ ...base, needsResync: true, gaps: gap })?.text).toBe("View out of step after 1 sequence gap(s): waiting to re-sync");
    expect(recoveryLine({ ...base, needsResync: true, gaps: gap, pendingResync: 5 })?.text).toContain("requesting a server snapshot");
    const failed = recoveryLine({ ...base, needsResync: true, gaps: gap, resyncFailures: 2 });
    expect(failed).toEqual({ tone: "warning", text: "View out of step after 1 sequence gap(s): snapshot request failed 2 time(s), retrying" });
    for (const l of [failed, recoveryLine({ ...base, needsResync: true, gaps: gap })]) expect(l?.text).not.toContain("re-synced");
  });

  it("reports a completed re-sync with its cause", () => {
    expect(recoveryLine({ ...base, resyncs: 1, gaps: gap })).toEqual({ tone: "info", text: "View re-synced from the server snapshot once after 1 sequence gap(s)" });
    expect(recoveryLine({ ...base, resyncs: 3, rejectedPatches: 2 })?.text).toBe("View re-synced from the server snapshot 3 times after 2 rejected update(s)");
    expect(recoveryLine({ ...base, resyncs: 1 })?.text).toContain("after a rejected frame");
  });

  it("warns about dropped updates even without a gap", () => {
    expect(recoveryLine({ ...base, rejectedPatches: 1 })).toEqual({ tone: "warning", text: "1 off-contract update(s) dropped" });
    expect(recoveryLine({ ...base, needsResync: true, rejectedPatches: 1 })?.text).toContain("1 rejected update(s)");
  });
});
