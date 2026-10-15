/** The seated interview's readable controls. One route owns session, navigation, focus, and all clocks. */
import type { ComponentProps } from "react";
import { EX4_TEXT } from "../../lib/copy/ex4";
import { draftToFinding } from "../../lib/copy/finding";
import { publicEvidenceSources, type EvidenceTableAction, type EvidenceTableState, type PublicEvidenceRef } from "../../lib/precinct/evidenceTable";
import type { InterviewStartKind } from "../../lib/precinct/interviewStart";
import type { PrecinctSession } from "../../routes/precinct/usePrecinctSession";
import { CoachPanel } from "../overlay/CoachPanel";
import { EvidencePanel } from "../overlay/EvidencePanel";
import { FindingPanel } from "../overlay/FindingPanel";
import { Tabs, type TabSpec } from "../overlay/Tabs";
import { Transcript } from "../overlay/Transcript";
import { PublicEvidenceTable } from "./PublicEvidenceTable";
import { SessionControlPanel } from "./SessionControlPanel";
import "../../styles/precinct-interview.css";

export type InterviewTab = "transcript" | "evidence" | "coach" | "finding";
export interface InterviewCitation {
  readonly turn: number;
  readonly quote: string;
  readonly nonce: number;
}
export type InterviewStationSession = ComponentProps<typeof SessionControlPanel>["session"] & Pick<PrecinctSession,
  "sessionKey" | "documents" | "released" | "transcriptExchanges" | "canAct" | "requestEvidence" | "commitFinding">;

export interface InterviewStationPanelProps {
  readonly session: InterviewStationSession;
  readonly still: boolean;
  readonly tab: InterviewTab;
  readonly onTabChange: (tab: InterviewTab) => void;
  readonly citation: InterviewCitation | null;
  readonly onCite: (turn: number, quote: string) => void;
  readonly evidenceScope: string;
  readonly evidenceState: EvidenceTableState;
  readonly onEvidenceAction: (action: EvidenceTableAction) => void;
  readonly onUseEvidenceQuestion: (question: string, source: PublicEvidenceRef) => void;
  readonly freshRecordId: string | null;
  /** Parent's guarded preparation-to-new-run adapter, overriding only this canonical control callback. */
  readonly startInterview: (kind: InterviewStartKind) => void;
  readonly called: boolean;
  readonly seated: boolean;
  /** Scene-only intercom action, never session.startInterview or an audio request. Null if unavailable. */
  readonly onCallSubject: (() => void) | null;
  readonly onSit: () => void;
  readonly onExitSeat: () => void;
}

function isInterviewTab(value: string): value is InterviewTab {
  return value === "transcript" || value === "evidence" || value === "coach" || value === "finding";
}

