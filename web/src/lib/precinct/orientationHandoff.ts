/** Explicit, memory-only handoff of earned preparation and its room owner into one new run. */
export interface OrientationContext {
  readonly caseId: string | null;
  readonly userId: string | null;
  readonly source: "idle" | "live" | "recording";
  readonly runKey: string | null;
}
export interface OrientationOffer {
  /** Keep only the call/seat owner across the accepted start; table/citations still reset per run. */
  readonly roomScope: string;
  readonly caseId: string;
  readonly userId: string | null;
  readonly briefed: boolean;
  readonly fileReviewed: boolean;
  readonly runKey: string | null;
}
export function createOrientationHandoff() {
  let snapshot: OrientationOffer | null = null;
  let sawLive = false;
  const listeners = new Set<() => void>();
  const publish = (next: OrientationOffer | null) => { snapshot = next; for (const listener of listeners) listener(); };
  const clear = () => { sawLive = false; if (snapshot !== null) publish(null); };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    clear,
    arm: (context: OrientationContext, progress: Pick<OrientationOffer, "briefed" | "fileReviewed">, roomScope: string) => {
      clear();
      if (context.source !== "idle" || context.caseId === null) return;
      publish({ ...progress, roomScope, caseId: context.caseId, userId: context.userId, runKey: null });
    },
    update: ({ caseId, userId, source, runKey }: OrientationContext) => {
      if (snapshot === null) return;
      if (caseId !== snapshot.caseId || userId !== snapshot.userId || source === "recording" || (source === "idle" && sawLive)) { clear(); return; }
      if (source !== "live") return;
      sawLive = true;
      // Starting/error is not a completed run. Keep the same explicit offer available for its retry.
      if (runKey === null) return;
      if (snapshot.runKey === null) publish({ ...snapshot, runKey });
      else if (snapshot.runKey !== runKey) clear();
    },
  };
}
export function applicableOrientationOffer(offer: OrientationOffer | null, context: OrientationContext) {
  return offer !== null && context.source === "live" && offer.caseId === context.caseId && offer.userId === context.userId && (offer.runKey === null || context.runKey === null || offer.runKey === context.runKey) ? offer : null;
}
