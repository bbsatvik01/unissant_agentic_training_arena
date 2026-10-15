"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import type { RunEventEnvelope } from "@/lib/contracts/run-events";
import type { InspectCall } from "@/lib/live/inspect";
import { foldHistory } from "@/lib/pipeline/rail";
import { foldOffice, type OfficeRecord } from "@/lib/war-room/office";
import { buildTimeline, detailAt, inspectAt, mergeEnvelopes, spendAt, spendIndex, statusAt, withRunStatus, withSpend, type Timeline } from "@/lib/war-room/replay";
import { parseReplayParams, replayHref } from "@/lib/war-room/replay-controls";
import { createReplaySession, type ReplayEngine, type ReplaySnapshot, type ReplayState } from "@/lib/war-room/replay-engine";
import { ACTIVE_RUN_STATES, type WarRoomStore } from "@/lib/war-room/state";
import { foldSwarm, type SwarmView } from "@/lib/war-room/swarm";

import type { RunFeed } from "./run-feed";
import type { Transport } from "./use-war-room";

/** The replay entry point every view shows: whether this run can be replayed, and the way in and out. */
export interface ReplayOffer {
  /** The run is not live (decided, parked at a gate, failed, interrupted): its record can be replayed. */
  available: boolean;
  /** Replay is on (`?replay=1`). */
  active: boolean;
  /** Replay is on but the record is still being read. */
  preparing: boolean;
  /** Why the record could not be read yet (it is tried again), while preparing. */
  problem: string | null;
  /** The record's recorded length (creation to the end of the record), once it is read. */
  totalMs: number | null;
  enter: () => void;
  exit: () => void;
}

/** A run page in replay: the transport, its timeline, the state at the cursor and the whole record. */
export interface ReplayView {
  engine: ReplayEngine;
  timeline: Timeline;
  state: ReplayState;
  /** The run's status at the cursor. */
  status: string;
  /** The whole record: the office schedules its agents' model calls ahead of the messages they produce. */
  /** The whole run: its swarm, its office record and every recorded model call (the inspector's, read once). */
  full: { swarm: SwarmView; record: OfficeRecord; calls: readonly InspectCall[] };
}

const OFF: ReplaySnapshot = { engine: null, state: null };
const noop = () => undefined;
const EMPTY: RunEventEnvelope[] = [];
const NO_CALLS: readonly InspectCall[] = [];

function navigate(href: string) {
  window.history.replaceState(null, "", href);
}

/** The Transport the views read in replay: the store at the cursor, nothing connected and nothing to retry. */
function replayTransport(store: WarRoomStore): Transport {
  return { store, lifecycle: "completed", silence: "", retry: null, gaveUp: false, restart: noop, reconnect: noop, refresh: noop, seedError: null };
}

/**
 * Full-run replay for a run page: the run's own record (every frame the office feed read from seq 0, with the swarm's
 * uncut envelopes merged in, the run row's approvals and the inspector's calls) played back on the transport, and
 * the shared run feed rebuilt as of the cursor, so every view (War Room, Pipeline, Office) shows the run as it was.
 * Offered only once the run is no longer live; `?replay=1&t=<seconds>` opens it at a moment. Live mode is untouched:
 * `live` is returned as it came, with the offer added.
 */
