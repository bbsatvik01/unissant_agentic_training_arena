/**
 * The debrief's score reveal (S6 4.7 and 6.6, signature moment): when the published debrief arrives, the rubric
 * total and the five 0-4 dimension scores count up to the server values. The client never sums: every number shown
 * is the document's own, and the count-up always ends on it (FE-DEB-2). Under reduced motion the values appear at
 * once. The full debrief view is stage 2; this card shows the outcome and the scores.
 */
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { useRef } from "react";

import type { Debrief } from "../../lib/contracts/generated/types";
import { EX4_TEXT } from "../../lib/copy/ex4";
import { LABELS } from "../../lib/copy/finding";

gsap.registerPlugin(useGSAP);

const DIMENSIONS: Readonly<Record<string, string>> = {
  D1: "Clarity and neutrality",
  D2: "Response relevance",
  D3: "Evidence-based follow-up",
  D4: "Testing alternative explanations",
  D5: "Supported closure",
};

function word(label: string): string {
  return LABELS.find((l) => l.id === label)?.word ?? label;
}

export function DebriefScore({ debrief, reducedMotion, onClose }: { debrief: Debrief; reducedMotion: boolean; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      if (reducedMotion) return;
      for (const el of root.current?.querySelectorAll<HTMLElement>("[data-count]") ?? []) {
        const target = Number(el.dataset["count"]);
        const counter = { value: 0 };
        gsap.to(counter, {
          value: target,
          duration: 1.4,
          ease: "power2.out",
          onUpdate: () => {
            el.textContent = String(Math.round(counter.value));
          },
          onComplete: () => {
            el.textContent = String(target);
          },
        });
      }
    },
    { scope: root, dependencies: [debrief.session_id, reducedMotion] },
  );
  const scored = debrief.scored ? debrief : null;
  return (
    <div className="debrief" ref={root} role="dialog" aria-labelledby="debrief-title">
      <header className="panel-head">
        <h2 id="debrief-title">Debrief</h2>
        <button type="button" className="btn-secondary-sm" onClick={onClose}>
          Close
        </button>
      </header>
      <p className="fine">{EX4_TEXT}</p>
      <p>
        Case outcome: <strong>{word(debrief.outcome.correct_finding)}</strong>. Your finding: <strong>{debrief.outcome.committed_label === null ? "none" : word(debrief.outcome.committed_label)}</strong>.
      </p>
      {scored === null ? (
        <p className="fine">Voice practice: not scored.</p>
      ) : scored.rubric.total === null ? (
        <p className="fine">{scored.rubric.unscorable_reason}</p>
      ) : (
        <>
          <p className="total">
            <span data-count={scored.rubric.total}>{scored.rubric.total}</span>
            <span className="of">/ 100</span>
          </p>
          <ul className="dims">
            {scored.rubric.dimensions.map((d) => (
              <li key={d.dim_id}>
                <span className="mono">{d.dim_id}</span>
                <span>{DIMENSIONS[d.dim_id]}</span>
                <span className="dim-score">
                  <span data-count={d.score}>{d.score}</span> / 4
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
