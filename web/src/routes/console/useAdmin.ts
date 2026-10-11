/**
 * The admin console's data (S6 4.13): budget and tournaments read once, the reveal preconditions of each
 * tournament in scoring, and one lifecycle action at a time (each POST carries the referee's CSRF token through
 * the client). A 404 means the server does not offer that route yet, which the console says plainly.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "../../lib/api/client";
import type { ConsoleApi } from "../../lib/api/console";
import { parseBudget, parsePreconditions, parseTournaments, parseValidityReviews, verdictBody, type AdminAction, type AdminTournament, type BudgetRow, type Precondition, type ValidityReview } from "../../lib/console/admin";
import type { Section } from "../../components/console/AdminConsole";

function failed(e: unknown): Section<never> {
  return e instanceof ApiError && e.status === 404 ? { state: "missing" } : { state: "error" };
}

export function useAdmin(api: Pick<ConsoleApi, "adminBudget" | "adminTournaments" | "adminTournament" | "adminAction" | "adminReviews" | "adminVerdict">, enabled: boolean) {
  const [budget, setBudget] = useState<Section<readonly BudgetRow[]>>({ state: "loading" });
  const [tournaments, setTournaments] = useState<Section<readonly AdminTournament[]>>({ state: "loading" });
  const [preconditions, setPreconditions] = useState<Readonly<Record<string, readonly Precondition[] | null>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reviews, setReviews] = useState<Section<readonly ValidityReview[]>>({ state: "loading" });
  const [round, setRound] = useState(0);
  const { adminBudget, adminTournaments, adminTournament, adminAction, adminReviews, adminVerdict } = api;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    adminBudget().then(
      (raw) => {
        if (cancelled) return;
        const rows = parseBudget(raw);
        setBudget(rows === null ? { state: "error" } : { state: "ready", value: rows });
      },
      (e: unknown) => {
        if (!cancelled) setBudget(failed(e));
      },
    );
    adminReviews().then(
      (raw) => {
        if (cancelled) return;
        const list = parseValidityReviews(raw);
        setReviews(list === null ? { state: "error" } : { state: "ready", value: list });
      },
      (e: unknown) => {
        if (!cancelled) setReviews(failed(e));
      },
    );
    adminTournaments().then(
      (raw) => {
        if (cancelled) return;
        const list = parseTournaments(raw);
        setTournaments(list === null ? { state: "error" } : { state: "ready", value: list });
        for (const t of list ?? []) {
          if (t.status !== "scoring") continue;
          adminTournament(t.id).then(
            (detail) => {
              if (!cancelled) setPreconditions((m) => ({ ...m, [t.id]: parsePreconditions(detail) }));
            },
            () => {
              if (!cancelled) setPreconditions((m) => ({ ...m, [t.id]: null }));
            },
          );
        }
      },
      (e: unknown) => {
        if (!cancelled) setTournaments(failed(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [adminBudget, adminTournaments, adminTournament, adminReviews, enabled, round]);

  const act = useCallback(
    (tournamentId: string, action: AdminAction) => {
      setBusy(tournamentId);
      setMessage(null);
      adminAction(tournamentId, action).then(
        () => {
          setBusy(null);
          setMessage("Done.");
          setRound((r) => r + 1);
        },
        (e: unknown) => {
          setBusy(null);
          setMessage(e instanceof ApiError && e.status === 404 ? "The server does not offer this action yet." : "The server refused the action; the tournament is unchanged.");
        },
      );
    },
    [adminAction],
  );

  // One idempotency key per trial and verdict, kept across retries so a resent verdict is the same request.
  const keys = useRef(new Map<string, string>());
  const decide = useCallback(
    (review: ValidityReview, verdict: "valid" | "subject_invalid", reason: string) => {
      const slot = `${review.trial_id}:${verdict}`;
      const key = keys.current.get(slot) ?? crypto.randomUUID();
      keys.current.set(slot, key);
      const body = verdictBody(review, verdict, reason, key);
      if (body === null) {
        setMessage("A verdict needs a reason and the referee's report.");
        return;
      }
      setBusy(review.trial_id);
      setMessage(null);
      adminVerdict(review.trial_id, body).then(
        () => {
          setBusy(null);
          setMessage("Verdict recorded.");
          setRound((r) => r + 1);
        },
        (e: unknown) => {
          setBusy(null);
          setMessage(e instanceof ApiError && e.status === 404 ? "The server does not offer this action yet." : "The server refused the verdict.");
        },
      );
    },
    [adminVerdict],
  );

  return { budget, tournaments, preconditions, reviews, busy, message, act, decide };
}