export function useRunReplay(live: RunFeed, swarmEnvelopes: readonly RunEventEnvelope[]): RunFeed {
  const params = useSearchParams();
  const { replay: requested, t } = parseReplayParams((name) => params.get(name));
  const detail = live.detail;
  const status = detail?.run.status ?? null;
  const available = status !== null && !ACTIVE_RUN_STATES.has(status);
  const envs = live.office.envs;
  const lastSeq = envs.reduce((m, e) => Math.max(m, e.seq), 0);
  const complete = available && detail !== null && live.office.loaded && lastSeq >= detail.run.lastEventSeq;

  // the timeline's content key: a parked run is re-read every fifteen seconds, and an unchanged record keeps its engine
  const key = complete && detail ? [live.runId, status, detail.run.terminalAt, detail.approvals.map((a) => `${a.gate}@${a.createdAt}`).join(","), envs.length, lastSeq, swarmEnvelopes.length].join("|") : null;
  const timeline = useMemo(
    () => (complete && detail ? buildTimeline({ runId: live.runId, run: detail.run, approvals: detail.approvals, envs: mergeEnvelopes(envs, swarmEnvelopes) }) : null),
    [complete, detail, live.runId, envs, swarmEnvelopes],
  );

  const [session] = useState(() => createReplaySession());
  useEffect(() => () => session.dispose(), [session]);
  useEffect(() => {
    session.configure(requested && key !== null && timeline !== null ? { key, timeline, at: t === null ? null : timeline.t0 + t * 1000 } : null);
  }, [session, requested, key, timeline, t]);
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot, () => OFF);

  const enter = useCallback(() => {
    session.autoplay();
    navigate(replayHref(window.location.href, { replay: true, t: null }));
  }, [session]);
  const exit = useCallback(() => {
    session.cancelAutoplay();
    navigate(replayHref(window.location.href, { replay: false, t: null }));
  }, [session]);

  // the run went live again (approved in another tab): leave the replay for the live view
  useEffect(() => {
    if (requested && status !== null && ACTIVE_RUN_STATES.has(status)) exit();
  }, [requested, status, exit]);
  const preparing = requested && snap.engine === null;
  const problem = preparing ? (live.office.error ?? (detail === null ? null : available ? null : "the run is live again")) : null;
  const offer = useMemo<ReplayOffer>(
    () => ({ available, active: requested, preparing, problem, totalMs: timeline ? timeline.end - timeline.t0 : null, enter, exit }),
    [available, requested, preparing, problem, timeline, enter, exit],
  );

  const engine = snap.engine;
  const state = snap.state;
  // a hidden tab pauses the replay (nobody is watching it play out); it stays paused until the viewer presses play
  useEffect(() => {
    if (!engine) return;
    const onHide = () => {
      if (document.visibilityState === "hidden" && engine.getState().playing) engine.pause();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [engine]);
  const tl = engine?.timeline ?? null;
  const k = state?.k ?? 0;
  const prefix = useMemo(() => (tl ? tl.envs.slice(0, k) : EMPTY), [tl, k]);
  const history = useMemo(() => foldHistory(prefix), [prefix]);
  const record = useMemo(() => foldOffice(prefix), [prefix]);
  const swarmView = useMemo(() => foldSwarm(prefix), [prefix]);
  const fullCalls = live.inspect?.calls;
  const full = useMemo(() => (tl ? { swarm: foldSwarm(tl.envs), record: foldOffice(tl.envs), calls: fullCalls ?? NO_CALLS } : null), [tl, fullCalls]);
  const spending = useMemo(() => (live.inspect ? spendIndex(live.inspect.calls) : null), [live.inspect]);

  return useMemo<RunFeed>(() => {
    if (!engine || !state || !tl || !full) return live.replayOffer === offer ? live : { ...live, replayOffer: offer };
    const r = state.r;
    const runStatus = statusAt(tl, r);
    const capUsd = detail ? Number(detail.run.capUsd) : tl.capUsd;
    // spend: the run's model calls received by then (the inspector's single cost source); the view's own last
    // recorded cost until the inspector has been read
    // at the end of the record the views show the live feed's own final store (bh-api's snapshot, the authoritative
    // end state, which also reconciles anything a frame cut for size left out) once it covers the whole record
    const liveEnd = live.stream.store;
    const lastSeq = tl.envs.at(-1)?.seq ?? 0;
    const atEnd = k >= tl.envs.length && r >= tl.end && liveEnd.view !== null && !liveEnd.needsResync && liveEnd.lastSeq >= lastSeq;
    const spendUsd = atEnd ? (live.spendUsd ?? liveEnd.view?.cost.usd ?? 0) : spending ? spendAt(spending, r) : (state.cursor.store.view?.cost.usd ?? 0);
    const store = atEnd ? liveEnd : withRunStatus(withSpend(state.cursor.store, spendUsd, capUsd), runStatus);
    return {
      runId: live.runId,
      stream: replayTransport(store),
      office: { record, envs: prefix, sync: { settledSeq: 0, skewMs: 0 }, loaded: true, error: null },
      history,
      swarm: { view: swarmView, status: runStatus, error: null, loaded: true },
      detail: detail ? detailAt(detail, tl, k, r) : null,
      inspect: live.inspect ? inspectAt(live.inspect, tl, r) : null,
      spendUsd,
      capUsd,
      reload: noop,
      replay: { engine, timeline: tl, state, status: runStatus, full },
      replayOffer: offer,
    };
  }, [engine, state, tl, full, live, offer, detail, spending, k, record, prefix, history, swarmView]);
}
