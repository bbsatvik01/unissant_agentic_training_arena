/**
 * The pure voice core under protocol v2.5 (S6 6.2, FE-VOICE-1..3, 6..8; S5 7.3-7.5): voice is
 * display-only and unscored; the stored `exchange` frame is the transcript; captions are unpaired;
 * the close code is the only end signal; 4410 drains; every transport drop ends the session.
 * Lifted from gokbase `voiceMachine.test.ts` and re-targeted.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  audioUtterance,
  closeCodeToEnded,
  controlFrame,
  EXCHANGE_CAP,
  frameToEvent,
  initialVoiceState,
  inputLevel,
  MAX_CAPTION_CHARS,
  reconnectOffered,
  reconnectState,
  talkLevel,
  voiceBarState,
  voiceReducer,
  type VoiceControl,
  type VoiceEndKey,
  type VoiceEvent,
  type VoiceState,
  type VoiceStateName,
} from "./voiceMachine";

const run = (events: VoiceEvent[], from: VoiceState = initialVoiceState("push_to_talk")): VoiceState =>
  events.reduce(voiceReducer, from);

const OPEN: VoiceEvent[] = [{ type: "open_consent" }, { type: "connect" }, { type: "socket_open" }];
const say = (role: "investigator" | "subject", text: string, partial = true): VoiceEvent => ({ type: "transcription", role, text, partial });
/** The investigator's turn by its capture edges (live mode; push-to-talk maps talk_start and talk_end to them). */
const turn: VoiceEvent[] = [{ type: "investigator_audio" }, { type: "investigator_silence" }];
const closed = (code: number): VoiceEvent => ({ type: "socket_closed", code });
const speaking = (utterance = 1): VoiceEvent[] => [
  { type: "utterance_start", utterance },
  { type: "playback", utterance },
];

describe("closeCodeToEnded: the S5 7.5 close-code table", () => {
  const known: [number, VoiceEndKey][] = [
    [1000, "normal"],
    [4400, "protocol"],
    [4401, "unavailable"],
    [4403, "unavailable"],
    [4404, "unavailable"],
    [4408, "idle"],
    [4409, "subject_guard"],
    [4410, "exchange_cap"],
    [4413, "cost_cap"],
    [4423, "paused"],
  ];
  it.each(known)("code %i ends the session with key %s", (code, key) => {
    expect(closeCodeToEnded(code)).toBe(key);
    expect(reconnectOffered(run([...OPEN, closed(code)]))).toBe(false);
  });

  it.each([1006, 1011, 1005, 1001, 4429, 4503, 4999, 0])("code %i (a transport drop or unknown) ends the session and offers a reconnect", (code) => {
    expect(closeCodeToEnded(code)).toBe("transport");
    const ended = run([...OPEN, closed(code)]);
    expect(ended.status).toBe("ended");
    expect(ended.endedKey).toBe("transport");
    expect(reconnectOffered(ended)).toBe(true);
  });
});

