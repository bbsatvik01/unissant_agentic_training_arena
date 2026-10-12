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
import { useEffect, useRef, useState } from "react";

import type { TrialView } from "../../lib/trial/trialReducer";
import { COACHES, INVESTIGATOR, subjectPersona, type Persona } from "../../lib/world/cast";
import type { WorldState } from "../../lib/world/worldState";
import type { VoiceEngine } from "../../lib/voice/gemini";
import { speechSync, type SpokenLine } from "../../lib/voice/speechSync";

interface Options {
  readonly world: WorldState | null;
  readonly view: TrialView | null;
  readonly subjectName: string;
  readonly clock: { readonly current: number };
  /** Sound on, at normal speed, in the room. */
  readonly active: boolean;
  /** The session or recording in the room: lines already spoken are forgotten when it changes. */
  readonly scope: string;
  /** Who speaks: Gemini voices through the server, or the browser's own (`roomEngine`). */
  readonly engine: VoiceEngine;
  /** The coach's earpiece is on (practice only; the trainee can mute it). */
  readonly earpiece?: boolean;
}

const START_WINDOW_MS = 500;
/** A clock step back larger than this is a rewind. */
const REWIND_MS = 250;
const COACH = COACHES[2] ?? INVESTIGATOR;

/** What has been voiced: line keys, coach cards, the clock at the last look, and the item speaking now. */
interface Memory {
  spoken: Set<string>;
  cards: Set<number>;
  lastClock: number;
  speaking: { readonly token: object; readonly kind: "dialogue" | "coach" } | null;
  /** Coach items queued or speaking: while any is, a new line queues instead of cancelling. */
  coachPending: number;
  /** Dialogue items queued or speaking (an earpiece mute never cancels them). */
  dialoguePending: number;
  /** Bumped on every silence: callbacks of items from before it are ignored. */
  generation: number;
  /** Tells the hook whether the coach's earpiece aside is being said. */
  onCoach: (speaking: boolean) => void;
  /** The earpiece toggle as it is now (read when a waiting aside would start). */
  earpiece: boolean;
  /** Asides waiting for the dialogue to finish: one goes to the voice only when no dialogue speaks or waits. */
  asides: (() => void)[];
}

/** Hand the waiting asides to the voice once no dialogue speaks or waits, if the earpiece is still on. */
function flushAsides(memory: Memory): void {
  if (!memory.earpiece) memory.asides = [];
  while (memory.dialoguePending === 0 && memory.asides.length > 0) memory.asides.shift()?.();
}

/** Speak `text` through the engine; a dialogue line reports its voice to `speechSync` (queued until it starts, so its
 * mouth waits). `onCoach` hears when the coach's earpiece aside starts and stops. */
function speak(engine: VoiceEngine, memory: Memory, kind: "dialogue" | "coach", persona: Persona, text: string, volume: number, line: SpokenLine | null, clock: { readonly current: number }): void {
  const epoch = speechSync.epoch();
  const generation = memory.generation;
  const token = {};
  let pending = true;
  if (kind === "coach") memory.coachPending += 1;
  else memory.dialoguePending += 1;
  if (line !== null) speechSync.queue(line, clock.current, epoch);
  engine.speak(
    { voice: persona.voice, text, volume, line },
    {
      onstart: () => {
        if (generation !== memory.generation) return;
        memory.speaking = { token, kind };
        if (kind === "coach") memory.onCoach(true);
        if (line !== null) speechSync.at(line, 0, clock.current, epoch);
      },
      onprogress: (charIndex) => {
        if (line !== null) speechSync.at(line, charIndex, clock.current, epoch);
      },
      onend: () => {
        if (generation !== memory.generation) return;
        if (pending) {
          pending = false;
          if (kind === "coach") memory.coachPending = Math.max(0, memory.coachPending - 1);
          else memory.dialoguePending = Math.max(0, memory.dialoguePending - 1);
        }
        if (kind === "dialogue") flushAsides(memory);
        if (memory.speaking?.token === token) memory.speaking = null;
        if (kind === "coach") memory.onCoach(false);
        if (line !== null) speechSync.end(line, epoch);
      },
    },
  );
}

