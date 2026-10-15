"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import type { RunEventEnvelope } from "@/lib/contracts/run-events";
import { parseInspection, type Inspection } from "@/lib/live/inspect";
import { parseDetail, type RunDetail } from "@/lib/live/types";
import { foldHistory, type RunHistory } from "@/lib/pipeline/rail";
import { runStateMismatch } from "@/lib/war-room/run-sync";
import { ACTIVE_RUN_STATES } from "@/lib/war-room/state";
import { PARKED_STATES } from "@/lib/war-room/swarm";

import { LIVE_ENDPOINTS, useStreamTransport, type Transport } from "./use-war-room";
import { useOfficeFeed, type OfficeFeed } from "./use-office-feed";
import { useRunReplay, type ReplayOffer, type ReplayView } from "./use-run-replay";
import { useSwarm, type SwarmFeed } from "./use-swarm";

/**
 * One live run's data, read once per page and shared by every view of it (War Room, Pipeline, Office):
 *
 * - `stream`: the War Room store (bh-api's snapshot, then the ticketed stream after its seq);
 * - `office`: the same stream read from seq 0 (the office's scene and the Pipeline's per-step history);
 * - `swarm`: the S9-S10 agent swarm (`/swarm`, polled while the run works);
 * - `detail`: the run row and its approvals (`GET /runs/{id}`), re-read while the run works and at each phase end;
 * - `inspect`: per-stage time and spend (`/inspect`, the single cost source), re-read at each stage end and every
 *   fifteen seconds while a stage runs.
 *
 * Switching views keeps every connection open; nothing reconnects.
 *
 * Replay (`?replay=1`, only once the run is no longer live): every field above is rebuilt as of the replay's cursor
 * from the run's own record, so each view shows the run as it was at that moment; `replay` carries the transport.
 */
export interface RunFeed {
  runId: string;
  stream: Transport;
  office: OfficeFeed;
  history: RunHistory;
  swarm: SwarmFeed;
  detail: RunDetail | null;
  inspect: Inspection | null;
  /** The run's spend so far: the inspector's total (model calls), else the snapshot's budget ledger. */
  spendUsd: number | null;
  capUsd: number | null;
  /** Re-read the run row now (after a person recorded H1 or H2 here), so every view moves on at once. */
  reload: () => void;
  /** The full-run replay the views are showing, or null while they show the run as it is now. */
  replay: ReplayView | null;
  /** Whether this run can be replayed, and the way in and out of the replay. */
  replayOffer: ReplayOffer;
}

const RunFeedContext = createContext<RunFeed | null>(null);

/** The shared run feed, or null outside a provider (a recorded replay, the admin inspector). */
export function useRunFeed(): RunFeed | null {
  return useContext(RunFeedContext);
}

const DETAIL_ACTIVE_MS = 5_000;
const DETAIL_PARKED_MS = 15_000;
const INSPECT_ACTIVE_MS = 15_000;
const RETRY_MS = 15_000;
const SYNC_RETRY_MS = 5_000;

/** Re-reads `path` (a same-origin bh-api proxy path) whenever `key` changes, then every `every(body)` ms. */
function usePolled<T>(path: string, parse: (body: unknown) => T | null, every: (v: T) => number | null, key: string): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const read = async () => {
      try {
        const res = await fetch(path, { cache: "no-store" });
        const parsed = res.ok ? parse(await res.json()) : null;
        if (!alive) return;
        if (parsed) setValue(parsed);
        const next = parsed ? every(parsed) : RETRY_MS;
        if (next !== null) timer = window.setTimeout(() => void read(), next);
      } catch {
        if (alive) timer = window.setTimeout(() => void read(), RETRY_MS);
      }
    };
    void read();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [path, parse, every, key]);
  return value;
}

const detailEvery = (d: RunDetail) => (ACTIVE_RUN_STATES.has(d.run.status) ? DETAIL_ACTIVE_MS : PARKED_STATES.has(d.run.status) ? DETAIL_PARKED_MS : null);
const inspectEvery = (i: Inspection) => (ACTIVE_RUN_STATES.has(i.run.status) ? INSPECT_ACTIVE_MS : null);

export function RunFeedProvider({ runId, children }: { runId: string; children: ReactNode }) {
  const router = useRouter();
  const stream = useStreamTransport(runId, true, LIVE_ENDPOINTS);
  const office = useOfficeFeed(runId, true);
  const swarm = useSwarm(runId);
  const history = useMemo(() => foldHistory(office.envs), [office.envs]);

  // every stage end and every phase end re-reads the run row and its spend
  const stageEnds = Object.values(history.edges).filter((e) => e?.end !== null).length;
  const phaseKey = `${history.parks.length}:${history.errors.length}:${stream.store.status}:${stream.store.finalState ?? ""}`;
  const id = encodeURIComponent(runId);
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);
  const detail = usePolled(`/api/live/runs/${id}`, parseDetail, detailEvery, `${phaseKey}:${reloads}`);
  const inspect = usePolled(`/api/live/runs/${id}/inspect`, parseInspection, inspectEvery, `${stageEnds}:${phaseKey}`);

  // a live phase ended: refresh the server-rendered parts (the run header) once the view has re-read the snapshot
  const phaseEnded = (stream.store.status === "finished" || stream.store.status === "error") && !stream.store.needsResync;
  useEffect(() => {
    if (phaseEnded) router.refresh();
  }, [phaseEnded, router]);

  // the view follows the run's status on every transition: whenever bh-api's status says something other than the
  // view (resumed after a gate, parked, decided at H2, ended), re-read the snapshot, which carries the run's own
  // status and reopens or closes the stream; a failed read is asked again until the two agree
  const outOfStep = runStateMismatch(detail?.run.status ?? null, stream.store.status, stream.store.finalState);
  const { refresh } = stream;
  useEffect(() => {
    if (!outOfStep) return;
    refresh();
    const t = window.setInterval(refresh, SYNC_RETRY_MS);
    return () => window.clearInterval(t);
  }, [outOfStep, refresh]);

  const view = stream.store.view;
  const live = useMemo<RunFeed>(
    () => ({
      runId,
      stream,
      office,
      history,
      swarm,
      detail,
      inspect,
      spendUsd: inspect ? inspect.run.usd : view ? view.cost.usd : null,
      capUsd: detail ? Number(detail.run.capUsd) : view ? view.cost.capUsd : null,
      reload,
      replay: null,
      replayOffer: NO_REPLAY,
    }),
    [runId, stream, office, history, swarm, detail, inspect, view, reload],
  );
  const value = useRunReplay(live, swarm.envelopes ?? NO_ENVELOPES);
  return <RunFeedContext.Provider value={value}>{children}</RunFeedContext.Provider>;
}

const NO_ENVELOPES: readonly RunEventEnvelope[] = [];
const NO_REPLAY: ReplayOffer = { available: false, active: false, preparing: false, problem: null, totalMs: null, enter: () => undefined, exit: () => undefined };