describe("frameToEvent: the S5 7.3 frame whitelist", () => {
  const valid: [unknown, VoiceEvent][] = [
    [{ type: "utterance_start", utterance: 3 }, { type: "utterance_start", utterance: 3 }],
    [{ type: "utterance_end", utterance: 3 }, { type: "utterance_end", utterance: 3 }],
    [{ type: "interrupted", utterance: 0 }, { type: "interrupted", utterance: 0 }],
    [{ type: "transcription", role: "subject", text: "x".repeat(MAX_CAPTION_CHARS), partial: true }, say("subject", "x".repeat(MAX_CAPTION_CHARS))],
    [{ type: "transcription", role: "investigator", text: "", partial: false }, say("investigator", "", false)],
    [
      { type: "exchange", exchange_no: 2, lines: [{ role: "investigator", text: "Where were you?", partial: false }, { role: "subject", text: "At home.", partial: false }] },
      { type: "exchange", exchangeNo: 2, lines: [{ role: "investigator", text: "Where were you?", partial: false }, { role: "subject", text: "At home.", partial: false }] },
    ],
    [
      { type: "exchange", exchange_no: 12, lines: [{ role: "subject", text: "I never", partial: true }] },
      { type: "exchange", exchangeNo: 12, lines: [{ role: "subject", text: "I never", partial: true }] },
    ],
    [
      { type: "exchange", exchange_no: 3, lines: [{ role: "subject", text: "late", partial: false }, { role: "investigator", text: "and then?", partial: false }, { role: "subject", text: "x".repeat(900), partial: false }] },
      { type: "exchange", exchangeNo: 3, lines: [{ role: "subject", text: "late", partial: false }, { role: "investigator", text: "and then?", partial: false }, { role: "subject", text: "x".repeat(900), partial: false }] },
    ],
    [{ type: "exchange", exchange_no: 1, lines: [] }, { type: "exchange", exchangeNo: 1, lines: [] }],
        [{ type: "exchange_count", used: 12, cap: 12 }, { type: "exchange_count", used: 12, cap: 12 }],
    [{ type: "timer_tick", time_remaining: 42.9 }, { type: "timer_tick", timeRemaining: 42 }],
    [{ type: "timer_tick", time_remaining: -3 }, { type: "timer_tick", timeRemaining: 0 }],
    [{ type: "warning", reason: "ending_soon", seconds: 60 }, { type: "warning", reason: "ending_soon", seconds: 60 }],
    [{ type: "warning", reason: "ending_soon" }, { type: "warning", reason: "ending_soon", seconds: null }],
  ];
  it.each(valid)("maps %j", (frame, event) => {
    expect(frameToEvent(frame)).toEqual(event);
  });

  const ignored: [string, unknown][] = [
    ["a non-object", "utterance_start"],
    ["null", null],
    ["an array", []],
    ["an ended frame (the close code alone ends the session, SG4-32)", { type: "ended" }],
    ["a turn_committed frame (voice creates no turns)", { type: "turn_committed", turn_no: 1, version: 1 }],
    ["a resume frame (there is no resumption)", { type: "resume", token: "t" }],
    ["a connection_lost_resume warning", { type: "warning", reason: "connection_lost_resume", seconds: null }],
    ["a connection_lost_resume warning with seconds", { type: "warning", reason: "connection_lost_resume", seconds: 5 }],
    ["a connection_lost_resume warning with no seconds", { type: "warning", reason: "connection_lost_resume" }],
    ["an unknown type", { type: "tool_call" }],
    ["a cost-shaped frame", { type: "usage", cost_usd: 0.4 }],
    ["a missing type", { utterance: 1 }],
    ["a negative utterance", { type: "utterance_start", utterance: -1 }],
    ["a fractional utterance", { type: "interrupted", utterance: 1.5 }],
    ["a transcription with no role", { type: "transcription", text: "x", partial: true }],
    ["a transcription with no text", { type: "transcription", role: "subject", partial: true }],
    ["a transcription with numeric text", { type: "transcription", role: "subject", text: 5, partial: true }],
    ["a transcription with no partial", { type: "transcription", role: "subject", text: "x" }],
    ["a warning with no reason", { type: "warning", seconds: 60 }],
    ["a warning with an unknown reason", { type: "warning", reason: "kill", seconds: 60 }],
    ["an interrupted with no number", { type: "interrupted" }],
    ["a bad role", { type: "transcription", role: "judge", text: "x", partial: true }],
    ["a non-boolean partial", { type: "transcription", role: "subject", text: "x", partial: "yes" }],
    ["a caption over 500 code points", { type: "transcription", role: "subject", text: "x".repeat(501), partial: true }],
    ["an exchange numbered 0", { type: "exchange", exchange_no: 0, lines: [] }],
    ["an exchange numbered past the cap", { type: "exchange", exchange_no: 13, lines: [] }],
    ["a fractional exchange number", { type: "exchange", exchange_no: 1.5, lines: [] }],
    ["a negative exchange number", { type: "exchange", exchange_no: -1, lines: [] }],
    ["an exchange with no lines field", { type: "exchange", exchange_no: 1 }],
    ["the withdrawn question/answer exchange shape", { type: "exchange", exchange_no: 1, question: "q", answer: "a", partial: false }],
    ["an exchange whose lines is not an array", { type: "exchange", exchange_no: 1, lines: "x" }],
    ["an exchange with a non-object line", { type: "exchange", exchange_no: 1, lines: ["x"] }],
    ["an exchange line with a bad role", { type: "exchange", exchange_no: 1, lines: [{ role: "judge", text: "x", partial: false }] }],
    ["an exchange line with no role", { type: "exchange", exchange_no: 1, lines: [{ text: "x", partial: false }] }],
    ["an exchange line with numeric text", { type: "exchange", exchange_no: 1, lines: [{ role: "subject", text: 7, partial: false }] }],
    ["an exchange line with no text", { type: "exchange", exchange_no: 1, lines: [{ role: "subject", partial: false }] }],
    ["an exchange line with a non-boolean partial", { type: "exchange", exchange_no: 1, lines: [{ role: "subject", text: "x", partial: 1 }] }],
    ["an exchange line with no partial", { type: "exchange", exchange_no: 1, lines: [{ role: "subject", text: "x" }] }],
    ["an exchange line over 900 code points", { type: "exchange", exchange_no: 1, lines: [{ role: "subject", text: "x".repeat(901), partial: false }] }],
    ["one bad line among good ones", { type: "exchange", exchange_no: 1, lines: [{ role: "subject", text: "x", partial: false }, { role: "subject", text: 1, partial: false }] }],
    ["an exchange_count with another cap", { type: "exchange_count", used: 3, cap: 10 }],
    ["an exchange_count used past the cap", { type: "exchange_count", used: 13, cap: 12 }],
    ["an exchange_count with a negative used", { type: "exchange_count", used: -1, cap: 12 }],
    ["an exchange_count with a fractional used", { type: "exchange_count", used: 1.5, cap: 12 }],
    ["an exchange_count with a string used", { type: "exchange_count", used: "3", cap: 12 }],
    ["an exchange_count with no cap", { type: "exchange_count", used: 3 }],
    ["an exchange_count with no used", { type: "exchange_count", cap: 12 }],
    ["a timer_tick with no time", { type: "timer_tick" }],
    ["a timer_tick with a string time", { type: "timer_tick", time_remaining: "9" }],
    ["a warning with negative seconds", { type: "warning", reason: "ending_soon", seconds: -1 }],
    ["a warning with string seconds", { type: "warning", reason: "ending_soon", seconds: "60" }],
    ["an utterance_start with a string number", { type: "utterance_start", utterance: "1" }],
    ["an utterance_end with no number", { type: "utterance_end" }],
    ["a non-finite timer", { type: "timer_tick", time_remaining: Number.POSITIVE_INFINITY }],
    ["a fractional warning seconds", { type: "warning", reason: "ending_soon", seconds: 1.5 }],
  ];
  it.each(ignored)("ignores %s", (_label, frame) => {
    expect(frameToEvent(frame)).toBeNull();
  });

  it("counts code points, not UTF-16 units", () => {
    const text = "\u{1F600}".repeat(MAX_CAPTION_CHARS);
    expect(frameToEvent({ type: "transcription", role: "subject", text, partial: true })).not.toBeNull();
  });

  it("the machine has no event for an ended or turn frame", () => {
    expectTypeOf<Extract<VoiceEvent["type"], "server_ended" | "turn_committed">>().toEqualTypeOf<never>();
  });
});

