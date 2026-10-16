import { useId, useState } from "react";
import { EX4_TEXT } from "../../lib/copy/ex4";
import { dayOf, kpi1Text, type Kpi1, type ScoreState } from "../../lib/progress/progress";
import { canReplayTape, caseBoardEntries, caseDifficulties, COURSE_PRIMERS, skillNodes, type ArchiveTape, type CaseBoardEntry, type SkillId } from "../../lib/precinct/trainingStations";
import "../../styles/precinct-training-stations.css";

export function TrainingGroundRule() {
  return <aside className="training-ground-rule"><strong>Evidence first</strong><p>Nervousness, demeanor, accent and stress are never evidence.</p><p>{EX4_TEXT}</p></aside>;
}

/** Content for the route's native dialog. Availability is explicit; selecting never starts a session here. */
export function CaseBoardPanel({ entries, selectedCaseId, onSelect, assessmentActive = false }: {
  readonly entries: readonly CaseBoardEntry[];
  readonly selectedCaseId: string | null;
  readonly onSelect: (caseId: string) => void;
  readonly assessmentActive?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [difficulty, setDifficulty] = useState<number | null>(null);
  const searchId = useId();
  const rows = caseBoardEntries(entries, query, difficulty);
  return <div className="training-station case-board-panel">
    <div className="training-intro"><span className="station-tag">PUBLIC CASE FILES</span><p>Start with the objective. Follow the evidence, wherever it leads.</p></div>
    <div className="training-filters"><label htmlFor={searchId}>Find a case<input id={searchId} type="search" value={query} onChange={(event) => { setQuery(event.target.value); }} placeholder="Title, objective, or case ID" /></label>
      <label>Difficulty<select value={difficulty ?? "all"} onChange={(event) => { setDifficulty(event.target.value === "all" ? null : Number(event.target.value)); }}><option value="all">All levels</option>{caseDifficulties(entries).map((level) => <option key={level} value={level}>Level {level}</option>)}</select></label>
    </div>
    <p className="training-meta">The ladder reflects public case difficulty. Availability and unlock requirements are supplied by the training source.</p>
    {assessmentActive ? <p className="training-notice" role="status">Case changes are unavailable during an assessment.</p> : null}
    <div className="case-file-grid">{rows.map(({ card, availability }) => <article key={card.case_id} className="case-file" data-selected={selectedCaseId === card.case_id}>
      <div className="case-file-top"><span className="training-mono">{card.case_id}</span><span>LEVEL {card.difficulty_level}</span></div>
      <h3>{card.title}</h3><p>{card.objective}</p>
      <dl><div><dt>Domain</dt><dd>{card.domain}</dd></div><div><dt>Public subject</dt><dd>{card.subject.display_name}</dd></div><div><dt>Documents</dt><dd>{card.initial_documents} initial · {card.requestable_records} requestable</dd></div></dl>
      <div className="case-file-foot"><span className="training-availability" data-kind={availability.kind}>{availability.kind === "locked" ? "Locked" : availability.kind === "preview" ? "Preview only" : "Available"}</span><p>{availability.detail}</p>
      <button type="button" className="training-button" disabled={assessmentActive || availability.kind !== "available" || selectedCaseId === card.case_id} onClick={() => { onSelect(card.case_id); }}>{selectedCaseId === card.case_id ? "Selected case" : availability.kind === "locked" ? "Case locked" : availability.kind === "preview" ? "Session unavailable" : "Select case"}</button></div>
    </article>)}</div>
    {rows.length === 0 ? <p className="training-empty">{entries.length === 0 ? "No public case files are available from this source." : "No cases match these filters. Try another title or difficulty."}</p> : null}
    <TrainingGroundRule />
  </div>;
}

export function SkillProgressPanel({ score, sourceLabel, kpi1 = null, onOpenPrimer, assessmentActive = false }: {
  readonly score: ScoreState | undefined;
  readonly sourceLabel: string;
  readonly kpi1?: Kpi1 | null;
  readonly onOpenPrimer: (skill: SkillId) => void;
  readonly assessmentActive?: boolean;
}) {
  const kpi = kpi1Text(kpi1);
  if (assessmentActive) return <div className="training-station"><p className="training-notice" role="status">Rubric guidance and skill feedback are unavailable during an assessment. Feedback returns in the debrief.</p><TrainingGroundRule /></div>;
  return <div className="training-station skill-progress-panel">
    <div className="training-intro"><span className="station-tag">FIVE SKILLS · ONE EVIDENCE-LED PRACTICE</span><p>Build a questioning practice you can explain.</p></div>
    <p className="training-source">{sourceLabel}</p><p className="training-meta">Each value is a published rubric dimension, from 0 to 4. These branches are learning topics, not locked abilities or a certification.</p>
    <ol className="training-skill-tree">{skillNodes(score).map((node) => <li key={node.id}><div className="skill-node-marker" aria-hidden="true">{node.id.slice(1)}</div><article>
      <div className="skill-node-title"><h3>{node.title}</h3><span className="skill-node-score">{node.score === null ? "Not measured" : `${String(node.score)} / 4`}</span></div>
      {node.score === null ? (node.status === "Not measured" ? null : <p className="training-meta">{node.status}</p>) : <><meter min={0} max={4} value={node.score} aria-label={`${node.title}: ${String(node.score)} of 4`} /><p className="training-meta">{node.anchor}</p></>}
      <button type="button" className="training-link" onClick={() => { onOpenPrimer(node.id); }}>Read the technique primer <span aria-hidden="true">↗</span></button>
    </article></li>)}</ol>
    <section className="training-kpi"><h3>Improvement on unseen cases</h3><p className="training-meta">KPI-1 appears only when the training source publishes it.</p><dl><div><dt>Baseline</dt><dd>{kpi.pre}</dd></div><div><dt>Post-test</dt><dd>{kpi.post}</dd></div><div><dt>Relative change</dt><dd>{kpi.relative}</dd></div></dl></section>
    <TrainingGroundRule />
  </div>;
}

export function ArchivePanel({ tapes, selectedPrimer = "D1", onReplay, assessmentActive = false }: {
  readonly tapes: readonly ArchiveTape[];
  readonly selectedPrimer?: SkillId;
  readonly onReplay: (trialId: string) => void;
  readonly assessmentActive?: boolean;
}) {
  const [shelf, setShelf] = useState<"courses" | "tapes">("courses");
  return <div className="training-station archive-panel"><div className="training-intro"><span className="station-tag">THE TRAINING ARCHIVE</span><p>A quiet place to revisit a question.</p></div>
    <div className="training-switch" aria-label="Archive shelves"><button type="button" aria-pressed={shelf === "courses"} onClick={() => { setShelf("courses"); }}>Technique primers</button><button type="button" aria-pressed={shelf === "tapes"} onClick={() => { setShelf("tapes"); }}>Recorded sessions</button></div>
    {assessmentActive ? <p className="training-notice" role="status">Training primers and prior-session playback are unavailable during an assessment. Feedback returns in the debrief.</p> : shelf === "courses" ? <div className="course-shelf"><p className="training-meta">Short authored practice guides, mapped to the five rubric skills. No case answers or hidden evaluator material.</p>{COURSE_PRIMERS.map((primer) => <details key={primer.id} open={primer.id === selectedPrimer} className="course-file"><summary><span className="training-mono">{primer.id}</span><span>{primer.title}</span><span className="course-arrow" aria-hidden="true">+</span></summary><div><p className="course-aim">{primer.aim}</p><ol>{primer.steps.map((step) => <li key={step}>{step}</li>)}</ol><div className="course-example"><span className="training-mono">TRY SAYING</span><p>“{primer.example}”</p></div><p className="course-reflection"><strong>Before you move on</strong>{primer.reflection}</p></div></details>)}</div> : <div className="tape-shelf">
      {tapes.length === 0 ? <p className="training-empty">No recordings are available from this source. Your recorded runs will appear here when supplied.</p> : null}
      {tapes.map((tape) => <article key={tape.session.session_id} className="archive-tape"><span className="tape-spools" aria-hidden="true">◉ ━ ◉</span><div><span className="training-mono">{tape.sourceLabel}</span><h3>{tape.session.case_title ?? "Untitled training session"}</h3><p>{dayOf(tape.session.created_at)} · {tape.session.mode} · {tape.session.status}</p><button type="button" className="training-button" disabled={!canReplayTape(tape)} onClick={() => { onReplay(tape.session.trial_id); }}>{canReplayTape(tape) ? "Play recording" : "Recording unavailable"}</button></div></article>)}
    </div>}
    <TrainingGroundRule />
  </div>;
}
