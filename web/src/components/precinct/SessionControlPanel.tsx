/** Content-only session controls. The route owns the dialog, focus, room, and keyboard capture. */
import { useState } from "react";
import { Composer, PlaybackBar } from "../overlay/Controls";
import { VoiceBar } from "../overlay/VoiceBar";
import { EX4_TEXT } from "../../lib/copy/ex4";
import { nextStepText, stepLabel } from "../../lib/study/study";
import { SESSION_STATUS } from "../../lib/precinct/session";
import type { PrecinctSession } from "../../routes/precinct/usePrecinctSession";
import "../../styles/precinct-session.css";

type InterviewControls = Pick<PrecinctSession,
  "backend" | "backendError" | "me" | "selectedCase" | "source" | "canStart" | "modes" | "startInterview" |
  "connectLocalBackend" | "disconnectLocalBackend" | "acknowledgeGroundRule" | "live" | "view" | "subjectName" |
  "isVoice" | "voice" | "draft" | "updateDraft" | "ask" | "questionReason" | "retryQuestion" | "stopSession" |
  "playback" | "sound" | "setSound" | "readAloudError" | "earpiece" | "setEarpiece" | "coachSpeaking">;

export function SessionControlPanel({ session, still }: { readonly session: InterviewControls; readonly still: boolean }) {
  const [ackBusy, setAckBusy] = useState(false);
  const [ackError, setAckError] = useState(false);
  return <section className="precinct-session" aria-label="Interview controls">
    <p className="precinct-session-origin">{session.source === "recording" ? "Recorded interview · read-only playback" : session.backend === "connected" ? "Explicitly connected local backend" : "Offline · no backend selected"}</p>
    {session.selectedCase === null ? <p>Choose a public case at the case board before starting an interview.</p> : <p><strong>{session.selectedCase.title}</strong><br />{session.subjectName}, {session.selectedCase.subject.position}</p>}
    {session.view === null ? null : <p role="status">{SESSION_STATUS[session.view.status]} · {session.view.exchangesUsed}/{session.view.exchangesCap} exchanges · {session.view.mode === "assessment" ? "Assessment: coaching withheld" : session.isVoice ? "Voice practice: not scored" : "Practice"}</p>}
    {session.source === "recording" ? <>
      <p className="precinct-note">Questions, evidence releases, finding and scores belong to this saved run. Playback does not score your own practice.</p>
      <PlaybackBar playing={session.playback.playing} speed={session.playback.speed} clock={session.playback.clock} duration={session.playback.duration} onPlay={session.playback.play} onPause={session.playback.pause} onSpeed={session.playback.setSpeed} onSeek={session.playback.seekTo} />
    </> : null}
    {session.source !== "live" || session.live.phase === "error" ? <div className="precinct-session-connect">
      {session.backend !== "connected" ? <>
        <p>Live text and voice require an explicitly selected backend running on this computer. This button checks only the current loopback origin. Configure the local fake-model stack for free development.</p>
        <button type="button" className="precinct-secondary" disabled={session.backend === "connecting"} onClick={() => { void session.connectLocalBackend(); }}>{session.backend === "connecting" ? "Connecting locally…" : "Connect local backend"}</button>
      </> : <>
        {session.me?.study == null ? null : <p><strong>{stepLabel(session.me.study)}</strong><br />{nextStepText(session.me.study)}</p>}
        {session.me?.ex4_acknowledged === null ? <div className="precinct-safety"><p>{EX4_TEXT}</p><button type="button" className="precinct-primary" disabled={ackBusy} onClick={() => {
          setAckBusy(true); setAckError(false);
          void session.acknowledgeGroundRule().then((ok) => { setAckBusy(false); setAckError(!ok); });
        }}>{ackBusy ? "Saving…" : "I understand the ground rule"}</button>{ackError ? <p role="alert">The acknowledgement could not be saved. Try again.</p> : null}</div> : null}
        <div className="precinct-session-actions">
          {session.live.resumable === null ? null : <button type="button" className="precinct-primary" disabled={!session.canStart} onClick={() => { session.startInterview("resume"); }}>Resume this case’s {session.live.resumable.mode} interview</button>}
          {session.modes.map((mode) => <button key={mode} type="button" className="precinct-primary" disabled={!session.canStart} onClick={() => { session.startInterview(mode); }}>{mode === "practice" ? "Start text practice" : "Start assessment"}</button>)}
          {session.modes.includes("practice") ? <button type="button" className="precinct-secondary" disabled={!session.canStart} onClick={() => { session.startInterview("voice"); }}>Prepare voice practice</button> : null}
          <button type="button" className="precinct-text-button" onClick={session.disconnectLocalBackend}>Disconnect local backend</button>
        </div>
        <p className="precinct-note">Preparing voice creates a session. The microphone stays closed until you review and accept the separate voice consent.</p>
      </>}
    </div> : null}
    {session.backendError === null ? null : <p role="alert">{session.backendError}</p>}
    {session.live.error === null ? null : <p role="alert">{session.live.error}</p>}
    {session.live.connectionError === null ? null : <p role="alert">{session.live.connectionError} <button type="button" className="precinct-secondary" onClick={session.live.reconnect}>Reconnect</button></p>}
    {session.live.failedQuestion === null ? null : <button type="button" className="precinct-secondary" onClick={() => { void session.retryQuestion(); }}>Retry the same question</button>}
    {session.live.debriefFailed ? <button type="button" className="precinct-secondary" onClick={session.live.retryDebrief}>Retry the debrief</button> : null}
    {session.isVoice ? <VoiceBar state={session.voice.state} captureAboveFloor={session.voice.captureAboveFloor} subjectName={session.subjectName} error={session.voice.error} talk={session.voice.state.audible !== null && !still ? 1 : 0} onOpen={session.voice.open} onConsent={session.voice.consent} onDecline={session.voice.decline} onStop={session.voice.stop} onInterrupt={session.voice.interrupt} onReconnect={session.voice.reconnect} /> : <Composer draft={session.draft} onDraft={session.updateDraft} onSend={session.questionReason === null ? (text) => { void session.ask(text); } : null} reason={session.questionReason ?? ""} />}
    {session.source !== "idle" && !session.isVoice ? <div className="precinct-session-audio"><label><input type="checkbox" checked={session.sound} onChange={(event) => { session.setSound(event.target.checked); }} />{session.backend === "connected" ? "Enable local backend read-aloud" : "Enable installed-voice read-aloud"}</label><p className="precinct-note">Read-aloud is synthesized, not the original recorded audio. Offline playback uses only an installed local English voice; if none is available, it stays silent. It plays only in the interview/observation rooms at 1× playback speed. Connecting a real-model backend can incur provider charges.</p>{session.readAloudError === null ? null : <p role="alert">{session.readAloudError}</p>}{session.view?.mode === "practice" && session.sound ? <label><input type="checkbox" checked={session.earpiece} onChange={(event) => { session.setEarpiece(event.target.checked); }} />Coach earpiece {session.coachSpeaking ? "· speaking" : ""}</label> : null}</div> : null}
    {session.source === "idle" ? null : <button type="button" className="precinct-text-button" onClick={session.stopSession}>Close this session view</button>}
    <p className="precinct-note">{EX4_TEXT}</p>
  </section>;
}