describe("voiceReducer: FE-VOICE-1, every (state, event) pair", () => {
  const states: [VoiceStateName, VoiceState][] = [
    ["idle", initialVoiceState("push_to_talk")],
    ["consent", run([{ type: "open_consent" }])],
    ["connecting", run([{ type: "open_consent" }, { type: "connect" }])],
    ["listening", run(OPEN)],
    ["recording", run([...OPEN, { type: "talk_start" }])],
    ["thinking", run([...OPEN, ...turn])],
    ["speaking", run([...OPEN, ...speaking()])],
    ["draining", run([...OPEN, ...speaking(), closed(4410)])],
    ["ended", run([...OPEN, closed(1000)])],
  ];
  // Expected status after each event, per starting state, in the order of `states`:
  // idle, consent, connecting, listening, recording, thinking, speaking, draining, ended.
  const expected: [string, VoiceEvent, VoiceStateName[]][] = [
    ["open_consent", { type: "open_consent" }, ["consent", "consent", "connecting", "listening", "recording", "thinking", "speaking", "draining", "ended"]],
    ["consent_declined", { type: "consent_declined" }, ["idle", "idle", "connecting", "listening", "recording", "thinking", "speaking", "draining", "ended"]],
    ["connect", { type: "connect" }, ["idle", "connecting", "connecting", "listening", "recording", "thinking", "speaking", "draining", "ended"]],
    ["socket_open", { type: "socket_open" }, ["idle", "consent", "listening", "listening", "recording", "thinking", "speaking", "draining", "ended"]],
    ["socket_closed 1006", closed(1006), ["idle", "consent", "ended", "ended", "ended", "ended", "ended", "ended", "ended"]],
    ["ended (hang-up)", { type: "ended", key: "error" }, ["ended", "ended", "ended", "ended", "ended", "ended", "ended", "ended", "ended"]],
    ["investigator_audio", { type: "investigator_audio" }, ["idle", "consent", "connecting", "listening", "recording", "thinking", "speaking", "draining", "ended"]],
    ["investigator_silence", { type: "investigator_silence" }, ["idle", "consent", "connecting", "listening", "recording", "thinking", "speaking", "draining", "ended"]],
    ["talk_start", { type: "talk_start" }, ["idle", "consent", "connecting", "recording", "recording", "recording", "speaking", "draining", "ended"]],
    ["talk_end", { type: "talk_end" }, ["idle", "consent", "connecting", "listening", "thinking", "thinking", "speaking", "draining", "ended"]],
    ["playback drained", { type: "playback", utterance: null }, ["idle", "consent", "connecting", "listening", "recording", "thinking", "thinking", "ended", "ended"]],
    ["playback 9", { type: "playback", utterance: 9 }, ["idle", "consent", "connecting", "speaking", "speaking", "speaking", "speaking", "draining", "ended"]],
    ["utterance_start 9", { type: "utterance_start", utterance: 9 }, ["idle", "consent", "connecting", "thinking", "recording", "thinking", "speaking", "draining", "ended"]],
    ["utterance_end 1", { type: "utterance_end", utterance: 1 }, ["idle", "consent", "connecting", "listening", "recording", "thinking", "speaking", "draining", "ended"]],
    ["interrupted 1", { type: "interrupted", utterance: 1 }, ["idle", "consent", "connecting", "listening", "recording", "thinking", "listening", "draining", "ended"]],
    ["transcription", say("subject", "hi"), ["idle", "consent", "connecting", "listening", "recording", "thinking", "speaking", "draining", "ended"]],
    ["exchange", { type: "exchange", exchangeNo: 1, lines: [{ role: "subject", text: "a", partial: false }] }, ["idle", "consent", "connecting", "listening", "recording", "thinking", "speaking", "draining", "ended"]],
    ["exchange_count", { type: "exchange_count", used: 1, cap: 12 }, ["idle", "consent", "connecting", "listening", "recording", "thinking", "speaking", "draining", "ended"]],
    ["timer_tick", { type: "timer_tick", timeRemaining: 5 }, ["idle", "consent", "connecting", "listening", "recording", "thinking", "speaking", "draining", "ended"]],
    ["warning", { type: "warning", reason: "ending_soon", seconds: 60 }, ["idle", "consent", "connecting", "listening", "recording", "thinking", "speaking", "draining", "ended"]],
  ];
  const events = expected.map(([, event]) => event);

  it("labels each fixture state correctly", () => {
    for (const [name, state] of states) expect(state.status).toBe(name);
  });

  for (const [label, event, results] of expected) {
    states.forEach(([name, state], index) => {
      it(`${name} + ${label} gives ${results[index] ?? "?"} and never mutates its input`, () => {
        const frozen = structuredClone(state);
        const next = voiceReducer(state, event);
        expect(state).toEqual(frozen);
        expect(next.status).toBe(results[index]);
        if (name === "ended") expect(next).toBe(state);
      });
    });
  }

  it("ended absorbs every later event, including a late frame and a second close", () => {
    const ended = states[8]?.[1] as VoiceState;
    for (const event of events) expect(voiceReducer(ended, event)).toBe(ended);
    expect(events).toHaveLength(20);
  });

  it("server frames change nothing before the socket is open", () => {
    const connecting = states[2]?.[1] as VoiceState;
    for (const event of [{ type: "utterance_start", utterance: 1 }, say("subject", "x"), { type: "exchange_count", used: 1, cap: 12 }] as VoiceEvent[]) {
      expect(voiceReducer(connecting, event)).toBe(connecting);
    }
  });

  it("walks idle to consent to connecting to listening, and consent can be declined", () => {
    expect(run([{ type: "open_consent" }]).status).toBe("consent");
    expect(run([{ type: "open_consent" }, { type: "consent_declined" }]).status).toBe("idle");
    expect(run([{ type: "connect" }]).status).toBe("idle");
    expect(run([{ type: "socket_open" }]).status).toBe("idle");
    expect(run([{ type: "open_consent" }, { type: "connect" }]).status).toBe("connecting");
    expect(run(OPEN).status).toBe("listening");
    expect(run([...OPEN, { type: "open_consent" }]).status).toBe("listening");
  });

  it("a close or hang-up before any microphone use leaves idle and consent alone; elsewhere it ends the session", () => {
    expect(run([closed(1006)]).status).toBe("idle");
    expect(run([{ type: "open_consent" }, closed(1006)]).status).toBe("consent");
    expect(run([{ type: "open_consent" }, { type: "connect" }, closed(1006)]).endedKey).toBe("transport");
    expect(run([...OPEN, { type: "ended", key: "normal" }]).endedKey).toBe("normal");
  });

  it("push-to-talk records only while the talk control is held and only on push_to_talk", () => {
    expect(run([...OPEN, { type: "talk_start" }]).status).toBe("recording");
    expect(run([...OPEN, { type: "talk_start" }, { type: "talk_end" }]).status).toBe("thinking");
    expect(run([{ type: "talk_start" }]).talkHeld).toBe(false);
    expect(run(OPEN, initialVoiceState("live")).mode).toBe("live");
    expect(run([...OPEN, { type: "talk_start" }], initialVoiceState("live")).status).toBe("listening");
    expect(run([...OPEN, { type: "talk_end" }]).status).toBe("listening");
  });
});

