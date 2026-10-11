/**
 * The arena (S6 4.9, 4.10; stage 2): the leaderboards and the tournament matrix, over the precinct. Built against
 * the WP-16 board bodies and the tournament poll shape; until `GET /api/leaderboards/{id}` and
 * `GET /api/tournaments/{id}/events` land it shows the bundled example data, labeled as such. Ranks, eligibility,
 * intervals and states are the server's; the client draws them (rank intervals draw in at their endpoints) and never
 * re-ranks. EX-4 and the EVL-10 sentence head the view.
 */
import { useState } from "react";

import { EX4_TEXT } from "../../lib/copy/ex4";
import { metricText, rankBar, type Board } from "../../lib/arena/leaderboard";
import { cellState, matrix, type TournamentState } from "../../lib/arena/tournament";
import { Tabs } from "./Tabs";

export const NOT_CERTIFICATION = "A tournament rank is not certification for real investigations.";

function AssistantBoard({ board, motionOff }: { board: Board; motionOff: boolean }) {
  // The scale runs to the last rank any interval reaches (an interval can be wider than the ranked count).
  const ranked = Math.max(board.rows.filter((r) => r.rank !== null).length, ...board.rows.map((r) => r.rankInterval?.hi ?? 0));
  return (
    <table className="board">
      <caption className="fine">
        Assistant board, {board.status}. Ranked by deceptive-role recall, then questioning quality, among eligible candidates; the bar is the rank interval.
      </caption>
      <thead>
        <tr>
          <th scope="col">Rank</th>
          <th scope="col">Coach</th>
          <th scope="col">Eligibility</th>
          <th scope="col">Rank interval</th>
          <th scope="col">Recall (M01)</th>
          <th scope="col">False positives (M02)</th>
          <th scope="col">Precision (M03)</th>
          <th scope="col">Questioning (M09)</th>
        </tr>
      </thead>
      <tbody>
        {board.rows.map((r) => {
          const bar = r.rankInterval === null ? null : rankBar(r.rankInterval, Math.max(1, ranked));
          return (
            <tr key={r.candidate_id}>
              <td className="mono">{r.rank === null ? "not ranked" : r.rank}</td>
              <td>
                {r.display_name} <span className="mono fine">{r.candidate_id}</span>
              </td>
              <td>
                {r.eligible === null ? "not computed" : r.eligible ? "eligible" : `ineligible${r.reason === null ? "" : ` (${r.reason.replaceAll("_", " ")})`}`}
                {r.provisional ? ", provisional" : ""}
              </td>
              <td>
                {bar === null || r.rankInterval === null ? (
                  "none"
                ) : (
                  <span className="rank-interval" role="img" aria-label={`Ranks ${String(r.rankInterval.lo)} to ${String(r.rankInterval.hi)}`}>
                    <span className="rank-bar" data-animate={motionOff ? "false" : "true"} style={{ left: `${String(bar.left * 100)}%`, width: `${String(bar.width * 100)}%` }} />
                  </span>
                )}
              </td>
              <td>{metricText(r.metrics["M01_deceptive_recall"])}</td>
              <td>{metricText(r.metrics["M02_false_positive_rate"])}</td>
              <td>{metricText(r.metrics["M03_ppv"])}</td>
              <td>{metricText(r.metrics["M09_questioning_quality"])}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SubjectBoard({ board }: { board: Board }) {
  return (
    <table className="board">
      <caption className="fine">Subject board, {board.status}: subjects are compared, not ranked.</caption>
      <thead>
        <tr>
          <th scope="col">Subject</th>
          <th scope="col">Fidelity (M12)</th>
          <th scope="col">Invalid sessions (M13)</th>
          <th scope="col">Deceptive success (M14)</th>
        </tr>
      </thead>
      <tbody>
        {board.rows.map((r) => (
          <tr key={r.candidate_id}>
            <td>
              {r.display_name} <span className="mono fine">{r.candidate_id}</span>
            </td>
            <td>{metricText(r.metrics["M12_subject_fidelity"])}</td>
            <td>{metricText(r.metrics["M13_invalid_session_rate"])}</td>
            <td>{metricText(r.metrics["M14_deceptive_success"])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Matrix({ tournament }: { tournament: TournamentState }) {
  if (tournament.visibility === "counts") {
    return (
      <table className="board">
        <caption className="fine">Hidden tournament before reveal: progress counts only.</caption>
        <thead>
          <tr>
            <th scope="col">Track</th>
            <th scope="col">Block</th>
            <th scope="col">Planned</th>
            <th scope="col">By state</th>
          </tr>
        </thead>
        <tbody>
          {tournament.progress.map((p) => (
            <tr key={`${p.track}-${String(p.block)}`}>
              <td>{p.track.replaceAll("_", " ")}</td>
              <td>{p.block ?? "none"}</td>
              <td>{p.planned}</td>
              <td>
                {Object.entries(p.counts_by_state)
                  .map(([k, n]) => `${k.replaceAll("_", " ")} ${String(n)}`)
                  .join(", ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <div className="matrix" role="table" aria-label="Tournament trials by pairing">
      {matrix(tournament).map((row) => (
        <div key={row.pairing} className="matrix-row" role="row">
          <span className="mono matrix-pairing" role="rowheader">
            {row.pairing}
          </span>
          {row.cells.map((c) => {
            const state = cellState(c);
            return (
              <span key={c.trial_ref} className="matrix-cell" role="cell" data-state={state.replaceAll(" ", "_")} title={`Trial ${String(c.trial_ref)}, block ${String(c.block)}: ${state}`}>
                <span className="mono">#{c.trial_ref}</span> {state}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function ArenaView(props: {
  readonly name: string;
  readonly example: boolean;
  readonly assistant: Board | null;
  readonly subject: Board | null;
  readonly tournament: TournamentState;
  readonly motionOff: boolean;
  readonly onClose: () => void;
}) {
  const [tab, setTab] = useState("leaderboard");
  return (
    <div className="arena-view" role="dialog" aria-labelledby="arena-title">
      <header className="panel-head">
        <h2 id="arena-title">{props.name}</h2>
        <button type="button" className="btn-secondary-sm" onClick={props.onClose}>
          Close
        </button>
      </header>
      <div className="debrief-intro">
        <p className="fine">
          {EX4_TEXT} {NOT_CERTIFICATION}
        </p>
        {props.example ? <p className="fine">Example data until the leaderboard and tournament routes are live. Not a result.</p> : null}
      </div>
      <Tabs
        label="Arena views"
        value={tab}
        onChange={setTab}
        tabs={[
          {
            id: "leaderboard",
            label: "Leaderboards",
            content: (
              <>
                {props.assistant === null ? <p className="empty">No assistant board published yet.</p> : <AssistantBoard board={props.assistant} motionOff={props.motionOff} />}
                {props.subject === null ? null : <SubjectBoard board={props.subject} />}
              </>
            ),
          },
          { id: "tournament", label: "Tournament", content: <Matrix tournament={props.tournament} /> },
        ]}
      />
    </div>
  );
}