/** Stop every voice; lines go back to their text cadence. */
function silence(engine: VoiceEngine, memory: Memory): void {
  speechSync.clear();
  memory.generation += 1;
  engine.cancel();
  memory.speaking = null;
  memory.coachPending = 0;
  memory.dialoguePending = 0;
  memory.asides = [];
  memory.onCoach(false);
}

function forget(engine: VoiceEngine, memory: Memory): void {
  memory.spoken = new Set();
  memory.cards = new Set();
  silence(engine, memory);
}

/** Forget what was voiced when the clock has gone back since the last look (Replay, a seek back). */
function noteClock(engine: VoiceEngine, memory: Memory, now: number): void {
  if (now + REWIND_MS < memory.lastClock) forget(engine, memory);
  memory.lastClock = now;
}

export function useVoice({ world, view, subjectName, clock, active, scope, engine, earpiece = true }: Options): { readonly coachSpeaking: boolean } {
  const [coachSpeaking, setCoachSpeaking] = useState(false);
  const memory = useRef<Memory>({ spoken: new Set(), cards: new Set(), lastClock: 0, speaking: null, coachPending: 0, dialoguePending: 0, generation: 0, onCoach: setCoachSpeaking, earpiece, asides: [] });
  useEffect(() => {
    forget(engine, memory.current);
    memory.current.lastClock = 0;
  }, [scope, engine]);

  useEffect(() => {
    if (!active) silence(engine, memory.current);
  }, [active, engine]);

  useEffect(() => {
    const m = memory.current;
    return () => {
      silence(engine, m);
    };
  }, [engine]);

  const subject = world?.subject.speech ?? null;
  const question = world?.investigator.speech ?? null;
  useEffect(() => {
    const m = memory.current;
    noteClock(engine, m, clock.current);
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
      if (m.coachPending === 0) engine.cancel();
      speak(engine, m, "dialogue", who === "s" ? subjectPersona(subjectName) : INVESTIGATOR, line.text, 1, line, clock);
    }
  }, [active, subject, question, subjectName, clock, engine]);

  // The coach in the investigator's earpiece (stage 8): as it hands a new card over it says the suggested follow-up
  // quietly, in its own voice, after the answer (it waits for the dialogue: it never talks over the subject). Practice
  // only, never in an assessment; muted with the earpiece toggle. A card that arrives muted is not said later.
  const newest = view?.mode === "practice" ? (view.cards.at(-1) ?? null) : null;
  const handing = world?.coaches.some((c) => c.pose === "handing") ?? false;
  useEffect(() => {
    const m = memory.current;
    noteClock(engine, m, clock.current);
    if (!active || !handing || newest === null || m.cards.has(newest.turn_no)) return;
    m.cards.add(newest.turn_no);
    if (!earpiece) return;
    // Said after the answer: it waits while any dialogue speaks or waits, and is dropped if the earpiece is muted
    // before its turn.
    m.asides.push(() => {
      speak(engine, m, "coach", COACH, `Try asking: ${newest.card.follow_up.question}`, 0.8, null, clock);
    });
    flushAsides(m);
  }, [newest, handing, active, clock, engine, earpiece]);
  // Muting the earpiece stops an aside being said, when no dialogue is speaking or waiting behind it (the engine's
  // cancel drops its whole queue, and an answer is never cut for the earpiece); otherwise the aside finishes.
  useEffect(() => {
    const m = memory.current;
    m.earpiece = earpiece;
    if (earpiece) return;
    m.asides = [];
    if (m.coachPending === 0 || m.dialoguePending > 0) return;
    silence(engine, m);
  }, [earpiece, engine]);
  return { coachSpeaking: coachSpeaking && active && earpiece };
}
