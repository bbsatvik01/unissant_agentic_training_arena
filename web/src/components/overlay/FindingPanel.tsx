/**
 * The findings lock (S6 4.6): once a finding is committed it is shown with its template sentences and, after the
 * trial is finalized, its commitment hash. Before that, the commit form: three labels with equal weight and none
 * preselected, the likelihood terms the chosen label allows, confidence, citations of answered turns and board
 * records, corroboration for insufficient evidence, the rationale and the EX-4 statement. Confirm stays disabled
 * until the draft is complete (FE-FIND-1); it is wired to the API with live sessions (stage 2).
 */
import { useId, useState } from "react";

import { EX4_TEXT } from "../../lib/copy/ex4";
import { allowedLikelihoods, CONFIDENCES, draftProblems, EMPTY_DRAFT, LABELS, LIKELIHOODS, renderFinding, type FindingDraft } from "../../lib/copy/finding";
import type { CommittedFinding, TurnView } from "../../lib/trial/trialReducer";

interface FindingPanelProps {
  readonly committed: CommittedFinding | null;
  readonly hash: string | null;
  readonly turns: readonly TurnView[];
  readonly records: readonly { readonly id: string; readonly title: string }[];
  /** Null while no live session can take the commit (playback, or before WP-13). */
  readonly onConfirm: ((draft: FindingDraft) => void) | null;
  readonly disabledReason: string;
}

function toggle<T>(list: readonly T[], item: T): readonly T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

export function FindingPanel({ committed, hash, turns, records, onConfirm, disabledReason }: FindingPanelProps) {
  const [draft, setDraft] = useState<FindingDraft>(EMPTY_DRAFT);
  const id = useId();
  if (committed !== null) {
    const [first, second] = renderFinding(committed.finding);
    return (
      <div className="finding-locked" data-finding={committed.finding.label}>
        <span className="eyebrow">Finding committed{committed.by === "investigator" ? " by the investigator" : ""}</span>
        <p className="finding-label">{LABELS.find((l) => l.id === committed.finding.label)?.word}</p>
        <p>{first}</p>
        <p>{second}</p>
        <p className="fine">{committed.finding.rationale}</p>
        {hash === null ? (
          <p className="loading">Sealing the finding</p>
        ) : (
          <div className="hash">
            <span className="eyebrow">Commitment hash</span>
            <code>{hash}</code>
            <button
              type="button"
              className="btn-secondary-sm"
              onClick={() => {
                void navigator.clipboard.writeText(hash).catch(() => undefined);
              }}
            >
              Copy
            </button>
          </div>
        )}
        <p className="fine">{EX4_TEXT}</p>
      </div>
    );
  }
  const answered = turns.filter((t) => t.answer !== null && !t.partial);
  const problems = draftProblems(draft);
  const set = (patch: Partial<FindingDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
  };
  return (
    <form
      className="finding-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (problems.length === 0) onConfirm?.(draft);
      }}
    >
      <fieldset>
        <legend>Finding</legend>
        <div className="segmented">
          {LABELS.map((l) => (
            <label key={l.id}>
              <input
                type="radio"
                name={`${id}-label`}
                checked={draft.label === l.id}
                onChange={() => {
                  set({ label: l.id, likelihood: draft.likelihood !== null && allowedLikelihoods(l.id).includes(draft.likelihood) ? draft.likelihood : null });
                }}
              />
              <span>{l.word}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="field">
        <span>Likelihood that the subject is concealing involvement</span>
        <select
          value={draft.likelihood ?? ""}
          disabled={draft.label === null}
          onChange={(e) => {
            const value = LIKELIHOODS.find((l) => l.id === e.target.value)?.id ?? null;
            set({ likelihood: value });
          }}
        >
          <option value="">Choose</option>
          {(draft.label === null ? [] : allowedLikelihoods(draft.label)).map((value) => {
            const entry = LIKELIHOODS.find((l) => l.id === value);
            return (
              <option key={value} value={value}>
                {entry === undefined ? value : `${entry.term} (${entry.range})`}
              </option>
            );
          })}
        </select>
      </label>
      <fieldset>
        <legend>Confidence</legend>
        <div className="segmented">
          {CONFIDENCES.map((c) => (
            <label key={c}>
              <input
                type="radio"
                name={`${id}-confidence`}
                checked={draft.confidence === c}
                onChange={() => {
                  set({ confidence: c });
                }}
              />
              <span>{c}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Cite turns and records</legend>
        <div className="cite-grid">
          {answered.map((t) => (
            <label key={t.turn_no} className="check">
              <input
                type="checkbox"
                checked={draft.citedTurns.includes(t.turn_no)}
                onChange={() => {
                  set({ citedTurns: toggle(draft.citedTurns, t.turn_no) });
                }}
              />
              T{t.turn_no}
            </label>
          ))}
          {records.map((r) => (
            <label key={r.id} className="check" title={r.title}>
              <input
                type="checkbox"
                checked={draft.citedRecords.includes(r.id)}
                onChange={() => {
                  set({ citedRecords: toggle(draft.citedRecords, r.id) });
                }}
              />
              {r.id}
            </label>
          ))}
          {answered.length + records.length === 0 ? <p className="fine">Nothing to cite yet.</p> : null}
        </div>
      </fieldset>
      {draft.label === "insufficient_evidence" ? (
        <label className="field">
          <span>What would settle it (one per line, up to three)</span>
          <textarea
            rows={3}
            value={draft.corroboration}
            onChange={(e) => {
              set({ corroboration: e.target.value });
            }}
          />
        </label>
      ) : null}
      <label className="field">
        <span>Rationale</span>
        <textarea
          rows={3}
          maxLength={600}
          value={draft.rationale}
          onChange={(e) => {
            set({ rationale: e.target.value });
          }}
        />
      </label>
      <p className="fine">{EX4_TEXT}</p>
      {problems.length === 0 ? null : <p className="fine">{problems[0]}</p>}
      <button type="submit" className="btn-primary" disabled={onConfirm === null || problems.length > 0}>
        Confirm finding
      </button>
      {onConfirm === null ? <p className="fine">{disabledReason}</p> : null}
    </form>
  );
}
