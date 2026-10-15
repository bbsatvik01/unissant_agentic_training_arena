/** Content only. The existing route owns capture, downloads, assessment withholding and its one scene. */
import { useState } from "react";
import type { FreshCaptureState } from "../../lib/world/freshClientCapture";
export interface FreshCapturePanelProps {
  readonly state: FreshCaptureState;
  readonly canArm: boolean;
  readonly assessmentActive: boolean;
  readonly onArm: () => void;
  readonly onStop: () => void;
  readonly onExport: () => void;
  readonly error: string | null;
}
export function FreshCapturePanel({ state, canArm, assessmentActive, onArm, onStop, onExport, error }: FreshCapturePanelProps) {
  const [replace, setReplace] = useState(false);
  return <section aria-label="Fresh text capture" className="precinct-replay__section">
    <h3>Client-experienced silent-text capture</h3>
    <p>Arm before starting a new interview. Records accepted text events, explicit question drafts and sampled world state on this tab’s presentation clock. Original audio is absent. No microphone, automatic storage or extra server requests.</p>
    <p>World replay is sampled. Camera and actor roots are held between captured samples; monitor motion is reconstructed. Original panel/page layout, speech and visemes are not restored.</p>
    <p>{state.phase} · {state.frames} accepted frames · {state.worldSamples} world samples</p>
    {state.phase === "complete" && <p>Client-experienced silent-text timeline captured. World motion is limited to actual samples. Whole-world fidelity is not verified.</p>}
    {state.phase === "incomplete" && <p>Incomplete capture ({state.reason}). Only the accepted prefix can be exported; this is not an exact interview recording.</p>}
    {assessmentActive && <p>Export is withheld until this assessment publishes its debrief or you explicitly close the assessment view.</p>}
    <div className="precinct-replay__controls">
      <button type="button" disabled={!canArm || state.phase === "armed" || state.phase === "recording"} onClick={() => { if (state.phase === "complete" || state.phase === "incomplete") setReplace(true); else onArm(); }}>Arm next new text run</button>
      <button type="button" disabled={state.phase !== "armed" && state.phase !== "recording"} onClick={onStop}>Stop capture</button>
      <button type="button" disabled={assessmentActive || (state.phase !== "complete" && state.phase !== "incomplete")} onClick={onExport}>{state.phase === "incomplete" ? "Export incomplete capture" : "Export captured text run"}</button>
    </div>
    {replace && <div>
      <p>Replace the previous in-memory capture? Export it first if you want to keep it.</p>
      <button type="button" disabled={!canArm} onClick={() => { onArm(); setReplace(false); }}>Replace and arm</button>
      <button type="button" onClick={() => { setReplace(false); }}>Keep capture</button>
    </div>}
    {error !== null && <p role="alert">{error}</p>}
  </section>;
}
