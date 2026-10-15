"use client";

import { useEffect, useMemo, useState } from "react";

import type { RunEventEnvelope } from "@/lib/contracts/run-events";
import { foldSwarm, parseSwarmBody, SWARM_POLL_MS, swarmPollDelay, type SwarmView } from "@/lib/war-room/swarm";

export { SWARM_POLL_MS } from "@/lib/war-room/swarm";



export interface SwarmFeed {
  view: SwarmView;
  status: string;
  error: string | null;
  loaded: boolean;
  /** The swarm's envelopes as bh-api served them (never cut for size; a full-run replay merges them in). */
  envelopes?: readonly RunEventEnvelope[];
}

/**
 * The run's recorded swarm events from bh-api (`GET /runs/{id}/swarm` through the same-origin proxy), re-read every
 * two seconds while the run is active so the panel follows the agents live, every fifteen seconds while it waits at a
 * human gate, and once for an ended run. `enabled` false reads nothing (a page that shares one run feed).
 */
export function useSwarm(runId: string, enabled = true): SwarmFeed {
  const [envs, setEnvs] = useState<RunEventEnvelope[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let timer: number | undefined;
    const read = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/live/runs/${encodeURIComponent(runId)}/swarm`, { cache: "no-store" });
        if (!res.ok) throw new Error(`swarm ${res.status}`);
        const body = parseSwarmBody(await res.json());
        if (!live) return;
        setEnvs(body.envelopes);
        setStatus(body.status);
        setError(null);
        setLoaded(true);
        const next = swarmPollDelay(body.status);
        if (next !== null) timer = window.setTimeout(() => void read(), next);
      } catch (e: unknown) {
        if (!live) return;
        setError(e instanceof Error ? e.message : "swarm unavailable");
        setLoaded(true);
        timer = window.setTimeout(() => void read(), SWARM_POLL_MS * 3);
      }
    };
    void read();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [runId, enabled]);

  const view = useMemo(() => foldSwarm(envs), [envs]);
  return { view, status, error, loaded, envelopes: envs };
}
