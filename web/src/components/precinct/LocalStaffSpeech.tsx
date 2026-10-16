import { useLayoutEffect, useId, useRef, useState } from "react";
import { findLocalStaffClip, LOCAL_SPEECH_STARTED, localStaffPlayer, type LocalStaffPlayback, type LocalStaffVoiceStatus } from "../../lib/precinct/localStaffVoice";

/** Keyed lifetime cancels even during fetch/decode; only the explicit play click creates audio. */
export function LocalStaffSpeech({ text, voiceId }: { readonly text: string; readonly voiceId: string }) {
  return <StaffPlayback key={`${voiceId}\n${text}`} text={text} voiceId={voiceId} />;
}
function StaffPlayback({ text, voiceId }: { readonly text: string; readonly voiceId: string }) {
  const id = useId();
  const [status, setStatus] = useState<LocalStaffVoiceStatus>("idle");
  const [muted, setMuted] = useState(false);
  const playback = useRef<LocalStaffPlayback | null>(null);
  const alive = useRef(true);
  const clip = findLocalStaffClip(voiceId, text);
  useLayoutEffect(() => {
    alive.current = true;
    const stopOther = (event: Event) => {
      if (event instanceof CustomEvent && event.detail !== id) playback.current?.stop();
    };
    window.addEventListener(LOCAL_SPEECH_STARTED, stopOther);
    return () => {
      alive.current = false;
      window.removeEventListener(LOCAL_SPEECH_STARTED, stopOther);
      playback.current?.stop(); playback.current = null;
    };
  }, [id]);
  const active = status === "loading" || status === "speaking";
  const play = () => {
    window.dispatchEvent(new CustomEvent(LOCAL_SPEECH_STARTED, { detail: id }));
    setMuted(false);
    playback.current = localStaffPlayer.play(clip, (next) => { if (alive.current) setStatus(next); });
  };
  const unavailable = clip === undefined || status === "unavailable";
  return <div className="local-speech">
    <button type="button" className="precinct-secondary" disabled={unavailable} onClick={active ? () => { playback.current?.stop(); } : play}>{active ? "Stop staff voice" : "Play scripted staff voice"}</button>
    {status === "speaking" ? <button type="button" className="precinct-secondary" aria-pressed={muted} onClick={() => { playback.current?.setMuted(!muted); setMuted(!muted); }}>{muted ? "Unmute staff voice" : "Mute staff voice"}</button> : null}
    <span role="status">{unavailable ? "Audio is unavailable for this exact line. Read the full subtitle above." : status === "error" ? "Audio could not play. Try again or read the full subtitle above." : status === "loading" ? "Loading this exact scripted line…" : status === "speaking" ? muted ? "Staff voice muted. The full subtitle remains above." : "Playing fixed local dialogue in a synthetic voice. The full subtitle is above." : "Fixed local dialogue · synthetic voice. No microphone or AI conversation."}</span>
  </div>;
}
