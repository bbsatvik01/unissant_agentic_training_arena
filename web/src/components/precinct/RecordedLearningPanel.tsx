/** Content-only post-publication review. Callbacks navigate existing replay/setup; no API or ghost actor. */
import { useState } from "react";
import { checkName } from "../../lib/copy/rubric";
import type { LearningTimeline, PublishedCheck } from "../../lib/world/learningTimeline";

export interface RecordedLearningProps {
  readonly timeline: LearningTimeline;
  readonly onReplayFromTurn?: (atMs: number) => void;
  readonly onOpenFreshPractice?: () => void;
}
function Check({ check }: { readonly check: PublishedCheck }) {
  return <span>{check.dimension} · {checkName(check.id)}: <strong>{check.result === "fail" ? "Published fail" : check.result === "pass" ? "Published pass" : "Not applicable"}</strong></span>;
}
function timestamp(atMs: number): string { return `${(atMs / 1_000).toFixed(3)} s`; }

export function RecordedLearningPanel({ timeline, onReplayFromTurn, onOpenFreshPractice }: RecordedLearningProps) {
  const [compare, setCompare] = useState(false);
  return <section className="precinct-session-learning" aria-label="Recorded learning timeline">
    <h3>Learning and reported issues</h3>
    <p>Only this run’s published checks and recorded coach review appear here. A failed check is the published reviewer’s judgment; a coach flag is not a proven fact. No new mistakes, scores or answers are generated.</p>
    {!timeline.scored && <p>This recording is unscored. No rubric failures or learning scorecard are inferred.</p>}
    {timeline.evidenceCoverage !== null && <p>Published evidence coverage: {timeline.evidenceCoverage.addressed} of {timeline.evidenceCoverage.key_facts} key facts addressed.</p>}
    {timeline.unsupported !== null && <p>Published unsupported totals: citation {timeline.unsupported.citation}, claim {timeline.unsupported.claim}, demeanor {timeline.unsupported.demeanor}. These totals do not identify individual turn timestamps.</p>}
    <label><input type="checkbox" checked={compare} onChange={(event) => { setCompare(event.currentTarget.checked); }} />Compare recorded coach suggestions with the next question actually asked</label>
    {compare && <p>These are the actual recorded coach’s suggestions, not a verified winning-expert trace. No alternative answer or improved score is known.</p>}
    <ol className="precinct-session-review">{timeline.turns.map((turn) => <li key={turn.turn}>
      <h4>Turn {turn.turn} · {turn.atMs === null ? "exact replay time unavailable" : timestamp(turn.atMs)}</h4>
      <p>Asked: {turn.question}</p><p>Answered: {turn.answer ?? "No complete answer recorded"}</p>
      {turn.coachAssessment !== null && <p>Recorded coach review: {turn.coachAssessment}</p>}
      {turn.neutralityIssues.length > 0 && <p>Recorded neutrality issues: {turn.neutralityIssues.join("; ")}</p>}
      {turn.checks.length > 0 && <ul>{turn.checks.map((check, index) => <li key={`${check.dimension}:${check.id}:${String(index)}`}><Check check={check} /></li>)}</ul>}
      {turn.learning.map((item, index) => <p key={index}>Published learning intent addressed: {item.intent}</p>)}
      {turn.flags.map(({ flag, validation }) => <div key={flag.flag_ref}>
        <p>Recorded coach flag {flag.flag_ref}: {flag.kind} · cited turn {flag.turn_id}</p><p>Recorded quote: {flag.quote}</p>
        {flag.missing_fact !== null && <p>Coach’s stated gap: {flag.missing_fact}</p>}
        {flag.conflict_turn_id !== null && <p>Cited conflicting turn: {flag.conflict_turn_id} · {flag.conflict_quote ?? "No quote recorded"}</p>}
        {flag.conflict_record_id !== null && <p>Cited record: {flag.conflict_record_id} · {flag.conflict_record_quote ?? "No quote recorded"}</p>}
        <p>{validation === null ? "Citation validation was not recorded." : `Recorded validation: citation ${validation.citation_ok ? "accepted" : "rejected"}; demeanor-based ${validation.demeanor_based ? "yes" : "no"}; duplicate ${validation.duplicate ? "yes" : "no"}.`}</p>
      </div>)}
      {compare && <div className="precinct-session-comparison"><p>Recorded coach suggestion: {turn.suggested?.question ?? "No suggestion recorded"}</p>
        {turn.suggested !== null && <p>Recorded purpose: {turn.suggested.purpose}</p>}
        <p>Actually asked next: {turn.askedNext ?? "No next question recorded"}</p></div>}
      <button type="button" className="precinct-secondary" disabled={turn.atMs === null || onReplayFromTurn === undefined} onClick={() => { if (turn.atMs !== null) onReplayFromTurn?.(turn.atMs); }}>Replay from turn {turn.turn}</button>
    </li>)}</ol>
    {timeline.unlocatedChecks.length + timeline.unlocatedLearning.length > 0 && <div>
      <h4>Published items without a complete turn location</h4>
      <ul>{timeline.unlocatedChecks.map((check, index) => <li key={`check:${String(index)}`}><Check check={check} /> · Reported turns: {check.turns.join(", ") || "none"}</li>)}
        {timeline.unlocatedLearning.map((item, index) => <li key={`learning:${String(index)}`}>{item.intent} · Addressed turns: {item.addressed_turns.join(", ") || "none reported"}</li>)}</ul>
      <p>Missing locations stay unplaced; an unaddressed intent is not assigned an invented mistake timestamp.</p>
    </div>}
    <p>Replaying a moment only revisits this recording. Retry or fork from a turn is unsupported by the current session contract. Fresh practice starts a separate run from its opening state, with no inherited transcript or score.</p>
    {onOpenFreshPractice !== undefined && <button type="button" className="precinct-secondary" onClick={onOpenFreshPractice}>Open fresh practice setup</button>}
  </section>;
}
