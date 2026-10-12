/**
 * The selected tournament's published leaderboards (`GET /api/leaderboards/{id}?board=`, WP-16) for the arena:
 * read when the arena opens, and read again when the tournament poll reports the tournament revealed while the
 * boards still read as sealed or missing, so a reveal shows its boards without a page reload. Reveal publishes in
 * the same call, but a board can trail it briefly: a revealed read that still finds none is tried again every 2 s,
 * at most `REVEAL_TRIES` times; a failed read (not a 404 or 409) is tried again the same way, and opening the arena
 * reads it once more. Before reveal the state is sealed and carries no numbers (FE-LB-5).
 */
import { useEffect, useState } from "react";

import type { ArenaApi } from "../../lib/api/arena";
import { ApiError } from "../../lib/api/client";
import { boardsFailure, parseBoard, type Board, type BoardsState } from "../../lib/arena/leaderboard";

export interface Boards {
  readonly assistant: Board | null;
  readonly subject: Board | null;
  readonly state: BoardsState;
}

export const REVEAL_TRIES = 5;
const RETRY_MS = 2000;

/** `round`: bump it to read again (the arena opening), so a board that failed to load is asked for anew. */
export function useBoards(api: Pick<ArenaApi, "leaderboard">, tournamentId: string | null, label: "original" | null, enabled: boolean, revealed: boolean, round = 0): Boards | null {
  const [held, setHeld] = useState<{ readonly key: string; readonly boards: Boards } | null>(null);
  const { leaderboard } = api;
  const key = `${tournamentId ?? ""}|${label ?? ""}`;
  useEffect(() => {
    if (!enabled || tournamentId === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = (tries: number) => {
      // A failure (a refused read, or a board in another shape): a transient one keeps the boards already shown
      // (the wall neither drops nor turns over again) and is tried again; a definite answer (sealed, missing)
      // replaces them, and is tried again only for a revealed tournament whose board has not appeared yet.
      const failed = (state: BoardsState) => {
        setHeld((h) => (state.kind === "error" && h !== null && h.key === key && h.boards.state.kind === "published" ? h : { key, boards: { assistant: null, subject: null, state } }));
        const again = state.kind === "error" || (revealed && (state.kind === "sealed" || state.kind === "missing"));
        if (again && tries + 1 < REVEAL_TRIES) {
          timer = setTimeout(() => {
            read(tries + 1);
          }, RETRY_MS);
        }
      };
      Promise.all([leaderboard(tournamentId, "assistant", label ?? undefined), leaderboard(tournamentId, "subject", label ?? undefined)]).then(
        ([a, s]) => {
          if (cancelled) return;
          const assistant = parseBoard(a);
          const subject = parseBoard(s);
          if (assistant === null || subject === null) failed({ kind: "error" });
          else setHeld({ key, boards: { assistant, subject, state: { kind: "published", tournamentId, label } } });
        },
        (e: unknown) => {
          if (!cancelled) failed(e instanceof ApiError ? boardsFailure(e.status, e.code) : { kind: "error" });
        },
      );
    };
    read(0);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [leaderboard, tournamentId, label, enabled, revealed, key, round]);
  return held !== null && held.key === key && tournamentId !== null ? held.boards : null;
}
