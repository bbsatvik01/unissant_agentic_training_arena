import type { PrecinctWorldId } from "./sceneSelection";

/** A small local capability. Unmounted scenes cannot report readiness or append late samples. */
export function createSceneReadiness(id: PrecinctWorldId) {
  let active = false;
  let ready = false;
  let unavailable = false;
  return { id,
    activate: () => { active = true; },
    expire: () => { active = false; ready = false; },
    markReady: (): boolean => { if (!active || unavailable) return false; ready = true; return true; },
    markUnavailable: (): boolean => { if (!active) return false; unavailable = true; ready = false; return true; },
    isActive: (): boolean => active,
    isReady: (): boolean => active && ready,
  };
}

/** Child error-boundary commit callbacks can precede the parent's mount effect.
 * Retry once after that commit, while retaining the same scene's expiry guard. */
export function reportSceneUnavailable(scene: ReturnType<typeof createSceneReadiness>, notify: () => void): void {
  const report = () => { if (scene.markUnavailable()) notify(); };
  if (scene.isActive()) report();
  else queueMicrotask(report);
}
