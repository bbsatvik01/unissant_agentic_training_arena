import { useId, useState } from "react";
import type { SubmitEvent } from "react";
import type { CaseCard } from "../../lib/world/cases";
import { EX4_TEXT } from "../../lib/copy/ex4";
import { NPC_IDENTITIES } from "../../lib/precinct/npcIdentity";
import type { NpcId } from "../../lib/precinct/npcIdentity";
import { NPC_REQUEST_LIMITS, validateNpcRequest } from "../../lib/precinct/npcLocalAdapter";
import type { NpcResponse } from "../../lib/precinct/npcLocalAdapter";
import { STAFF_CONVERSATIONS } from "../../lib/precinct/staffDialogue";
import type { LocalNpcVisit, PrecinctNpcController } from "../../hooks/usePrecinctNpcController";
import { LocalSpeech } from "./LocalSpeech";
import "../../styles/precinct-staff-panel.css";

export interface ReceptionBriefingPanelProps {
  readonly station: "reception" | "briefing" | "office";
  readonly assignment: CaseCard | null;
  readonly onTravel: (hotspotId: string) => void;
  readonly onCheckIn: () => void;
  readonly onBriefed: () => void;
  readonly controller: PrecinctNpcController;
  /** Optional route-owned progress preserves the acknowledged label across panel reopenings. */
  readonly checkedIn?: boolean;
  readonly briefed?: boolean;
}

/** Public display only. Neither this card nor any assignment field is passed to the NPC seam. */
function PublicBriefingCard({ assignment, onBriefed, briefed }: { readonly assignment: CaseCard; readonly onBriefed: () => void; readonly briefed: boolean }) {
  const titleId = useId();
  const [acknowledged, setAcknowledged] = useState(false);
  const complete = briefed || acknowledged;
  const spokenBriefing = `${assignment.title}. Your objective: ${assignment.objective}. Nervousness, demeanor, accent and stress are never evidence. ${EX4_TEXT}`;
  return <section className="npc-assignment" aria-labelledby={titleId}>
    <span className="station-tag">PUBLIC TRAINING BRIEFING</span>
    <h3 id={titleId}>{assignment.title}</h3>
    <p className="npc-objective"><strong>Objective</strong>{assignment.objective}</p>
    <dl><div><dt>Public subject</dt><dd>{assignment.subject.display_name} · {assignment.subject.position}</dd></div><div><dt>Facility</dt><dd>{assignment.facility}</dd></div></dl>
    <aside className="precinct-safety"><strong>Evidence first. Always.</strong><p>Nervousness, demeanor, accent and stress are never evidence.</p><p>{EX4_TEXT}</p></aside>
    <LocalSpeech key={assignment.case_id} text={spokenBriefing} />
    <button type="button" className="precinct-primary" disabled={complete} onClick={() => { if (!complete) { setAcknowledged(true); onBriefed(); } }}>{complete ? "Briefing acknowledged" : "Acknowledge the briefing and ground rule"}</button>
  </section>;
}

/** Dialog content only: the route retains the native dialog, close button, Escape and focus return. */
export function ReceptionBriefingPanel({ station, assignment, onTravel, onCheckIn, onBriefed, controller, checkedIn = false, briefed = false }: ReceptionBriefingPanelProps) {
  const npcId: NpcId = station === "reception" ? "receptionist" : station === "briefing" ? "sergeant" : "analyst";
  return <div className="npc-panel">
    {station === "briefing" ? assignment === null ? <section className="npc-assignment" aria-label="Assignment selection required"><h3>Choose your public assignment</h3><p className="panel-lead">Select a case at the board before acknowledging its briefing.</p><button type="button" className="precinct-primary" onClick={() => { onTravel("case_board"); }}>Go to the case board</button></section> : <PublicBriefingCard key={assignment.case_id} assignment={assignment} onBriefed={onBriefed} briefed={briefed} /> : <StationWelcome key={station} station={station} assignment={assignment} onCheckIn={onCheckIn} onTravel={onTravel} checkedIn={checkedIn} />}
    <NpcConversation key={npcId} npcId={npcId} controller={controller} onTravel={onTravel} />
  </div>;
}

function StationWelcome({ station, assignment, onCheckIn, onTravel, checkedIn }: Pick<ReceptionBriefingPanelProps, "assignment" | "onCheckIn" | "onTravel"> & { readonly station: "reception" | "office"; readonly checkedIn: boolean }) {
  const [localCheckedIn, setCheckedIn] = useState(false);
  const complete = checkedIn || localCheckedIn;
  return <section className="npc-station-welcome" aria-label={station === "reception" ? "Reception check-in" : "Office introduction"}>
    <p className="panel-lead">{station === "reception" ? "Check in, choose your next stop, and get to know the precinct staff." : "Meet a colleague, then use your dossier desk or head to the briefing room."}</p>
    <p className="npc-assignment-summary"><span className="precinct-kicker">PUBLIC ASSIGNMENT</span><strong>{assignment?.title ?? "Choose a case at the case board."}</strong>{assignment === null ? null : <span>{assignment.objective}</span>}</p>
    <div className="station-actions">
      {station === "reception" ? <button type="button" className="precinct-primary" disabled={complete} onClick={() => { if (!complete) { setCheckedIn(true); onCheckIn(); } }}>{complete ? "Checked in" : "Check in for this shift"}</button> : null}
      <button type="button" className="precinct-secondary" onClick={() => { onTravel(station === "reception" ? "case_board" : "personal_dossier"); }}>{station === "reception" ? "Go to the case board" : "Go to my dossier desk"}</button>
      <button type="button" className="precinct-secondary" onClick={() => { onTravel("briefing"); }}>Go to briefing</button>
    </div>
  </section>;
}

