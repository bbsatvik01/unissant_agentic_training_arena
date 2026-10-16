import { useEffect, useRef } from "react";
import type { ActorCapture } from "../../lib/precinct/proceduralActors";
import { createActorSampler } from "./actorSamples";

export function useActorSampler(capture: ActorCapture | undefined, actorId: string) {
  const sampler = useRef<ReturnType<typeof createActorSampler> | null>(null);
  const callback = capture?.onActorSample;
  const scope = capture?.scope;
  useEffect(() => {
    if (callback === undefined || scope === undefined) return;
    const current = createActorSampler({ scope, onActorSample: callback }, actorId);
    sampler.current = current;
    return () => { current.close(); if (sampler.current === current) sampler.current = null; };
  }, [callback, scope, actorId]);
  return sampler;
}
