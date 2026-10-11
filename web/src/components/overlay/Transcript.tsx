/**
 * The transcript (S6 4.3): turns T1..Tn with the question, the answer and the records released after each turn.
 * A `role="log"` region, mounted from the start and never unmounted; text is rendered as plain text nodes, never as
 * HTML or markdown (SUB-7). A turn cited by a chip or by the flag being pointed out is highlighted, and its quoted
 * span is marked when the quote is found verbatim.
 */
import { useEffect, useRef } from "react";

import { quoteOk } from "../../lib/contracts/quote";
import type { SnapshotRelease, VoiceExchange } from "../../lib/contracts/generated/types";
import type { TurnView } from "../../lib/trial/trialReducer";

interface TranscriptProps {
  readonly turns: readonly TurnView[];
  /** A voice session's exchanges (display only, V1..Vn; S6 4.3). */
  readonly voiceExchanges?: readonly VoiceExchange[];
  readonly released: readonly SnapshotRelease[];
  readonly subjectName: string;
  readonly highlighted: ReadonlySet<number>;
  /** A quote to mark inside the highlighted turn's answer. */
  readonly quote: { readonly turn: number; readonly text: string } | null;
  /** Set by a chip activation: scroll to the turn and move focus to it (S6 4.5 AST-7). */
  readonly focusTurn: { readonly turn: number; readonly nonce: number } | null;
  /** Reduced motion or the pause control: citation navigation jumps instead of scrolling smoothly. */
  readonly motionOff?: boolean;
}

/** Marks the quoted span only when the shared predicate accepts the quote and it appears verbatim; a quote that
 * matches only after normalization leaves the whole turn highlighted, unmarked. */
function Answer({ text, quote }: { text: string; quote: string | null }) {
  const at = quote === null || !quoteOk(quote, text) ? -1 : text.indexOf(quote);
  if (quote === null || at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark data-highlighted="true">{quote}</mark>
      {text.slice(at + quote.length)}
    </>
  );
}

export function Transcript({ turns, voiceExchanges = [], released, subjectName, highlighted, quote, focusTurn, motionOff = false }: TranscriptProps) {
  const refs = useRef(new Map<number, HTMLElement>());
  const end = useRef<HTMLDivElement>(null);
  // Read at activation time: changing the motion setting alone never moves focus.
  const motionRef = useRef(motionOff);
  useEffect(() => {
    motionRef.current = motionOff;
  });
  // Keyed on the primitive values, so only a new chip activation moves focus, never an unrelated render.
  const focusNo = focusTurn?.turn ?? null;
  const focusNonce = focusTurn?.nonce ?? null;
  useEffect(() => {
    if (focusNo === null || focusNonce === null) return;
    const el = refs.current.get(focusNo);
    el?.scrollIntoView({ block: "center", behavior: motionRef.current ? "auto" : "smooth" });
    el?.focus({ preventScroll: true });
  }, [focusNo, focusNonce]);
  const lastAnswer = turns.at(-1)?.answer ?? null;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [turns.length, lastAnswer]);
  return (
    <section className="panel transcript" aria-labelledby="transcript-title">
      <header className="panel-head">
        <h2 id="transcript-title">Transcript</h2>
        <span className="eyebrow">{turns.length === 0 ? "No turns yet" : `${String(turns.length)} turns`}</span>
      </header>
      <div className="panel-body" role="log" aria-live="polite">
        {turns.length + voiceExchanges.length === 0 ? <p className="empty">The interview has not started.</p> : null}
        {voiceExchanges.map((v) => (
          <article key={`v${String(v.exchange_no)}`} className="turn" aria-labelledby={`voice-${String(v.exchange_no)}`}>
            <h3 id={`voice-${String(v.exchange_no)}`} className="turn-no">
              V{v.exchange_no}
            </h3>
            {v.lines.map((line, i) => (
              <p key={i} className="line">
                <span className="speaker">{line.role === "investigator" ? "Investigator" : subjectName}</span>
                {line.text}
                {line.partial ? <span className="pending"> (interrupted)</span> : null}
              </p>
            ))}
          </article>
        ))}
        {turns.map((t) => {
          const marked = highlighted.has(t.turn_no);
          const releases = released.filter((r) => r.released_at_turn === t.turn_no);
          return (
            <article
              key={t.turn_no}
              ref={(el) => {
                if (el === null) refs.current.delete(t.turn_no);
                else refs.current.set(t.turn_no, el);
              }}
              tabIndex={-1}
              className="turn"
              data-highlighted={marked ? "true" : "false"}
              aria-labelledby={`turn-${String(t.turn_no)}`}
            >
              <h3 id={`turn-${String(t.turn_no)}`} className="turn-no">
                T{t.turn_no}
              </h3>
              <p className="line">
                <span className="speaker">Investigator</span>
                {t.question ?? "..."}
              </p>
              <p className="line">
                <span className="speaker">{subjectName}</span>
                {t.answer === null ? <span className="pending">Answering</span> : <Answer text={t.answer} quote={marked && quote?.turn === t.turn_no ? quote.text : null} />}
              </p>
              {releases.map((r) => (
                <p key={r.record_id} className="release-marker">
                  <span className="mono">{r.record_id}</span> released after T{t.turn_no} ({r.trigger})
                </p>
              ))}
            </article>
          );
        })}
        <div ref={end} />
      </div>
    </section>
  );
}
