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

import type { CoachCard, Debrief } from "../../lib/contracts/generated/types";
import { EX4_EVASION_SENTENCE, EX4_TEXT } from "../../lib/copy/ex4";
import { contentText } from "../../lib/contracts/quote";
import { LABELS } from "../../lib/copy/finding";
import { anchorFor, checkName, RUBRIC } from "../../lib/copy/rubric";
import type { TrialView } from "../../lib/trial/trialReducer";
import { detectionOf, ofText, questionReview } from "../../lib/world/debrief";
import type { CaseDocument } from "../../lib/world/recording";
import { Flag, recordMap } from "./CoachPanel";
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
      <p className="fine provenance">
        Scored with rubric <span className="mono">{debrief.provenance.rubric_sha256.slice(0, 12)}</span>, prompts{" "}
        <span className="mono">{debrief.provenance.r3_prompt_sha256.map((h) => h.slice(0, 12)).join(", ")}</span>, referee models{" "}
        <span className="mono">{debrief.provenance.referee_model_ids.join(", ")}</span>, scorer <span className="mono">{debrief.provenance.scorer_git_sha.slice(0, 12)}</span>.
      </p>
    </div>
  );
}

function FlagList({ card, view, records, onCite }: { card: CoachCard["card"]; view: TrialView; records: ReadonlyMap<string, { title: string; text: string }>; onCite: (turn: number, quote: string) => void }) {
  return (
    <>
      <ul className="flags">
        {card.flags.map((f) => (
          <Flag key={f.flag_ref} flag={f} card={card} view={view} records={records} onCite={onCite} />
        ))}
      </ul>
      <p className="fine">{EX4_EVASION_SENTENCE}.</p>
    </>
  );
}

/** A voice session's stored exchanges, role-tagged, in order (S6 4.7, FE-DEB-6): not scored, shown as spoken. */
function VoiceExchanges({ view }: { view: TrialView }) {
  return (
    <ol className="review">
      {view.voiceExchanges.map((x) => (
        <li key={x.exchange_no} className="review-item">
          <span className="mono">V{x.exchange_no}</span>
          {x.lines.map((l, i) => (
            <p key={i} className="line">
              <span className="speaker">{l.role === "investigator" ? "You said" : "The subject said"}</span>
              {l.text}
              {l.partial ? " (cut off)" : ""}
            </p>
          ))}
        </li>
      ))}
    </ol>
  );
}

function Questions({ view, documents }: { view: TrialView | null; documents: readonly CaseDocument[] }) {
  if (view !== null && view.turns.length === 0 && view.voiceExchanges.length > 0) return <VoiceExchanges view={view} />;
  if (view === null || view.turns.length === 0) return <p className="empty">No questions were asked.</p>;
  const records = recordMap(documents, view.released);
  return <Review view={view} records={records} />;
}

/** The answer with the cited quote marked, when the quote is in it. */
function Answer({ text, quote }: { text: string; quote: string | null }) {
  const at = quote === null || quote === "" ? -1 : text.indexOf(quote);
  if (quote === null || at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{quote}</mark>
      {text.slice(at + quote.length)}
    </>
  );
}

function Review({ view, records }: { view: TrialView; records: ReadonlyMap<string, { title: string; text: string }> }) {
  const [cited, setCited] = useState<{ turn: number; quote: string } | null>(null);
  // A citation chip moves focus to its turn and marks the quote there (S6 9: keyboard reachable, visible target).
  const onCite = (turn: number, quote: string) => {
    setCited({ turn, quote });
    const target = document.getElementById(`review-T${String(turn)}`);
    target?.scrollIntoView({ block: "center" });
    target?.focus();
  };
  return (
    <ol className="review">
      {questionReview(view).map((r) => (
        <li key={r.turn} id={`review-T${String(r.turn)}`} className="review-item" tabIndex={-1} data-cited={cited?.turn === r.turn ? "true" : undefined}>
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
          {r.neutralityIssues.includes("demeanor_reference") ? <p className="callout">This question relied on how the subject seems rather than on what they said or the records.</p> : null}
          {r.answer === null ? null : (
            <p className="line">
              <span className="speaker">Answered</span>
              <Answer text={r.answer} quote={cited?.turn === r.turn ? cited.quote : null} />
            </p>
          )}
          {r.answerCategory === null ? null : <p className="fine">Answer: {words(r.answerCategory)}</p>}
          {r.card === null || r.card.flags.length === 0 ? null : <FlagList card={r.card} view={view} records={records} onCite={onCite} />}
          {r.released.map((rel) => (
            <details key={rel.record_id} className="release-marker">
              <summary>
                Released after this turn: <span className="mono">{rel.record_id}</span> {rel.title}
              </summary>
              <p className="fine">{contentText(rel.content)}</p>
            </details>
          ))}
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
        <dd>
          {ofText(d.evasion_strict.tp, d.evasion_strict.events)} labeled events; {ofText(d.evasion_strict.tp, d.evasion_strict.flags)} of its flags matched
        </dd>
      </div>
      <div>
        <dt>Evasion the coach found (broad)</dt>
        <dd>
          {ofText(d.evasion_broad.tp, d.evasion_broad.events)} labeled events; {ofText(d.evasion_broad.tp, d.evasion_broad.flags)} of its flags matched
        </dd>
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
      <div>
        <dt>Subject realism failures by check</dt>
        <dd>
          F1 canonical consistency {realism.failures.F1}, F2/F4 disclosure policy {realism.failures.F2_F4}, F3 knowledge bounds {realism.failures.F3}, F5 platform integrity {realism.failures.F5}, F6 in character {realism.failures.F6}
        </dd>
      </div>
    </dl>
  );
}

export function DebriefScene({ debrief, view, documents, reducedMotion, onClose }: { debrief: Debrief; view: TrialView | null; documents: readonly CaseDocument[]; reducedMotion: boolean; onClose: () => void }) {
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
          The subject's role: <strong>{debrief.outcome.role}</strong>. Case outcome: <strong>{word(debrief.outcome.correct_finding)}</strong>. Your finding: <strong>{word(debrief.outcome.committed_label)}</strong>.
        </p>
        <p className="fine">{debrief.outcome.resolution}</p>
      </div>
      <Tabs
        label="Debrief views"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "scores", label: "Scores", content: <Scores debrief={debrief} /> },
          { id: "questions", label: debrief.scored ? "Questions" : "Exchanges", content: <Questions view={view} documents={documents} /> },
          { id: "detection", label: "Detection", content: <Detection debrief={debrief} /> },
          { id: "learning", label: "Learning", content: <Learning debrief={debrief} /> },
        ]}
      />
    </div>
  );
}
