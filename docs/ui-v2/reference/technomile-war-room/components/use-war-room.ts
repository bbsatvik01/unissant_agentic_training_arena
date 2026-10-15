"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { createBatcher } from "@/lib/batcher";
import { parseEnvelope, type RunEventEnvelope } from "@/lib/contracts/run-events";
import { createLivenessClock } from "@/lib/liveness-clock";
import { deriveRunLifecycle, formatSilence, silenceMs, type RunLifecycle } from "@/lib/run-lifecycle";
import { openTicketedStream, type TicketedStreamHandle } from "@/lib/sse/ticketed-stream";
import {
  ACTIVE_RUN_STATES,
  applyLiveSnapshot,
  applyResync,
  liveAnswer,
  emptyStore,
  parseActiveStage,
  failResync,
  nextEpoch,
  reduceAll,
  requestResync,
  RESYNC_BACKOFF_MS,
  seedFromSnapshot,
  type WarRoomStore,
} from "@/lib/war-room/state";
import { seedRetryDelay } from "@/lib/war-room/run-sync";
import type { WarRoomSnapshot } from "@/lib/contracts/run-events";
import { createPlayer, type Player } from "@/lib/war-room/player";

export type Mode = "stream" | "scrub";

/** bh-api's snapshot answer (the view at `seq`, the run's status, the stage working now). */
interface LiveSnapshotAnswer {
  seq: number;
  snapshot: WarRoomSnapshot;
  run: { status: string };
  activeStage?: unknown;
  lastEventAt?: unknown;
}

export interface Transport {
  store: WarRoomStore;
  lifecycle: RunLifecycle;
  silence: string;
  retry: { attempt: number; delayMs: number } | null;
  gaveUp: boolean;
  restart: () => void;
  reconnect: () => void;
  /** Live: re-read the run's durable state now; an active run's stream reopens from it (a gate approved elsewhere). */
  refresh: () => void;
  /** A live run's initial snapshot could not be read (the stream does not open without it). */
  seedError: string | null;
}

/**
 * Where a run's stream lives. `recorded`: the web's own fixture routes (public gold-run replay). `live`: the
 * same-origin proxy to bh-api (single-use tickets, real `run_events`), which starts from bh-api's snapshot of
 * the run's durable state and streams `seq > snapshot.seq`.
 */
export interface StreamEndpoints {
  live: boolean;
  ticket: (runId: string) => string;
  events: (runId: string) => string;
  snapshot: (runId: string, at: number) => string;
}

export const RECORDED_ENDPOINTS: StreamEndpoints = {
  live: false,
  ticket: (r) => `/api/runs/${encodeURIComponent(r)}/ticket`,
  events: (r) => `/api/runs/${encodeURIComponent(r)}/events`,
  snapshot: (r, at) => `/api/runs/${encodeURIComponent(r)}/snapshot?at=${at}`,
};

export const LIVE_ENDPOINTS: StreamEndpoints = {
  live: true,
  ticket: (r) => `/api/live/runs/${encodeURIComponent(r)}/tickets`,
  events: (r) => `/api/live/runs/${encodeURIComponent(r)}/events`,
  snapshot: (r) => `/api/live/runs/${encodeURIComponent(r)}/snapshot`,
};

export async function mintUrl(ep: StreamEndpoints, runId: string, lastEventId: string | null): Promise<string> {
  const res = await fetch(ep.ticket(runId), {
    method: "POST",
    cache: "no-store",
    ...(ep.live ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {}),
  });
  if (!res.ok) throw new Error(`ticket ${res.status}`);
  const { ticket } = (await res.json()) as { ticket: string };
  const params = new URLSearchParams({ ticket });
  if (lastEventId) params.set("after", lastEventId);
  return `${ep.events(runId)}?${params.toString()}`;
}

