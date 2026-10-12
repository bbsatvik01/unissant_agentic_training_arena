/**
 * The admin console (S6 4.13), on the referee origin: the kill switch, read-only, with the owner's command beside
 * it; the budget rows (ceiling, liability, open reservations, headroom); and the tournaments, each with the one
 * transition its state allows, its progress per track and block (counts only) and its open reviews. Reveal lists the server's preconditions and is enabled only when every one passes
 * (FE-ADM-2). No infra control (workers, instances, timeouts, health checks) and no ceiling editor appear here.
 * A section whose route the server does not offer yet says so.
 */
import { useState } from "react";

import type { AdminAction, AdminTournament, BudgetRow, CompliancePacket, ProgressCount, TournamentDetail, ValidityReview } from "../../lib/console/admin";
import { killSwitchOf, nextAction, revealAllowed, reviewable } from "../../lib/console/admin";
import { ContentView } from "./TrainerConsole";

export type Section<T> = { readonly state: "loading" } | { readonly state: "missing" } | { readonly state: "error" } | { readonly state: "ready"; readonly value: T };

interface AdminConsoleProps {
  readonly budget: Section<readonly BudgetRow[]>;
  readonly tournaments: Section<readonly AdminTournament[]>;
  /** Each tournament's detail by id (progress, open reviews, reveal preconditions); null when it could not be read. */
  readonly details: Readonly<Record<string, TournamentDetail | null>>;
  readonly reviews: Section<readonly ValidityReview[]>;
  readonly busy: string | null;
  readonly message: string | null;
  readonly onAction: (tournamentId: string, action: AdminAction) => void;
  readonly onVerdict: (review: ValidityReview, verdict: "valid" | "subject_invalid", reason: string) => void;
}

const TRACK_LABEL: Readonly<Record<ProgressCount["track"], string>> = { interactive: "Interactive", replay: "Replay", replay_corpus: "Replay corpus" };