describe("voiceReducer: server activity and playback", () => {
  it("an open utterance without audible audio is the subject preparing; audible audio is speaking", () => {
    expect(run([...OPEN, { type: "utterance_start", utterance: 1 }]).status).toBe("thinking");
    expect(run([...OPEN, ...speaking()]).status).toBe("speaking");
  });

  it("the investigator's turn ending (capture edges) is thinking; the utterance clears the wait", () => {
    expect(run([...OPEN, ...turn]).status).toBe("thinking");
    expect(run([...OPEN, { type: "investigator_audio" }]).status).toBe("listening");
    expect(run([...OPEN, { type: "investigator_silence" }]).status).toBe("listening");
    expect(run([...OPEN, ...turn, { type: "utterance_start", utterance: 1 }, { type: "utterance_end", utterance: 1 }]).status).toBe("listening");
    expect(voiceBarState({ voice: run([...OPEN, ...turn]), captureAboveFloor: false })).toBe("preparing_answer");
    // Push-to-talk: release is the end of the turn.
    expect(run([...OPEN, { type: "talk_start" }, { type: "talk_end" }]).status).toBe("thinking");
  });

  it("captions never change activity: they arrive unordered against audio and turns (S5 7.3, SG3-40)", () => {
    const answered: VoiceEvent[] = [{ type: "investigator_audio" }, { type: "investigator_silence" }, { type: "utterance_start", utterance: 1 }, { type: "utterance_end", utterance: 1 }];
    // Fragments and finals of any speaker, before or after the answer, leave a listening machine listening.
    expect(run([...OPEN, say("investigator", "Why?"), say("investigator", "", false)]).status).toBe("listening");
    expect(run([...OPEN, say("investigator", "Why?", false)]).status).toBe("listening");
    expect(run([...OPEN, say("subject", "No."), say("investigator", "Why?", false)]).status).toBe("listening");
    // A delayed final of the answered question does not reopen the wait.
    const late = run([...OPEN, say("investigator", "Why"), ...answered, say("investigator", "?", false)]);
    expect(late.status).toBe("listening");
    expect(late.awaitingAnswer).toBe(false);
    // A delayed fragment while the answer is open is not the investigator speaking over it.
    const during = run([...OPEN, ...turn, { type: "utterance_start", utterance: 1 }, say("investigator", "Wh")]);
    expect(voiceBarState({ voice: during, captureAboveFloor: false })).toBe("preparing_answer");
    // A late partial after the turn ended and the exchange was stored does not say "You are speaking".
    const stored = run([...OPEN, ...turn, { type: "utterance_start", utterance: 1 }, { type: "utterance_end", utterance: 1 }, { type: "exchange", exchangeNo: 1, lines: [{ role: "subject", text: "a", partial: false }] }, say("investigator", "Wh")]);
    expect(voiceBarState({ voice: stored, captureAboveFloor: false })).toBe("listening");
    expect(voiceBarState({ voice: run([...OPEN, { type: "investigator_audio" }]), captureAboveFloor: false })).toBe("investigator_speaking");
  });

  it("an exchange frame does not erase a question already finished for the next exchange", () => {
    // Exchange k is stored after the investigator's next turn ended (S5 7.4 holds that audio meanwhile).
    const s = run([...OPEN, { type: "utterance_start", utterance: 1 }, ...turn, { type: "exchange", exchangeNo: 1, lines: [{ role: "subject", text: "a", partial: false }] }, { type: "utterance_end", utterance: 1 }]);
    expect(s.awaitingAnswer).toBe(true);
    expect(s.status).toBe("thinking");
    expect(run([{ type: "utterance_start", utterance: 2 }], s).awaitingAnswer).toBe(false);
  });

  it("a capture interval the subject already answered opens no wait when it ends", () => {
    // Voice activity detection answered while the control was still held (or capture still active).
    const held: VoiceEvent[] = [{ type: "talk_start" }, { type: "utterance_start", utterance: 1 }, { type: "talk_end" }, { type: "utterance_end", utterance: 1 }, { type: "playback", utterance: null }];
    const afterHold = run([...OPEN, ...held]);
    expect(afterHold.awaitingAnswer).toBe(false);
    expect(afterHold.status).toBe("listening");
    const live: VoiceEvent[] = [{ type: "investigator_audio" }, { type: "utterance_start", utterance: 1 }, { type: "investigator_silence" }, { type: "utterance_end", utterance: 1 }];
    expect(run([...OPEN, ...live]).status).toBe("listening");
    // Input that begins after an answer started is a pending question again.
    const next = run([...OPEN, ...live, { type: "investigator_audio" }, { type: "investigator_silence" }]);
    expect(next.status).toBe("thinking");
    expect(run([...OPEN, { type: "talk_start" }, { type: "utterance_start", utterance: 1 }, { type: "talk_end" }, { type: "talk_start" }, { type: "talk_end" }]).status).toBe("thinking");
  });

  it("barge-in while the control is held makes the release a pending question again", () => {
    const s = run([...OPEN, { type: "talk_start" }, ...speaking(1), { type: "interrupted", utterance: 1 }, { type: "talk_end" }]);
    expect(s.awaitingAnswer).toBe(true);
    expect(s.status).toBe("thinking");
  });

  it("an interruption that trails the release still leaves the question pending, in both arrival orders", () => {
    const ptt: VoiceEvent[] = [{ type: "talk_start" }, ...speaking(1)];
    const releasedFirst = run([...OPEN, ...ptt, { type: "talk_end" }, { type: "interrupted", utterance: 1 }]);
    const interruptedFirst = run([...OPEN, ...ptt, { type: "interrupted", utterance: 1 }, { type: "talk_end" }]);
    for (const s of [releasedFirst, interruptedFirst]) {
      expect(s.awaitingAnswer).toBe(true);
      expect(s.status).toBe("thinking");
    }
    const live: VoiceEvent[] = [{ type: "investigator_audio" }, ...speaking(1), { type: "investigator_silence" }, { type: "interrupted", utterance: 1 }];
    expect(run([...OPEN, ...live]).status).toBe("thinking");
    // An interruption of an utterance that answered nothing pending leaves no wait.
    expect(run([...OPEN, ...speaking(1), { type: "interrupted", utterance: 1 }]).awaitingAnswer).toBe(false);
    // A later answer to that turn clears the marker, so a late interruption of it adds no wait.
    const answered = run([...OPEN, ...turn, ...speaking(1), { type: "interrupted", utterance: 1 }]);
    expect(answered.awaitingAnswer).toBe(false);
  });

  it("push-to-talk held across the exchange store keeps the investigator active", () => {
    const s = run([...OPEN, { type: "talk_start" }, { type: "exchange", exchangeNo: 1, lines: [{ role: "subject", text: "a", partial: false }] }]);
    expect(s.talkHeld).toBe(true);
    expect(s.investigatorActive).toBe(true);
    expect(s.status).toBe("recording");
    expect(run([{ type: "talk_end" }], s).status).toBe("thinking");
  });

  it("queued audio keeps the subject speaking after utterance_end until playback drains", () => {
    const ended = run([...OPEN, ...speaking(), { type: "utterance_end", utterance: 1 }]);
    expect(ended.status).toBe("speaking");
    expect(run([{ type: "playback", utterance: null }], ended).status).toBe("listening");
  });

  it("ignores a stale or foreign utterance marker", () => {
    const open = run([...OPEN, { type: "utterance_start", utterance: 5 }]);
    expect(voiceReducer(open, { type: "utterance_start", utterance: 5 })).toBe(open);
    expect(voiceReducer(open, { type: "utterance_start", utterance: 4 })).toBe(open);
    expect(voiceReducer(open, { type: "utterance_end", utterance: 4 })).toBe(open);
    expect(voiceReducer(open, { type: "interrupted", utterance: 4 })).toBe(open);
  });

  it("interrupted flushes at once, and a playback report posted before the flush is stale", () => {
    const flushed = run([...OPEN, ...speaking(), { type: "interrupted", utterance: 1 }]);
    expect(flushed.audible).toBeNull();
    expect(flushed.status).toBe("listening");
    expect(voiceReducer(flushed, { type: "playback", utterance: 1 })).toBe(flushed);
    expect(voiceReducer(flushed, { type: "playback", utterance: 2 }).audible).toBe(2);
    // Older audio than the interrupted utterance is flushed too; a newer utterance plays again.
    const second = run([...speaking(2), { type: "interrupted", utterance: 2 }], run(OPEN));
    expect(voiceReducer(second, { type: "playback", utterance: 1 })).toBe(second);
    expect(voiceReducer(second, { type: "playback", utterance: 2 })).toBe(second);
    expect(voiceReducer(second, { type: "playback", utterance: 3 }).audible).toBe(3);
  });

  it("tracks the exchange count, ignoring a stale or repeated count", () => {
    const one = run([...OPEN, { type: "exchange_count", used: 3, cap: 12 }]);
    expect(one.exchangeCount).toEqual({ used: 3, cap: 12 });
    expect(voiceReducer(one, { type: "exchange_count", used: 2, cap: 12 })).toBe(one);
    expect(voiceReducer(one, { type: "exchange_count", used: 3, cap: 12 })).toBe(one);
    expect(voiceReducer(one, { type: "exchange_count", used: 4, cap: 12 }).exchangeCount?.used).toBe(4);
  });

  it("keeps the timer and the 60 s warning for the room's copy", () => {
    const warned = run([...OPEN, { type: "timer_tick", timeRemaining: 90 }, { type: "warning", reason: "ending_soon", seconds: 60 }]);
    expect(warned.endingSoon).toBe(true);
    expect(warned.timeRemaining).toBe(60);
    expect(run([...OPEN, { type: "warning", reason: "ending_soon", seconds: null }, { type: "timer_tick", timeRemaining: 4 }]).timeRemaining).toBe(4);
    expect(run([...OPEN, { type: "timer_tick", timeRemaining: 7 }, { type: "warning", reason: "ending_soon", seconds: null }]).timeRemaining).toBe(7);
  });

  it("has no turn, card, resume or upstream facts: voice is display-only and unscored", () => {
    const keys = Object.keys(initialVoiceState("live"));
    for (const gone of ["committedTurn", "resumeAttempts", "upstreamResuming", "serverEnded", "questionsDone", "answersStarted"]) {
      expect(keys).not.toContain(gone);
    }
  });
});

