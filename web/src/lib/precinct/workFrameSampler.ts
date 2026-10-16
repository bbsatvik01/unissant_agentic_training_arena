/** Samples one existing canonical clock. No clock advancement, timer, event folding or network. */
import type { RefObject } from "react";
import { deriveAgentWork, type WorkFrame, type WorkInput } from "../agent-work/model";
import { observationWork } from "./observationScreens";

export interface WorkFrameSampleInput extends Omit<WorkInput, "nowMs"> {
  readonly clock: RefObject<number>;
  readonly assessment: boolean;
  readonly recorded: boolean;
}

export function createWorkFrameSampler() {
  let input: WorkFrameSampleInput | null = null;
  let sampledTime = 0;
  let snapshot = deriveAgentWork({ view: null, arrivals: new Map(), nowMs: 0, paused: true, reducedMotion: true });
  let key = JSON.stringify(snapshot);
  const listeners = new Set<() => void>();
  const publish = (next: WorkFrame) => {
    const nextKey = JSON.stringify(next);
    if (nextKey === key) return;
    snapshot = next; key = nextKey;
    for (const listener of listeners) listener();
  };
  const project = () => {
    if (input === null) return;
    publish(observationWork(deriveAgentWork({ view: input.view, arrivals: input.arrivals, nowMs: sampledTime, paused: input.paused, reducedMotion: input.reducedMotion, ...(input.referee === undefined ? {} : { referee: input.referee }) }), input.assessment));
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    configure: (next: WorkFrameSampleInput) => {
      // A live global pause holds decorative geometry; public state may continue arriving.
      // Recorded event/seek updates always use their exact cursor, even while paused.
      if (input === null || !next.paused || !input.paused || next.recorded) sampledTime = next.clock.current;
      input = next; project();
    },
    sample: (explicitSeek = false) => {
      if (input === null || (input.paused && !explicitSeek)) return;
      sampledTime = input.clock.current;
      project();
    },
  };
}