/** Stream path: ticketed SSE -> parse -> 10 Hz batch -> reducer, with the liveness state machine. */
export function useStreamTransport(runId: string, enabled: boolean, ep: StreamEndpoints = RECORDED_ENDPOINTS): Transport {
  const [store, setStore] = useState<WarRoomStore>(emptyStore);
  const [retry, setRetry] = useState<{ attempt: number; delayMs: number } | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const [generation, setGeneration] = useState(0);
  // A live run starts from bh-api's snapshot of its durable state; the stream then resumes after that seq.
  const [seeded, setSeeded] = useState(!ep.live);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [seedFailures, setSeedFailures] = useState(0);
  const handleRef = useRef<TicketedStreamHandle | null>(null);
  // The view's own resume point: a re-enabled or restarted transport continues from what the
  // store already holds instead of replaying from seq 0.
  const resumeRef = useRef<{ lastSeq: number; finished: boolean }>({ lastSeq: 0, finished: false });
  useEffect(() => {
    resumeRef.current = { lastSeq: store.lastSeq, finished: store.status === "finished" };
  }, [store.lastSeq, store.status]);
  const clock = useMemo(() => createLivenessClock(), []);
  const snap = useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);

  // Live runs: every read of the run's durable state goes through here. The snapshot's own run status decides
  // whether a stream is open: an active run streams from the snapshot's seq (reopening if a phase had closed),
  // a parked or ended run is shown as such and nothing reconnects.
  const openRef = useRef(false);
  const epochRef = useRef(store.epoch);
  const seqRef = useRef(store.lastSeq);
  useEffect(() => {
    epochRef.current = store.epoch;
    seqRef.current = store.lastSeq;
  }, [store.epoch, store.lastSeq]);
  const [streamGen, setStreamGen] = useState(0);
  const refreshLive = useCallback(
    async (epoch: number): Promise<void> => {
      const res = await fetch(ep.snapshot(runId, 0), { cache: "no-store" });
      if (!res.ok) throw new Error(`snapshot ${res.status}`);
      const body = (await res.json()) as LiveSnapshotAnswer;
      // an answer for an earlier epoch (a restart happened) or older than what the view holds changes nothing:
      // not the view, not the status, not the stream
      const answer = liveAnswer(epoch, epochRef.current, body.seq, seqRef.current, body.run.status);
      if (answer === "ignore") return;
      if (answer === "release") {
        setStore((s) => failResync(s, epoch));
        return;
      }
      setStore((s) => applyLiveSnapshot(s, epoch, body.seq, body.snapshot, body.run.status, parseActiveStage(body.activeStage), typeof body.lastEventAt === "string" ? body.lastEventAt : null));
      if (answer === "stream" && !openRef.current) {
        resumeRef.current = { lastSeq: Math.max(body.seq, resumeRef.current.lastSeq), finished: false };
        setStreamGen((g) => g + 1);
      } else if (answer === "stop") {
        resumeRef.current = { ...resumeRef.current, finished: true };
        handleRef.current?.finish();
        openRef.current = false;
      }
    },
    [ep, runId],
  );

  useEffect(() => {
    if (!enabled || seeded || !ep.live) return;
    let live = true;
    fetch(ep.snapshot(runId, 0), { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`snapshot ${res.status}`);
        const body = (await res.json()) as LiveSnapshotAnswer;
        if (!live) return;
        const parked = !ACTIVE_RUN_STATES.has(body.run.status);
        resumeRef.current = { lastSeq: body.seq, finished: parked };
        setStore((s) => seedFromSnapshot(s, body.seq, body.snapshot, body.run.status, parseActiveStage(body.activeStage), typeof body.lastEventAt === "string" ? body.lastEventAt : null));
        setSeeded(true);
        setSeedError(null);
        setSeedFailures(0);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setSeedError(e instanceof Error ? e.message : "snapshot unavailable");
        setSeedFailures((n) => n + 1);
      });
    return () => {
      live = false;
    };
  }, [enabled, seeded, ep, runId, generation]);

  // a failed first read is tried again on its own, with backoff (the stream opens only from that read); the error
  // stays shown, with a Retry, until a read succeeds
  useEffect(() => {
    if (!enabled || seeded || seedFailures === 0) return;
    const t = window.setTimeout(() => setGeneration((g) => g + 1), seedRetryDelay(seedFailures));
    return () => window.clearTimeout(t);
  }, [enabled, seeded, seedFailures]);


  useEffect(() => {
    if (!enabled || !seeded || resumeRef.current.finished) return;
    const batcher = createBatcher<RunEventEnvelope>((items) => setStore((s) => reduceAll(s, items)), 100);
    const resume = resumeRef.current.lastSeq;
    openRef.current = true;
    const handle = openTicketedStream({
      initialLastEventId: resume > 0 ? String(resume) : null,
      resolveUrl: ({ lastEventId }) => mintUrl(ep, runId, lastEventId),
      onOpen: () => {
        setRetry(null);
        setGaveUp(false);
      },
      onMessage: (e) => {
        const env = parseEnvelope(String(e.data));
        if (!env) return false;
        batcher.push(env);
        clock.markProgress();
        if (env.event.type === "RUN_FINISHED" || env.event.type === "RUN_ERROR") {
          batcher.flush();
          handle.finish();
          openRef.current = false;
          // a live phase ended: the run's durable state decides what happens next (parked, ended, or already
          // re-activated by an approval in another tab, then the stream reopens from the snapshot's seq)
          if (ep.live) refreshLive(epochRef.current).catch(() => setStore((s) => ({ ...s, needsResync: true })));
        }
        return true;
      },
      onRetry: (r) => {
        setRetry(r);
        // the stream ended without a closing event (cancel, reclamation): re-read the run before reconnecting
        if (ep.live) refreshLive(epochRef.current).catch(() => undefined);
      },
      onGiveUp: () => setGaveUp(true),
    });
    handleRef.current = handle;
    return () => {
      handle.close();
      batcher.dispose();
      handleRef.current = null;
      openRef.current = false;
    };
  }, [runId, enabled, seeded, generation, streamGen, clock, ep, refreshLive]);

  // Gap or rejected frame: the store's recovery state machine decides; this effect only performs
  // the request it asks for, tagged with the epoch so a restart can never be overwritten.
  const { needsResync, pendingResync, lastSeq, epoch, resyncFailures } = store;
  useEffect(() => {
    if (!enabled || !needsResync || pendingResync !== null || lastSeq === 0) return;
    const timer = window.setTimeout(() => {
      setStore((s) => requestResync(s, epoch, lastSeq));
      const read = ep.live
        ? refreshLive(epoch)
        : fetch(ep.snapshot(runId, lastSeq), { cache: "no-store" }).then(async (res) => {
            if (!res.ok) throw new Error(`snapshot ${res.status}`);
            const body = (await res.json()) as { seq: number; snapshot: WarRoomSnapshot };
            setStore((s) => applyResync(s, epoch, body.seq, body.snapshot));
          });
      read.catch(() => setStore((s) => failResync(s, epoch)));
    }, RESYNC_BACKOFF_MS(resyncFailures));
    return () => window.clearTimeout(timer);
  }, [enabled, needsResync, pendingResync, lastSeq, epoch, resyncFailures, runId, ep, refreshLive]);

  const restart = useCallback(() => {
    resumeRef.current = { lastSeq: 0, finished: false };
    setStore((s) => nextEpoch(s));
    setSeeded(!ep.live);
    setSeedError(null);
    setSeedFailures(0);
    setRetry(null);
    setGaveUp(false);
    clock.reset();
    setGeneration((g) => g + 1);
  }, [clock, ep.live]);

  const reconnect = useCallback(() => {
    setGaveUp(false);
    if (handleRef.current) {
      handleRef.current.reconnect();
      return;
    }
    // no stream yet: the first read of the run failed, so read it again now (the error stays shown until it works)
    setGeneration((g) => g + 1);
  }, []);

  const refresh = useCallback(() => {
    if (!ep.live || !seeded) return;
    refreshLive(epochRef.current).catch(() => undefined);
  }, [ep.live, seeded, refreshLive]);

  const finished = store.status === "finished";
  const lifecycle = deriveRunLifecycle({
    ...snap,
    serverStatus: finished ? store.finalState : store.status === "running" ? "running" : null,
    isError: store.status === "error",
    isDisconnected: gaveUp || seedError !== null,
  });
  return { store, lifecycle, silence: formatSilence(silenceMs(snap)), retry, gaveUp: gaveUp || seedError !== null, restart, reconnect, refresh, seedError };
}