describe("FE-VOICE-7: termination, draining and flushing", () => {
  const sequence: VoiceEvent[] = [
    ...OPEN,
    ...speaking(7),
    { type: "exchange", exchangeNo: 12, lines: [{ role: "subject", text: "a", partial: false }] },
    { type: "exchange_count", used: 12, cap: 12 },
    { type: "utterance_end", utterance: 7 },
  ];

  it("the full 4410 sequence with a final utterance queued drains, then ends with the exchange-cap copy", () => {
    const draining = run([...sequence, closed(4410)]);
    expect(draining.status).toBe("draining");
    expect(draining.audible).toBe(7);
    expect(draining.talkHeld).toBe(false);
    expect(draining.endedKey).toBeNull();
    expect(voiceBarState({ voice: draining, captureAboveFloor: true })).toBe("finishing_answer");
    const done = run([{ type: "playback", utterance: null }], draining);
    expect(done.status).toBe("ended");
    expect(done.endedKey).toBe("exchange_cap");
    expect(done.audible).toBeNull();
    expect(done.transcript).toHaveLength(1);
  });

  it("capture stops while draining and nothing new starts", () => {
    const draining = run([...sequence, { type: "talk_start" }, closed(4410)]);
    expect(draining.talkHeld).toBe(false);
    for (const event of [{ type: "talk_start" }, { type: "utterance_start", utterance: 8 }, say("subject", "more"), { type: "socket_open" }, { type: "connect" }] as VoiceEvent[]) {
      expect(voiceReducer(draining, event)).toBe(draining);
    }
    // A start report only updates audibility; another utterance's report does not end the drain.
    expect(voiceReducer(draining, { type: "playback", utterance: 7 }).status).toBe("draining");
  });

  it("a hang-up while draining ends at once with its own key", () => {
    const done = run([{ type: "ended", key: "normal" }], run([...sequence, closed(4410)]));
    expect(done.status).toBe("ended");
    expect(done.endedKey).toBe("normal");
    expect(done.audible).toBeNull();
  });

  it("4410 always drains: the machine cannot see the queue, so it ends on the drained report (sent at once when the queue is empty)", () => {
    const draining = run([...OPEN, { type: "exchange_count", used: 12, cap: 12 }, closed(4410)]);
    expect(draining.status).toBe("draining");
    expect(run([{ type: "playback", utterance: null }], draining).endedKey).toBe("exchange_cap");
  });

  it("audio queued while its playback-start report is still in flight is not cut off", () => {
    const draining = run([...OPEN, { type: "utterance_start", utterance: 3 }, { type: "utterance_end", utterance: 3 }, closed(4410)]);
    expect(draining.status).toBe("draining");
    expect(draining.audible).toBeNull();
    const reported = run([{ type: "playback", utterance: 3 }], draining);
    expect(reported.status).toBe("draining");
    expect(reported.audible).toBe(3);
    expect(talkLevel(reported, 0.7, { reducedMotion: false, paused: false })).toBe(0.7);
    expect(run([{ type: "playback", utterance: null }], reported).status).toBe("ended");
  });

  it("an interrupted frame before 4410 flushed the audio; the drained report from the flush ends the drain", () => {
    const draining = run([...sequence, { type: "interrupted", utterance: 7 }, closed(4410)]);
    expect(draining.audible).toBeNull();
    expect(run([{ type: "playback", utterance: null }], draining).status).toBe("ended");
  });

  it.each([4409, 4423, 4413, 4400, 4408, 1000])("close %i flushes at once, never draining", (code) => {
    const done = run([...OPEN, ...speaking(), closed(code)]);
    expect(done.status).toBe("ended");
    expect(done.audible).toBeNull();
    expect(done.endedKey).toBe(closeCodeToEnded(code));
  });

  it("termination clears the warning, captions and activity, whichever close ends the session", () => {
    const warned: VoiceEvent[] = [...OPEN, { type: "warning", reason: "ending_soon", seconds: 60 }, ...speaking(), say("subject", "x"), { type: "investigator_audio" }];
    for (const code of [1000, 1006, 4409]) {
      const done = run([...warned, closed(code)]);
      expect(done.endingSoon).toBe(false);
      expect(done.captions).toEqual([]);
      expect(done.audible).toBeNull();
      expect(done.investigatorActive).toBe(false);
      expect(done.talkHeld).toBe(false);
    }
    const draining = run([...warned, closed(4410)]);
    expect(draining.endingSoon).toBe(true);
    const drained = run([{ type: "playback", utterance: null }], draining);
    expect(drained.endingSoon).toBe(false);
    expect(drained.captions).toEqual([]);
    expect(drained.investigatorActive).toBe(false);
  });

  it("an ended text frame is ignored as unknown and cannot end the session", () => {
    expect(frameToEvent({ type: "ended" })).toBeNull();
    const open = run([...OPEN, ...speaking()]);
    expect(open.status).toBe("speaking");
  });
});

