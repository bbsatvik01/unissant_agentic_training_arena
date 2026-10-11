/**
 * The debrief (S6 4.7, stage 2 signature scene): staged in the room, the camera on the evidence wall where the score
 * cards pin themselves, with this card beside it. Four views of the published `debrief.v1`: the rubric (the total
 * and the five 0-4 dimensions counting up to the server values, each with its bundled anchor text and checks), the
 * per-question review (what was asked, how the coach read it, its suggestion against the question asked next), the
 * coach's detection scorecard (evasion found of events, unsupported flags) and learning (evidence coverage, key
 * questions). The outcome appears here and only here (S6 5.4). Every number is the document's own (FE-DEB-2).
 */
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { useRef, useState } from "react";

import type { Debrief } from "../../lib/contracts/generated/types";
import { EX4_EVASION_SENTENCE, EX4_TEXT } from "../../lib/copy/ex4";
import { flagPhrase, LABELS } from "../../lib/copy/finding";
import { anchorFor, checkName, RUBRIC } from "../../lib/copy/rubric";
import type { TrialView } from "../../lib/trial/trialReducer";
import { detectionOf, ofText, questionReview } from "../../lib/world/debrief";
import { Tabs } from "./Tabs";

gsap.registerPlugin(useGSAP);

function word(label: string | null): string {
  if (label === null) return "none";
  return LABELS.find((l) => l.id === label)?.word ?? label;
}

