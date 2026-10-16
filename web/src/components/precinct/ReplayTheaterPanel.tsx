/** Content only. Parent owns the single Canvas, native dialog, focus, file loading and downloads. */
import { LEGACY_SCENE_NOTICE, recordingScene } from "../../lib/world/sceneContext";
import { useEffect, useState } from "react";
import { isLocalWorldRecording } from "../../lib/world/localWorldCapture";
import { SPEEDS, type Annotation, type Recording } from "../../lib/world/recording";
import type { CaptureSnapshot, WorldCapture } from "../../lib/world/worldCapture";
import type { PlaybackControls } from "../../routes/world/usePlayback";
import { EX4_TEXT } from "../../lib/copy/ex4";
import "../../styles/precinct-replay.css";

type ReplayControls = Pick<PlaybackControls, "clock" | "capturedWorld" | "duration" | "playing" | "speed" | "play" | "pause" | "seekTo" | "setSpeed">;
export interface ReplayTheaterProps {
  readonly recording: Recording | null;
  readonly playback: ReplayControls;
  readonly paused: boolean;
  readonly freeCamera: boolean;
  readonly onFreeCamera: (free: boolean) => void;
  readonly onImport: (file: File) => void;
  readonly onExport: (() => void) | null;
  readonly loading?: boolean;
  /** Route can block replacement during assessment without disabling its current playback. */
  readonly importDisabled?: boolean;
  readonly error?: string | null;
  readonly capture?: { readonly controller: WorldCapture; readonly snapshot: CaptureSnapshot; readonly onExport: () => void };
}
const ISSUES = {
  unavailable: "Capture needs an active public session with a known clock.",
  "audio-enabled": "Uncaptured local staff audio began. This sampled capture is incomplete; only its earlier silent prefix can be exported. Clear it before starting again.",
  "scene-changed": "The scene changed or became unavailable. This capture is incomplete; only its original sampled prefix can be exported. Clear it before starting again.",
  "scope-changed": "The session changed. Earlier samples are retained; export and clear them before starting another capture.",
  "clock-reset": "The session clock moved backward or became invalid. Capture stopped to protect timing; earlier samples are retained.",
  "invalid-event": "A sample failed validation or exceeded the batch limit. Capture stopped; earlier samples are retained.",
  "private-input": "An undeclared input or evidence ID was refused. Capture stopped; earlier samples are retained.",
  "memory-limit": "The local capture limit was reached. Capture stopped without discarding earlier samples. Export before clearing.",
} as const;
function time(ms: number): string { return `${Math.floor(ms / 60_000).toString().padStart(2, "0")}:${Math.floor((ms % 60_000) / 1_000).toString().padStart(2, "0")}`; }

