/** Route-owned local station memory. No API, browser storage, audio, or model capability is accepted. */
import { useCallback, useEffect, useState } from "react";
import { dailyDrillReducer, INITIAL_DRILL, type DrillAction, type DrillState } from "../../lib/precinct/dailyDrill";
import { annotationDraft, assignmentDraft, LOCAL_COACH_LAB, type LocalAssignmentDraft } from "../../lib/precinct/stationLab";
import type { SkillId } from "../../lib/precinct/trainingStations";
import type { TrainingStationId } from "../../lib/precinct/stationSources";
import type { CoachLabSource, LocalTimelineDraft } from "../../components/precinct/LabStations";

export interface PrecinctStationsOptions {
  readonly caseId: string | null;
  readonly panel: TrainingStationId | null;
  readonly assessmentActive: boolean;
  readonly paused: boolean;
}
interface DrillWorkspace { readonly caseId: string | null; readonly state: DrillState; readonly nowMs: number }
const unavailableLab: CoachLabSource = { kind: "unavailable", reason: "No verified Coach Lab adapter is connected. The documented read routes do not yet specify complete response contracts." };

function isLocalDemoTrial(id: string): boolean { return id === "LOCAL-DEMO-TRIAL"; }

export function usePrecinctStations({ caseId, panel, assessmentActive, paused }: PrecinctStationsOptions) {
  const [selectedPrimer, setSelectedPrimer] = useState<SkillId>("D1");
  const [coachLab, setCoachLab] = useState<CoachLabSource>(unavailableLab);
  const [instructorDemo, setInstructorDemo] = useState(false);
  const [assignments, setAssignments] = useState<readonly LocalAssignmentDraft[]>([]);
  const [annotations, setAnnotations] = useState<readonly LocalTimelineDraft[]>([]);
  const [drill, setDrill] = useState<DrillWorkspace>({ caseId, state: INITIAL_DRILL, nowMs: 0 });
  // A different case must never inherit the previous case's written answers or elapsed time.
  // React's guarded same-component adjustment resets before its children can observe the old workspace.
  if (drill.caseId !== caseId) setDrill({ caseId, state: INITIAL_DRILL, nowMs: 0 });
  const active = panel === "drill" && caseId !== null && !assessmentActive && !paused;
  const pauseDrill = useCallback(() => {
    const nowMs = performance.now();
    setDrill((current) => ({ ...current, state: dailyDrillReducer(current.state, { type: "pause", nowMs }), nowMs }));
  }, []);
  const drillAction = useCallback((action: DrillAction) => {
    if (!active || document.visibilityState !== "visible") return;
    const nowMs = performance.now();
    const timed = action.type === "start" || action.type === "pause" || action.type === "tick" ? { ...action, nowMs } : action;
    setDrill((current) => ({ caseId, state: dailyDrillReducer(current.caseId === caseId ? current.state : INITIAL_DRILL, timed), nowMs }));
  }, [active, caseId]);
  useEffect(() => {
    if (!active || drill.state.status !== "running") return;
    const onHidden = () => { if (document.visibilityState !== "visible") pauseDrill(); };
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") { pauseDrill(); return; }
      const nowMs = performance.now();
      setDrill((current) => ({ ...current, state: dailyDrillReducer(current.state, { type: "tick", nowMs }), nowMs }));
    }, 250);
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", pauseDrill);
    return () => {
      clearInterval(timer); document.removeEventListener("visibilitychange", onHidden); window.removeEventListener("pagehide", pauseDrill);
      pauseDrill();
    };
  }, [active, caseId, drill.state.status, pauseDrill]);
  const showCoachDemo = useCallback(() => { if (!assessmentActive) setCoachLab({ kind: "local-demo", view: LOCAL_COACH_LAB }); }, [assessmentActive]);
  const enableInstructorDemo = useCallback(() => { if (!assessmentActive) setInstructorDemo(true); }, [assessmentActive]);
  const addAssignment = useCallback((draft: LocalAssignmentDraft) => {
    if (!instructorDemo || assessmentActive || !["Sample trainee A", "Sample trainee B"].includes(draft.traineeLabel)) return;
    const checked = assignmentDraft(draft.traineeLabel, draft.caseId, draft.note);
    if (checked !== null) setAssignments((current) => [...current, checked]);
  }, [instructorDemo, assessmentActive]);
  const addAnnotation = useCallback((draft: LocalTimelineDraft) => {
    if (!instructorDemo || assessmentActive || !isLocalDemoTrial(draft.trialId)) return;
    const checked = annotationDraft(draft.body.t_ms, draft.body.text);
    if (checked !== null) setAnnotations((current) => [...current, { trialId: "LOCAL-DEMO-TRIAL", body: checked }]);
  }, [instructorDemo, assessmentActive]);
  const choosePrimer = useCallback((id: SkillId) => { if (!assessmentActive) setSelectedPrimer(id); }, [assessmentActive]);
  return { selectedPrimer, choosePrimer, coachLab, showCoachDemo, instructorDemo, enableInstructorDemo,
    assignments, annotations, addAssignment, addAnnotation, drill: drill.state, nowMs: drill.nowMs, drillAction, pauseDrill };
}
export type PrecinctStations = ReturnType<typeof usePrecinctStations>;
