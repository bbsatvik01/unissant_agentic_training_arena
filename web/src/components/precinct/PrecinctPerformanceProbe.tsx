import { addAfterEffect, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { PrecinctFrameMeasurements } from "../../lib/precinct/renderMeasurements";
import { PRECINCT_RENDER_BUDGET } from "../../lib/precinct/renderQuality";
import type { Tier } from "../../lib/world/quality";
import { inspectPrecinctRenderer, inspectPrecinctScene } from "./inspectPrecinctRenderer";

const MOVEMENT_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

import type { PrecinctPerformanceApi, PrecinctPerformanceReport } from "./precinctPerformanceTypes";

/** Opt-in only. Uses the existing R3F loop, reads counters after its actual render, and never writes scene state. */
export function PrecinctPerformanceProbe({ tier, continuous, sceneAsset }: {
  readonly tier: Tier; readonly continuous: boolean; readonly sceneAsset: string;
}) {
  const get = useThree((state) => state.get);
  const live = useRef({ tier, continuous, sceneAsset });
  const frameStart = useRef<number | null>(null);
  useEffect(() => { live.current = { tier, continuous, sceneAsset }; }, [tier, continuous, sceneAsset]);
  // Early negative priority only; does not take over R3F's render function or Controls.
  useFrame(() => { frameStart.current = performance.now(); }, -100);
  useEffect(() => {
    const measurements = new PrecinctFrameMeasurements();
    let pendingInputs: number[] = [];
    let recordingStarted = 0;
    const observers: PerformanceObserver[] = [];
    const support = { longtask: false, event: false };
    const observerErrors: string[] = [];
    const snapshot = (): PrecinctPerformanceReport => ({ ...measurements.report(performance.now()),
      schema: "arena.precinct-render-performance.v1", production: import.meta.env.PROD, sceneAsset: live.current.sceneAsset,
      renderer: inspectPrecinctRenderer(get().gl), scene: inspectPrecinctScene(get().scene), budgets: PRECINCT_RENDER_BUDGET,
      observers: { ...support }, measurementNotes: [
        "Frame intervals are measured after actual R3F render submissions. No synthetic frames or FPS.",
        "CPU duration includes frame callbacks and WebGL submission; it is not GPU execution time.",
        "Input proxy is canvas movement key dispatch to next render submission. It is not input-to-photon latency.",
        "Event Timing duration is browser-reported event-to-next-presentation estimate, rounded and thresholded at 16 ms; unsupported or zero samples means unavailable, not zero latency.",
        "Long tasks use browser PerformanceObserver (>=50 ms); unsupported means unavailable.",
        "No diagnostic export is sent over the network. No typed text, actor truth labels, credentials or case payloads are recorded.",
        ...observerErrors,
      ] });
    const collectEntries = (entries: PerformanceEntry[]) => {
      for (const entry of entries) {
        if (!measurements.active || entry.startTime < recordingStarted) continue;
        if (entry.entryType === "longtask") measurements.longTaskDuration.add(entry.duration);
        if (entry.entryType === "event" && entry.name === "keydown" && "target" in entry && entry.target === get().gl.domElement) {
          measurements.eventTimingDuration.add(entry.duration);
        }
      }
    };
    for (const type of ["longtask", "event"] as const) {
      if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes.includes(type)) continue;
      const observer = new PerformanceObserver((list) => { collectEntries(list.getEntries()); });
      try {
        // Event Timing extends the browser options before the pinned DOM library models it.
        const options: PerformanceObserverInit & { durationThreshold?: number } = type === "event" ? { type, durationThreshold: 16 } : { type };
        observer.observe(options);
        support[type] = true; observers.push(observer);
      } catch (error) {
        observer.disconnect(); observerErrors.push(`${type} observer unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const api: PrecinctPerformanceApi = {
      start: () => {
        // Discard queued entries from warm-up/previous phases.
        for (const observer of observers) observer.takeRecords();
        pendingInputs = []; recordingStarted = performance.now(); measurements.start(recordingStarted);
      },
      stop: () => {
        for (const observer of observers) collectEntries(observer.takeRecords());
        measurements.stop(performance.now()); pendingInputs = []; return snapshot();
      }, snapshot,
      status: () => {
        const { gl, camera } = get();
        return { active: measurements.active, tier: live.current.tier, continuous: live.current.continuous, visible: !document.hidden,
          cameraPosition: camera.position.toArray(), cameraQuaternion: camera.quaternion.toArray(), calls: gl.info.render.calls, triangles: gl.info.render.triangles,
          drawingBuffer: { width: gl.domElement.width, height: gl.domElement.height }, dpr: gl.getPixelRatio(),
          sceneAsset: live.current.sceneAsset, production: import.meta.env.PROD };
      },
    };
    window.__arenaPrecinctPerformance = api;
    const key = (event: KeyboardEvent) => {
      if (!measurements.active || event.repeat || !MOVEMENT_KEYS.has(event.code) || document.activeElement !== get().gl.domElement || document.hidden || !live.current.continuous) return;
      // Event time is deliberately not stored with a key, position or text.
      if (pendingInputs.length < 64) pendingInputs.push(performance.now());
    };
    const visibility = () => { measurements.visibilityChanged(); pendingInputs = []; };
    window.addEventListener("keydown", key, true); document.addEventListener("visibilitychange", visibility);
    const removeAfter = addAfterEffect(() => {
      const started = frameStart.current;
      if (started === null) return; // Other canvases or a demand-only root did not render this frame.
      frameStart.current = null;
      if (!measurements.active) return;
      const now = performance.now(), { gl } = get();
      measurements.frame({ time: now, cpuSubmissionMs: now - started, calls: gl.info.render.calls,
        triangles: gl.info.render.triangles, dpr: gl.getPixelRatio(), pixels: gl.domElement.width * gl.domElement.height,
        tier: live.current.tier, visible: !document.hidden, continuous: live.current.continuous });
      for (const input of pendingInputs) measurements.inputToRenderSubmission.add(now - input);
      pendingInputs = [];
    });
    return () => {
      removeAfter(); for (const observer of observers) observer.disconnect();
      window.removeEventListener("keydown", key, true); document.removeEventListener("visibilitychange", visibility);
      if (window.__arenaPrecinctPerformance === api) delete window.__arenaPrecinctPerformance;
    };
  }, [get]);
  return null;
}
