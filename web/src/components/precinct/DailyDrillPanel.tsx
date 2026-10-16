import { useId } from "react";
import { DRILL_DURATION_MS, drillClock, drillElapsed, drillStage, type DrillAction, type DrillState } from "../../lib/precinct/dailyDrill";
import type { CaseCard } from "../../lib/world/cases";
import { TrainingGroundRule } from "./TrainingStations";

/** Route owns the timer and reducer; pause it when the panel closes. No external action is performed here. */
export function DailyDrillPanel({ caseCard, state, nowMs, onAction, assessmentActive = false }: {
  readonly caseCard: CaseCard;
  readonly state: DrillState;
  readonly nowMs: number;
  readonly onAction: (action: DrillAction) => void;
  readonly assessmentActive?: boolean;
}) {
  const id = useId();
  const elapsed = drillElapsed(state, nowMs);
  const stage = drillStage(elapsed);
  if (assessmentActive) return <div className="training-station"><p className="training-notice" role="status">The warm-up is unavailable during an assessment. Finish the assessment before opening practice guidance.</p><TrainingGroundRule /></div>;
  return <div className="training-station daily-drill-panel"><div className="training-intro"><span className="station-tag">DAILY DRILL · LOCAL, UNSCORED PRACTICE</span><p>Three minutes. One careful follow-up.</p></div>
    <div className="drill-clock"><span aria-label={`${drillClock(elapsed)} remaining`}>{drillClock(elapsed)}</span><div><strong>{state.status === "complete" ? "Warm-up time complete" : state.status === "paused" ? "Take your time" : "A gentle practice timer"}</strong><p>No score, streak, or recorded completion. Pause whenever you need.</p></div></div>
    <progress max={DRILL_DURATION_MS} value={elapsed} aria-label="Warm-up time elapsed" />
    <ol className="drill-stages"><li aria-current={stage === "read" ? "step" : undefined}>1. Read the objective</li><li aria-current={stage === "question" ? "step" : undefined}>2. Write one neutral ask</li><li aria-current={stage === "closure" ? "step" : undefined}>3. Name corroboration</li></ol>
    <section className="drill-case"><span className="training-mono">PUBLIC CASE · {caseCard.case_id}</span><h3>{caseCard.title}</h3><p>{caseCard.objective}</p></section>
    <label className="training-field" htmlFor={`${id}-question`}>Your neutral opening question<textarea id={`${id}-question`} maxLength={2000} rows={3} value={state.question} onChange={(event) => { onAction({ type: "write", field: "question", text: event.target.value }); }} placeholder="Ask one thing, without suggesting the answer." /></label>
    <label className="training-field" htmlFor={`${id}-corroboration`}>What would you verify next?<textarea id={`${id}-corroboration`} maxLength={2000} rows={3} value={state.corroboration} onChange={(event) => { onAction({ type: "write", field: "corroboration", text: event.target.value }); }} placeholder="Name a record or a detail to check. Uncertainty is a valid outcome." /></label>
    <div className="training-actions">{state.status === "running" ? <button type="button" className="training-button" onClick={() => { onAction({ type: "pause", nowMs }); }}>Pause timer</button> : state.status === "ready" || state.status === "paused" ? <button type="button" className="training-button" onClick={() => { onAction({ type: "start", nowMs }); }}>{state.status === "ready" ? "Start 3-minute warm-up" : "Resume timer"}</button> : null}<button type="button" className="training-link" onClick={() => { onAction({ type: "reset" }); }}>Clear this warm-up</button></div>
    <p className="training-meta">Notes stay in this page’s memory until cleared or reloaded. Nothing is sent to a subject, instructor, or scoring service. This is a writing warm-up, not a simulated interview.</p>
    {state.status === "complete" ? <div className="training-notice" role="status"><strong>Keep the useful question.</strong><p>Check it for neutrality, a specific evidence gap, and a fair alternative explanation. You can keep editing without a time limit.</p></div> : null}<TrainingGroundRule />
  </div>;
}
