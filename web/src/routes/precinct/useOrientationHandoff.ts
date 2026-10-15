import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { applicableOrientationOffer, createOrientationHandoff, type OrientationContext } from "../../lib/precinct/orientationHandoff";

export function useOrientationHandoff(context: OrientationContext) {
  const controller = useMemo(() => createOrientationHandoff(), []);
  const { caseId, userId, source, runKey } = context;
  useLayoutEffect(() => { controller.update({ caseId, userId, source, runKey }); }, [controller, caseId, userId, source, runKey]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return { controller, offer: applicableOrientationOffer(snapshot, context) };
}
