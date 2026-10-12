/**
 * The arena (S6 4.9, 4.10): the leaderboards and the tournament matrix, over the precinct. A selected tournament
 * (`?tournament=<id>`) shows its published boards and the matrix its poll builds; any visible trial in the matrix
 * replays in the interview room. Without a selection it lists the tournaments to choose from and shows the bundled
 * example data, labeled as such. Ranks, eligibility,
 * intervals and states are the server's; the client draws them (rank intervals draw in at their endpoints) and never
 * re-ranks. EX-4 and the EVL-10 sentence head the view.
 */
import { useState } from "react";

import { EX4_TEXT } from "../../lib/copy/ex4";
import { assistantDetails, countMatrix, subjectDetails, type DetailLine } from "../../lib/arena/details";
import { differenceText, fprGate, metricText, otherLabelHref, rankBar, rankStatus, type Board, type BoardRow, type BoardsState } from "../../lib/arena/leaderboard";
import { cellState, matrix, tracks, type Track, type TournamentState } from "../../lib/arena/tournament";
import type { TournamentListing } from "../../lib/arena/tournamentPoll";
import { Tabs } from "./Tabs";

export const NOT_CERTIFICATION = "A tournament rank is not certification for real investigations.";

/** A candidate's name and id; a board that publishes the id as the name shows it once. */
function Who({ row }: { row: BoardRow }) {
  if (row.display_name === row.candidate_id) return <span className="mono fine">{row.candidate_id}</span>;
  return (
    <>
      {row.display_name} <span className="mono fine">{row.candidate_id}</span>
    </>
  );
}

function Binding({ board }: { board: Board }) {
  return board.manifestHash === null ? (
    <p className="fine">Inclusion manifest not published.</p>
  ) : (
    <p className="fine binding">
      Bound to inclusion manifest{board.manifestVersion === null ? "" : ` version ${String(board.manifestVersion)}`}: <code className="mono hash">{board.manifestHash}</code>
    </p>
  );
}

