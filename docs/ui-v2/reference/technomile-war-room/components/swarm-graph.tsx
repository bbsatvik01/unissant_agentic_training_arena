"use client";

import dynamic from "next/dynamic";

/**
 * The agent graph (War Room, Agent swarm, Graph): a situation-room network drawn with React Flow, loaded only when the
 * Graph view opens (the chunk is client-only). The office shares the card tip and the motion preference.
 */
export { AgentCardTip } from "./agent-card-tip";
export { useReducedMotion } from "./use-reduced-motion";

export const loadSwarmGraphView = () => import("./swarm-graph-view");

export const SwarmGraphView = dynamic(loadSwarmGraphView, {
  ssr: false,
  loading: () => <GraphSkeleton />,
});

/** The graph's footprint while its chunk loads (no layout shift when it arrives). */
export function GraphSkeleton() {
  return (
    <div className="hatch flex aspect-[1200/760] max-h-[760px] min-h-[460px] w-full items-center justify-center rounded-lg border border-hairline text-sm text-muted">
      Reading the swarm&apos;s record...
    </div>
  );
}