function ReplayTimeline({ playback, disabled, annotations }: { readonly playback: ReplayControls; readonly disabled: boolean; readonly annotations: readonly Annotation[] }) {
  const [at, setAt] = useState(0);
  useEffect(() => {
    const update = () => { setAt(playback.clock.current); };
    const timer = window.setInterval(update, 100);
    return () => { window.clearInterval(timer); };
  }, [playback.clock]);
  return <><label className="precinct-replay__timeline">Replay position
    <input aria-label="Replay position" type="range" min={0} max={playback.duration} step={1} value={Math.min(at, playback.duration)} disabled={disabled}
      onChange={(event) => { const value = event.currentTarget.valueAsNumber; setAt(value); playback.seekTo(value); }} />
    <span>{time(at)} / {time(playback.duration)}</span>
  </label>{annotations.length > 0 && <section aria-label="Recorded instructor annotations"><h3>Recorded instructor notes · read-only</h3><ol>{annotations.filter((note) => note.t_ms <= at).map((note, index) => <li key={`${note.created_at}:${String(index)}`}><time>{time(note.t_ms)}</time><p>{note.text}</p></li>)}</ol></section>}</>;
}
function CapturePanel({ capture }: { readonly capture: NonNullable<ReplayTheaterProps["capture"]> }) {
  const { controller, snapshot, onExport } = capture;
  const [confirmClear, setConfirmClear] = useState(false);
  return <section aria-label="World capture" className="precinct-replay__section">
    <h3>Local sampled world capture</h3>
    <p>Records explicit training controls, public draft text, notebook and evidence actions, panels, camera and actor samples in this tab’s memory. No microphone or automatic storage. Export before leaving.</p>
    <p>{snapshot.status} · {snapshot.count.toLocaleString()} samples · {(snapshot.bytes / 1_000).toFixed(1)} KB</p>
    {snapshot.issue !== null && <p>{ISSUES[snapshot.issue]}</p>}
    <div className="precinct-replay__controls">
      <button type="button" disabled={snapshot.status === "recording" || snapshot.status === "blocked"} onClick={() => { controller.start(); }}>Start local capture</button>
      <button type="button" disabled={snapshot.status !== "recording"} onClick={controller.stop}>Stop capture</button>
      <button type="button" disabled={snapshot.count === 0} onClick={onExport}>Export captured samples</button>
      <button type="button" disabled={snapshot.status === "recording" || snapshot.transport === "sending"} onClick={() => { setConfirmClear(true); }}>Clear local capture</button>
    </div>
    {confirmClear && <div className="precinct-replay__notice">
      <p>Clear these samples from this tab? Unsaved samples cannot be recovered.</p>
      <button type="button" disabled={snapshot.status === "recording" || snapshot.transport === "sending"} onClick={() => { if (controller.clear()) setConfirmClear(false); }}>Yes, clear samples</button>
      <button type="button" onClick={() => { setConfirmClear(false); }}>Keep samples</button>
    </div>}
    {snapshot.transport !== "off" && <p>Local server: {snapshot.transport} · {snapshot.pending.toLocaleString()} unconfirmed samples</p>}
    {snapshot.transport === "uncertain" && <div className="precinct-replay__notice">
      <p>The server response was not confirmed. Local samples are safe. A retry may duplicate actions because this endpoint has no deduplication contract.</p>
      <button type="button" onClick={() => { void controller.retryFlush(true); }}>Retry, accepting duplicate risk</button>
      <button type="button" onClick={controller.disableSender}>Keep capture offline</button>
    </div>}
  </section>;
}

