/**
 * The arena's tournament data (S6 4.9): the tournament list once the arena opens, and for the selected tournament
 * its state (`GET /api/tournaments/{id}`) then the poll on the global ledger cursor
 * (`GET /api/tournaments/{id}/events?after=`), folded into the matrix. A full page is followed at once by the next
 * one; otherwise the poll repeats every 2 s while the tournament is running, sealed or scoring, and stops after the
 * response that reports a state that needs no polling (`nextPoll`). No request leaves while the tab is hidden: a
 * poll that falls due then waits for the tab to be visible again. A 404 means the server does not offer the
 * route yet, which the arena says plainly; nothing else stands in for the data.
 */
import { useEffect, useState } from "react";

import type { ArenaApi } from "../../lib/api/arena";
import { ApiError } from "../../lib/api/client";
import { EMPTY_TOURNAMENT, foldPoll, type TournamentState } from "../../lib/arena/tournament";
import { nextPoll, parseTournamentList, parseTournamentStatus, POLL_MS, POLL_PAGE, type TournamentListing } from "../../lib/arena/tournamentPoll";

export type TournamentLoad =
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | { readonly state: "missing" }
  | { readonly state: "error" }
  | { readonly state: "ready"; readonly tournament: TournamentState };

export type ListLoad = { readonly state: "idle" | "loading" | "missing" | "error" } | { readonly state: "ready"; readonly list: readonly TournamentListing[] };

function failure(e: unknown): { readonly state: "missing" } | { readonly state: "error" } {
  return e instanceof ApiError && e.status === 404 ? { state: "missing" } : { state: "error" };
}

export function useTournamentList(api: Pick<ArenaApi, "tournaments">, enabled: boolean): ListLoad {
  const [load, setLoad] = useState<ListLoad>({ state: "loading" });
  const { tournaments } = api;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    tournaments().then(
      (raw) => {
        if (cancelled) return;
        const list = parseTournamentList(raw);
        setLoad(list === null ? { state: "error" } : { state: "ready", list });
      },
      (e: unknown) => {
        if (!cancelled) setLoad(failure(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tournaments, enabled]);
  return enabled ? load : { state: "idle" };
}

export function useTournament(api: Pick<ArenaApi, "tournament" | "tournamentEvents">, tournamentId: string | null, enabled: boolean): TournamentLoad {
  // Each answer is kept with the tournament it is for, so a newly selected tournament reads as loading, never as
  // the previous one's data.
  const [held, setHeld] = useState<{ readonly id: string; readonly load: TournamentLoad } | null>(null);
  const { tournament: readTournament, tournamentEvents } = api;
  useEffect(() => {
    if (!enabled || tournamentId === null) return;
    const id = tournamentId;
    let cancelled = false;
    const setLoad = (load: TournamentLoad) => {
      setHeld({ id, load });
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    let folded: TournamentState = EMPTY_TOURNAMENT;
    // Whether the last answer was a full page: more frames are waiting, whatever the lifecycle state says.
    let more = false;
    let status: TournamentState["state"] = null;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", onVisible);
      poll();
    };
    const visible = () => document.visibilityState === "visible";
    const schedule = (more: boolean) => {
      const next = nextPoll(folded.state ?? status, visible(), more);
      if (next === "stop") return;
      if (next === "hidden") document.addEventListener("visibilitychange", onVisible);
      else timer = setTimeout(poll, next);
    };
    function poll() {
      timer = null;
      // Checked when the request would leave, not only when it was scheduled: the tab may have been hidden since.
      if (!visible()) {
        document.addEventListener("visibilitychange", onVisible);
        return;
      }
      tournamentEvents(id, folded.last).then(
        (answer) => {
          if (cancelled) return;
          folded = foldPoll(folded, answer);
          setLoad({ state: "ready", tournament: folded });
          more = answer.visibility === "events" && answer.frames.length >= POLL_PAGE;
          schedule(more);
        },
        (e: unknown) => {
          if (cancelled) return;
          // A failed poll after data keeps what was shown and tries again from the same cursor: on the lifecycle's
          // schedule, or in 2 s while pages are still waiting (a revealed tournament half drained is not done).
          // Before any data the failure is the arena's state; a 404 always means the route is not there.
          const f = failure(e);
          if (f.state === "missing" || folded === EMPTY_TOURNAMENT) setLoad(f);
          else if (more) timer = setTimeout(poll, POLL_MS);
          else schedule(false);
        },
      );
    }
    readTournament(id).then(
      (raw) => {
        if (cancelled) return;
        status = parseTournamentStatus(raw);
        poll();
      },
      (e: unknown) => {
        if (!cancelled) setLoad(failure(e));
      },
    );
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [readTournament, tournamentEvents, tournamentId, enabled]);
  if (!enabled || tournamentId === null) return { state: "idle" };
  return held !== null && held.id === tournamentId ? held.load : { state: "loading" };
}
