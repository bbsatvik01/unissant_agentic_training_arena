import { useId, useState } from "react";
import { annotationDraft, assignmentDraft, type AnnotationBody, type CoachLabView, type LocalAssignmentDraft } from "../../lib/precinct/stationLab";
import type { CaseCard } from "../../lib/world/cases";
import { TrainingGroundRule } from "./TrainingStations";

export type CoachLabSource =
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "local-demo"; readonly view: CoachLabView }
  | { readonly kind: "published"; readonly view: CoachLabView; readonly sourceLabel: string };

export function CoachLabPanel({ source, onShowLocalDemo, assessmentActive = false }: {
  readonly source: CoachLabSource;
  readonly onShowLocalDemo: () => void;
  readonly assessmentActive?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const view = source.kind === "unavailable" ? null : source.view;
  const version = view?.versions.find((entry) => entry.id === selected) ?? view?.versions[0];
  return <div className="training-station coach-lab-panel"><div className="training-intro"><span className="station-tag">COACH LAB · VERSIONED PRACTICE</span><p>Better questions, one revision at a time.</p></div>
    {assessmentActive ? <p className="training-notice" role="status">Coach playbooks and lessons are unavailable during an assessment. Feedback is reserved for the debrief.</p> : <>
      {source.kind === "unavailable" ? <div className="training-empty"><h3>Coach Lab is not connected</h3><p>{source.reason}</p><button type="button" className="training-button" onClick={onShowLocalDemo}>Explore a local demonstration</button></div> : null}
      {source.kind === "local-demo" ? <p className="training-notice" role="status"><strong>Local demonstration.</strong> All coach versions, metric values and source-run IDs below are fictional display examples. They are not results.</p> : source.kind === "published" ? <p className="training-source">{source.sourceLabel}</p> : null}
      {view === null ? null : <><div className="coach-version-grid" aria-label="Coach versions">{view.versions.map((entry) => <button type="button" key={entry.id} aria-pressed={version?.id === entry.id} onClick={() => { setSelected(entry.id); }}><span className="training-mono">{entry.status}</span><strong>{entry.name}</strong><span>{entry.parent === null ? "Original version" : `Parent: ${entry.parent}`}</span></button>)}</div>
      {version === undefined ? <p className="training-empty">No coach versions have been supplied.</p> : <section className="coach-playbook"><h3>{version.name}: lessons playbook</h3>{version.lessons.length === 0 ? <p>No published lessons.</p> : version.lessons.map((lesson) => <article key={lesson.title}><h4>{lesson.title}</h4><p>{lesson.technique}</p><p className="training-meta">Source runs: {lesson.sourceRuns.length === 0 ? "not supplied" : lesson.sourceRuns.join(", ")}</p></article>)}<h4>Tournament history</h4>{version.history.length === 0 ? <p className="training-meta">No published tournament history.</p> : <ul>{version.history.map((item) => <li key={item}>{item}</li>)}</ul>}</section>}
      <section className="coach-comparison"><h3>Before & after</h3><p className="training-meta">{source.kind === "local-demo" ? "Illustrative values, not measured improvement. The bars compare display examples only." : "Values supplied by the published experiment view. A change is not by itself evidence of improvement."}</p>{view.experiments.length === 0 ? <p className="training-empty">No experiment comparisons have been supplied.</p> : view.experiments.map((metric) => <div key={metric.label} className="coach-metric"><strong>{metric.label}</strong><span>{metric.unit}</span><div><span>Before</span><meter min={metric.min} max={metric.max} value={metric.before} aria-label={`${metric.label} before: ${String(metric.before)}`} /><b>{metric.before}</b></div><div><span>After</span><meter min={metric.min} max={metric.max} value={metric.after} aria-label={`${metric.label} after: ${String(metric.after)}`} /><b>{metric.after}</b></div></div>)}</section><p className="training-meta">Champion and challenger are version labels. No promotion, tuning, model call, or tournament run is started here. Sealed held-out material is never used for these primers.</p></>}
    </>}<TrainingGroundRule />
  </div>;
}

export interface LocalTimelineDraft { readonly trialId: "LOCAL-DEMO-TRIAL"; readonly body: AnnotationBody }
export function InstructorPanel({ demoEnabled, cases, assignments, annotations, onEnableDemo, onAssignmentDraft, onAnnotationDraft }: {
  readonly demoEnabled: boolean;
  readonly cases: readonly CaseCard[];
  readonly assignments: readonly LocalAssignmentDraft[];
  readonly annotations: readonly LocalTimelineDraft[];
  readonly onEnableDemo: () => void;
  readonly onAssignmentDraft: (draft: LocalAssignmentDraft) => void;
  readonly onAnnotationDraft: (draft: LocalTimelineDraft) => void;
}) {
  const id = useId();
  const [trainee, setTrainee] = useState("Sample trainee A");
  const [caseId, setCaseId] = useState(cases[0]?.case_id ?? "");
  const [note, setNote] = useState("");
  const [time, setTime] = useState("0");
  const [annotation, setAnnotation] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [observing, setObserving] = useState(false);
  return <div className="training-station instructor-panel"><div className="training-intro"><span className="station-tag">INSTRUCTOR WORKSPACE</span><p>Support the next careful question.</p></div>
    {!demoEnabled ? <div className="training-empty"><h3>Instructor access is not connected</h3><p>No class roster, permissions or live sessions have been verified. You can explore a fictional class and prepare local example drafts.</p><button type="button" className="training-button" onClick={onEnableDemo}>Open the local instructor demo</button></div> : <><p className="training-notice"><strong>Local mock workspace.</strong> Sample trainees are fictional. Drafts stay in this page’s memory, are not assigned or delivered, and clear on reload. No instructor permission is implied.</p>
      <section className="instructor-class"><h3>Class overview</h3><div><article><span className="training-mono">SAMPLE TRAINEE A</span><strong>No measured progress</strong><p>Local observation preview available.</p><button type="button" className="training-link" onClick={() => { setObserving(!observing); }}>{observing ? "Close observation preview" : "Preview observation"}</button></article><article><span className="training-mono">SAMPLE TRAINEE B</span><strong>No measured progress</strong><p>No connected session.</p></article></div></section>
      {observing ? <section className="instructor-observation"><span className="training-mono">LOCAL-DEMO-TRIAL · NOT LIVE</span><h3>Observation preview</h3><p>No transcript or camera stream is connected. A verified local instructor adapter is required to watch a real session.</p><p>Assessment feedback remains withheld from the trainee until debrief.</p></section> : null}
      <form className="instructor-form" onSubmit={(event) => { event.preventDefault(); const draft = assignmentDraft(trainee, caseId, note); if (draft === null || !cases.some((card) => card.case_id === caseId)) { setNotice("Choose an available public case and a sample trainee."); return; } onAssignmentDraft(draft); setNotice("Local assignment draft prepared. Nothing was assigned or sent."); }}><h3>Prepare an assignment draft</h3><div className="training-filters"><label htmlFor={`${id}-trainee`}>Sample trainee<select id={`${id}-trainee`} value={trainee} onChange={(event) => { setTrainee(event.target.value); }}><option>Sample trainee A</option><option>Sample trainee B</option></select></label><label htmlFor={`${id}-case`}>Public case<select id={`${id}-case`} value={caseId} onChange={(event) => { setCaseId(event.target.value); }}>{cases.length === 0 ? <option value="">No public cases supplied</option> : cases.map((card) => <option key={card.case_id} value={card.case_id}>{card.title}</option>)}</select></label></div><label className="training-field" htmlFor={`${id}-note`}>Practice objective<textarea id={`${id}-note`} rows={2} maxLength={2000} value={note} onChange={(event) => { setNote(event.target.value); }} /></label><button className="training-button" type="submit" disabled={cases.length === 0}>Prepare local assignment draft</button><p className="training-meta">The assignment request contract is not available. This local note is not an API request.</p></form>
      <form className="instructor-form" onSubmit={(event) => { event.preventDefault(); const body = annotationDraft(Number(time), annotation); if (body === null || time.trim() === "") { setNotice("Enter a whole, non-negative millisecond timestamp and a note."); return; } onAnnotationDraft({ trialId: "LOCAL-DEMO-TRIAL", body }); setNotice("Local timeline draft prepared. Nothing was posted."); }}><h3>Prepare a timeline note</h3><label className="training-field" htmlFor={`${id}-time`}>Timestamp in milliseconds<input id={`${id}-time`} type="number" min={0} step={1} value={time} onChange={(event) => { setTime(event.target.value); }} /></label><label className="training-field" htmlFor={`${id}-annotation`}>Note for the sample timeline<textarea id={`${id}-annotation`} rows={2} maxLength={2000} value={annotation} onChange={(event) => { setAnnotation(event.target.value); }} /></label><button className="training-button" type="submit">Prepare local timeline draft</button></form>
      {notice === null ? null : <p role="status" className="training-notice">{notice}</p>}
      <section className="instructor-drafts"><h3>Local drafts</h3>{assignments.length === 0 && annotations.length === 0 ? <p className="training-meta">No drafts yet.</p> : <ul>{assignments.map((draft, index) => <li key={`assignment-${String(index)}`}><strong>Assignment draft</strong> · {draft.traineeLabel} · {draft.caseId}<p>{draft.note}</p></li>)}{annotations.map((draft, index) => <li key={`annotation-${String(index)}`}><strong>Timeline draft</strong> · {draft.trialId} · {draft.body.t_ms} ms<p>{draft.body.text}</p></li>)}</ul>}</section>
    </>}<TrainingGroundRule />
  </div>;
}
