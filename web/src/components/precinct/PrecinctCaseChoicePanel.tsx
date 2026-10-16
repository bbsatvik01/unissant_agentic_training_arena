import type { PrecinctSession } from "../../routes/precinct/usePrecinctSession";

type CaseChoiceSession = Pick<PrecinctSession, "cases" | "selectedCase" | "packetState" | "source">;
/** Minimal public selection seam; the full diegetic case-board slice can replace this content. */
export function PrecinctCaseChoicePanel({ session, onSelect, onDesk }: { readonly session: CaseChoiceSession; readonly onSelect: (caseId: string) => void; readonly onDesk: () => void }) {
  return <section className="precinct-case-choice" aria-label="Public case assignments">
    <span className="station-tag">PUBLIC CASE ASSIGNMENTS</span><h3>Choose the file you will read.</h3>
    <p className="panel-lead">Selecting an assignment opens its public packet. Start an interview or load a recording separately.</p>
    <div className="station-directory">{session.cases.map((card) => {
      const selected = session.selectedCase?.case_id === card.case_id;
      return <button type="button" key={card.case_id} aria-pressed={selected} disabled={selected && session.source === "idle" && session.packetState !== "unavailable"} onClick={() => { onSelect(card.case_id); }} aria-label={`Select ${card.title}`}><span><strong>{card.title}</strong><small>{card.case_id} · Level {card.difficulty_level}</small><small>{card.objective}</small><small>{selected ? "Selected public assignment" : `${String(card.initial_documents)} opening documents`}</small></span></button>;
    })}</div>
    {session.selectedCase === null ? null : <div className="station-actions"><p role="status">{session.packetState === "loading" ? "Opening the selected public packet…" : session.packetState === "ready" ? "Your public packet is ready at your desk." : "This packet is unavailable offline. Choose another assignment or explicitly connect the local training backend."}</p><button type="button" className="precinct-primary" onClick={onDesk}>Go to my dossier desk</button></div>}
    {session.cases.length === 0 ? <p>No public assignments are offered by this source.</p> : null}
  </section>;
}