export interface Scrub {
  store: WarRoomStore;
  ready: boolean;
  error: string | null;
  playing: boolean;
  cursor: number;
  total: number;
  positionMs: number;
  durationMs: number;
  speed: number;
  play: () => void;
  pause: () => void;
  seek: (n: number) => void;
  setSpeed: (s: number) => void;
}

/** Replay path: fetch the whole recording once, then play, pause, scrub and change speed. */
export function useScrubTransport(runId: string, enabled: boolean): Scrub {
  const [store, setStore] = useState<WarRoomStore>(emptyStore);
  const [player, setPlayer] = useState<Player | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, force] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let created: Player | null = null;
    fetch(`/api/runs/${encodeURIComponent(runId)}/events?format=json`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`recording ${res.status}`);
        return (await res.json()) as { events: RunEventEnvelope[]; offsets: number[] };
      })
      .then((rec) => {
        if (!live) return;
        setError(null);
        created = createPlayer({
          events: rec.events,
          offsets: rec.offsets,
          onBatch: (batch) => {
            setStore((s) => reduceAll(s, batch));
            force((n) => n + 1);
          },
          onEnd: () => force((n) => n + 1),
        });
        setPlayer(created);
        setStore(reduceAll(emptyStore(), created.seek(rec.events.length)));
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : "recording unavailable"));
    return () => {
      live = false;
      created?.dispose();
    };
  }, [runId, enabled]);

  const seek = useCallback(
    (n: number) => {
      if (!player) return;
      player.pause();
      setStore(reduceAll(emptyStore(), player.seek(n)));
      force((x) => x + 1);
    },
    [player],
  );

  return {
    store,
    ready: player !== null,
    error,
    playing: player?.playing ?? false,
    cursor: player?.cursor ?? 0,
    total: player?.total ?? 0,
    positionMs: player?.positionMs ?? 0,
    durationMs: player?.durationMs ?? 0,
    speed: player?.speed ?? 1,
    play: () => {
      if (!player) return;
      if (player.cursor >= player.total) setStore(emptyStore());
      player.play();
      force((n) => n + 1);
    },
    pause: () => {
      player?.pause();
      force((n) => n + 1);
    },
    seek,
    setSpeed: (s) => {
      player?.setSpeed(s);
      force((n) => n + 1);
    },
  };
}
