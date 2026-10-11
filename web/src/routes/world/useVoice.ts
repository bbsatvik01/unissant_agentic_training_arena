/**
 * Voices for the room (stage 2): the subject's answers, the investigator's questions and the coach's suggested
 * follow-up are spoken by the browser's speech synthesis, each persona with its own voice (`pickVoice`), while the
 * avatars' visemes follow the same line on the session clock. A line is spoken only when it starts live (within
 * half a second of its start on the clock), so scrubbing into the middle of an answer stays silent. Sound stops when
 * muted, when playback is paused or runs faster than 1x, and on leaving the room. Gemini TTS or Live can replace the
 * synthesis behind the same calls (WP-22).
 */
import { useEffect, useRef } from "react";

import type { TrialView } from "../../lib/trial/trialReducer";
import { COACHES, INVESTIGATOR, subjectPersona, type Persona } from "../../lib/world/cast";
import type { WorldState } from "../../lib/world/worldState";
import { pickVoice, utteranceSettings } from "../../lib/voice/tts";

interface Options {
  readonly world: WorldState | null;
  readonly view: TrialView | null;
  readonly subjectName: string;
  readonly clock: { readonly current: number };
  /** Sound on, at normal speed, in the room. */
  readonly active: boolean;
  /** The session or recording in the room: lines already spoken are forgotten when it changes. */
  readonly scope: string;
}

const START_WINDOW_MS = 500;
const COACH = COACHES[2] ?? INVESTIGATOR;

function synth(): SpeechSynthesis | null {
  return typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
}

function speak(persona: Persona, text: string, volume = 1): void {
  const s = synth();
  if (s === null) return;
  const u = new SpeechSynthesisUtterance(text);
  const voice = pickVoice(s.getVoices(), persona.voice.prefer);
  if (voice !== null) u.voice = voice;
  const { pitch, rate } = utteranceSettings(persona.voice);
  u.pitch = pitch;
  u.rate = rate;
  u.volume = volume;
  s.speak(u);
}

export function useVoice({ world, view, subjectName, clock, active, scope }: Options): void {
  const spoken = useRef(new Set<string>());
  const spokenCards = useRef(new Set<number>());
  useEffect(() => {
    spoken.current = new Set();
    spokenCards.current = new Set();
    synth()?.cancel();
  }, [scope]);

  useEffect(() => {
    if (!active) synth()?.cancel();
  }, [active]);

  useEffect(
    () => () => {
      synth()?.cancel();
    },
    [],
  );

  const subject = world?.subject.speech ?? null;
  const question = world?.investigator.speech ?? null;
  useEffect(() => {
    if (!active) return;
    for (const [who, line] of [
      ["i", question],
      ["s", subject],
    ] as const) {
      if (line === null) continue;
      const key = `${who}:${String(line.turn)}:${String(line.startedAt)}`;
      if (spoken.current.has(key)) continue;
      spoken.current.add(key);
      if (clock.current - line.startedAt > START_WINDOW_MS) continue;
      synth()?.cancel();
      speak(who === "s" ? subjectPersona(subjectName) : INVESTIGATOR, line.text);
    }
  }, [active, subject, question, subjectName, clock]);

  // The coach reads its suggested follow-up as it hands a new card over (practice only; queued after the answer).
  const newest = view?.mode === "practice" ? (view.cards.at(-1) ?? null) : null;
  const handing = world?.coaches.some((c) => c.pose === "handing") ?? false;
  useEffect(() => {
    if (!active || !handing || newest === null || spokenCards.current.has(newest.turn_no)) return;
    spokenCards.current.add(newest.turn_no);
    speak(COACH, `Suggested follow-up: ${newest.card.follow_up.question}`, 0.8);
  }, [newest, handing, active]);
}
