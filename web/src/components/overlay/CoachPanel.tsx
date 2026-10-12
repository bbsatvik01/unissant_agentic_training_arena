/**
 * The coach card panel (S6 4.5): the newest accepted card expanded, earlier cards collapsed. Fields are rendered
 * from the card's typed values through fixed words and templates; flags carry citation chips checked with the
 * shared quote predicate, and an unverifiable quote is shown as such. In assessment the region holds only its
 * placeholder (S6 4.3, FE-ROOM-3).
 */
import type { CoachCard, SnapshotRelease, StoredFinding, StoredFlag } from "../../lib/contracts/generated/types";
import { contentText, quoteOk } from "../../lib/contracts/quote";
import { EX4_EVASION_SENTENCE, EX4_TEXT } from "../../lib/copy/ex4";
import { flagPhrase, renderFinding } from "../../lib/copy/finding";
import type { TrialView } from "../../lib/trial/trialReducer";
import type { CaseDocument } from "../../lib/world/recording";

const CATEGORY: Readonly<Record<string, string>> = {
  responsive: "Responsive",
  non_responsive: "Non-responsive",
  contradiction: "Contradiction",
  explicit_uncertainty: "Explicit uncertainty",
  possible_evasion: "Possible evasion",
};

function words(id: string): string {
  const text = id.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface CoachPanelProps {
  readonly view: TrialView;
  readonly released: readonly SnapshotRelease[];
  readonly documents: readonly CaseDocument[];
  readonly onCite: (turn: number, quote: string) => void;
  /** Null when the composer cannot take a question (playback). */
  readonly onUseQuestion: ((question: string) => void) | null;
}

function turnOf(id: string): number {
  return Number(id.slice(1, 3));
}

function Chip({ turn, quote, ok, onCite }: { turn: number; quote: string; ok: boolean; onCite: (turn: number, quote: string) => void }) {
  return (
    <button
      type="button"
      className="chip"
      data-cite={ok ? "ok" : "missing"}
      aria-label={ok ? `Turn ${String(turn)}: ${quote.slice(0, 60)}` : `Quote not found in T${String(turn)}`}
      onClick={() => {
        // An unverifiable citation is never highlighted (S6 4.5); its chip only says so.
        if (ok) onCite(turn, quote);
      }}
    >
      T{turn}
      {ok ? null : <span className="chip-note">quote not found</span>}
    </button>
  );
}

/** A flag with its citation chips; shared with the debrief's annotated transcript (S6 4.7 region 5). */
export function Flag({ flag, card, view, records, onCite }: { flag: StoredFlag; card: CoachCard["card"]; view: TrialView; records: ReadonlyMap<string, { title: string; text: string }>; onCite: CoachPanelProps["onCite"] }) {
  const turn = turnOf(flag.turn_id);
  const answer = view.turns.find((t) => t.turn_no === turn)?.answer ?? "";
  // Verified only when both the shared predicate here and the server's own check agree (S6 4.5).
  const ok = quoteOk(flag.quote, answer) && card.validation.flags[flag.flag_ref]?.citation_ok !== false;
  const record = flag.conflict_record_id === null ? undefined : records.get(flag.conflict_record_id);
  const conflictTurn = flag.conflict_turn_id === null ? null : turnOf(flag.conflict_turn_id);
  const conflictAnswer = conflictTurn === null ? "" : (view.turns.find((t) => t.turn_no === conflictTurn)?.answer ?? "");
  return (
    <li className="flag" data-flag-kind={flag.kind}>
      <span className="flag-kind">{words(flagPhrase(flag.kind))}</span>
      <Chip turn={turn} quote={flag.quote} ok={ok} onCite={onCite} />
      <q>{flag.quote}</q>
      {flag.missing_fact === null ? null : <span className="flag-detail">Missing: {flag.missing_fact}</span>}
      {conflictTurn !== null && flag.conflict_quote !== null ? (
        <span className="flag-detail">
          Conflicts with <Chip turn={conflictTurn} quote={flag.conflict_quote} ok={quoteOk(flag.conflict_quote, conflictAnswer)} onCite={onCite} />
          <q>{flag.conflict_quote}</q>
        </span>
      ) : null}
      {flag.conflict_record_id !== null && flag.conflict_record_quote !== null ? (
        <span className="flag-detail">
          Conflicts with record <span className="mono">{flag.conflict_record_id}</span>
          {record === undefined ? null : ` (${record.title})`}: <q>{flag.conflict_record_quote}</q>
          {record !== undefined && !quoteOk(flag.conflict_record_quote, record.text) ? <span className="chip-note"> quote not found</span> : null}
        </span>
      ) : null}
    </li>
  );
}

function Card({ card, view, records, onCite, onUseQuestion, finding }: { card: CoachCard; view: TrialView; records: ReadonlyMap<string, { title: string; text: string }>; finding: StoredFinding } & Pick<CoachPanelProps, "onCite" | "onUseQuestion">) {
  const c = card.card;
  const [first, second] = renderFinding(finding);
  const requested = c.follow_up.record_request;
  const suggested = requested === null ? undefined : (records.get(requested) ?? view.requestable.find((r) => r.record_id === requested));
  return (
    <div className="card-body">
      <dl className="facts">
        <div>
          <dt>Question</dt>
          <dd>
            {words(c.question.question_type)}
            {c.question.neutrality_issues.length === 0 ? "" : `; ${c.question.neutrality_issues.map(words).join(", ")}`}. {c.question.assessment}
          </dd>
        </div>
        {c.question.neutrality_issues.includes("demeanor_reference") ? (
          <p className="callout">This question relied on how the subject seems rather than on what they said or the records.</p>
        ) : null}
        <div>
          <dt>Answer</dt>
          <dd>{CATEGORY[c.answer_category] ?? c.answer_category}</dd>
        </div>
      </dl>
      {c.flags.length === 0 ? null : (
        <>
          <ul className="flags">
            {c.flags.map((f) => (
              <Flag key={f.flag_ref} flag={f} card={c} view={view} records={records} onCite={onCite} />
            ))}
          </ul>
          <p className="fine">{EX4_EVASION_SENTENCE}.</p>
        </>
      )}
      <div className="follow-up">
        <span className="eyebrow">Suggested follow-up</span>
        <p>{c.follow_up.question}</p>
        <p className="fine">
          {words(c.follow_up.tactic)}. {c.follow_up.purpose}
          {suggested === undefined ? "" : ` Suggests presenting ${suggested.title}.`}
        </p>
        <button
          type="button"
          className="btn-secondary-sm"
          disabled={onUseQuestion === null}
          onClick={() => {
            onUseQuestion?.(c.follow_up.question);
          }}
        >
          Use this question
        </button>
      </div>
      <div className="finding-text" data-finding={finding.label}>
        <span className="eyebrow">Running finding</span>
        <p>{first}</p>
        <p>{second}</p>
        <p className="fine">{EX4_TEXT}</p>
      </div>
    </div>
  );
}

/** The case documents and released records by id, as title and plain text, for quote checks. */
export function recordMap(documents: readonly CaseDocument[], released: readonly SnapshotRelease[]): ReadonlyMap<string, { title: string; text: string }> {
  return new Map<string, { title: string; text: string }>([
    ...documents.map((d) => [d.doc_id, { title: d.title, text: contentText(d.content) }] as const),
    ...released.map((r) => [r.record_id, { title: r.title, text: contentText(r.content) }] as const),
  ]);
}

export function CoachPanel({ view, released, documents, onCite, onUseQuestion }: CoachPanelProps) {
  if (view.mode === "assessment") return <p className="empty">Coaching is saved for your debrief.</p>;
  const records = recordMap(documents, released);
  const newest = view.cards.at(-1);
  const earlier = view.cards.slice(0, -1).reverse();
  const failed = view.coachFailures.at(-1);
  const update = view.updates.at(-1);
  return (
    <div className="coach">
      {view.coachReading === null ? null : (
        <p className="loading" role="status">
          Coach is reading T{view.coachReading}
        </p>
      )}
      {failed !== undefined && (newest === undefined || failed.turn_no > newest.turn_no) ? <p className="empty">Coaching for this turn was not available.</p> : null}
      {/* While the subject answers, the coach is listening: the wait reads as work in progress, not an empty panel. */}
      {view.coachReading === null && view.status === "subject_answering" ? (
        <p className="loading" role="status">
          Coach is listening to the answer
        </p>
      ) : null}
      {newest === undefined ? (
        view.coachReading === null && view.status !== "subject_answering" ? <p className="empty">The coach reviews each answer and suggests a follow-up.</p> : null
      ) : (
        <article aria-labelledby="card-title">
          <h3 id="card-title" className="card-title">
            Card for T{newest.turn_no}
          </h3>
          {/* The newest card shows the reducer's running finding: a later deep update supersedes the card's (S6 4.5). */}
          <Card card={newest} view={view} records={records} onCite={onCite} onUseQuestion={onUseQuestion} finding={view.runningFinding ?? newest.card.finding} />
          {update === undefined || update.update.evidence_coverage.length === 0 ? null : (
            <div className="follow-up">
              <span className="eyebrow">Evidence coverage, as of T{update.turn_no}</span>
              <ul>
                {update.update.evidence_coverage.map((e) => (
                  <li key={e.record_id}>
                    <span className="mono">{e.record_id}</span> {words(e.status)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </article>
      )}
      {earlier.length === 0 ? null : (
        <div className="earlier">
          <span className="eyebrow">Earlier cards</span>
          {earlier.map((card) => (
            <details key={card.turn_no}>
              <summary>
                T{card.turn_no}: {CATEGORY[card.card.answer_category] ?? card.card.answer_category}
                {card.card.flags.length === 0 ? "" : `, ${String(card.card.flags.length)} flag${card.card.flags.length === 1 ? "" : "s"}`}
              </summary>
              <Card card={card} view={view} records={records} onCite={onCite} onUseQuestion={onUseQuestion} finding={card.card.finding} />
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