export function InterviewStationPanel({ session, still, tab, onTabChange, citation, onCite, evidenceScope, evidenceState, onEvidenceAction, onUseEvidenceQuestion, freshRecordId, startInterview, called, seated, onCallSubject, onSit, onExitSeat }: InterviewStationPanelProps) {
  const recorded = session.source === "recording";
  const live = session.source === "live" && session.backend === "connected";
  const canAct = live && session.canAct;
  const canDraft = live && !session.isVoice && session.view?.channel !== "voice" && session.questionReason === null;
  const coaching = session.view?.mode === "practice" && session.view.channel === "text";
  const sources = publicEvidenceSources(session.documents, session.released);
  // Finding citations use the existing wire format: ID only. Do not add requestable or hidden IDs.
  const records = [...new Map(sources.map((source) => [source.ref.id, { id: source.ref.id, title: source.title }])).values()];
  const tabs: TabSpec[] = [
    { id: "transcript", label: "Transcript", content: <Transcript turns={session.view?.turns ?? []} voiceExchanges={session.transcriptExchanges} released={session.released} subjectName={session.subjectName} highlighted={new Set(citation === null ? [] : [citation.turn])} quote={citation === null ? null : { turn: citation.turn, text: citation.quote }} focusTurn={citation} motionOff={still} /> },
    { id: "evidence", label: "Evidence table", content: <>
      <PublicEvidenceTable documents={session.documents} released={session.released} scope={evidenceScope} state={evidenceState} readOnly={recorded} onAction={onEvidenceAction} onUseQuestion={canDraft ? onUseEvidenceQuestion : null} />
      <details className="precinct-evidence-catalogue"><summary>All public sources and record requests</summary>
        <p className="precinct-note">Unreleased records can be requested only when the session allows it. A request does not put a record on the table; it must first be released.</p>
        <EvidencePanel documents={session.documents} released={session.released} requestable={session.view?.requestable ?? []} exchangesUsed={session.view?.exchangesUsed ?? 0} freshId={freshRecordId} onRequest={canAct ? (id) => { void session.requestEvidence(id); } : null} />
      </details>
    </> },
  ];
  if (coaching && session.view !== null) tabs.push({ id: "coach", label: "Practice coach", content: <CoachPanel view={session.view} documents={session.documents} released={session.released} onCite={(turn, quote) => { onTabChange("transcript"); onCite(turn, quote); }} onUseQuestion={canDraft ? session.updateDraft : null} /> });
  tabs.push({ id: "finding", label: "Finding", content: <>
    <p className="precinct-note">Base your finding on cited interview turns and public records. Nervousness, demeanor, accent and stress are never evidence.</p>
    <fieldset className="precinct-finding-boundary" disabled={!live && session.view?.committedFinding == null}>
      <legend className="sr-only">Finding submission</legend>
      <FindingPanel key={session.sessionKey} committed={session.view?.committedFinding ?? null} hash={session.view?.commitmentHash ?? null} turns={session.view?.turns ?? []} records={records} onConfirm={canAct ? (draft) => {
        const finding = draftToFinding(draft);
        if (finding !== null) void session.commitFinding(finding);
      } : null} disabledReason={recorded ? "Read-only recording: its finding belongs to the saved interview." : session.source === "idle" ? "Start an explicitly connected local interview before submitting a finding." : "Wait until this interview is ready for a finding."} />
    </fieldset>
  </> });
  const activeTab = tabs.some((candidate) => candidate.id === tab) ? tab : "transcript";
  return <div className="precinct-interview">
    <header className="precinct-interview-heading"><div><span className="precinct-interview-kicker">INTERVIEW ROOM</span><h2>{recorded ? "Review the saved interview" : "A clear question. A careful record."}</h2><p>{session.subjectName} · {recorded ? "Read-only playback" : session.view?.mode === "assessment" ? "Assessment · coaching withheld" : session.view === null ? "Preparation" : "Practice"}</p></div></header>
    <section className="precinct-intercom" aria-label="Intercom and interview seat">
      <div><h3>Intercom</h3><p>{recorded ? "The subject and answers come from the saved run." : called ? "Subject called to the interview room." : "Call the subject when you are ready to enter the room."}</p><p className="precinct-note">Calling and sitting are room controls. Use the explicit session controls below to start an interview.</p></div>
      <div className="precinct-intercom-actions"><button type="button" className="precinct-secondary" disabled={recorded || called || onCallSubject === null} onClick={() => { if (!recorded && !called) onCallSubject?.(); }}>Call subject to room</button>
        {seated ? <button type="button" className="precinct-primary" onClick={onExitSeat}>Leave interview seat</button> : <button type="button" className="precinct-primary" disabled={!called && session.view === null} onClick={onSit}>Sit at interview table</button>}
      </div>
    </section>
    <div className="precinct-interview-layout"><div className="precinct-interview-controls"><SessionControlPanel session={{ ...session, startInterview }} still={still} /></div>
      <section className="precinct-interview-record" aria-label="Interview record">
        {session.view?.mode === "assessment" ? <p className="precinct-interview-boundary">Assessment: coaching is withheld here and in the observation room.</p> : session.view?.channel === "voice" ? <p className="precinct-interview-boundary">Voice practice: the text coach is paused. Voice consent remains separate.</p> : null}
        <Tabs tabs={tabs} value={activeTab} onChange={(value) => { if (isInterviewTab(value)) onTabChange(value); }} label="Interview record tabs" />
      </section>
    </div>
    <p className="precinct-interview-ground-rule">{EX4_TEXT}</p>
  </div>;
}
