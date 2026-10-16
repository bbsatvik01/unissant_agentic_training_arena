import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { precinctDpr, PrecinctQualityWindow } from "../../lib/precinct/renderQuality";
import type { Tier } from "../../lib/world/quality";

export function precinctDiagnosticsEnabled(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("precinctPerf") === "1";
}

/** The benchmark may hold a tier, but ordinary production sessions still adapt. */
function pinnedForDiagnostics(): boolean {
  return precinctDiagnosticsEnabled() && new URLSearchParams(window.location.search).get("precinctPerfPinned") === "1";
}

/** Canvas occupies the viewport; using that envelope also bounds a smaller embedded canvas.
 * Keep DPR in Canvas props so R3F reconfiguration cannot overwrite a child setDpr call. */
function subscribeViewport(listener: () => void): () => void {
  window.addEventListener("resize", listener);
  let query = typeof window.matchMedia === "function" ? window.matchMedia(`(resolution: ${String(window.devicePixelRatio)}dppx)`) : null;
  const changed = () => {
    query?.removeEventListener("change", changed);
    query = window.matchMedia(`(resolution: ${String(window.devicePixelRatio)}dppx)`);
    query.addEventListener("change", changed); listener();
  };
  query?.addEventListener("change", changed);
  return () => { window.removeEventListener("resize", listener); query?.removeEventListener("change", changed); };
}

export function usePrecinctDpr(tier: Tier): number {
  const snapshot = useCallback(() => precinctDpr(tier, window.devicePixelRatio, window.innerWidth, window.innerHeight), [tier]);
  const server = useCallback(() => precinctDpr(tier, 1, 1440, 900), [tier]);
  return useSyncExternalStore(subscribeViewport, snapshot, server);
}

export function PrecinctRenderPolicy({ tier, continuous, onChange }: {
  readonly tier: Tier; readonly continuous: boolean; readonly onChange: (tier: Tier) => void;
}) {
  const get = useThree((state) => state.get);
  const samples = useRef(new PrecinctQualityWindow());
  const pinned = useMemo(() => pinnedForDiagnostics(), []);
  useEffect(() => {
    const reset = () => { samples.current.sample(performance.now(), tier, continuous, !document.hidden); };
    reset(); document.addEventListener("visibilitychange", reset);
    return () => { document.removeEventListener("visibilitychange", reset); };
  }, [tier, continuous]);
  useEffect(() => {
    if (pinned) return;
    const context = get().gl.getContext(), debug = context.getExtension("WEBGL_debug_renderer_info");
    const renderer: unknown = debug === null ? "" : context.getParameter(debug.UNMASKED_RENDERER_WEBGL);
    if (typeof renderer === "string" && /swiftshader|llvmpipe|softpipe|software/i.test(renderer) && tier !== "low") onChange("low");
  }, [get, onChange, tier, pinned]);
  useFrame(() => {
    if (pinned) return;
    const next = samples.current.sample(performance.now(), tier, continuous, !document.hidden);
    if (next !== tier) onChange(next);
  });
  return null;
}