describe("transport drops: no resumption", () => {
  it("every drop ends the session at once, with no reconnecting state, and offers a reconnect", () => {
    for (const code of [1006, 1011]) {
      const ended = run([...OPEN, ...speaking(), say("investigator", "So", true), closed(code)]);
      expect(ended.status).toBe("ended");
      expect(ended.connection).toBe("ended");
      expect(ended.audible).toBeNull();
      expect(ended.captions).toEqual([]);
      expect(reconnectOffered(ended)).toBe(true);
    }
    expect(reconnectOffered(run(OPEN))).toBe(false);
  });

  it("a reconnect is a new session: nothing stale carries over except the stored transcript", () => {
    const old = run([
      ...OPEN,
      { type: "utterance_start", utterance: 4 },
      say("subject", "At ho"),
      { type: "exchange", exchangeNo: 1, lines: [{ role: "subject", text: "a", partial: false }] },
      { type: "exchange_count", used: 1, cap: 12 },
      { type: "timer_tick", timeRemaining: 30 },
      { type: "warning", reason: "ending_soon", seconds: 60 },
      closed(1006),
    ]);
    const fresh = reconnectState(old);
    expect(fresh.status).toBe("connecting");
    expect(fresh.endedKey).toBeNull();
    expect(fresh.openUtterance).toBeNull();
    expect(fresh.lastUtterance).toBeNull();
    expect(fresh.captions).toEqual([]);
    expect(fresh.audible).toBeNull();
    expect(fresh.interruptedUtterance).toBeNull();
    // The cap is per trial across voice sessions: the trial-level count carries over.
    expect(fresh.exchangeCount).toEqual({ used: 1, cap: 12 });
    expect(run([{ type: "socket_open" }, { type: "exchange_count", used: 1, cap: 12 }], fresh).exchangeCount).toEqual({ used: 1, cap: 12 });
    expect(run([{ type: "socket_open" }, { type: "exchange_count", used: 2, cap: 12 }], fresh).exchangeCount?.used).toBe(2);
    expect(fresh.timeRemaining).toBeNull();
    expect(fresh.endingSoon).toBe(false);
    expect(fresh.mode).toBe(old.mode);
    expect(fresh.transcript).toEqual(old.transcript);
    // Utterance numbers restart with the new session, so a low number is accepted again.
    expect(run([{ type: "socket_open" }, { type: "utterance_start", utterance: 1 }], fresh).openUtterance).toBe(1);
  });

  it("a reconnect is offered only from a transport end", () => {
    expect(() => reconnectState(run(OPEN))).not.toThrow();
    expect(reconnectOffered(run([...OPEN, { type: "ended", key: "error" }]))).toBe(false);
  });
});

