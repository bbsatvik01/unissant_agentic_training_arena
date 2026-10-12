/**
 * The judge demo's guide card (stage 4): the step, what to say, what to point at, elapsed time against about four
 * minutes, and the step's controls. The interview step offers the recorded run first (no model call), a recording
 * file, and a live interview only when one can start; "Go to the debrief" jumps a recorded run to its debrief wall,
 * which keeps the demo on time.
 */
import { useEffect, useRef, useState } from "react";

import { clockText, DEMO_COPY, DEMO_STEPS, DEMO_TARGET_MS, type DemoStep } from "../../lib/demo/demo";

interface DemoGuideProps {
  readonly step: DemoStep;
  readonly startedAt: number;
  /** The interview step: a recorded run is playing or loaded. */
  readonly recordingLoaded: boolean;
  /** The step cannot move on yet (a live interview reaches the debrief by finishing it). */
  readonly nextDisabled: boolean;
  readonly canLive: boolean;
  readonly onNext: () => void;
  readonly onBack: (() => void) | null;
  readonly onClose: () => void;
  readonly onRecorded: () => void;
  readonly onFile: (file: File) => void;
  readonly onLive: () => void;
  /** A recording file that was refused or could not be read, in words. */
  readonly error: string | null;
}

function useElapsed(startedAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, []);
  return now - startedAt;
}

export function DemoGuide(props: DemoGuideProps) {
  const { step } = props;
  const copy = DEMO_COPY[step];
  const elapsed = useElapsed(props.startedAt);
  const file = useRef<HTMLInputElement>(null);
  const index = DEMO_STEPS.indexOf(step);
  const last = index === DEMO_STEPS.length - 1;
  return (
    <aside className="demo-guide" aria-label="Guided demo" aria-live="polite">
      <header className="demo-head">
        <span className="eyebrow">
          Demo {index + 1} of {DEMO_STEPS.length}
        </span>
        <span className="mono fine" title="Elapsed time, aiming for about four minutes">
          {clockText(elapsed)} / {clockText(DEMO_TARGET_MS)}
        </span>
        <button type="button" className="btn-secondary-sm" onClick={props.onClose}>
          End demo
        </button>
      </header>
      <h2>{copy.title}</h2>
      <p>{copy.body}</p>
      <p className="fine">Point at: {copy.look}</p>
      {step === "interview" ? (
        <div className="demo-sources" role="group" aria-label="Interview source">
          <button type="button" className={props.recordingLoaded ? "btn-secondary-sm" : "btn-primary"} onClick={props.onRecorded}>
            Play the recorded run
          </button>
          <button
            type="button"
            className="btn-secondary-sm"
            onClick={() => {
              file.current?.click();
            }}
          >
            Open a recording file
          </button>
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f !== undefined) props.onFile(f);
              e.target.value = "";
            }}
          />
          {props.error === null ? null : (
            <p className="fine" role="alert">
              {props.error}
            </p>
          )}
          {props.canLive ? (
            <button type="button" className="btn-secondary-sm" onClick={props.onLive}>
              Interview live instead
            </button>
          ) : null}
        </div>
      ) : null}
      <footer className="demo-foot">
        {props.onBack === null ? <span /> : (
          <button type="button" className="btn-secondary-sm" onClick={props.onBack}>
            Back
          </button>
        )}
        <button type="button" className="btn-primary" disabled={!last && props.nextDisabled} onClick={last ? props.onClose : props.onNext}>
          {last ? "Finish" : step === "precinct" ? "Open the interview room" : step === "interview" ? "Go to the debrief" : "Go to the arena"}
        </button>
      </footer>
    </aside>
  );
}