function GatePanel({ board }: { board: Board }) {
  return (
    <section className="gates" aria-labelledby="gates-title">
      <h3 id="gates-title" className="eyebrow">
        Eligibility gates, before any rank
      </h3>
      <p className="fine">
        Isolation gate: {board.notRanked ? "failed" : "passed"}
        {board.isolationHash === null ? "" : ", evidence "}
        {board.isolationHash === null ? null : <code className="mono">{board.isolationHash.slice(0, 12)}</code>}. <a href="/trust/isolation">How isolation is checked</a>
      </p>
      <ul className="gate-list">
        {board.rows.map((r) => {
          const g = fprGate(r);
          return (
            <li key={r.candidate_id} data-gate={g.result.split(" ")[0]}>
              <span>
                <Who row={r} />
              </span>
              <span>
                False-positive rate {g.fpr}; sponsor gate at or below 5%: {g.result}
                {g.bound === null ? "" : `. ${g.bound}`}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function AssistantBoard({ board, motionOff }: { board: Board; motionOff: boolean }) {
  if (board.notRanked) {
    return (
      <>
        <Binding board={board} />
        <p className="empty">Not ranked: the isolation gate failed.</p>
      </>
    );
  }
  const ranked = board.rows.filter((r) => r.rank !== null);
  const unranked = board.rows.filter((r) => r.rank === null);
  // The scale runs to the last rank any interval reaches (an interval can be wider than the ranked count).
  const scale = Math.max(1, ranked.length, ...ranked.map((r) => r.rankInterval?.hi ?? 0));
  return (
    <>
      <Binding board={board} />
      <GatePanel board={board} />
      <table className="board">
        <caption className="fine">
          Assistant board, {board.status}. Ranked by deceptive-role recall, then questioning quality, among eligible candidates; the bar is the rank interval, and overlapping bars mean the order is uncertain.
        </caption>
        <thead>
          <tr>
            <th scope="col">Rank</th>
            <th scope="col">Coach</th>
            <th scope="col">Rank interval</th>
            <th scope="col">Recall (M01)</th>
            <th scope="col">Questioning (M09)</th>
            <th scope="col">Precision (M03)</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((r) => {
            const bar = r.rankInterval === null ? null : rankBar(r.rankInterval, scale);
            return (
              <tr key={r.candidate_id}>
                <td className="mono">{r.rank}</td>
                <td>
                  <Who row={r} />
                </td>
                <td>
                  {bar === null || r.rankInterval === null ? (
                    "interval unavailable"
                  ) : (
                    <span className="rank-interval" role="img" aria-label={`Ranks ${String(r.rankInterval.lo)} to ${String(r.rankInterval.hi)}`}>
                      <span className="rank-bar" data-animate={motionOff ? "false" : "true"} style={{ left: `${String(bar.left * 100)}%`, width: `${String(bar.width * 100)}%` }} />
                    </span>
                  )}
                </td>
                <td>{metricText(r.metrics["M01_deceptive_recall"])}</td>
                <td>{metricText(r.metrics["M09_questioning_quality"])}</td>
                <td>{metricText(r.metrics["M03_ppv"])}</td>
                <td>{rankStatus(board, r)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {unranked.length === 0 ? null : (
        <>
          <h3 className="eyebrow">Ineligible, not ranked</h3>
          <ul className="ineligible">
            {unranked.map((r) => (
              <li key={r.candidate_id}>
                <Who row={r} />: {r.reason ?? r.eligibilityStatus ?? "not eligible"}
              </li>
            ))}
          </ul>
        </>
      )}
      {board.pairwise.length === 0 ? null : (
        <table className="board pairwise">
          <caption className="fine">Paired differences between ranked coaches, first minus second, on the trials both played</caption>
          <thead>
            <tr>
              <th scope="col">Pair</th>
              <th scope="col">Common trials</th>
              <th scope="col">Recall difference</th>
              <th scope="col">Questioning difference</th>
            </tr>
          </thead>
          <tbody>
            {board.pairwise.map((p) => (
              <tr key={`${p.a}-${p.b}`}>
                <td className="mono">
                  {p.a} minus {p.b}
                </td>
                <td className="mono">{p.commonCells}</td>
                <td>{differenceText(p.recall)}</td>
                <td>{differenceText(p.qq)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <CandidateDetails rows={board.rows} lines={(r) => assistantDetails(r.published)} matrix />
    </>
  );
}

function Lines({ lines }: { lines: readonly DetailLine[] }) {
  return (
    <dl className="facts">
      {lines.map((l) => (
        <div key={l.label}>
          <dt>{l.label}</dt>
          <dd>{l.value}</dd>
        </div>
      ))}
    </dl>
  );
}

const OUTPUT_NAMES = ["truthful", "deceptive", "insufficient evidence"];

function CandidateDetails({ rows, lines, matrix: withMatrix = false }: { rows: readonly BoardRow[]; lines: (r: BoardRow) => readonly DetailLine[]; matrix?: boolean }) {
  return (
    <div className="candidate-details">
      {rows.map((r) => {
        const counts = withMatrix ? countMatrix(r.published) : null;
        return (
          <details key={r.candidate_id}>
            <summary>
              <Who row={r} />: details
            </summary>
            {counts === null ? null : (
              <table className="board count-matrix">
                <caption className="fine">Findings by the subject&apos;s role, raw counts (M05)</caption>
                <thead>
                  <tr>
                    <th scope="col">Role</th>
                    {OUTPUT_NAMES.map((o) => (
                      <th key={o} scope="col">
                        Found {o}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {counts.map((row) => (
                    <tr key={row.role}>
                      <th scope="row">{row.role}</th>
                      {row.cells.map((n, i) => (
                        <td key={OUTPUT_NAMES[i]} className="mono">
                          {n}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <Lines lines={lines(r)} />
          </details>
        );
      })}
    </div>
  );
}

function SubjectBoard({ board }: { board: Board }) {
  return (
    <>
    <table className="board">
      <caption className="fine">
        Subject board, {board.status}: subjects are compared, not ranked. The referee that labels subject turns runs on the same model as the subjects, so read fidelity with that shared checkpoint in mind.
      </caption>
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
              <Who row={r} />
            </td>
            <td>{metricText(r.metrics["M12_subject_fidelity"])}</td>
            <td>{metricText(r.metrics["M13_invalid_session_rate"])}</td>
            <td>{metricText(r.metrics["M14_deceptive_success"])}</td>
          </tr>
        ))}
      </tbody>
    </table>
    <CandidateDetails rows={board.rows} lines={(r) => subjectDetails(r.published)} />
    </>
  );
}

export type TournamentChoices = { readonly state: "idle" | "loading" | "missing" | "error" } | { readonly state: "ready"; readonly list: readonly TournamentListing[] };

const CHOICES_NOTE: Readonly<Record<"missing" | "error", string>> = {
  missing: "The server does not offer the tournament list yet.",
  error: "The tournament list could not be read.",
};

/** Where the matrix's data stands: the example, the selected tournament's poll, or why there is none. */
export type MatrixSource = "example" | "ready" | "loading" | "missing" | "error";

const MATRIX_NOTE: Readonly<Record<Exclude<MatrixSource, "ready">, string>> = {
  example: "Example data: no tournament is selected. Not a result.",
  loading: "Reading the tournament.",
  missing: "The server does not offer the tournament routes yet, so this tournament's trials cannot be shown.",
  error: "The tournament could not be read. Try again later.",
};

function Matrix({ tournament, source, track, onTrack, onReplay }: { tournament: TournamentState; source: MatrixSource; track: Track | null; onTrack: (t: Track) => void; onReplay: (trialId: string) => void }) {
  if (source !== "ready" && source !== "example") return <p className="empty">{MATRIX_NOTE[source]}</p>;
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
  const present = tracks(tournament);
  if (present.length === 0) return <p className="empty">No trials yet.</p>;
  return (
    <>
      {source === "ready" ? <p className="fine">Choose a finished trial to replay it in the interview room; a running trial can be replayed once it ends.</p> : <p className="fine">{MATRIX_NOTE.example}</p>}
      <Tabs
        label="Tracks"
        value={track ?? present[0] ?? "interactive"}
        onChange={(t) => {
          onTrack(t as Track);
        }}
        tabs={present.map((t) => ({ id: t, label: TRACK_NAME[t], content: <TrackMatrix tournament={tournament} track={t} onReplay={source === "ready" ? onReplay : null} /> }))}
      />
    </>
  );
}

const TRACK_NAME: Readonly<Record<Track, string>> = { replay: "Replay track", interactive: "Interactive track", replay_corpus: "Replay corpus" };

function TrackMatrix({ tournament, track, onReplay }: { tournament: TournamentState; track: Track; onReplay: ((trialId: string) => void) | null }) {
  return (
    <div className="matrix" role="table" aria-label={`${TRACK_NAME[track]}: trials by pairing`}>
      {matrix(tournament, track).map((row) => (
        <div key={row.pairing} className="matrix-row" role="row">
          <span className="mono matrix-pairing" role="rowheader">
            {row.pairing}
          </span>
          {row.cells.map((c) => {
            const state = cellState(c);
            const label = `Trial ${String(c.trial_ref)}${c.block === null ? "" : `, block ${String(c.block)}`}: ${state}`;
            return (
              <span key={c.trial_ref} className="matrix-cell" role="cell" data-state={state.replaceAll(" ", "_")} title={label}>
                {/* A running trial's recording is still growing: it replays once it has ended, whole. */}
                {onReplay === null || state === "running" ? (
                  <>
                    <span className="mono">#{c.trial_ref}</span> {state}
                  </>
                ) : (
                  <button
                    type="button"
                    className="matrix-replay"
                    aria-label={`Replay ${label}`}
                    onClick={() => {
                      onReplay(c.trial_id);
                    }}
                  >
                    <span className="mono">#{c.trial_ref}</span> {state}
                  </button>
                )}
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
  readonly boards: BoardsState;
  readonly assistant: Board | null;
  readonly subject: Board | null;
  readonly tournament: TournamentState;
  /** Where the matrix's data stands. */
  readonly matrix: MatrixSource;
  /** The tournaments to choose from when none is selected (`idle` when one is). */
  readonly tournaments: TournamentChoices;
  /** Why the last replay did not start, if it did not. */
  readonly notice: string | null;
  readonly onReplay: (trialId: string) => void;
  readonly motionOff: boolean;
  readonly onClose: () => void;
}) {
  const [tab, setTab] = useState("leaderboard");
  const [track, setTrack] = useState<Track | null>(null);
  const b = props.boards;
  const corrected = b.kind === "published" ? otherLabelHref(b.tournamentId, b.label, props.assistant?.manifestVersion ?? null) : null;
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
        {props.boards.kind === "example" ? <p className="fine">Example data: no tournament is selected. Not a result.</p> : null}
        {corrected === null ? null : (
          <p className="fine corrected">
            <strong>{corrected.heading}</strong>. <a href={corrected.href}>{corrected.text}</a>
          </p>
        )}
        {props.boards.kind === "example" ? <p className="fine">The tournament matrix shows example data too.</p> : null}
        {props.tournaments.state === "missing" || props.tournaments.state === "error" ? <p className="fine">{CHOICES_NOTE[props.tournaments.state]}</p> : null}
        {props.tournaments.state === "ready" && props.tournaments.list.length === 0 ? <p className="fine">No tournaments yet.</p> : null}
        {props.tournaments.state !== "ready" || props.tournaments.list.length === 0 ? null : (
          <nav aria-label="Tournaments">
            <ul className="tournament-list">
              {props.tournaments.list.map((t) => (
                <li key={t.id}>
                  <a href={`?tournament=${encodeURIComponent(t.id)}`}>{t.name}</a>{" "}
                  <span className="fine">
                    {t.split} split, {t.status}
                    {t.seed === null ? "" : `, seed ${String(t.seed)}`}
                    {t.rosterHash === null ? "" : ", roster "}
                  </span>
                  {t.rosterHash === null ? null : (
                    <code className="mono hash" title={t.rosterHash}>
                      {t.rosterHash.slice(0, 12)}
                    </code>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        )}
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
                {b.kind === "sealed" ? <p className="empty sealed">Results are sealed until reveal.</p> : null}
                {b.kind === "missing" ? <p className="empty">No leaderboard has been published for this tournament.</p> : null}
                {b.kind === "error" ? <p className="empty">The leaderboards could not be read. Try again later.</p> : null}
                {b.kind === "example" || b.kind === "published" ? (
                  <>
                    {props.assistant === null ? <p className="empty">No assistant board published yet.</p> : <AssistantBoard board={props.assistant} motionOff={props.motionOff} />}
                    {props.subject === null ? null : <SubjectBoard board={props.subject} />}
                  </>
                ) : null}
              </>
            ),
          },
          {
            id: "tournament",
            label: "Tournament",
            content: (
              <>
                {props.notice === null ? null : (
                  <p className="fine" role="alert">
                    {props.notice}
                  </p>
                )}
                <Matrix tournament={props.tournament} source={props.matrix} track={track} onTrack={setTrack} onReplay={props.onReplay} />
              </>
            ),
          },
        ]}
      />
    </div>
  );
}