describe("FE-VOICE-3 and FE-VOICE-8: captions are unpaired; the stored exchange is the transcript", () => {
  it("fragments of one subject utterance merge into one caption line, a final closes it, the next starts anew", () => {
    const s = run([...OPEN, say("subject", "At "), say("subject", "home"), say("subject", ".", false)]);
    expect(s.captions).toEqual([{ role: "subject", text: "At home.", done: true }]);
    expect(run([say("subject", "Then ")], s).captions).toEqual([
      { role: "subject", text: "At home.", done: true },
      { role: "subject", text: "Then ", done: false },
    ]);
  });

  it("renders captions in arrival order, an investigator caption after the subject's included, without pairing", () => {
    const s = run([...OPEN, say("subject", "At home."), say("investigator", "Where were you?"), say("subject", " All night.")]);
    expect(s.captions.map((c) => [c.role, c.text])).toEqual([
      ["subject", "At home. All night."],
      ["investigator", "Where were you?"],
    ]);
  });

  it("an empty final only closes its speaker's open line and an empty final with none open adds nothing", () => {
    const s = run([...OPEN, say("investigator", "So"), say("investigator", "", false)]);
    expect(s.captions).toEqual([{ role: "investigator", text: "So", done: true }]);
    const mixed = run([...OPEN, say("subject", "At home."), say("investigator", "So"), say("investigator", "", false)]);
    expect(mixed.captions).toEqual([
      { role: "subject", text: "At home.", done: false },
      { role: "investigator", text: "So", done: true },
    ]);
    expect(run([say("investigator", "", false)], run(OPEN)).captions).toEqual([]);
    expect(run([say("subject", "", true)], run(OPEN)).captions).toEqual([]);
  });

  it("keeps the newest 500 code points of a long line and the newest 20 lines", () => {
    const long = run([...OPEN, say("subject", "a".repeat(400)), say("subject", "b".repeat(300))]);
    const text = long.captions[0]?.text ?? "";
    expect(Array.from(text)).toHaveLength(MAX_CAPTION_CHARS);
    expect(text.endsWith("b".repeat(300))).toBe(true);
    const many = run([...OPEN, ...Array.from({ length: 30 }, (_, i) => say("subject", `line ${String(i)}`, false))]);
    expect(many.captions).toHaveLength(20);
    expect(many.captions.at(-1)?.text).toBe("line 29");
    expect(many.captions[0]?.text).toBe("line 10");
  });

  it("keeps 500 whole code points of an astral-character line, never splitting a surrogate pair", () => {
    const s = run([...OPEN, say("subject", "\u{1F600}".repeat(400)), say("subject", "\u{1F4A1}".repeat(300))]);
    const text = s.captions[0]?.text ?? "";
    const points = Array.from(text);
    expect(points).toHaveLength(MAX_CAPTION_CHARS);
    expect(text.length).toBe(1000);
    expect(points.slice(-300).every((p) => p === "\u{1F4A1}")).toBe(true);
    expect(points.slice(0, 200).every((p) => p === "\u{1F600}")).toBe(true);
  });

  it("the exchange frame replaces the captions with one stored entry listing the window's role-tagged lines in arrival order", () => {
    const lines = [
      { role: "subject", text: "At home.", partial: false },
      { role: "investigator", text: "Where were you?", partial: false },
    ] as const;
    const s = run([...OPEN, say("subject", "At home."), say("investigator", "Where were you?"), { type: "exchange", exchangeNo: 2, lines }]);
    expect(s.captions).toEqual([]);
    expect(s.transcript).toEqual([{ exchangeNo: 2, lines }]);
  });

  it("keeps per-line partial marks, makes no pairing claim, and renders a late line in the window it arrived in", () => {
    const first = { type: "exchange", exchangeNo: 1, lines: [{ role: "investigator", text: "Where were you?", partial: false }, { role: "subject", text: "At ho", partial: true }] } as const;
    // The end of question 1 is stored in window 2, with its role, ahead of question 2's own line.
    const second = { type: "exchange", exchangeNo: 2, lines: [{ role: "investigator", text: " that night?", partial: false }, { role: "subject", text: "No.", partial: false }] } as const;
    const s = run([...OPEN, first, second]);
    expect(s.transcript.map((e) => e.exchangeNo)).toEqual([1, 2]);
    expect(s.transcript[0]?.lines.map((l) => l.partial)).toEqual([false, true]);
    expect(s.transcript[1]?.lines[0]).toEqual({ role: "investigator", text: " that night?", partial: false });
    expect(Object.keys(s.transcript[0] ?? {}).sort()).toEqual(["exchangeNo", "lines"]);
  });

  it("an exchange with an existing number replaces it, never duplicates, and entries stay ordered by number", () => {
    const entry = (exchangeNo: number, text: string) => ({ type: "exchange", exchangeNo, lines: [{ role: "subject", text, partial: false }] }) as const;
    const s = run([...OPEN, entry(3, "old"), entry(1, "one"), entry(3, "new")]);
    expect(s.transcript.map((e) => e.exchangeNo)).toEqual([1, 3]);
    expect(s.transcript[1]?.lines).toEqual([{ role: "subject", text: "new", partial: false }]);
    // An empty window is stored as an empty entry (the room shows it as untranscribed).
    expect(run([entry(1, "x"), { type: "exchange", exchangeNo: 1, lines: [] }], run(OPEN)).transcript).toEqual([{ exchangeNo: 1, lines: [] }]);
  });

  it.each([3, 12])("restores %i stored windows and the trial's count before any socket (FE-VOICE-9)", (used) => {
    const stored = Array.from({ length: used }, (_, i) => ({ exchangeNo: i + 1, lines: [{ role: "subject" as const, text: `s${String(i + 1)}`, partial: false }] }));
    const fresh = initialVoiceState("live", stored, { used, cap: 12 });
    expect(fresh.transcript).toHaveLength(used);
    expect(fresh.exchangeCount).toEqual({ used, cap: 12 });
    // The count survives the whole session lifecycle, including a reconnect, until a newer one arrives.
    const dropped = run([...OPEN, closed(1006)], fresh);
    expect(reconnectState(dropped).exchangeCount).toEqual({ used, cap: 12 });
    expect(reconnectState(dropped).transcript).toHaveLength(used);
    // A repeated exchange number replaces its entry; the stored count is not duplicated.
    const replaced = run([...OPEN, { type: "exchange", exchangeNo: used, lines: [{ role: "subject", text: "again", partial: false }] }], fresh);
    expect(replaced.transcript).toHaveLength(used);
    expect(replaced.transcript.at(-1)?.lines[0]?.text).toBe("again");
    // A stale count from the socket does not lower the restored one.
    expect(run([...OPEN, { type: "exchange_count", used: used - 1, cap: 12 }], fresh).exchangeCount?.used).toBe(used);
  });

  it("starts from the snapshot's stored exchanges and a later frame replaces its number (FE-VOICE-9)", () => {
    const stored = [1, 2, 3].map((exchangeNo) => ({ exchangeNo, lines: [{ role: "subject" as const, text: `s${String(exchangeNo)}`, partial: false }] }));
    const s = run([...OPEN, { type: "exchange", exchangeNo: 2, lines: [{ role: "subject", text: "again", partial: false }] }], initialVoiceState("live", stored));
    expect(s.transcript.map((e) => e.exchangeNo)).toEqual([1, 2, 3]);
    expect(s.transcript[1]?.lines[0]?.text).toBe("again");
  });

  it("a fragment arriving after the exchange stays a caption", () => {
    const stored = run([{ type: "exchange", exchangeNo: 1, lines: [{ role: "subject", text: "Because.", partial: false }] }, say("subject", " late")], run(OPEN));
    expect(stored.status).toBe("listening");
    expect(stored.captions).toEqual([{ role: "subject", text: " late", done: false }]);
  });

  it("holds no turn, card or acknowledgement state", () => {
    expectTypeOf<Extract<keyof VoiceState, "committedTurn" | "card" | "ack">>().toEqualTypeOf<never>();
  });
});