type RecordingControls = Pick<PrecinctSession, "backend" | "recordingState" | "recordingError" | "recordingTrialId" | "loadBundledRecording" | "loadCoachedRecording" | "importRecording" | "loadLocalRecording">;
export function SessionRecordingsPanel({ session }: { readonly session: RecordingControls }) {
  const [trialId, setTrialId] = useState("");
  return <section className="precinct-session" aria-label="Recorded runs">
    <p>Load a saved interview into this precinct, then use Play, pause, speed and timeline controls in the interview room. Loading never starts playback or sound automatically.</p>
    <div className="precinct-session-actions"><button type="button" className="precinct-primary" onClick={() => { void session.loadCoachedRecording(); }}>Recorded coached interview · Gemini</button><button type="button" className="precinct-secondary" onClick={() => { void session.loadBundledRecording(); }}>Load bundled example run</button><label className="precinct-secondary precinct-recording-file">Import recording JSON<input type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file !== undefined) void session.importRecording(file); }} /></label></div>
    <p className="precinct-note">The coached interview is a saved Gemini run. Its original scores and provenance appear only after playback reaches its published debrief. Loading it does not contact Gemini or produce a new score. The bundled example is a hand-built synthetic interview. All arena.recording.v1 files are validated whole before loading.</p>
    {session.backend === "connected" ? <form onSubmit={(event) => { event.preventDefault(); void session.loadLocalRecording(trialId); }}><label className="field"><span>Trial ID from the local backend</span><input value={trialId} onChange={(event) => { setTrialId(event.target.value); }} /></label><button type="submit" className="precinct-secondary" disabled={trialId.trim() === ""}>Load this local recording</button></form> : null}
    {session.recordingState === "loading" ? <p role="status">Loading the selected run…</p> : null}
    {session.recordingTrialId === null ? null : <p>Loaded run: <span className="mono">{session.recordingTrialId}</span></p>}
    {session.recordingError === null ? null : <p role="alert">{session.recordingError}</p>}
  </section>;
}
