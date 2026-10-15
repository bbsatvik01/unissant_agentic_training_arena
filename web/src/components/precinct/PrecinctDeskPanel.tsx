import { useState } from "react";
import type { PrecinctSession } from "../../routes/precinct/usePrecinctSession";
import type { PrecinctNotebook } from "../../routes/precinct/usePrecinctNotebook";
import { DossierPanel, type DossierUiEvent } from "./DossierPanel";
import "../../styles/precinct-desk.css";

type DeskSession = Pick<PrecinctSession, "packet" | "packetState" | "selectedCase" | "released">;
export interface PrecinctDeskPanelProps {
  readonly session: DeskSession;
  readonly notebook: PrecinctNotebook;
  readonly reviewed: boolean;
  readonly onReviewed: () => void;
  readonly onChooseCase: () => void;
  readonly onUiEvent: (event: DossierUiEvent) => void;
}

/** Content only. The existing route retains the single dialog and movement/focus ownership. */
export function PrecinctDeskPanel({ session, notebook, reviewed, onReviewed, onChooseCase, onUiEvent }: PrecinctDeskPanelProps) {
  const [carryError, setCarryError] = useState<string | null>(null);
  const { packet, packetState, selectedCase, released } = session;
  const ready = packetState === "ready" && packet !== null && packet.case_id === selectedCase?.case_id;
  if (!ready) return <section aria-label="Desk packet status">
    <span className="station-tag">YOUR PUBLIC CASE FILE</span>
    <h3>{selectedCase?.title ?? "Choose a public assignment"}</h3>
    <p className="panel-lead" role="status">{packetState === "loading" ? "Opening the public case packet…" : selectedCase === null ? "Select an assignment at the case board to read its opening documents and begin your notebook." : "This case packet is unavailable from the current source. Choose an available public packet at the case board."}</p>
    <button type="button" className="precinct-secondary" onClick={onChooseCase}>Choose a case at the board</button>
  </section>;
  return <>
    {notebook.carryAvailable ? <section className="precinct-desk-review" aria-label="Preparation notebook handoff"><strong>{notebook.carryCount} preparation notes are available for this new run.</strong><p>Carry the notes you wrote before starting this case. This keeps their text, citations and original note times; device saving stays off.</p><button type="button" className="precinct-primary" onClick={() => {
      const result = notebook.carryPreparation();
      if (result.ok) { setCarryError(null); onUiEvent({ type: "notebook.carry", document: result.document }); }
      else setCarryError(result.error);
    }}>Carry preparation notes into this run</button><button type="button" className="precinct-secondary" onClick={notebook.discardPreparation}>Discard preparation note offer</button>{carryError === null ? null : <p role="alert">{carryError}</p>}</section> : null}
    <DossierPanel key={notebook.key} packet={packet} released={released} notebook={notebook.snapshot} notebookActions={notebook.actions} notebookReadOnly={notebook.readOnly} onUiEvent={onUiEvent} />
    <section className="precinct-desk-review" aria-label="Case file review">
      <div><strong>Ready for the next step?</strong><p>Confirm when you have reviewed the public file. Reading pages or writing notes does not complete an interview or finding.</p></div>
      <button type="button" className="precinct-primary" disabled={reviewed || notebook.readOnly} onClick={onReviewed}>{reviewed ? "Case file reviewed" : "Mark case file reviewed"}</button>
      {notebook.readOnly ? <p className="precinct-note">Reviewing a recorded file does not advance your current training orientation.</p> : null}
    </section>
  </>;
}