describe("controlFrame: the browser sends only S5 7.3's controls", () => {
  it("encodes stop and interrupt as closed JSON frames", () => {
    expect(controlFrame({ type: "stop" })).toBe('{"type":"stop"}');
    expect(controlFrame({ type: "interrupt" })).toBe('{"type":"interrupt"}');
  });

  it("cannot express a played or context_changed frame: playback progress stays in the browser (D7)", () => {
    expectTypeOf<VoiceControl>().toEqualTypeOf<{ readonly type: "stop" } | { readonly type: "interrupt" }>();
    expectTypeOf(controlFrame).parameter(0).toEqualTypeOf<VoiceControl>();
  });
});

describe("audioUtterance: audio frames belong to the open utterance", () => {
  it("attributes audio to the open utterance on an open socket and drops it otherwise", () => {
    const open = run([...OPEN, { type: "utterance_start", utterance: 4 }]);
    expect(audioUtterance(open)).toBe(4);
    expect(audioUtterance(voiceReducer(open, { type: "interrupted", utterance: 4 }))).toBeNull();
    expect(audioUtterance(voiceReducer(open, { type: "utterance_end", utterance: 4 }))).toBeNull();
    expect(audioUtterance(run(OPEN))).toBeNull();
    expect(audioUtterance(voiceReducer(open, closed(1006)))).toBeNull();
    expect(EXCHANGE_CAP).toBe(12);
  });
});

describe("voiceBarState: FE-VOICE-6, connection x capture x server activity x playback", () => {
  const open = run(OPEN, initialVoiceState("live"));
  const ptt = run(OPEN);
  const rows: [string, VoiceState, boolean, string][] = [
    ["idle", initialVoiceState("live"), false, "hidden"],
    ["consent", run([{ type: "open_consent" }]), true, "hidden"],
    ["connecting", run([{ type: "open_consent" }, { type: "connect" }]), true, "connecting"],
    ["open, quiet, nothing pending", open, false, "listening"],
    ["open, capture above the floor", open, true, "investigator_speaking"],
    ["open, investigator partial transcription only (captions never drive the bar)", run([say("investigator", "So")], open), false, "listening"],
    ["open, capture edge: investigator active, level below floor", run([{ type: "investigator_audio" }], open), false, "investigator_speaking"],
    ["turn ended, no utterance yet, capture below", run(turn, open), false, "preparing_answer"],
    ["turn ended, capture above again", run(turn, open), true, "investigator_speaking"],
    ["utterance open, playback not started", run([{ type: "utterance_start", utterance: 1 }], open), false, "preparing_answer"],
    ["utterance open and audible", run(speaking(), open), false, "subject_speaking"],
    ["utterance open, investigator talking over it", run(speaking(), open), true, "subject_speaking"],
    ["utterance open, playback underrun", run([...speaking(), { type: "playback", utterance: null }], open), false, "preparing_answer"],
    ["utterance ended, audio still queued", run([...speaking(), { type: "utterance_end", utterance: 1 }], open), false, "subject_speaking"],
    ["utterance ended, queue drained", run([...speaking(), { type: "utterance_end", utterance: 1 }, { type: "playback", utterance: null }], open), false, "listening"],
    ["interrupted, then a stale playback report", run([...speaking(), { type: "interrupted", utterance: 1 }, { type: "playback", utterance: 1 }], open), false, "listening"],
    ["closed by 4410 with audio queued", run([...speaking(), closed(4410)], open), false, "finishing_answer"],
    ["push-to-talk held, silent", run([{ type: "talk_start" }], ptt), false, "recording"],
    ["push-to-talk released, no answer yet", run([{ type: "talk_start" }, { type: "talk_end" }], ptt), false, "preparing_answer"],
    ["ended", run([closed(1000)], open), true, "ended"],
    ["ended by a transport drop", run([closed(1006)], open), false, "ended"],
  ];
  it.each(rows)("%s", (_label, voice, captureAboveFloor, bar) => {
    expect(voiceBarState({ voice, captureAboveFloor })).toBe(bar);
  });
});

describe("talkLevel and inputLevel: one amplitude from the playback node", () => {
  const still = { reducedMotion: false, paused: false };
  const playing = run([...OPEN, ...speaking()]);

  it("passes the playback level through only while audio is actually playing", () => {
    expect(talkLevel(playing, 0.6, still)).toBe(0.6);
    expect(talkLevel(run([{ type: "playback", utterance: null }], playing), 0.6, still)).toBe(0);
    expect(talkLevel(run([...OPEN, { type: "utterance_start", utterance: 1 }]), 0.6, still)).toBe(0);
    expect(talkLevel(run(OPEN), 0.6, still)).toBe(0);
  });

  it("keeps the amplitude while draining and drops it to 0 on interrupted, before the analyser decays", () => {
    expect(talkLevel(run([closed(4410)], playing), 0.5, still)).toBe(0.5);
    const interrupted = voiceReducer(playing, { type: "interrupted", utterance: 1 });
    expect(talkLevel(interrupted, 0.9, still)).toBe(0);
    expect(talkLevel(voiceReducer(interrupted, { type: "playback", utterance: 1 }), 0.9, still)).toBe(0);
  });

  it("stays still under reduced motion or the pause control", () => {
    expect(talkLevel(playing, 0.6, { reducedMotion: true, paused: false })).toBe(0);
    expect(talkLevel(playing, 0.6, { reducedMotion: false, paused: true })).toBe(0);
  });

  it("clamps to 0-1 and reads a non-finite level as silence", () => {
    expect([1.7, -0.2, Number.NaN, Number.POSITIVE_INFINITY].map((l) => talkLevel(playing, l, still))).toEqual([1, 0, 0, 0]);
  });

  it("shows the investigator's own level only above the floor, while the mic is live and not draining", () => {
    const live = run(OPEN);
    expect(inputLevel(live, 0.4, 0.05, still)).toBe(0.4);
    expect(inputLevel(live, 0.05, 0.05, still)).toBe(0);
    expect(inputLevel(live, 0.4, 0.05, { reducedMotion: true, paused: false })).toBe(0);
    expect(inputLevel(live, 0.4, 0.05, { reducedMotion: false, paused: true })).toBe(0);
    expect(inputLevel(initialVoiceState("live"), 0.4, 0.05, still)).toBe(0);
    expect(inputLevel(run([closed(1000)], live), 0.4, 0.05, still)).toBe(0);
    expect(inputLevel(run([closed(4410)], playing), 0.4, 0.05, still)).toBe(0);
    expect(inputLevel(run([{ type: "open_consent" }, { type: "connect" }]), 0.4, 0.05, still)).toBe(0.4);
    expect(inputLevel(live, 3, 0.05, still)).toBe(1);
  });
});
