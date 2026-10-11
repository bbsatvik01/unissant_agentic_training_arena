/**
 * The trainer console (S6 4.12, S3 7.3): the rater's assigned items as opaque ids and task kinds, and one item at
 * a time rendered from exactly the fields its kind returns, with the form for the proxy's own binary fields. Never
 * shown: participant or candidate identity, phase, session dates or times, case-set label, mode, proxy outputs or
 * any other rating (FE-REV-1, FE-REV-2). Submit needs every field the kind requires (FE-REV-3); no 0-4 score is
 * ever entered. A submitted item reads "already submitted".
 */
import type { ReactNode } from "react";

import type { CaseFile, Content, FlagItem, LabelItem, ReviewItem, ReviewListEntry, ReviewRecord, ReviewTurn, RubricItem, TriggerEntry } from "../../lib/contracts/generated/types";
import { checkName } from "../../lib/copy/rubric";
import { missing, turnId, type CitationDraft, type FlagDraft, type FollowupDraft, type LabelDraft, type ReviewDraft, type SubcheckDraft } from "../../lib/console/review";

export type SubmitState = "idle" | "sending" | "sent" | "already" | "failed";

interface TrainerConsoleProps {
  readonly items: readonly ReviewListEntry[] | null;
  readonly listFailed: boolean;
  readonly selected: string | null;
  readonly item: ReviewItem | null;
  readonly itemFailed: boolean;
  readonly draft: ReviewDraft | null;
  readonly submit: SubmitState;
  readonly onSelect: (itemId: string) => void;
  /** Apply a change to the draft (the caller copies it first). */
  readonly onEdit: (change: (draft: ReviewDraft) => void) => void;
  readonly onSubmit: () => void;
}

const TASK_NAME: Readonly<Record<ReviewItem["task"], string>> = { "T-RUB": "Questioning and finding", "T-LAB": "Subject turns", "T-FLAG": "Coach flags" };

