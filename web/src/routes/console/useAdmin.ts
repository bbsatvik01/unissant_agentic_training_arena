/**
 * The admin console's data (S6 4.13): budget and tournaments read once, each tournament's detail (progress per
 * track and block, the open review count, and the reveal preconditions), and one lifecycle action at a time (each POST carries the referee's CSRF token through
 * the client). A 404 means the server does not offer that route yet, which the console says plainly.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "../../lib/api/client";
import type { ConsoleApi } from "../../lib/api/console";
import { parseBudget, parseTournamentDetail, parseTournaments, parseValidityReviews, verdictBody, type AdminAction, type AdminTournament, type BudgetRow, type TournamentDetail, type ValidityReview } from "../../lib/console/admin";
import type { Section } from "../../components/console/AdminConsole";

function failed(e: unknown): Section<never> {
  return e instanceof ApiError && e.status === 404 ? { state: "missing" } : { state: "error" };
}

/** What the admin reads when a POST fails: a missing route, or the refusal with the server's own reason (the
 * referee's `detail`, for example which reveal check is not met), cut to a readable length. */
function refusal(e: unknown, refused: string): string {
  if (e instanceof ApiError && e.status === 404) return "The server does not offer this action yet.";
  const reason = e instanceof ApiError ? e.code : null;
  return reason === null || reason === "" ? refused : `${refused} Reason: ${reason.length > 300 ? `${reason.slice(0, 300)}...` : reason}`;
}

export function useAdmin(api: Pick<ConsoleApi, "adminBudget" | "adminTournaments" | "adminTournament" | "adminAction" | "adminReviews" | "adminVerdict">, enabled: boolean) {
  const [budget, setBudget] = useState<Section<readonly BudgetRow[]>>({ state: "loading" });
  const [tournaments, setTournaments] = useState<Section<readonly AdminTournament[]>>({ state: "loading" });
  // Each tournament's detail by id, as a section of its own (a missing route or a failed read says so).
  const [details, setDetails] = useState<Readonly<Record<string, Section<TournamentDetail>>>>({});
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
          adminTournament(t.id).then(
            (raw) => {
              if (cancelled) return;
              const detail = parseTournamentDetail(raw);
              setDetails((m) => ({ ...m, [t.id]: detail === null ? { state: "error" } : { state: "ready", value: detail } }));
            },
            (e: unknown) => {
              if (!cancelled) setDetails((m) => ({ ...m, [t.id]: failed(e) }));
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
          setMessage(refusal(e, "The server refused the action; the tournament is unchanged."));
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
          setMessage(refusal(e, "The server refused the verdict."));
        },
      );
    },
    [adminVerdict],
  );

  return { budget, tournaments, details, reviews, busy, message, act, decide };
}