/** Deliberately has no CaseCard, assignment, session or score prop. */
function NpcConversation({ npcId, controller, onTravel }: { readonly npcId: NpcId; readonly controller: PrecinctNpcController; readonly onTravel: (hotspotId: string) => void }) {
  const id = useId();
  const [visit, setVisit] = useState<LocalNpcVisit | null>(null);
  const [response, setResponse] = useState<NpcResponse | null>(null);
  const [prompt, setPrompt] = useState("");
  const [promptError, setPromptError] = useState(false);
  const [name, setName] = useState(controller.memory.displayName ?? "");
  const [nameInvalid, setNameInvalid] = useState(false);
  const [destination, setDestination] = useState<string | null>(null);
  const conversation = npcId === "receptionist" || npcId === "sergeant" ? STAFF_CONVERSATIONS[npcId] : null;
  const resetConversation = () => { setVisit(null); setResponse(null); setDestination(null); setPrompt(""); setPromptError(false); };
  const begin = () => {
    const next = controller.startVisit(npcId);
    setVisit(next); setResponse(next.greeting); setDestination(null); setPromptError(false);
  };
  const ask = (message: string, target: string | null = null) => {
    if (visit === null) return;
    setResponse(visit.reply(message)); setDestination(target); setPromptError(false);
  };
  const submitPrompt = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!validateNpcRequest({ npc_id: npcId, message: prompt, history: [] }).ok) { setPromptError(true); return; }
    ask(prompt); setPrompt("");
  };
  const submitName = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const valid = controller.updateName(name);
    setNameInvalid(!valid);
    if (valid) { resetConversation(); if (controller.remember) controller.saveMemory(); }
  };

  return <section className="npc-conversation" aria-labelledby={`${id}-title`}>
    <div className="npc-conversation-heading"><div><span className="station-tag">LOCAL SCRIPTED DIALOGUE</span><h3 id={`${id}-title`}>{NPC_IDENTITIES[npcId].label}</h3></div><span className="npc-offline-label">Authored responses · no model or network</span></div>
    <p className="npc-help">Choose a topic or type a short technique question. These are fixed local responses, not an open-ended assistant. Staff cannot answer your case.</p>
    <button type="button" className="precinct-primary" onClick={() => { if (visit === null) begin(); else { setResponse(visit.greeting); setDestination(null); } }}>{visit === null ? `Talk to ${NPC_IDENTITIES[npcId].label.toLowerCase()}` : "Repeat greeting"}</button>
    <div className={response === null ? "npc-subtitle-empty" : "npc-subtitle"} role="status" aria-live="polite" aria-atomic="true">{response === null ? null : <><span>{NPC_IDENTITIES[npcId].label}</span><p>{response.reply}</p></>}</div>
    {visit !== null ? <>
      {response !== null ? <LocalSpeech key={response.reply} text={response.reply} /> : null}
      {conversation !== null ? <div className="npc-topics" role="group" aria-label="Authored conversation topics">{conversation.replies.map((item) => <button type="button" key={item.topic} onClick={() => { ask(item.topic, item.destination ?? null); }}>{item.label}</button>)}</div> : <p className="npc-help">This colleague can welcome you. Reception has directions, and the sergeant has questioning-technique topics.</p>}
      {destination !== null ? <button type="button" className="precinct-secondary npc-go-there" onClick={() => { onTravel(destination); }}>Go to the suggested station</button> : null}
      <form className="npc-prompt" onSubmit={submitPrompt}><label htmlFor={`${id}-prompt`}>Optional short prompt</label><textarea id={`${id}-prompt`} value={prompt} maxLength={NPC_REQUEST_LIMITS.messageLength} rows={2} aria-describedby={`${id}-prompt-hint`} aria-invalid={promptError} onChange={(event) => { setPrompt(event.target.value); setPromptError(false); }} /><div className="npc-prompt-footer"><small id={`${id}-prompt-hint`}>{prompt.length}/{NPC_REQUEST_LIMITS.messageLength} · Unsupported prompts redirect to technique.</small><button type="submit" className="precinct-secondary">Ask locally</button></div>{promptError ? <p role="alert">Enter a short prompt without invisible control characters.</p> : null}</form>
    </> : null}
    <details className="npc-memory"><summary>Preferred name and local staff memory</summary><p className="npc-help">Optional: remember only your preferred name and which colleagues you have visited. No conversation or case information is saved. Nothing loads or saves automatically.</p>
      <label className="npc-memory-optin"><input type="checkbox" checked={controller.remember} onChange={(event) => { controller.setRemember(event.target.checked); }} /><span>Allow name and staff memory on this device</span></label>
      <form onSubmit={submitName}><label htmlFor={`${id}-name`}>Preferred name (optional)</label><input id={`${id}-name`} type="text" value={name} maxLength={40} autoComplete="off" aria-invalid={nameInvalid} onChange={(event) => { setName(event.target.value); setNameInvalid(false); }} /><button type="submit" className="precinct-secondary">{controller.remember ? "Save name and staff visits" : "Use name for this visit"}</button></form>
      <div className="npc-memory-actions"><button type="button" className="precinct-secondary" disabled={!controller.remember} onClick={() => { const loaded = controller.loadMemory(); if (loaded !== null) { setName(loaded.displayName ?? ""); setNameInvalid(false); resetConversation(); } }}>Load saved staff memory</button><button type="button" className="precinct-secondary" onClick={() => { controller.forgetMemory(); setName(""); setNameInvalid(false); resetConversation(); }}>Forget local staff memory</button></div>
      <p className={`npc-memory-notice${controller.notice.tone === "error" ? " npc-memory-error" : ""}`} role={controller.notice.tone === "error" ? "alert" : "status"}>{controller.notice.text}</p>
    </details>
  </section>;
}
