/** Four keyboard-accessible views of the same parent-projected public frame; no subscriptions or clocks. */
import { AgentWorkMonitor } from "../agent-work/AgentWorkMonitor";
import { WORK_STYLES, type WorkFrame, type WorkStyle } from "../../lib/agent-work/model";
import { EX4_TEXT } from "../../lib/copy/ex4";
import { observationWork } from "../../lib/precinct/observationScreens";
import "../../styles/precinct-interview.css";

export interface ObservationStationPanelProps {
  readonly frame: WorkFrame;
  /** Separate current-session gate also suppresses a stale practice frame during a source transition. */
  readonly assessment: boolean;
  readonly onExpandMonitor: (style: WorkStyle) => void;
  readonly onReturnToInterview: () => void;
}

export function ObservationStationPanel({ frame, assessment, onExpandMonitor, onReturnToInterview }: ObservationStationPanelProps) {
  const safeFrame = observationWork(frame, assessment);
  return <section className="precinct-observation" aria-label="Observation room agent screens">
    <header className="precinct-interview-heading"><div><span className="precinct-interview-kicker">OBSERVATION ROOM</span><h2>Follow the public work</h2><p>Four views share the same interview record and session clock. Expand a screen for its readable detail.</p></div></header>
    {safeFrame.assessment ? <p className="precinct-interview-boundary">Assessment: coaching activity and content are withheld.</p> : null}
    <div className="precinct-observation-grid">{WORK_STYLES.map((style) => <AgentWorkMonitor key={style} frame={safeFrame} style={style} size="thumbnail" onExpand={() => { onExpandMonitor(style); }} />)}</div>
    <button type="button" className="precinct-secondary" onClick={onReturnToInterview}>Return to interview room</button>
    <p className="precinct-note">Activity represents public work and turn timing. Nervousness, demeanor, accent and stress are never evidence.</p>
    <p className="precinct-interview-ground-rule">{EX4_TEXT}</p>
  </section>;
}
