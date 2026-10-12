/**
 * The progress page's data (S6 4.8): `GET /api/progress` when the page opens, then each ended session's published
 * debrief (`GET /api/sessions/{id}/debrief`) for its scores. A 404 means the server has no progress route yet, which
 * the page says plainly.
 */
import { useEffect, useState } from "react";

import type { ArenaApi } from "../../lib/api/arena";
import { ApiError } from "../../lib/api/client";
import { parseProgress, scoreOf, sessionEnded, type ProgressLoad, type ScoreState } from "../../lib/progress/progress";

export function useProgress(api: Pick<ArenaApi, "progress" | "readDebrief">, open: boolean): { load: ProgressLoad; scores: Readonly<Record<string, ScoreState>> } {
  const [load, setLoad] = useState<ProgressLoad>({ state: "loading" });
  const [scores, setScores] = useState<Readonly<Record<string, ScoreState>>>({});
  // The two reads, not the object holding them, so a caller's fresh object does not re-run the effect.
  const { progress: readProgress, readDebrief } = api;
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    readProgress().then(
      (raw) => {
        if (cancelled) return;
        const progress = parseProgress(raw);
        setLoad(progress === null ? { state: "error" } : { state: "ready", progress });
        for (const s of progress?.sessions ?? []) {
          if (!sessionEnded(s)) continue;
          readDebrief(s.session_id).then(
            (d) => {
              if (!cancelled) setScores((m) => ({ ...m, [s.session_id]: "status" in d ? "scoring" : scoreOf(d) }));
            },
            () => {
              if (!cancelled) setScores((m) => ({ ...m, [s.session_id]: "none" }));
            },
          );
        }
      },
      (e: unknown) => {
        if (!cancelled) setLoad(e instanceof ApiError && e.status === 404 ? { state: "missing" } : { state: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [readProgress, readDebrief, open]);
  return { load, scores };
}