function words(id: string): string {
  const t = id.replaceAll("_", " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function turnsText(turns: readonly number[]): string {
  return turns.length === 0 ? "" : ` (${turns.map((t) => `T${String(t)}`).join(", ")})`;
}

function Scores({ debrief }: { debrief: Debrief }) {
  if (!debrief.scored) return <p className="fine">Voice practice: not scored.</p>;
  const { rubric } = debrief;
  if (!rubric.scorable || rubric.total === null) return <p className="fine">{rubric.unscorable_reason ?? "This session could not be scored."}</p>;
  return (
    <div className="debrief-scores">
      <p className="total">
        <span data-count={rubric.total}>{rubric.total}</span>
        <span className="of">/ 100</span>
      </p>
      <ul className="dims">
        {rubric.dimensions.map((d) => (
          <li key={d.dim_id} className="dim">
            <div className="dim-head">
              <span className="mono">{d.dim_id}</span>
              <span>{words(RUBRIC[d.dim_id].name)}</span>
              <span className="dim-score">
                <span data-count={d.score}>{d.score}</span> / 4
              </span>
            </div>
            <p className="fine">{anchorFor(d.dim_id, d.score)}</p>
            <ul className="checks">
              {d.checks.map((c) => (
                <li key={c.id} data-result={c.result}>
                  <span className="mono">{c.id}</span> {checkName(c.id)}: {c.result === "na" ? "not applicable" : c.result === "pass" ? "met" : "not met"}
                  {turnsText(c.turns)}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Questions({ view }: { view: TrialView | null }) {
  if (view === null || view.turns.length === 0) return <p className="empty">No questions were asked.</p>;
  return (
    <ol className="review">
      {questionReview(view).map((r) => (
        <li key={r.turn} className="review-item">
          <span className="mono">T{r.turn}</span>
          <p className="line">
            <span className="speaker">Asked</span>
            {r.question}
          </p>
          {r.questionType === null ? null : (
            <p className="fine">
              {words(r.questionType)}
              {r.neutralityIssues.length === 0 ? "" : `; ${r.neutralityIssues.map(words).join(", ")}`}. {r.assessment}
            </p>
          )}
          {r.answerCategory === null ? null : <p className="fine">Answer: {words(r.answerCategory)}</p>}
          {r.flags.length === 0 ? null : (
            <p className="fine">
              {r.flags.map((f) => `${words(flagPhrase(f.kind as never))}: "${f.quote}"`).join("; ")}. {EX4_EVASION_SENTENCE}.
            </p>
          )}
          {r.suggested === null ? null : (
            <p className="line">
              <span className="speaker">Coach suggested next</span>
              {r.suggested}
            </p>
          )}
          {r.askedNext === null ? null : (
            <p className="line">
              <span className="speaker">You asked next</span>
              {r.askedNext}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

function Detection({ debrief }: { debrief: Debrief }) {
  const d = detectionOf(debrief);
  if (d === null) return <p className="fine">Voice practice: not scored.</p>;
  const contradictions = debrief.scored ? debrief.rubric.dimensions.flatMap((dim) => dim.checks).find((c) => c.id === "3e") : undefined;
  return (
    <dl className="facts">
      <div>
        <dt>Contradictions put to the subject (3e)</dt>
        <dd>{contradictions === undefined ? "not scored" : contradictions.result === "na" ? "none arose" : contradictions.result === "pass" ? `all raised${turnsText(contradictions.turns)}` : `not all raised${turnsText(contradictions.turns)}`}</dd>
      </div>
      <div>
        <dt>Evasion the coach found (strict)</dt>
        <dd>{ofText(d.evasion_strict.tp, d.evasion_strict.events)} labeled events</dd>
      </div>
      <div>
        <dt>Evasion the coach found (broad)</dt>
        <dd>{ofText(d.evasion_broad.tp, d.evasion_broad.events)} labeled events</dd>
      </div>
      <div>
        <dt>Coach flags</dt>
        <dd>
          {d.unique_flags} unique; unsupported: {d.unsupported.citation} citation, {d.unsupported.demeanor} demeanor, {d.unsupported.claim} claim
        </dd>
      </div>
      <div>
        <dt>Coach's last reading</dt>
        <dd>
          {word(d.coach_last_label)} (case outcome: {word(debrief.outcome.correct_finding)})
        </dd>
      </div>
      <p className="fine">{EX4_EVASION_SENTENCE}.</p>
    </dl>
  );
}

function Learning({ debrief }: { debrief: Debrief }) {
  if (!debrief.scored) return <p className="fine">Voice practice: not scored.</p>;
  const { learning, subject_realism: realism } = debrief.scorecards;
  return (
    <dl className="facts">
      <div>
        <dt>Key facts asked about</dt>
        <dd>{ofText(learning.evidence_coverage.addressed, learning.evidence_coverage.key_facts)}</dd>
      </div>
      {learning.key_questions.map((k) => (
        <div key={k.intent}>
          <dt>{k.intent}</dt>
          <dd>{k.addressed_turns.length === 0 ? "not asked" : `asked${turnsText(k.addressed_turns)}`}</dd>
        </div>
      ))}
      <div>
        <dt>Subject realism</dt>
        <dd>{ofText(realism.compliant, realism.turns)} turns within its role</dd>
      </div>
    </dl>
  );
}

export function DebriefScene({ debrief, view, reducedMotion, onClose }: { debrief: Debrief; view: TrialView | null; reducedMotion: boolean; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState("scores");
  useGSAP(
    () => {
      root.current?.querySelectorAll<HTMLElement>("[data-count]").forEach((el, i) => {
        const target = Number(el.dataset["count"]);
        if (reducedMotion) {
          el.textContent = String(target);
          return;
        }
        const counter = { value: 0 };
        gsap.to(counter, {
          value: target,
          duration: 1.4,
          delay: 0.3 + i * 0.12,
          ease: "power2.out",
          onUpdate: () => {
            el.textContent = String(Math.round(counter.value));
          },
          onComplete: () => {
            el.textContent = String(target);
          },
        });
      });
    },
    { scope: root, dependencies: [debrief.session_id, reducedMotion, tab], revertOnUpdate: true },
  );
  return (
    <div className="debrief debrief-scene" ref={root} role="dialog" aria-labelledby="debrief-title">
      <header className="panel-head">
        <h2 id="debrief-title">Debrief</h2>
        <button type="button" className="btn-secondary-sm" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="debrief-intro">
        <p className="fine">{EX4_TEXT}</p>
        <p>
          Case outcome: <strong>{word(debrief.outcome.correct_finding)}</strong>. Your finding: <strong>{word(debrief.outcome.committed_label)}</strong>.
        </p>
        <p className="fine">{debrief.outcome.resolution}</p>
      </div>
      <Tabs
        label="Debrief views"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "scores", label: "Scores", content: <Scores debrief={debrief} /> },
          { id: "questions", label: "Questions", content: <Questions view={view} /> },
          { id: "detection", label: "Detection", content: <Detection debrief={debrief} /> },
          { id: "learning", label: "Learning", content: <Learning debrief={debrief} /> },
        ]}
      />
    </div>
  );
}