function ProgressTable({ rows }: { rows: readonly ProgressCount[] }) {
  if (rows.length === 0) return <p className="fine">No planned trials.</p>;
  return (
    <table className="board progress-counts">
      <caption className="fine">Progress by track and block: counts only</caption>
      <thead>
        <tr>
          <th scope="col">Track</th>
          <th scope="col">Block</th>
          <th scope="col">Planned</th>
          <th scope="col">Running</th>
          <th scope="col">Ended</th>
          <th scope="col">By state</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.track}-${String(r.block)}`}>
            <td>{TRACK_LABEL[r.track]}</td>
            <td className="mono">{r.block ?? "none"}</td>
            <td className="mono">{r.planned}</td>
            <td className="mono">{r.running}</td>
            <td className="mono">{r.ended}</td>
            <td>{r.states.length === 0 ? "none yet" : r.states.map((x) => `${x.state} ${String(x.n)}`).join(", ")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Ids({ ids }: { ids: readonly string[] }) {
  return <span className="mono">{ids.join(", ")}</span>;
}

/** The private packet the subject was given, which compliance is judged against (S3 4.2 item 2). The facts the
 * referee says a turn contradicts are marked. */
function PacketView({ packet, violated }: { packet: CompliancePacket; violated: ReadonlySet<string> }) {
  return (
    <div className="review-packet">
      <h4 className="eyebrow">Private packet{packet.role === null ? "" : `: ${packet.role} role`}</h4>
      {packet.persona === null ? null : (
        <p>
          <strong>{packet.persona.name}</strong>, {packet.persona.position}
          {packet.persona.unit === null ? "" : `, ${packet.persona.unit}`}
          {packet.persona.organization === "" ? "" : `, ${packet.persona.organization}`}. <span className="fine">{packet.persona.background}</span>
        </p>
      )}
      {packet.matter === null ? null : (
        <p className="fine">
          <strong>Matter:</strong> {packet.matter}
        </p>
      )}
      {packet.objective === null ? null : (
        <p className="fine">
          <strong>Instruction:</strong> {packet.objective}
        </p>
      )}
      {packet.facts.length === 0 ? null : (
        <table className="board packet-facts">
          <caption className="fine">Facts the subject holds; a marked fact is one the referee says a turn contradicts</caption>
          <thead>
            <tr>
              <th scope="col">Fact</th>
              <th scope="col">Class</th>
              <th scope="col">Text</th>
              <th scope="col">Opened by</th>
            </tr>
          </thead>
          <tbody>
            {packet.facts.map((f) => (
              <tr key={f.id} data-violated={violated.has(f.id) ? "true" : "false"}>
                <td className="mono">
                  {f.id}
                  {violated.has(f.id) ? " (contradicted)" : ""}
                </td>
                <td className="mono">{f.cls}</td>
                <td>{f.text}</td>
                <td className="mono">{f.gate ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {packet.gates.length === 0 ? null : (
        <ul className="fine">
          {packet.gates.map((g) => (
            <li key={g.id}>
              <span className="mono">{g.id}</span> {g.condition} Opens <Ids ids={g.opens} />; needs <Ids ids={g.records} />.
            </li>
          ))}
        </ul>
      )}
      {packet.unknown.length === 0 ? null : (
        <ul className="fine">
          {packet.unknown.map((u) => (
            <li key={u.fact_id}>
              <span className="mono">{u.fact_id}</span> {u.text}
            </li>
          ))}
        </ul>
      )}
      {packet.uncertainty.length === 0 ? null : (
        <ul className="fine">
          {packet.uncertainty.map((u) => (
            <li key={u.id}>
              <span className="mono">{u.id}</span> on <span className="mono">{u.fact_id}</span>: {u.text}
              {u.range === null ? "" : ` Allowed answer: ${u.range}`}
            </li>
          ))}
        </ul>
      )}
      {packet.assertions.length === 0 ? null : (
        <ul className="fine">
          {packet.assertions.map((a) => (
            <li key={a.id}>
              <span className="mono">{a.id}</span> Must never say: &quot;{a.text}&quot; (contradicts <span className="mono">{a.contradicts}</span>)
            </li>
          ))}
        </ul>
      )}
      <p className="fine">
        Allowed: {packet.permitted.length === 0 ? "none" : packet.permitted.join(", ")}. Forbidden: {packet.forbidden.length === 0 ? "none" : packet.forbidden.join(", ")}.
        {packet.style.length === 0 ? "" : ` Style: ${packet.style.map((x) => `${x.axis} ${x.level}`).join(", ")}.`}
        {packet.maxExchanges === null ? "" : ` At most ${String(packet.maxExchanges)} exchanges.`}
      </p>
    </div>
  );
}

function ReviewRow({ review, n, tournament, busy, onVerdict }: { review: ValidityReview; n: number; tournament: string | null; busy: boolean; onVerdict: AdminConsoleProps["onVerdict"] }) {
  const [reason, setReason] = useState("");
  const ready = reviewable(review);
  const blocked = busy || !ready || reason.trim() === "";
  return (
    <div className="console-tournament">
      <p>
        <strong>Trial {n}</strong> <span className="fine">automatic proposal: {review.proposed === null ? "none" : review.proposed.replace("_", " ")}</span>
        {tournament === null ? null : <span className="fine"> in {tournament}</span>}
      </p>
      {review.reasons.length === 0 ? null : (
        <ul className="checks">
          {review.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <details className="validity-evidence">
        <summary>Evidence: questions and subject turns, records, private packet, the referee&apos;s per-turn evidence</summary>
        <ol className="review-transcript">
          {review.transcript.map((t) => (
            <li key={t.turn_no}>
              <span className="mono">T{t.turn_no}</span>
              <p className="line">
                <span className="speaker">Question</span>
                {t.question}
              </p>
              {t.answer === null ? null : (
                <p className="line">
                  <span className="speaker">Subject</span>
                  {t.answer}
                </p>
              )}
            </li>
          ))}
        </ol>
        {review.released.map((r) => (
          <div key={r.record_id}>
            <p className="fine">
              <span className="mono">{r.record_id}</span> {r.title}
            </p>
            <ContentView content={r.content} />
          </div>
        ))}
        {review.packet !== null ? <PacketView packet={review.packet} violated={new Set(review.evidence.flatMap((e) => e.violated_fact_ids))} /> : null}
        {review.packet !== null || review.facts.length === 0 ? null : (
          <ul>
            {review.facts.map((f) => (
              <li key={f.id}>
                <span className="mono">{f.id}</span> {f.text}
              </li>
            ))}
          </ul>
        )}
        {review.evidence.map((e) => (
          <p key={e.turn_id} className="fine">
            <span className="mono">{e.turn_id.toUpperCase()}</span> &quot;{e.evidence_quote}&quot;; failed: {e.failed_checks.join(", ") || "none"}
            {e.violated_fact_ids.length === 0 ? "" : `; contradicts ${e.violated_fact_ids.join(", ")}`}
          </p>
        ))}
      </details>
      {ready ? null : <p className="fine">The evidence for this trial is not available; no verdict can be recorded.</p>}
      <label className="field">
        <span>Reason</span>
        <input
          type="text"
          value={reason}
          maxLength={300}
          onChange={(e) => {
            setReason(e.target.value);
          }}
        />
      </label>
      <div className="start-row">
        <button
          type="button"
          className="btn-secondary-sm"
          disabled={blocked}
          onClick={() => {
            onVerdict(review, "valid", reason);
          }}
        >
          Valid
        </button>
        <button
          type="button"
          className="btn-secondary-sm"
          disabled={blocked}
          onClick={() => {
            onVerdict(review, "subject_invalid", reason);
          }}
        >
          Subject invalid
        </button>
      </div>
    </div>
  );
}

function Unavailable({ section }: { section: Section<unknown> }) {
  if (section.state === "loading") return <p className="fine">Loading.</p>;
  if (section.state === "missing") return <p className="empty">The server does not offer this yet.</p>;
  if (section.state === "error") return <p className="empty">This could not be read.</p>;
  return null;
}

export function AdminConsole({ budget, tournaments, details, reviews, busy, message, onAction, onVerdict }: AdminConsoleProps) {
  const kill = budget.state === "ready" ? killSwitchOf(budget.value) : null;
  return (
    <main className="console-admin">
      <section className="panel console-card" aria-labelledby="kill-title">
        <header className="panel-head">
          <h2 id="kill-title">Kill switch</h2>
        </header>
        <div className="panel-body">
          <p>
            {kill === null ? "State unknown." : kill ? <strong>On: no model call or voice session can start.</strong> : "Off."}
          </p>
          <p className="fine">
            Read-only here. The owner sets it from the operator shell: <code className="mono">scripts/kill_switch.sh on</code> or <code className="mono">scripts/kill_switch.sh off</code>.
          </p>
        </div>
      </section>
      <section className="panel console-card" aria-labelledby="budget-title">
        <header className="panel-head">
          <h2 id="budget-title">Budget</h2>
        </header>
        <div className="panel-body">
          <Unavailable section={budget} />
          {budget.state === "ready" ? (
            <table className="board">
              <thead>
                <tr>
                  <th scope="col">Bucket</th>
                  <th scope="col">Ceiling</th>
                  <th scope="col">Committed</th>
                  <th scope="col">Open reservations</th>
                  <th scope="col">Headroom</th>
                </tr>
              </thead>
              <tbody>
                {budget.value.map((r) => (
                  <tr key={r.bucket}>
                    <td className="mono">{r.bucket}</td>
                    <td>{r.ceiling}</td>
                    <td>{r.liability}</td>
                    <td>{r.open}</td>
                    <td>{r.headroom}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <p className="fine">Ceilings are applied by the operator from the budget plan; they are not edited here.</p>
        </div>
      </section>
      <section className="panel console-card" aria-labelledby="validity-title">
        <header className="panel-head">
          <h2 id="validity-title">Subject validity reviews</h2>
        </header>
        <div className="panel-body">
          <p className="fine">Blinded: the coach, its cards and its finding are not shown, so a verdict cannot depend on them. Every verdict needs a reason and cites the referee&apos;s report.</p>
          <Unavailable section={reviews} />
          {reviews.state === "ready" && reviews.value.length === 0 ? <p className="empty">No reviews waiting.</p> : null}
          {reviews.state === "ready"
            ? reviews.value.map((r, i) => (
                <ReviewRow key={r.trial_id} review={r} n={i + 1} tournament={tournaments.state === "ready" ? (tournaments.value.find((t) => t.id === r.tournament_id)?.name ?? null) : null} busy={busy !== null} onVerdict={onVerdict} />
              ))
            : null}
        </div>
      </section>
      <section className="panel console-card" aria-labelledby="tour-title">
        <header className="panel-head">
          <h2 id="tour-title">Tournaments</h2>
        </header>
        <div className="panel-body">
          <Unavailable section={tournaments} />
          {message === null ? null : (
            <p className="fine" role="status">
              {message}
            </p>
          )}
          {tournaments.state === "ready" && tournaments.value.length === 0 ? <p className="empty">No tournaments.</p> : null}
          {tournaments.state === "ready"
            ? tournaments.value.map((t) => {
                const next = nextAction(t.status);
                const detail = details[t.id] ?? null;
                const pre = detail?.preconditions ?? null;
                const blocked = next?.action === "reveal" && !revealAllowed(pre);
                return (
                  <div key={t.id} className="console-tournament">
                    <p>
                      <strong>{t.name}</strong> <span className="fine">{t.split} split, {t.status}</span>
                      {detail?.reviewQueue === null || detail?.reviewQueue === undefined ? null : (
                        <span className="fine">
                          , {detail.reviewQueue === 0 ? "no reviews waiting" : `${String(detail.reviewQueue)} review${detail.reviewQueue === 1 ? "" : "s"} waiting`}
                        </span>
                      )}
                    </p>
                    {detail?.progress === null || detail?.progress === undefined ? null : <ProgressTable rows={detail.progress} />}
                    {next?.action === "reveal" ? (
                      <ul className="checks">
                        {pre === null ? <li>The server has not reported the reveal preconditions.</li> : null}
                        {pre?.map((p) => (
                          <li key={p.name} data-result={p.passed ? "pass" : "fail"}>
                            {p.name}: {p.passed ? "met" : "not met"}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {next === null ? null : (
                      <button
                        type="button"
                        className={next.action === "reveal" ? "btn-primary" : "btn-secondary-sm"}
                        disabled={blocked || busy !== null}
                        onClick={() => {
                          onAction(t.id, next.action);
                        }}
                      >
                        {busy === t.id ? "Working" : next.label}
                      </button>
                    )}
                  </div>
                );
              })
            : null}
        </div>
      </section>
    </main>
  );
}
