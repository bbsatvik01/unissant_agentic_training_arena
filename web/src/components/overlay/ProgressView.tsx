/**
 * Progress (S6 4.8, KPI-1), over the precinct: the study steps with the one to do next (from `GET /api/me`), the
 * KPI-1 figures as the server reports them ("KPI-1 not measured" until then, FE-PRG-1), and the participant's own
 * sessions in order, each with its debrief total and five dimension scores as published and a way to watch the
 * run again in the room. The session list is `GET /api/progress`; when the server has no such route yet the page
 * says so rather than showing anything in its place. No streaks, reminders, loss framing or catch counts
 * (FE-PRG-2).
 */
import { EX4_TEXT } from "../../lib/copy/ex4";
import { dayOf, kpi1Text, sessionEnded, sessionLabels, type ProgressLoad, type ScoreState } from "../../lib/progress/progress";
import { nextStepText, stepLabel, studySteps, type Study } from "../../lib/study/study";

function Steps({ study }: { study: Study }) {
  return (
    <section aria-labelledby="study-title" className="progress-study">
      <h3 id="study-title" className="eyebrow">
        Study: {stepLabel(study)}
      </h3>
      <p className="fine">{nextStepText(study)}</p>
      <ol className="study-steps">
        {studySteps(study).map((s) => (
          <li key={s.label} data-state={s.state} aria-current={s.state === "current" ? "step" : undefined}>
            <span>{s.label}</span>
            <span className="fine">{s.state === "done" ? "done" : s.state === "current" ? "next" : ""}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Score({ score }: { score: ScoreState | undefined }) {
  if (score === undefined) return <span className="fine">Loading</span>;
  if (score === "scoring") return <span className="fine">Scoring</span>;
  if (score === "none") return <span className="fine">No debrief yet</span>;
  if (score.kind !== "scored") return <span className="fine">{score.reason}</span>;
  return (
    <span className="session-score">
      <strong>{score.total}</strong>
      <span className="fine"> / 100</span>
      <span className="dim-chips">
        {score.dimensions.map((d) => (
          <span key={d.id} className="dim-chip" title={`${d.id}: ${String(d.score)} of 4`}>
            <span className="mono">{d.id}</span> {d.score}
          </span>
        ))}
      </span>
    </span>
  );
}

export function ProgressView({
  load,
  scores,
  study,
  onReplay,
  onClose,
}: {
  load: ProgressLoad;
  scores: Readonly<Record<string, ScoreState>>;
  study: Study | null;
  onReplay: (trialId: string) => void;
  onClose: () => void;
}) {
  const k = kpi1Text(load.state === "ready" ? load.progress.kpi1 : null);
  return (
    <div className="arena-view progress-view" role="dialog" aria-labelledby="progress-title">
      <header className="panel-head">
        <h2 id="progress-title">Your progress</h2>
        <button type="button" className="btn-secondary-sm" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="progress-body">
        <p className="fine">{EX4_TEXT}</p>
        {study === null ? null : <Steps study={study} />}
        {study === null ? null : (
          <table className="board kpi1">
            <caption className="fine">Your pre-test and post-test results, as the referee scored them</caption>
            <thead>
              <tr>
                <th scope="col">Pre-test</th>
                <th scope="col">Post-test</th>
                <th scope="col">Change</th>
                <th scope="col">Relative change</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{k.pre}</td>
                <td>{k.post}</td>
                <td>{k.absolute}</td>
                <td>{k.relative}</td>
              </tr>
            </tbody>
          </table>
        )}
        <section aria-labelledby="sessions-title">
          <h3 id="sessions-title" className="eyebrow">
            Your sessions
          </h3>
          {load.state === "loading" ? <p className="fine">Loading your sessions.</p> : null}
          {load.state === "missing" ? <p className="empty">Your session history will appear here once the server offers it.</p> : null}
          {load.state === "error" ? <p className="empty">Your sessions could not be read. Try again later.</p> : null}
          {load.state === "ready" && load.progress.sessions.length === 0 ? <p className="empty">No sessions yet.</p> : null}
          {load.state === "ready" && load.progress.sessions.length > 0 ? (
            <table className="board sessions">
              <thead>
                <tr>
                  <th scope="col">Session</th>
                  <th scope="col">Day</th>
                  <th scope="col">Case</th>
                  <th scope="col">Mode</th>
                  <th scope="col">Debrief score</th>
                  <th scope="col">
                    <span className="sr-only">Watch</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {load.progress.sessions.map((s, i) => (
                  <tr key={s.session_id}>
                    <td>{sessionLabels(load.progress.sessions)[i]}</td>
                    <td>{dayOf(s.created_at)}</td>
                    <td>{s.case_title ?? ""}</td>
                    <td>{s.voice ? "voice practice" : s.mode}</td>
                    <td>{sessionEnded(s) ? <Score score={scores[s.session_id]} /> : <span className="fine">Not finished</span>}</td>
                    <td>
                      {sessionEnded(s) && !s.voice ? (
                        <button
                          type="button"
                          className="btn-secondary-sm"
                          onClick={() => {
                            onReplay(s.trial_id);
                          }}
                        >
                          Watch again
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      </div>
    </div>
  );
}
