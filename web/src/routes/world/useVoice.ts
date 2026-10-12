/**
 * Voices for the room (stage 2): the subject's answers, the investigator's questions and the coach's suggested
 * follow-up are spoken by the browser's speech synthesis, each persona with its own voice (`pickVoice`), while the
 * avatars' visemes follow the same line on the session clock. A line is spoken only when it starts live (within
 * half a second of its start on the clock), so scrubbing into the middle of an answer stays silent; a rewind (Replay,
 * a seek back) forgets what was spoken, so the lines are voiced again. The voice reports its start, word boundaries
 * and end to `speechSync`, which the avatars' mouths and the world's speaking windows follow, and its rate is fitted
 * to the line's speaking time (`fitRate`). A new line supersedes the dialogue being spoken but waits for the coach's
 * suggestion to finish (its mouth closed until its voice starts). Sound stops when muted, when playback is paused or runs faster than 1x, and on leaving the room.
 * Gemini TTS or Live can replace the synthesis behind the same calls (WP-22).
 */
import { useEffect, useRef } from "react";

import type { TrialView } from "../../lib/trial/trialReducer";
import { COACHES, INVESTIGATOR, subjectPersona, type Persona } from "../../lib/world/cast";
import type { WorldState } from "../../lib/world/worldState";
import { speechSync, type SpokenLine } from "../../lib/voice/speechSync";
import { fitRate, pickVoice, utteranceSettings } from "../../lib/voice/tts";

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
/** A clock step back larger than this is a rewind. */
const REWIND_MS = 250;
const COACH = COACHES[2] ?? INVESTIGATOR;

function synth(): SpeechSynthesis | null {
  return typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
}

/** What has been voiced: line keys, coach cards, the clock at the last look, and the utterance speaking now. */
interface Memory {
  spoken: Set<string>;
  cards: Set<number>;
  lastClock: number;
  speaking: { readonly utterance: SpeechSynthesisUtterance; readonly kind: "dialogue" | "coach" } | null;
  /** Coach utterances queued or speaking: while any is, a new line queues instead of cancelling. */
  coachPending: number;
}

/** Speak `text`; a dialogue line reports its voice to `speechSync` (queued until it starts, so its mouth waits). */
function speak(memory: Memory, kind: "dialogue" | "coach", persona: Persona, text: string, volume: number, line: SpokenLine | null, clock: { readonly current: number }): void {
  const s = synth();
  if (s === null) return;
  const u = new SpeechSynthesisUtterance(text);
  const voice = pickVoice(s.getVoices(), persona.voice.prefer);
  if (voice !== null) u.voice = voice;
  const { pitch, rate } = utteranceSettings(persona.voice);
  u.pitch = pitch;
  u.rate = line === null ? rate : fitRate(text, rate);
  u.volume = volume;
  const epoch = speechSync.epoch();
  let pending = kind === "coach";
  if (pending) memory.coachPending += 1;
  const done = () => {
    if (pending) {
      pending = false;
      memory.coachPending = Math.max(0, memory.coachPending - 1);
    }
    if (memory.speaking?.utterance === u) memory.speaking = null;
    if (line !== null) speechSync.end(line, epoch);
  };
  u.onstart = () => {
    memory.speaking = { utterance: u, kind };
    if (line !== null) speechSync.at(line, 0, clock.current, epoch);
  };
  u.onboundary = (e) => {
    if (line !== null) speechSync.at(line, e.charIndex, clock.current, epoch);
  };
  u.onend = done;
  u.onerror = done;
  if (line !== null) speechSync.queue(line, clock.current, epoch);
  s.speak(u);
}

/** Stop every voice; lines go back to their text cadence. */
function silence(memory: Memory): void {
  memory.speaking = null;
  memory.coachPending = 0;
  speechSync.clear();
  synth()?.cancel();
}

function forget(memory: Memory): void {
  memory.spoken = new Set();
  memory.cards = new Set();
  silence(memory);
}

/** Forget what was voiced when the clock has gone back since the last look (Replay, a seek back). */
function noteClock(memory: Memory, now: number): void {
  if (now + REWIND_MS < memory.lastClock) forget(memory);
  memory.lastClock = now;
}

export function useVoice({ world, view, subjectName, clock, active, scope }: Options): void {
  const memory = useRef<Memory>({ spoken: new Set(), cards: new Set(), lastClock: 0, speaking: null, coachPending: 0 });
  useEffect(() => {
    forget(memory.current);
    memory.current.lastClock = 0;
  }, [scope]);

  useEffect(() => {
    if (!active) silence(memory.current);
  }, [active]);

  useEffect(() => {
    const m = memory.current;
    return () => {
      silence(m);
    };
  }, []);

  const subject = world?.subject.speech ?? null;
  const question = world?.investigator.speech ?? null;
  useEffect(() => {
    const m = memory.current;
    noteClock(m, clock.current);
    if (!active) return;
    for (const [who, line] of [
      ["i", question],
      ["s", subject],
    ] as const) {
      if (line === null) continue;
      const key = `${who}:${String(line.turn)}:${String(line.startedAt)}`;
      if (m.spoken.has(key)) continue;
      m.spoken.add(key);
      if (clock.current - line.startedAt > START_WINDOW_MS) continue;
      // A newer line supersedes the dialogue being spoken; the coach's suggestion (speaking or queued) is never
      // cut: the line waits behind it.
      if (m.coachPending === 0) synth()?.cancel();
      speak(m, "dialogue", who === "s" ? subjectPersona(subjectName) : INVESTIGATOR, line.text, 1, line, clock);
    }
  }, [active, subject, question, subjectName, clock]);

  // The coach reads its suggested follow-up as it hands a new card over (practice only; queued after the answer).
  const newest = view?.mode === "practice" ? (view.cards.at(-1) ?? null) : null;
  const handing = world?.coaches.some((c) => c.pose === "handing") ?? false;
  useEffect(() => {
    const m = memory.current;
    noteClock(m, clock.current);
    if (!active || !handing || newest === null || m.cards.has(newest.turn_no)) return;
    m.cards.add(newest.turn_no);
    speak(m, "coach", COACH, `Suggested follow-up: ${newest.card.follow_up.question}`, 0.8, null, clock);
  }, [newest, handing, active, clock]);
}
