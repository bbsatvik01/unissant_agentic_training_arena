/**
 * `/review` and `/admin` (S6 2.2, 4.12, 4.13): the trainer and admin consoles, which act only on the referee
 * origin. The shell boots from this origin's own `GET /api/me`; on the arena-api origin (its `/api/me` carries the
 * investigator's acknowledgement field) the page reads "Not available here" and makes no review or admin request
 * (FE-REV-4, FE-ADM-1). A user without the console's role sees that instead.
 */
import { useEffect, useMemo, useState } from "react";

import { AdminConsole } from "../components/console/AdminConsole";
import { TrainerConsole } from "../components/console/TrainerConsole";
import { createApiClient, type Me } from "../lib/api/client";
import { createConsoleApi } from "../lib/api/console";
import { useAdmin } from "./console/useAdmin";
import { useReview } from "./console/useReview";

type Boot = { readonly state: "loading" } | { readonly state: "failed" } | { readonly state: "ready"; readonly me: Me };

export function ConsoleRoute({ kind }: { kind: "review" | "admin" }) {
  const api = useMemo(() => createConsoleApi(createApiClient()), []);
  const [boot, setBoot] = useState<Boot>({ state: "loading" });
  useEffect(() => {
    let cancelled = false;
    api.me().then(
      (me) => {
        if (!cancelled) setBoot({ state: "ready", me });
      },
      () => {
        if (!cancelled) setBoot({ state: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  const role = kind === "review" ? "trainer" : "admin";
  const allowed = boot.state === "ready" && boot.me.console && boot.me.roles.includes(role);
  const review = useReview(api, allowed && kind === "review");
  const admin = useAdmin(api, allowed && kind === "admin");
  const title = kind === "review" ? "Trainer console" : "Admin console";

  return (
    <div className="console-page">
      <header className="console-top">
        <span className="eyebrow">Training arena</span>
        <h1>{title}</h1>
        {boot.state === "ready" && allowed ? <span className="fine">{boot.me.display_name}</span> : null}
      </header>
      {boot.state === "loading" ? <p className="fine">Loading.</p> : null}
      {boot.state === "failed" ? <p className="empty">Your account could not be read on this server.</p> : null}
      {boot.state === "ready" && !boot.me.console ? (
        <div className="panel console-card">
          <p className="empty">Not available here.</p>
          <p className="fine">The {kind === "review" ? "trainer" : "admin"} console runs on the referee&apos;s own address on this machine.</p>
        </div>
      ) : null}
      {boot.state === "ready" && boot.me.console && !allowed ? <p className="empty">Your account does not have access to the {title.toLowerCase()}.</p> : null}
      {allowed && kind === "review" ? (
        <TrainerConsole
          items={review.items}
          listFailed={review.listFailed}
          selected={review.selected}
          item={review.item}
          itemFailed={review.itemFailed}
          draft={review.draft}
          submit={review.submit}
          onSelect={review.select}
          onEdit={review.edit}
          onSubmit={review.send}
        />
      ) : null}
      {allowed && kind === "admin" ? <AdminConsole budget={admin.budget} tournaments={admin.tournaments} preconditions={admin.preconditions} busy={admin.busy} message={admin.message} onAction={admin.act} /> : null}
    </div>
  );
}

export function ReviewRoute() {
  return <ConsoleRoute kind="review" />;
}

export function AdminRoute() {
  return <ConsoleRoute kind="admin" />;
}
