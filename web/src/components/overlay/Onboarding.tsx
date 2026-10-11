/**
 * Onboarding (S6 4.1, EX-4): the sponsor's ground rule in full, what the coach does and does not do, what is
 * recorded, the voice note and where the method is described. Acknowledging stores it once per user
 * (`POST /api/me/ack-ex4`); until then no session can start (FE-ONB-1). Opened again later from the precinct, it
 * reads the same and shows the stored acknowledgement instead of the button.
 */
import { useState } from "react";

import { EX4_TEXT } from "../../lib/copy/ex4";

interface OnboardingProps {
  /** The stored acknowledgement time, or null when not yet acknowledged. */
  readonly acknowledged: string | null;
  readonly onAcknowledge: () => Promise<boolean>;
  /** Null while acknowledgement is required (the panel cannot be dismissed). */
  readonly onClose: (() => void) | null;
}

export function Onboarding({ acknowledged, onAcknowledge, onClose }: OnboardingProps) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className="onboarding" role="dialog" aria-modal={onClose === null} aria-labelledby="onboarding-title">
      <header className="panel-head">
        <h2 id="onboarding-title">Before you start</h2>
        {onClose === null ? null : (
          <button type="button" className="btn-secondary-sm" onClick={onClose}>
            Close
          </button>
        )}
      </header>
      <div className="onboarding-body">
        <section aria-labelledby="ex4-title">
          <h3 id="ex4-title" className="eyebrow">
            Ground rule
          </h3>
          <p className="ex4-statement">{EX4_TEXT}</p>
        </section>
        <section aria-labelledby="coach-title">
          <h3 id="coach-title" className="eyebrow">
            What the coach does
          </h3>
          <ul>
            <li>After each answer it reads your question and the subject&apos;s reply, points to specific words in the transcript or the case records, and suggests a neutral follow-up.</li>
            <li>It keeps a running finding with a stated likelihood and the evidence it rests on, and says when more evidence is needed.</li>
            <li>It never judges how the subject seems: no tone, hesitation or manner. Only what was said and what the records show.</li>
            <li>It does not decide for you. You commit your own finding; the debrief compares it with the case outcome.</li>
          </ul>
        </section>
        <section aria-labelledby="modes-title">
          <h3 id="modes-title" className="eyebrow">
            Practice and assessment
          </h3>
          <p>In Practice the coach&apos;s cards appear beside you after each answer. In an Assessment you interview alone; the coaching is still computed and is shown in your debrief.</p>
        </section>
        <section aria-labelledby="recorded-title">
          <h3 id="recorded-title" className="eyebrow">
            What is recorded
          </h3>
          <p>
            Your questions, the subject&apos;s answers, the coach&apos;s cards, the records you request and the finding you commit are stored with your session, so the debrief and your progress can be shown. Scores come from the referee; anyone rating a session for the study sees the interview without your name, the date or the study step.
          </p>
        </section>
        <section aria-labelledby="voice-title">
          <h3 id="voice-title" className="eyebrow">
            Voice
          </h3>
          <p>The room reads lines aloud with your browser&apos;s speech voices. Some browsers provide those voices through an online service from the browser&apos;s maker; mute the voices at any time from the top bar. Speaking to the subject by microphone is not offered in this version.</p>
        </section>
        <p className="fine">
          How sessions are scored: <a href="/trust/methodology">methodology</a>.
        </p>
      </div>
      <footer className="onboarding-foot">
        {acknowledged === null ? (
          <>
            {failed ? <p className="fine" role="alert">The acknowledgement could not be saved. Try again.</p> : null}
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setFailed(false);
                void onAcknowledge().then((ok) => {
                  setBusy(false);
                  setFailed(!ok);
                });
              }}
            >
              I have read the ground rule
            </button>
          </>
        ) : (
          <p className="fine">You acknowledged the ground rule.</p>
        )}
      </footer>
    </div>
  );
}
