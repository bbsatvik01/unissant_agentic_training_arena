/**
 * One honest line about the view's recovery state, read only from the store's own recovery
 * fields: a view is called re-synced only after a snapshot was actually applied.
 */
import type { WarRoomStore } from "./state";

export interface RecoveryLine {
  tone: "warning" | "info";
  text: string;
}

type RecoveryFields = Pick<WarRoomStore, "needsResync" | "pendingResync" | "resyncFailures" | "resyncs" | "gaps" | "rejectedPatches">;

export function recoveryLine(s: RecoveryFields): RecoveryLine | null {
  const cause = s.gaps.length > 0 ? `${s.gaps.length} sequence gap(s)` : s.rejectedPatches > 0 ? `${s.rejectedPatches} rejected update(s)` : "a rejected frame";
  if (s.needsResync) {
    if (s.pendingResync !== null) return { tone: "warning", text: `View out of step after ${cause}: requesting a server snapshot` };
    if (s.resyncFailures > 0) return { tone: "warning", text: `View out of step after ${cause}: snapshot request failed ${s.resyncFailures} time(s), retrying` };
    return { tone: "warning", text: `View out of step after ${cause}: waiting to re-sync` };
  }
  if (s.resyncs > 0) return { tone: "info", text: `View re-synced from the server snapshot ${s.resyncs === 1 ? "once" : `${s.resyncs} times`} after ${cause}` };
  if (s.rejectedPatches > 0) return { tone: "warning", text: `${s.rejectedPatches} off-contract update(s) dropped` };
  return null;
}
