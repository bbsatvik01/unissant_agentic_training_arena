/** One caption node moves into the active native dialog, keeping its live region and text intact. */
import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { PrecinctSpeechCaption as Caption } from "../../lib/precinct/speechCaption";
import "../../styles/precinct-speech-caption.css";

export function PrecinctSpeechCaption({ caption, target, announce = true }: {
  readonly caption: Caption | null;
  readonly target: HTMLElement | null;
  /** The visible transcript already announces dialogue; do not announce that same line twice. */
  readonly announce?: boolean;
}) {
  const [container] = useState(() => document.createElement("div"));
  useLayoutEffect(() => {
    if (target === null) return;
    target.appendChild(container);
    return () => { container.remove(); };
  }, [container, target]);
  // A stable portal container preserves the actual DOM node across modal/HUD moves. No second announcer,
  // animation-frame updates, microphone access, or focus movement is introduced by captions.
  return createPortal(<section className="precinct-speech-caption" hidden={caption === null}
    role={announce ? "status" : "group"} tabIndex={0} aria-label="Speech caption" aria-live={announce ? "polite" : "off"} aria-atomic="true">
    {caption === null ? null : <><span className="precinct-speech-caption-label">{caption.label}</span><p><strong>{caption.speaker}:</strong> {caption.text}</p></>}
  </section>, container);
}
