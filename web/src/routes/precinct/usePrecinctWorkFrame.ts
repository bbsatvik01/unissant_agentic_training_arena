import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { createWorkFrameSampler, type WorkFrameSampleInput } from "../../lib/precinct/workFrameSampler";

/** The scene's existing 10 Hz camera cadence calls sample. Flat mode needs no decorative timer. */
export function usePrecinctWorkFrame(scope: string, input: WorkFrameSampleInput) {
  const { controller } = useMemo(() => ({ scope, controller: createWorkFrameSampler() }), [scope]);
  const { view, arrivals, clock, paused, reducedMotion, referee, assessment, recorded } = input;
  useLayoutEffect(() => {
    controller.configure({ view, arrivals, clock, paused, reducedMotion, ...(referee === undefined ? {} : { referee }), assessment, recorded });
  }, [controller, view, arrivals, clock, paused, reducedMotion, referee, assessment, recorded]);
  const frame = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return { frame, sample: controller.sample };
}
