import { useEffect, useId, useRef, useState } from "react";

const LOCAL_SPEECH_STARTED = "arena-local-speech-started";

/** Explicit installed-device playback only. Mount keyed by text so a new subtitle cancels old speech. */
export function LocalSpeech({ text }: { readonly text: string }) {
  const id = useId();
  const [status, setStatus] = useState<"idle" | "speaking" | "unavailable" | "error">("idle");
  const current = useRef<SpeechSynthesisUtterance | null>(null);
  useEffect(() => {
    const release = () => {
      if (current.current === null) return;
      current.current.onend = null; current.current.onerror = null; current.current = null;
      try { if ("speechSynthesis" in window) window.speechSynthesis.cancel(); }
      catch { /* A disappearing device voice cannot prevent panel cleanup. */ }
    };
    const anotherStarted = (event: Event) => {
      if (!(event instanceof CustomEvent) || event.detail === id || current.current === null) return;
      release(); setStatus("idle");
    };
    window.addEventListener(LOCAL_SPEECH_STARTED, anotherStarted);
    return () => { window.removeEventListener(LOCAL_SPEECH_STARTED, anotherStarted); release(); };
  }, [id]);
  const stop = () => {
    if (current.current !== null) { current.current.onend = null; current.current.onerror = null; current.current = null; }
    try {
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      setStatus("idle");
    } catch { setStatus("error"); }
  };
  const play = () => {
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) { setStatus("unavailable"); return; }
    try {
      const voices = window.speechSynthesis.getVoices().filter((voice) => voice.localService);
      const voice = voices.find((candidate) => candidate.lang.startsWith("en")) ?? voices[0];
      if (voice === undefined) { setStatus("unavailable"); return; }
      if (current.current !== null) { current.current.onend = null; current.current.onerror = null; current.current = null; }
      window.dispatchEvent(new CustomEvent(LOCAL_SPEECH_STARTED, { detail: id }));
      window.speechSynthesis.cancel();
      const line = new SpeechSynthesisUtterance(text.slice(0, 5000));
      line.voice = voice; line.lang = voice.lang; line.rate = 0.94;
      line.onend = () => { if (current.current === line) { current.current = null; setStatus("idle"); } };
      line.onerror = () => { if (current.current === line) { current.current = null; setStatus("error"); } };
      current.current = line; setStatus("speaking");
      window.speechSynthesis.speak(line);
    } catch {
      if (current.current !== null) { current.current.onend = null; current.current.onerror = null; current.current = null; }
      setStatus("error");
    }
  };
  return <div className="local-speech"><button className="precinct-secondary" onClick={status === "speaking" ? stop : play}>{status === "speaking" ? "Stop voice" : "Read aloud locally"}</button><span role="status">{status === "unavailable" ? "No installed local voice is available. The full subtitle remains on screen." : status === "error" ? "Voice playback is unavailable. Read the full subtitle on screen." : status === "speaking" ? "Speaking with a device-local voice. Follow the subtitle on screen." : "Optional device-local voice. No audio service is contacted."}</span></div>;
}
