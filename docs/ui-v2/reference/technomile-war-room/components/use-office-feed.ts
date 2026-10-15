"use client";

import { useEffect, useMemo, useState } from "react";

import { createBatcher } from "@/lib/batcher";
import { parseEnvelope, type RunEventEnvelope } from "@/lib/contracts/run-events";
import { openTicketedStream, type TicketedStreamHandle } from "@/lib/sse/ticketed-stream";
import { feedAction, foldOffice, NEW_SYNC, noteArrival, type LiveSync, type OfficeRecord } from "@/lib/war-room/office";
import { PARKED_POLL_MS } from "@/lib/war-room/swarm";

import { LIVE_ENDPOINTS, mintUrl } from "./use-war-room";

export interface OfficeFeed {
  record: OfficeRecord;
  /** Every frame of the run this feed read, in arrival order: the office's events, the stage, gate and error edges
   *  the Pipeline reads, and the rest of the record a full-run replay plays back. */
  envs: RunEventEnvelope[];
  sync: LiveSync;
  loaded: boolean;
  error: string | null;
}

/** How long the feed waits before asking again when its first read of the run fails. */
const START_RETRY_MS = 6000;

/** bh-api's snapshot answer, read for two facts: the run's last seq and its state. */
async function readRun(runId: string): Promise<{ seq: number; status: string }> {
  const res = await fetch(LIVE_ENDPOINTS.snapshot(runId, 0), { cache: "no-store" });
  if (!res.ok) throw new Error(`snapshot ${res.status}`);
  const body = (await res.json()) as { seq?: unknown; run?: { status?: unknown } };
  if (typeof body.seq !== "number" || !Number.isInteger(body.seq) || body.seq < 0) throw new Error("snapshot without a seq");
  return { seq: body.seq, status: typeof body.run?.status === "string" ? body.run.status : "" };
}

/**
 * The run's research lanes, S4 fetches, S7 verdicts, stage edges and phase ends for the agent office and the
 * Pipeline view, and the whole record for a full-run replay: the run's own ticketed stream read from seq 0 (the same
 * frames the War Room streams).
 *
 * The run's last seq when the office opens (bh-api's snapshot) is the history boundary: everything up to it sets the
 * scene and never animates; only later events move anything. Whenever the stream closes or catches up, the run's own
 * state decides (`feedAction`): follow an active run, read on until everything recorded has arrived, look again every
 * fifteen seconds while the run waits at a human gate (it resumes from the last seq received when approved, here or
 * in another tab), or stop for good once it has ended.
 */
export function useOfficeFeed(runId: string, enabled: boolean): OfficeFeed {
  const [envs, setEnvs] = useState<RunEventEnvelope[]>([]);
  const [sync, setSync] = useState<LiveSync>(NEW_SYNC);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let syncNow = NEW_SYNC;
    let handle: TicketedStreamHandle | null = null;
    let parkTimer: number | undefined;
    let lastSeq = 0;
    let stopAt = Infinity;
    const held: RunEventEnvelope[] = [];
    const batcher = createBatcher<RunEventEnvelope>((items) => {
      if (items.length > 0) {
        held.push(...items);
        setEnvs([...held]);
      }
      setSync(syncNow);
    }, 250);

    // one cancellable timer for a parked run's next look
    const schedulePark = () => {
      window.clearTimeout(parkTimer);
      parkTimer = window.setTimeout(ask, PARKED_POLL_MS);
    };

    // one question to bh-api at a time: a question asked while one is in flight is asked again after it
    let asking = false;
    let askAgain = false;
    const ask = () => {
      if (!live) return;
      if (asking) {
        askAgain = true;
        return;
      }
      asking = true;
      readRun(runId)
        .then(decide)
        .catch(() => {
          // a failed read while parked looks again later; while streaming, the stream itself carries on
          if (live && !handle) schedulePark();
        })
        .finally(() => {
          asking = false;
          if (askAgain) {
            askAgain = false;
            ask();
          }
        });
    };

    // the run's state decides what happens after the stream closed or caught up
    const decide = (run: { seq: number; status: string }) => {
      if (!live) return;
      // an answer older than what the stream already delivered says nothing about now: the run has moved on
      if (run.seq < lastSeq) {
        if (!handle) schedulePark();
        return;
      }
      const action = feedAction(run.status, lastSeq, run.seq);
      stopAt = action === "follow" ? Infinity : run.seq;
      if (action === "follow" || action === "read") {
        if (!handle) open();
        return;
      }
      // everything the run recorded has arrived (park and end both mean caught up)
      batcher.flush();
      handle?.finish();
      handle = null;
      setLoaded(true);
      setError(null);
      if (action === "park") schedulePark();
    };

    const open = () => {
      const stream = openTicketedStream({
        initialLastEventId: lastSeq > 0 ? String(lastSeq) : null,
        resolveUrl: ({ lastEventId }) => mintUrl(LIVE_ENDPOINTS, runId, lastEventId),
        onOpen: () => setError(null),
        onMessage: (e) => {
          const env = parseEnvelope(String(e.data));
          if (!env) return false;
          lastSeq = Math.max(lastSeq, env.seq);
          syncNow = noteArrival(syncNow, env, Date.now());
          batcher.push(env);
          if (syncNow.settledSeq !== null && lastSeq >= syncNow.settledSeq) setLoaded(true);
          if (lastSeq >= stopAt) {
            // caught up with what the run had recorded: ask it once what comes next
            stopAt = Infinity;
            ask();
          }
          return true;
        },
        // the stream closed without the run being done: ask the run before the helper reconnects
        onRetry: ask,
        onGiveUp: () => {
          // the helper stopped reconnecting: drop its handle and look again later, so the run's state can reopen
          // the stream (from the last seq received) once bh-api answers
          if (handle === stream) handle = null;
          setLoaded(true);
          setError("the run's event stream could not be read; trying again");
          if (live) schedulePark();
        },
      });
      handle = stream;
    };

    // the first read sets the history boundary; until it succeeds nothing streams, and it is tried again
    const start = () => {
      readRun(runId)
        .then((run) => {
          if (!live) return;
          setError(null);
          syncNow = { ...NEW_SYNC, settledSeq: run.seq };
          setSync(syncNow);
          decide(run);
        })
        .catch((e: unknown) => {
          if (!live) return;
          setLoaded(true);
          setError(`${e instanceof Error ? e.message : "the run's snapshot could not be read"}; trying again`);
          window.clearTimeout(parkTimer);
          parkTimer = window.setTimeout(start, START_RETRY_MS);
        });
    };
    start();
    return () => {
      live = false;
      window.clearTimeout(parkTimer);
      handle?.close();
      batcher.dispose();
    };
  }, [runId, enabled]);

  const record = useMemo(() => foldOffice(envs), [envs]);
  return { record, envs, sync, loaded, error };
}
