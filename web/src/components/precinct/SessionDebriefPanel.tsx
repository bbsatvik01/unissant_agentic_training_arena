/** A debrief's content, not another modal/canvas. Scores are displayed verbatim from its own run. */
import type { Debrief } from "../../lib/contracts/generated/types";
import type { TrialView } from "../../lib/trial/trialReducer";
import { EX4_TEXT } from "../../lib/copy/ex4";
import { RUBRIC } from "../../lib/copy/rubric";
import { LABELS } from "../../lib/copy/finding";
import { debriefExport, exportName, questionReview } from "../../lib/world/debrief";
import "../../styles/precinct-session.css";

export function SessionDebriefPanel({ debrief, view, recorded }: { readonly debrief: Debrief | null; readonly view: TrialView | null; readonly recorded: boolean }) {
  if (debrief === null) return <section className="precinct-session"><p>The debrief appears after the finding is sealed and scoring is published. For recordings, play or scrub to the end of that run.</p><p className="precinct-note">No score has been computed for your current exploration.</p></section>;
  const label = (value: string | null) => value === null ? "None committed" : LABELS.find((item) => item.id === value)?.word ?? value;
  return <section className="precinct-session" aria-label="Session debrief">
    <p className="precinct-session-origin">{recorded ? "Published debrief from this recorded run" : "Published debrief from this local session"}</p>
    <p className="precinct-note">{EX4_TEXT}</p>
    {recorded ? <p>These scores belong only to the loaded recording. They are not a score for questions you typed, notes you saved, or your exploration.</p> : null}
    <p>Case outcome: <strong>{label(debrief.outcome.correct_finding)}</strong>. Committed finding: <strong>{label(debrief.outcome.committed_label)}</strong>.</p><p>{debrief.outcome.resolution}</p>
    {!debrief.scored ? <p>This session is not scored.</p> : !debrief.rubric.scorable || debrief.rubric.total === null ? <p>{debrief.rubric.unscorable_reason ?? "This session could not be scored."}</p> : <>
      <p className="precinct-debrief-total">{debrief.rubric.total}<small> / 100</small></p>
      <dl className="precinct-debrief-dimensions">{debrief.rubric.dimensions.map((dimension) => <div key={dimension.dim_id}><dt>{RUBRIC[dimension.dim_id].name}</dt><dd>{dimension.score} / 4</dd></div>)}</dl>
    </>}
    <h3>Review the interview</h3>
    {view === null ? <p>The transcript is unavailable.</p> : view.channel === "voice" ? <ol className="precinct-session-review">{view.voiceExchanges.map((exchange) => <li key={exchange.exchange_no}><strong>Exchange {exchange.exchange_no}</strong>{exchange.lines.map((line, index) => <p key={index}><strong>{line.role === "investigator" ? "You" : "Subject"}:</strong> {line.text}{line.partial ? " (cut off)" : ""}</p>)}</li>)}</ol> : <ol className="precinct-session-review">{questionReview(view).map((review) => <li key={review.turn}><strong>Turn {review.turn}</strong><p>Asked: {review.question}</p><p>Answered: {review.answer ?? "No complete answer"}</p>{review.assessment === null ? null : <p>Coach review: {review.assessment}</p>}{review.suggested === null ? null : <p>Suggested next question: {review.suggested}</p>}{review.askedNext === null ? null : <p>Actually asked next: {review.askedNext}</p>}</li>)}</ol>}
    <button type="button" className="precinct-secondary" onClick={() => { const url = URL.createObjectURL(new Blob([debriefExport(debrief)], { type: "application/json" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = exportName(debrief); anchor.click(); URL.revokeObjectURL(url); }}>Download this debrief JSON</button>
  </section>;
}
