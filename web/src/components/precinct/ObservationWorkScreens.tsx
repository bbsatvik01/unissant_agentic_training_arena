import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MeshBasicMaterial } from "three";
import { WORK_STYLES, type WorkFrame, type WorkStyle } from "../../lib/agent-work/model";
import { OBSERVATION_MONITOR } from "../../lib/precinct/interviewStage";
import { monitorBudget, monitorStyleAtUv, observationWork } from "../../lib/precinct/observationScreens";
import type { Tier } from "../../lib/world/quality";
import { AgentWorkSvg } from "../agent-work/AgentWorkMonitor";
import { createLocalSvgTexture, type LocalSvgImage } from "./localSvgTexture";

/** One raster image makes all four panes commit the same canonical public frame atomically. */
export function observationAtlas(frame: WorkFrame, width: number, height: number): LocalSvgImage {
  return { svg: renderToStaticMarkup(<svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} viewBox="0 0 1920 1080" role="img" aria-label="Four public agent-work views">
    <rect width="1920" height="1080" fill="#263d35" />
    {WORK_STYLES.map((style, index) => <g key={style} transform={`translate(${String(index % 2 * 960 + 10)} ${String(Math.floor(index / 2) * 540 + 6)}) scale(.98)`}>
      <AgentWorkSvg frame={frame} style={style} id={`precinct-monitor-${style}`} />
    </g>)}
  </svg>) };
}

interface Props {
  readonly frame: WorkFrame;
  readonly assessment: boolean;
  readonly tier: Tier;
  readonly interactive: boolean;
  readonly onExpand?: (style: WorkStyle) => void;
}

/** Mount inside the existing Canvas. No camera, timers, transport, rooms or duplicate furniture. */
function ScreenSurface({ frame, assessment, tier, interactive, onExpand }: Props) {
  const material = useRef<MeshBasicMaterial>(null);
  const renderer = useRef<ReturnType<typeof createLocalSvgTexture> | null>(null);
  const invalidate = useThree((state) => state.invalidate);
  const safeFrame = useMemo(() => observationWork(frame, assessment), [frame, assessment]);
  const budget = monitorBudget(tier);
  const live = useRef({ frame: safeFrame, budget });
  const last = useRef<{ frame: WorkFrame | null; elapsed: number; width: number }>({ frame: null, elapsed: Infinity, width: 0 });
  useEffect(() => { live.current = { frame: safeFrame, budget }; invalidate(); }, [safeFrame, budget, invalidate]);
  useEffect(() => {
    const resource = createLocalSvgTexture((texture) => {
      if (material.current !== null) {
        material.current.map = texture; material.current.needsUpdate = true;
        invalidate();
      }
    });
    renderer.current = resource; last.current = { frame: null, elapsed: Infinity, width: 0 };
    return () => { renderer.current = null; resource.dispose(); };
  }, [invalidate]);
  useFrame((_state, delta) => {
    const current = live.current;
    last.current.elapsed += Number.isFinite(delta) ? Math.max(0, delta) : 0;
    if (last.current.frame === current.frame && last.current.width === current.budget.width) return;
    // A paused seek or accessibility change must paint once even on a demand-only Canvas.
    const immediate = current.frame.paused || current.frame.reducedMotion || last.current.width !== current.budget.width;
    if (!immediate && last.current.elapsed < current.budget.seconds) return;
    renderer.current?.update(observationAtlas(current.frame, current.budget.width, current.budget.height));
    last.current = { frame: current.frame, elapsed: 0, width: current.budget.width };
  });
  return <mesh name="precinct-observation-work-screens" position={OBSERVATION_MONITOR.position} rotation={OBSERVATION_MONITOR.rotation} onPointerDown={(event) => {
    event.stopPropagation();
    if (!interactive || event.button !== 0 || event.uv === undefined) return;
    const style = monitorStyleAtUv(event.uv.x, event.uv.y);
    if (style !== null) onExpand?.(style);
  }}>
    <planeGeometry args={[...OBSERVATION_MONITOR.size]} />
    <meshBasicMaterial ref={material} color="#ffffff" toneMapped={false} />
  </mesh>;
}

export function ObservationWorkScreens(props: Props) {
  // Replace the material immediately on assessment entry. A late practice decode cannot flash coaching.
  return <ScreenSurface key={props.assessment || props.frame.assessment ? "assessment" : "practice"} {...props} />;
}
