/** Optional local capture seam. No transport, reducer, mutable live-state reference, or error propagation. */
import type { DebriefRead, TrialFrame, TrialSnapshot } from "../contracts/generated/types";
import type { TrialView } from "./trialReducer";

export type SessionObservation =
  | { readonly type: "opening"; readonly snapshot: TrialSnapshot }
  | { readonly type: "frame"; readonly frame: TrialFrame }
  | { readonly type: "finding"; readonly operation: "submitted" | "failed" }
  | { readonly type: "terminal"; readonly equivalent: boolean }
  | { readonly type: "debrief"; readonly debrief: DebriefRead }
  | { readonly type: "unsupported"; readonly reason: "resync" | "disposition" }
  | { readonly type: "disposed" };
export interface SessionObserver {
  readonly observe: (event: SessionObservation) => void;
  readonly failed: () => void;
}
/** A throwing/mutating observer is detached, and never interferes with the live controller. */
export function isolatedSessionObserver(observer: SessionObserver | undefined): (event: SessionObservation) => void {
  let active = observer;
  return (event) => {
    if (active === undefined) return;
    try { active.observe(structuredClone(event)); }
    catch {
      const failed = active.failed;
      active = undefined;
      try { failed(); } catch { /* An observer failure cannot break a live session. */ }
    }
  };
}
/** JSON object key order is not public content. Array order and every value remain significant. */
function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, canonicalJsonValue(item)]));
  return value;
}
/** Compare validated public JSON content without treating object insertion order as a change. */
export function samePublicContent(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));
}
/** Snapshot compaction can erase readiness/commit provenance, but must add no unobserved public content. */
export function terminalMatches(before: TrialView | null, after: TrialView | null): boolean {
  if (before?.status !== "ended" || after?.status !== "ended") return false;
  const releasedBefore = new Set(before.released.map((record) => record.record_id));
  const retainedAfter = new Set(after.requestable.map((record) => record.record_id));
  // Only omit metadata for a release already observed on the live path. Retained records still compare
  // in full, so additions, changed metadata and unexplained removals cannot pass as compaction.
  const compactedBefore = before.requestable.filter((record) => !releasedBefore.has(record.record_id) || retainedAfter.has(record.record_id));
  const publicContent = (view: TrialView, requestable = view.requestable) => ({ status: view.status, serverStatus: view.serverStatus,
    reasonCode: view.reasonCode, mode: view.mode, channel: view.channel, split: view.split,
    exchangesUsed: view.exchangesUsed, exchangesCap: view.exchangesCap, transcriptVersion: view.transcriptVersion,
    turns: view.turns, voiceExchanges: view.voiceExchanges, released: view.released, requestable,
    cards: view.cards, rejectedCards: view.rejectedCards, pendingCards: view.pendingCards,
    updates: view.updates, coachFailures: view.coachFailures, coachReading: view.coachReading,
    runningFinding: view.runningFinding, finding: view.committedFinding?.finding ?? null,
    commitmentHash: view.commitmentHash, notices: view.notices });
  return before.lastSeq === after.lastSeq && before.contiguousSeq === before.lastSeq
    && samePublicContent(publicContent(before, compactedBefore), publicContent(after));
}
