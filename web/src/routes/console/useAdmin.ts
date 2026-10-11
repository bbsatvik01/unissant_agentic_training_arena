/**
 * The admin console's data (S6 4.13): budget and tournaments read once, the reveal preconditions of each
 * tournament in scoring, and one lifecycle action at a time (each POST carries the referee's CSRF token through
 * the client). A 404 means the server does not offer that route yet, which the console says plainly.
 */
import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../../lib/api/client";
import type { ConsoleApi } from "../../lib/api/console";
import { parseBudget, parsePreconditions, parseTournaments, type AdminAction, type AdminTournament, type BudgetRow, type Precondition } from "../../lib/console/admin";
import type { Section } from "../../components/console/AdminConsole";

function failed(e: unknown): Section<never> {
  return e instanceof ApiError && e.status === 404 ? { state: "missing" } : { state: "error" };
}

export function useAdmin(api: Pick<ConsoleApi, "adminBudget" | "adminTournaments" | "adminTournament" | "adminAction">, enabled: boolean) {
  const [budget, setBudget] = useState<Section<readonly BudgetRow[]>>({ state: "loading" });
  const [tournaments, setTournaments] = useState<Section<readonly AdminTournament[]>>({ state: "loading" });
  const [preconditions, setPreconditions] = useState<Readonly<Record<string, readonly Precondition[] | null>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const { adminBudget, adminTournaments, adminTournament, adminAction } = api;

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
  }, [adminBudget, adminTournaments, adminTournament, enabled, round]);

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

  return { budget, tournaments, preconditions, busy, message, act };
}