export function ReplayTheaterPanel({ recording, playback, paused, freeCamera, onFreeCamera, onImport, onExport, loading = false, importDisabled = false, error = null, capture }: ReplayTheaterProps) {
  const world = playback.capturedWorld;
  return <div className="precinct-replay">
    <p className="precinct-replay__eyebrow">{recording !== null && isLocalWorldRecording(recording) ? "Local world capture · no interview or score" : "Replay theater"}</p>
    <h2>{recording?.case.title ?? "Review a recorded interview"}</h2>
    <p>Replay the captured public timeline and sampled world state. Scrubbing restores notes and evidence markers without sending questions, requests or writes.</p>
    <div className="precinct-replay__controls">
      <label className="precinct-replay__upload">Import recording<input aria-label="Import recording" type="file" accept=".json,application/json" disabled={loading || importDisabled} onChange={(event) => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (!importDisabled && file !== undefined) onImport(file);
      }} /></label>
      <button type="button" onClick={onExport ?? undefined} disabled={onExport === null || recording === null}>Export recording</button>
    </div>
    {loading && <p role="status">Checking the complete recording…</p>}
    {error !== null && <p role="alert">{error}</p>}
    {recording !== null && <>
      <p className="precinct-replay__notice">{recording.scene_context === undefined ? LEGACY_SCENE_NOTICE : `Recorded scene: ${recordingScene(recording.scene_context)?.label ?? "Unavailable"}. The bounded scene tuple is a client compatibility claim, not trusted provenance.`}</p>
      <p className="precinct-replay__notice">{recording.format === "arena.recording.v1"
        ? "V1 includes trial text and events. It does not contain captured movement, camera, notebook or original audio. Character motion is a reconstruction."
        : "V2 provides sampled world replay. Camera and actor roots are held between samples (currently captured at about 10 Hz). Monitor animation is reconstructed; original panel/page layout, speech and visemes are not restored. Complete world fidelity has not been verified."}</p>
      {recording.client_capture !== undefined && <p className="precinct-replay__notice">
        Client-experienced capture: {recording.client_capture.status}.
        {recording.client_capture.reason === null ? " Accepted text and available world samples only." : ` Accepted prefix only (${recording.client_capture.reason}).`}
        {" Original audio is absent. File provenance is an untrusted client claim, not a server signature."}
      </p>}
      {recording.unsupportedWorldEvents > 0 && <p className="precinct-replay__notice">{recording.unsupportedWorldEvents} world events have an unsupported rendering format. Their original JSON is preserved for export and stays inert. Only validated UI samples are shown; the full recorded world cannot be reconstructed.</p>}
      <ReplayTimeline key={recording.trial_id} playback={playback} disabled={loading} annotations={importDisabled ? [] : recording.annotations} />
      <div className="precinct-replay__controls">
        <button type="button" disabled={paused || loading} onClick={playback.playing ? playback.pause : playback.play}>{playback.playing ? "Pause replay" : "Play replay"}</button>
        <button type="button" onClick={() => { playback.pause(); playback.seekTo(0); }}>Back to start</button>
        <label>Replay speed<select aria-label="Replay speed" value={playback.speed} onChange={(event) => {
          const selected = SPEEDS.find((value) => String(value) === event.currentTarget.value); if (selected !== undefined) playback.setSpeed(selected);
        }}>{SPEEDS.map((value) => <option key={value} value={value}>{value}×</option>)}</select></label>
        <label><input type="checkbox" checked={freeCamera} onChange={(event) => { onFreeCamera(event.currentTarget.checked); }} />Explore with free camera</label>
      </div>
      {paused && <p>World motion is paused. Resume it to play the recording.</p>}
      {freeCamera && <p>Your viewing camera is free. Turn this off to return to the latest captured camera sample, if present.</p>}
      <section className="precinct-replay__section" aria-label="Captured state">
        <h3>At this moment</h3>
        <p>{world.actors.size} captured actors · Camera {world.camera === null ? "not captured yet" : world.camera.mode} · {world.openPanels.size} recorded open panels</p>
        <p>Pinned evidence: {[...world.pinnedEvidence].join(", ") || "none captured"}</p>
        <p>File pages: {[...world.filePages].map(([id, page]) => `${id}: ${String(page)}`).join(", ") || "none captured"}</p>
        {[...world.textDrafts].map(([id, value]) => <p key={id}><strong>Recorded draft · {id}</strong><br />{value || "(empty)"}</p>)}
        <h3>Replayed notebook</h3>
        {world.notes.size === 0 ? <p>No notes captured by this point.</p> : <ol>{[...world.notes.values()].map((note) => <li key={note.id}>
          <time>Captured {time(note.updatedAtMs)}</time><p>{note.text}</p>
          {note.metadata === undefined ? <p>Original note kind, citations and timestamps were not captured.</p> : <>
            <p>{note.metadata.kind === "contradiction" ? "Possible contradiction · trainee note, not a finding" : note.metadata.kind}</p>
            <p>Sources: {note.metadata.citations.map((ref) => `${ref.kind}: ${ref.id}`).join(", ") || "none cited"}</p>
            <p>Original note times (ms): created {note.metadata.createdAtMs}; updated {note.metadata.updatedAtMs}</p>
          </>}
        </li>)}</ol>}
        {world.notebookDraft !== null && <div><h4>Recorded notebook draft · read-only</h4>
          <p>{world.notebookDraft.kind === "contradiction" ? "Possible contradiction · trainee note, not a finding" : world.notebookDraft.kind}</p>
          <p>{world.notebookDraft.text || "(empty)"}</p><p>Sources: {world.notebookDraft.citations.map((ref) => `${ref.kind}: ${ref.id}`).join(", ") || "none cited"}</p>
          <p>{world.notebookDraft.editingId === null ? "New note" : `Editing ${world.notebookDraft.editingId}`}</p>
        </div>}
      </section>
      <p>Original speech and visemes are absent from these recording formats. Any separately enabled read-aloud is synthesized. Exact audio replay needs versioned audio assets, timestamps, offsets and viseme samples. Agent screens use this same replay clock and recorded trial arrivals; their visual phases are derived.</p>
    </>}
    {capture !== undefined && <CapturePanel capture={capture} />}
    <p className="precinct-replay__ground-rule">{EX4_TEXT}</p>
  </div>;
}