function words(id: string): string {
  const t = id.replaceAll("_", " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function ContentView({ content }: { content: Content }) {
  return (
    <>
      <p className="record-body">{content.body}</p>
      {content.table === undefined || content.table === null ? null : (
        <table className="board">
          <thead>
            <tr>
              {content.table.columns.map((c) => (
                <th key={c} scope="col">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {content.table.rows.map((r, i) => (
              <tr key={i}>
                {r.map((cell, j) => (
                  <td key={j}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Transcript({ turns }: { turns: readonly ReviewTurn[] }) {
  return (
    <ol className="review-transcript">
      {turns.map((t) => (
        <li key={t.turn_no}>
          <span className="mono">T{t.turn_no}</span>
          <p className="line">
            <span className="speaker">Investigator</span>
            {t.question}
          </p>
          {t.answer === null ? null : (
            <p className="line">
              <span className="speaker">Subject</span>
              {t.answer}
              {t.partial ? " (cut off)" : ""}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

function Records({ initial, released }: { initial: readonly { doc_id: string; title: string; content: Content }[]; released: readonly ReviewRecord[] }) {
  return (
    <div className="review-records">
      {initial.map((d) => (
        <details key={d.doc_id}>
          <summary>
            <span className="mono">{d.doc_id}</span> {d.title}
          </summary>
          <ContentView content={d.content} />
        </details>
      ))}
      {released.map((r) => (
        <details key={r.record_id}>
          <summary>
            <span className="mono">{r.record_id}</span> {r.title} <span className="fine">released after exchange {r.released_after_exchanges}</span>
          </summary>
          <ContentView content={r.content} />
        </details>
      ))}
    </div>
  );
}

/** A case timeline time in words ("14:07, 12 March 2026"): case content, never shown as a machine timestamp. */
export function caseTime(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (m === null) return value;
  const [, y, mo, d, h, mi] = m;
  const month = new Date(Date.UTC(Number(y), Number(mo) - 1, 1)).toLocaleString("en-GB", { month: "long", timeZone: "UTC" });
  return `${h ?? ""}:${mi ?? ""}, ${String(Number(d))} ${month} ${y ?? ""}`;
}

function CaseFileView({ file }: { file: CaseFile }) {
  const c = file.interview_context;
  return (
    <section className="review-section">
      <h3 className="eyebrow">Case file</h3>
      <p>
        <strong>{file.title}</strong>
      </p>
      <p className="fine">{file.investigation_objective}</p>
      <p className="fine">
        {c.subject.name}, {c.subject.position}, {c.subject.unit}. {/[.!?]$/.test(c.setting) ? c.setting : `${c.setting}.`} {c.purpose_statement}
      </p>
      <ul className="timeline">
        {file.known_timeline.map((e, i) => (
          <li key={i}>
            {caseTime(e.time)}: {e.event} <span className="fine">({e.source})</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One code-built trigger entry in words: the check, what triggered it (turns and record), and the questions that
 * may answer it. */
export function triggerText(t: TriggerEntry): string {
  const at = [...t.trigger_turns.map((n) => `T${String(n)}`), ...(t.trigger_record === null ? [] : [t.trigger_record])];
  const window = t.question_turns.map((n) => `T${String(n)}`);
  return `${t.subcheck_id}: triggered by ${at.length === 0 ? "nothing listed" : at.join(", ")}; questions to look at: ${window.length === 0 ? "none" : window.join(", ")}`;
}

function YesNo({ label, value, onChange }: { label: string; value: boolean | null; onChange: (v: boolean) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select
        value={value === null ? "" : value ? "yes" : "no"}
        onChange={(e) => {
          onChange(e.target.value === "yes");
        }}
      >
        <option value="" disabled>
          Choose
        </option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    </label>
  );
}

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T | null; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select
        value={value ?? ""}
        onChange={(e) => {
          const hit = options.find((o) => o === e.target.value);
          if (hit !== undefined) onChange(hit);
        }}
      >
        <option value="" disabled>
          Choose
        </option>
        {options.map((o) => (
          <option key={o} value={o}>
            {words(o)}
          </option>
        ))}
      </select>
    </label>
  );
}

const QUESTION_TYPES = ["open", "probing", "closed", "leading", "suggestive", "compound", "forced_choice", "opinion"] as const;
const PER_QUESTION_FIELDS = [
  ["not_leading", "Not leading (1a)"],
  ["well_framed", "Well framed (1c)"],
  ["no_loaded_wording", "No loaded wording (1d)"],
  ["on_objective", "On the objective (2c)"],
  ["builds_on_previous", "Builds on the previous answer (2d)"],
] as const;

function RubForm({ item, draft, onEdit }: { item: RubricItem; draft: Extract<ReviewDraft, { task: "T-RUB" }>; onEdit: TrainerConsoleProps["onEdit"] }) {
  const edit = (f: (d: Extract<ReviewDraft, { task: "T-RUB" }>) => void) => {
    onEdit((d) => {
      if (d.task === "T-RUB") f(d);
    });
  };
  const turnIds = item.transcript.map((t) => turnId(t.turn_no));
  return (
    <>
      <section className="review-section">
        <h3 className="eyebrow">Each question</h3>
        {draft.followups.map((f: FollowupDraft, i) => (
          <fieldset key={f.turn_id} className="review-form">
            <legend>
              <span className="mono">{f.turn_id.toUpperCase()}</span> {item.questions[i]?.question}
            </legend>
            <Choice
              label="Question type"
              value={f.question_type}
              options={QUESTION_TYPES}
              onChange={(v) => {
                edit((d) => {
                  const x = d.followups[i];
                  if (x !== undefined) x.question_type = v;
                });
              }}
            />
            {PER_QUESTION_FIELDS.map(([key, label]) => (
              <YesNo
                key={key}
                label={label}
                value={f[key]}
                onChange={(v) => {
                  edit((d) => {
                    const x = d.followups[i];
                    if (x !== undefined) x[key] = v;
                  });
                }}
              />
            ))}
          </fieldset>
        ))}
      </section>
      <section className="review-section">
        <h3 className="eyebrow">Other checks</h3>
        {item.triggers.length === 0 ? (
          <p className="fine">Code-built trigger entries: none.</p>
        ) : (
          <ul className="triggers">
            {item.triggers.map((t, i) => (
              <li key={`${t.subcheck_id}-${String(i)}`}>{triggerText(t)}</li>
            ))}
          </ul>
        )}
        {draft.subchecks.map((s: SubcheckDraft, i) => (
          <fieldset key={s.id} className="review-form">
            <legend>
              <span className="mono">{s.id}</span> {checkName(s.id)}
            </legend>
            <Choice
              label="Result"
              value={s.result}
              options={["pass", "fail", "na"] as const}
              onChange={(v) => {
                edit((d) => {
                  const x = d.subchecks[i];
                  if (x !== undefined) x.result = v;
                });
              }}
            />
            <div className="field turn-picks" role="group" aria-label={`Deciding turns for ${s.id}, at most four`}>
              <span>Deciding turns</span>
              {turnIds.map((t) => (
                <label key={t}>
                  <input
                    type="checkbox"
                    checked={s.turn_ids.includes(t)}
                    onChange={(e) => {
                      edit((d) => {
                        const x = d.subchecks[i];
                        if (x === undefined) return;
                        x.turn_ids = e.target.checked ? [...x.turn_ids, t] : x.turn_ids.filter((y) => y !== t);
                      });
                    }}
                  />
                  {t.toUpperCase()}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </section>
      <section className="review-section">
        <h3 className="eyebrow">The committed finding</h3>
        {item.finding === null ? (
          <p className="fine">No finding was committed.</p>
        ) : (
          <>
            <p>
              {words(item.finding.label)}, {words(item.finding.likelihood)}, {item.finding.confidence} confidence. {item.finding.rationale}
            </p>
            <p className="fine">
              Cited: {[...item.finding.cited_turns.map((n) => `T${String(n)}`), ...item.finding.cited_records].join(", ") || "nothing"}.
            </p>
            {item.finding.corroboration_needed.length === 0 ? null : (
              <div>
                <span className="eyebrow">Corroboration to seek</span>
                <ul>
                  {item.finding.corroboration_needed.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
            {item.finding.alternative_explanations === null || item.finding.alternative_explanations.length === 0 ? null : (
              <div>
                <span className="eyebrow">Alternative explanations</span>
                <ul>
                  {item.finding.alternative_explanations.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </div>
            )}
            {draft.citations.map((c: CitationDraft, i) => (
              <YesNo
                key={c.cite}
                label={`Citation ${c.cite.toUpperCase()} supports the finding`}
                value={c.supports_basis}
                onChange={(v) => {
                  edit((d) => {
                    const x = d.citations[i];
                    if (x !== undefined) x.supports_basis = v;
                  });
                }}
              />
            ))}
          </>
        )}
      </section>
    </>
  );
}

const LABELS = ["responsive", "genuine_uncertainty", "legitimate_non_disclosure", "evasion", "poorly_framed_question"] as const;
const EVA = ["omission", "deflection", "appeal_to_routine", "minimization", "feigned_non_recall", "counter_question", "stall", "refusal_without_ground"] as const;
const PFQ = ["compound", "ambiguous_referent", "contested_presupposition", "double_negative", "jargon"] as const;
const FIDELITY = [
  ["no_contradiction", "No contradiction of a canonical fact (F1)"],
  ["no_invention", "No invented event (F1)"],
  ["disclosure_policy_respected", "Disclosure policy respected (F2, F4)"],
  ["uncertainty_respected", "Uncertainty respected (F3)"],
  ["platform_attack", "Aimed at the platform or the coach (F5: yes fails)"],
  ["in_character", "In character (F6)"],
] as const;

function LabForm({ item, draft, onEdit }: { item: LabelItem; draft: Extract<ReviewDraft, { task: "T-LAB" }>; onEdit: TrainerConsoleProps["onEdit"] }) {
  const edit = (i: number, f: (t: LabelDraft) => void) => {
    onEdit((d) => {
      const t = d.task === "T-LAB" ? d.turns[i] : undefined;
      if (t !== undefined) f(t);
    });
  };
  return (
    <>
      <section className="review-section">
        <h3 className="eyebrow">Private ledger</h3>
        <ul>
          {item.facts.map((f) => (
            <li key={f.id}>
              <span className="mono">{f.id}</span> {f.class.toLowerCase()}, {f.certainty}: {f.text}
              {f.gate_id === undefined || f.gate_id === null ? "" : ` (gate ${f.gate_id})`}
            </li>
          ))}
        </ul>
        {item.uncertainty.length === 0 ? null : (
          <ul>
            {item.uncertainty.map((u) => (
              <li key={u.id}>
                Uncertain about <span className="mono">{u.fact_id}</span>: {u.text} ({u.answer_form}
                {u.range_text === undefined || u.range_text === null ? "" : `: ${u.range_text}`})
              </li>
            ))}
          </ul>
        )}
        <ul>
          {item.gates.map((g) => (
            <li key={g.id}>
              Gate <span className="mono">{g.id}</span>: {g.condition}; opens {g.opens.join(", ")}
              {g.precondition_records.length === 0 ? "" : `; needs ${g.precondition_records.join(", ")}`}
            </li>
          ))}
        </ul>
        <p className="fine">Permitted behaviors: {item.permitted_behaviors.length === 0 ? "none" : item.permitted_behaviors.join(", ")}</p>
        <h3 className="eyebrow">Canonical facts</h3>
        <ul>
          {item.canonical_facts.map((f) => (
            <li key={f.id}>
              <span className="mono">{f.id}</span> {f.statement}
            </li>
          ))}
        </ul>
      </section>
      <section className="review-section">
        <h3 className="eyebrow">Each subject turn</h3>
        {draft.turns.map((t, i) => (
          <fieldset key={t.turn_id} className="review-form">
            <legend className="mono">{t.turn_id.toUpperCase()}</legend>
            <Choice
              label="Label"
              value={t.label}
              options={LABELS}
              onChange={(v) => {
                edit(i, (x) => {
                  x.label = v;
                });
              }}
            />
            {t.label === "evasion" ? (
              <Choice
                label="Evasion kind"
                value={t.eva_subtype}
                options={EVA}
                onChange={(v) => {
                  edit(i, (x) => {
                    x.eva_subtype = v;
                  });
                }}
              />
            ) : null}
            {t.label === "poorly_framed_question" ? (
              <Choice
                label="Framing problem"
                value={t.pfq_reason}
                options={PFQ}
                onChange={(v) => {
                  edit(i, (x) => {
                    x.pfq_reason = v;
                  });
                }}
              />
            ) : null}
            {FIDELITY.map(([key, label]) => (
              <YesNo
                key={key}
                label={label}
                value={t[key]}
                onChange={(v) => {
                  edit(i, (x) => {
                    x[key] = v;
                  });
                }}
              />
            ))}
          </fieldset>
        ))}
      </section>
    </>
  );
}

const J3 = [
  ["quote_relevant", "The quote is relevant to the flag"],
  ["claim_holds", "The claim holds against the transcript and records"],
  ["content_based", "Based on what was said, not on manner"],
  ["no_outside_facts", "Uses no facts from outside the case"],
] as const;

function FlagForm({ item, draft, onEdit }: { item: FlagItem; draft: Extract<ReviewDraft, { task: "T-FLAG" }>; onEdit: TrainerConsoleProps["onEdit"] }) {
  return (
    <section className="review-section">
      <h3 className="eyebrow">Each flag</h3>
      {draft.flags.map((f: FlagDraft, i) => {
        const flag = item.flags.find((x) => x.flag_ref === f.flag_ref);
        return (
          <fieldset key={f.flag_ref} className="review-form">
            <legend>
              <span className="mono">{f.flag_ref}</span> {flag === undefined ? "" : `${words(flag.kind)} at ${flag.turn_id.toUpperCase()}`}
            </legend>
            {flag === undefined ? null : (
              <p className="fine">
                &quot;{flag.quote}&quot;
                {flag.missing_fact === null ? "" : ` Missing: ${flag.missing_fact}.`}
                {flag.conflict_quote === null ? "" : ` Conflicts with ${flag.conflict_turn_id?.toUpperCase() ?? ""}: "${flag.conflict_quote}".`}
                {flag.conflict_record_quote === null ? "" : ` Conflicts with ${flag.conflict_record_id ?? ""}: "${flag.conflict_record_quote}".`}
              </p>
            )}
            {J3.map(([key, label]) => (
              <YesNo
                key={key}
                label={label}
                value={f[key]}
                onChange={(v) => {
                  onEdit((d) => {
                    const x = d.task === "T-FLAG" ? d.flags[i] : undefined;
                    if (x !== undefined) x[key] = v;
                  });
                }}
              />
            ))}
          </fieldset>
        );
      })}
    </section>
  );
}

function ItemView({ item, draft, onEdit }: { item: ReviewItem; draft: ReviewDraft; onEdit: TrainerConsoleProps["onEdit"] }) {
  let form: ReactNode = null;
  if (item.task === "T-RUB" && draft.task === "T-RUB") form = <RubForm item={item} draft={draft} onEdit={onEdit} />;
  if (item.task === "T-LAB" && draft.task === "T-LAB") form = <LabForm item={item} draft={draft} onEdit={onEdit} />;
  if (item.task === "T-FLAG" && draft.task === "T-FLAG") form = <FlagForm item={item} draft={draft} onEdit={onEdit} />;
  const initial = item.task === "T-RUB" ? item.case_file.initial_documents : item.initial_documents;
  return (
    <div className="review-item-view">
      {item.task === "T-RUB" ? <CaseFileView file={item.case_file} /> : null}
      <section className="review-section">
        <h3 className="eyebrow">Records</h3>
        <Records initial={initial} released={item.released} />
      </section>
      <section className="review-section">
        <h3 className="eyebrow">Transcript</h3>
        <Transcript turns={item.transcript} />
      </section>
      {form}
    </div>
  );
}

export function TrainerConsole(props: TrainerConsoleProps) {
  const { items, selected, item, draft, submit } = props;
  const entry = items?.find((i) => i.item_id === selected);
  const todo = draft === null ? [] : missing(draft);
  const done = entry?.submitted === true || submit === "sent" || submit === "already";
  return (
    <div className="console-layout">
      <nav className="panel console-list" aria-label="Review items">
        <header className="panel-head">
          <h2>Your review items</h2>
        </header>
        {props.listFailed ? <p className="empty">The items could not be read.</p> : null}
        {items === null && !props.listFailed ? <p className="fine">Loading.</p> : null}
        {items !== null && items.length === 0 ? <p className="empty">No items are assigned to you.</p> : null}
        <ul>
          {items?.map((i, n) => (
            <li key={i.item_id}>
              <button
                type="button"
                className="console-item"
                aria-current={i.item_id === selected ? "true" : undefined}
                onClick={() => {
                  props.onSelect(i.item_id);
                }}
              >
                <span>
                  Item {n + 1}: {TASK_NAME[i.task]}
                </span>
                <span className="fine">{i.submitted ? "submitted" : "to do"}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <main className="panel console-main">
        {selected === null ? <p className="empty">Choose an item.</p> : null}
        {props.itemFailed ? <p className="empty">This item could not be read.</p> : null}
        {item !== null && draft !== null ? (
          <>
            <header className="panel-head">
              <h2>{TASK_NAME[item.task]}</h2>
            </header>
            <ItemView item={item} draft={draft} onEdit={props.onEdit} />
            <footer className="console-foot">
              {done ? (
                <p className="fine">{submit === "sent" ? "Submitted. Thank you." : "Already submitted."}</p>
              ) : (
                <>
                  {todo.length === 0 ? null : <p className="fine">Still to answer: {todo.slice(0, 6).join(", ")}{todo.length > 6 ? `, and ${String(todo.length - 6)} more` : ""}.</p>}
                  {submit === "failed" ? <p className="fine" role="alert">The submission was refused. Check the answers and try again.</p> : null}
                  <button type="button" className="btn-primary" disabled={todo.length > 0 || submit === "sending"} onClick={props.onSubmit}>
                    Submit
                  </button>
                </>
              )}
            </footer>
          </>
        ) : null}
      </main>
    </div>
  );
}
