/**
 * The pure voice core: reducer, frame whitelist, close-code taxonomy, resume policy and the voice
 * bar (S6 6.2, FE-VOICE-1..3 and 6; S5 7.3-7.5). Lifted from gokbase `voiceMachine.test.ts` and
 * re-targeted to the arena's states, frames and close codes.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  audioUtterance,
  closeCodeToEnded,
  controlFrame,
  frameToEvent,
  initialVoiceState,
  inputLevel,
  isTerminalCloseCode,
  MAX_CAPTION_CHARS,
  RESUME_BACKOFF_MS,
  RESUME_SUBPROTOCOL,
  resumeDelayMs,
  talkLevel,
  voiceBarState,
  voiceReducer,
  type VoiceControl,
  type VoiceEndKey,
  type VoiceEvent,
  type VoiceMode,
  type VoiceState,
  type VoiceStateName,
} from "./voiceMachine";

const run = (events: VoiceEvent[], from: VoiceState = initialVoiceState("push_to_talk")): VoiceState =>
  events.reduce(voiceReducer, from);

const OPEN: VoiceEvent[] = [{ type: "open_consent" }, { type: "connect" }, { type: "socket_open" }];

describe("closeCodeToEnded: the S5 7.5 close-code taxonomy", () => {
  const terminal: [number, VoiceEndKey][] = [
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
    [4503, "resume_failed"],
  ];
  it.each(terminal)("code %i is terminal and ends with key %s", (code, key) => {
    expect(closeCodeToEnded(code)).toEqual({ terminal: true, key });
    expect(isTerminalCloseCode(code)).toBe(true);
  });

  it.each([1006, 1011, 1005, 1001, 4429, 4999, 0])("code %i is transient and drives a resume", (code) => {
    expect(closeCodeToEnded(code)).toEqual({ terminal: false, key: "transient_exhausted" });
    expect(isTerminalCloseCode(code)).toBe(false);
  });
});

describe("frameToEvent: the S5 7.3 frame whitelist", () => {
  const valid: [unknown, VoiceEvent][] = [
    [{ type: "utterance_start", utterance: 3 }, { type: "utterance_start", utterance: 3 }],
    [{ type: "utterance_end", utterance: 3 }, { type: "utterance_end", utterance: 3 }],
    [{ type: "interrupted", utterance: 0 }, { type: "interrupted", utterance: 0 }],
    [
      { type: "transcription", role: "investigator", text: "Where were you?", partial: true },
      { type: "transcription", role: "investigator", text: "Where were you?", partial: true },
    ],
    [
      { type: "transcription", role: "subject", text: "At home.", partial: false },
      { type: "transcription", role: "subject", text: "At home.", partial: false },
    ],
    [
      { type: "transcription", role: "subject", text: "x".repeat(MAX_CAPTION_CHARS), partial: true },
      { type: "transcription", role: "subject", text: "x".repeat(MAX_CAPTION_CHARS), partial: true },
    ],
    [{ type: "turn_committed", turn_no: 4, version: 9 }, { type: "turn_committed", turnNo: 4, version: 9 }],
    [{ type: "exchange_count", used: 12, cap: 12 }, { type: "exchange_count", used: 12, cap: 12 }],
    [{ type: "timer_tick", time_remaining: 42 }, { type: "timer_tick", timeRemaining: 42 }],
    [{ type: "timer_tick", time_remaining: 41.7 }, { type: "timer_tick", timeRemaining: 41 }],
    [{ type: "timer_tick", time_remaining: -3 }, { type: "timer_tick", timeRemaining: 0 }],
    [
      { type: "warning", reason: "ending_soon", seconds: 60 },
      { type: "warning", reason: "ending_soon", seconds: 60 },
    ],
    [{ type: "warning", reason: "ending_soon" }, { type: "warning", reason: "ending_soon", seconds: null }],
    [
      { type: "warning", reason: "connection_lost_resume" },
      { type: "warning", reason: "connection_lost_resume", seconds: null },
    ],
    [{ type: "ended", reason: "cost_cap" }, { type: "server_ended" }],
  ];
  it.each(valid)("maps %j", (frame, event) => {
    expect(frameToEvent(frame)).toEqual(event);
  });

  const ignored: [string, unknown][] = [
    ["resume (the token belongs to the session hook, never the machine)", { type: "resume", token: "abc", expires_in: 300 }],
    ["a cost-shaped frame (no cost ever reaches the UI)", { type: "cost", cost_usd: 0.05 }],
    ["an unknown type", { type: "tool_status", tool: "lookup" }],
    ["a v1 playback_ack echo", { type: "playback_ack", utterance: 1 }],
    ["a non-object", "utterance_start"],
    ["null", null],
    ["an array", [{ type: "utterance_start", utterance: 1 }]],
    ["a missing type", { utterance: 1 }],
    ["a negative utterance", { type: "utterance_start", utterance: -1 }],
    ["a fractional utterance", { type: "utterance_end", utterance: 1.5 }],
    ["a string utterance", { type: "interrupted", utterance: "1" }],
    ["an unknown transcription role", { type: "transcription", role: "model", text: "x", partial: false }],
    ["a missing transcription role", { type: "transcription", text: "x", partial: false }],
    ["a non-string transcription text", { type: "transcription", role: "subject", text: 5, partial: false }],
    [
      "a transcription over the S5 500-character limit",
      { type: "transcription", role: "subject", text: "x".repeat(MAX_CAPTION_CHARS + 1), partial: false },
    ],
    ["a non-boolean partial", { type: "transcription", role: "subject", text: "x", partial: "no" }],
    ["a turn_committed without a turn", { type: "turn_committed", version: 2 }],
    ["a turn_committed with a fractional version", { type: "turn_committed", turn_no: 2, version: 2.5 }],
    ["an exchange count over its cap", { type: "exchange_count", used: 13, cap: 12 }],
    ["an exchange count with a cap other than S5's 12", { type: "exchange_count", used: 13, cap: 13 }],
    ["an exchange count with a lower cap", { type: "exchange_count", used: 1, cap: 11 }],
    ["a negative exchange count", { type: "exchange_count", used: -1, cap: 12 }],
    ["an exchange count without a cap", { type: "exchange_count", used: 3 }],
    ["a timer_tick without a time", { type: "timer_tick" }],
    ["a non-finite timer_tick", { type: "timer_tick", time_remaining: Number.POSITIVE_INFINITY }],
    ["a warning with an unknown reason", { type: "warning", reason: "cost", seconds: 5 }],
    ["a warning without a reason", { type: "warning", seconds: 5 }],
    ["a warning with negative seconds", { type: "warning", reason: "ending_soon", seconds: -1 }],
  ];
  it.each(ignored)("ignores %s", (_label, frame) => {
    expect(frameToEvent(frame)).toBeNull();
  });
});

/** One reachable representative of every machine state (push-to-talk, so `recording` exists). */
function representatives(): Record<VoiceStateName, VoiceState> {
  const idle = initialVoiceState("push_to_talk");
  const consent = run([{ type: "open_consent" }], idle);
  const connecting = run([{ type: "connect" }], consent);
  const listening = run([{ type: "socket_open" }], connecting);
  return {
    idle,
    consent,
    connecting,
    listening,
    recording: run([{ type: "talk_start" }], listening),
    thinking: run([{ type: "transcription", role: "investigator", text: "Why?", partial: false }], listening),
    speaking: run([{ type: "utterance_start", utterance: 1 }, { type: "playback", utterance: 1 }], listening),
    reconnecting: run([{ type: "socket_closed", code: 1006, resumable: true }], listening),
    ended: run([{ type: "socket_closed", code: 1000, resumable: true }], listening),
  };
}

/** One representative of every event, aimed at the state's own utterance where that matters. */
const EVENTS = {
  open_consent: () => ({ type: "open_consent" }),
  consent_declined: () => ({ type: "consent_declined" }),
  connect: () => ({ type: "connect" }),
  socket_open: () => ({ type: "socket_open" }),
  closed_terminal: () => ({ type: "socket_closed", code: 4410, resumable: true }),
  closed_resumable: () => ({ type: "socket_closed", code: 1006, resumable: true }),
  closed_no_token: () => ({ type: "socket_closed", code: 1006, resumable: false }),
  ended: () => ({ type: "ended", key: "normal" }),
  talk_start: () => ({ type: "talk_start" }),
  talk_end: () => ({ type: "talk_end" }),
  playback_on: (s) => ({ type: "playback", utterance: s.openUtterance ?? s.lastUtterance ?? 1 }),
  playback_off: () => ({ type: "playback", utterance: null }),
  utterance_start: (s) => ({ type: "utterance_start", utterance: (s.lastUtterance ?? 0) + 1 }),
  utterance_end: (s) => ({ type: "utterance_end", utterance: s.openUtterance ?? 1 }),
  interrupted: (s) => ({ type: "interrupted", utterance: s.lastUtterance ?? 1 }),
  investigator_partial: () => ({ type: "transcription", role: "investigator", text: "And ", partial: true }),
  investigator_final: () => ({ type: "transcription", role: "investigator", text: "then?", partial: false }),
  subject_caption: () => ({ type: "transcription", role: "subject", text: "I left.", partial: true }),
  turn_committed: () => ({ type: "turn_committed", turnNo: 1, version: 2 }),
  exchange_count: () => ({ type: "exchange_count", used: 1, cap: 12 }),
  timer_tick: () => ({ type: "timer_tick", timeRemaining: 300 }),
  warning_ending: () => ({ type: "warning", reason: "ending_soon", seconds: 60 }),
  warning_resume: () => ({ type: "warning", reason: "connection_lost_resume", seconds: null }),
  server_ended: () => ({ type: "server_ended" }),
} satisfies Record<string, (s: VoiceState) => VoiceEvent>;

type EventName = keyof typeof EVENTS;

/** Expected status after each (state, event) pair: FE-VOICE-1 covers every cell. */
const EXPECTED: Record<VoiceStateName, Record<EventName, VoiceStateName>> = {
  idle: {
    open_consent: "consent", consent_declined: "idle", connect: "idle", socket_open: "idle",
    closed_terminal: "idle", closed_resumable: "idle", closed_no_token: "idle", ended: "ended",
    talk_start: "idle", talk_end: "idle", playback_on: "idle", playback_off: "idle",
    utterance_start: "idle", utterance_end: "idle", interrupted: "idle", investigator_partial: "idle",
    investigator_final: "idle", subject_caption: "idle", turn_committed: "idle", exchange_count: "idle",
    timer_tick: "idle", warning_ending: "idle", warning_resume: "idle", server_ended: "idle",
  },
  consent: {
    open_consent: "consent", consent_declined: "idle", connect: "connecting", socket_open: "consent",
    closed_terminal: "consent", closed_resumable: "consent", closed_no_token: "consent", ended: "ended",
    talk_start: "consent", talk_end: "consent", playback_on: "consent", playback_off: "consent",
    utterance_start: "consent", utterance_end: "consent", interrupted: "consent", investigator_partial: "consent",
    investigator_final: "consent", subject_caption: "consent", turn_committed: "consent", exchange_count: "consent",
    timer_tick: "consent", warning_ending: "consent", warning_resume: "consent", server_ended: "consent",
  },
  connecting: {
    open_consent: "connecting", consent_declined: "connecting", connect: "connecting", socket_open: "listening",
    closed_terminal: "ended", closed_resumable: "reconnecting", closed_no_token: "ended", ended: "ended",
    talk_start: "connecting", talk_end: "connecting", playback_on: "connecting", playback_off: "connecting",
    utterance_start: "connecting", utterance_end: "connecting", interrupted: "connecting",
    investigator_partial: "connecting", investigator_final: "connecting", subject_caption: "connecting",
    turn_committed: "connecting", exchange_count: "connecting", timer_tick: "connecting",
    warning_ending: "connecting", warning_resume: "connecting", server_ended: "connecting",
  },
  listening: {
    open_consent: "listening", consent_declined: "listening", connect: "listening", socket_open: "listening",
    closed_terminal: "ended", closed_resumable: "reconnecting", closed_no_token: "ended", ended: "ended",
    talk_start: "recording", talk_end: "listening", playback_on: "speaking", playback_off: "listening",
    utterance_start: "thinking", utterance_end: "listening", interrupted: "listening",
    investigator_partial: "listening", investigator_final: "thinking", subject_caption: "listening",
    turn_committed: "listening", exchange_count: "listening", timer_tick: "listening",
    warning_ending: "listening", warning_resume: "reconnecting", server_ended: "listening",
  },
  recording: {
    open_consent: "recording", consent_declined: "recording", connect: "recording", socket_open: "recording",
    closed_terminal: "ended", closed_resumable: "reconnecting", closed_no_token: "ended", ended: "ended",
    talk_start: "recording", talk_end: "listening", playback_on: "speaking", playback_off: "recording",
    utterance_start: "recording", utterance_end: "recording", interrupted: "recording",
    investigator_partial: "recording", investigator_final: "recording", subject_caption: "recording",
    turn_committed: "recording", exchange_count: "recording", timer_tick: "recording",
    warning_ending: "recording", warning_resume: "reconnecting", server_ended: "recording",
  },
  thinking: {
    open_consent: "thinking", consent_declined: "thinking", connect: "thinking", socket_open: "thinking",
    closed_terminal: "ended", closed_resumable: "reconnecting", closed_no_token: "ended", ended: "ended",
    talk_start: "recording", talk_end: "thinking", playback_on: "speaking", playback_off: "thinking",
    utterance_start: "thinking", utterance_end: "thinking", interrupted: "thinking",
    investigator_partial: "thinking", investigator_final: "thinking", subject_caption: "thinking",
    // A count reporting a commit whose answer this client never saw start (missed while the
    // socket was down): the pending question was answered (S5 7.4 pairs each commit with one).
    turn_committed: "thinking", exchange_count: "listening", timer_tick: "thinking",
    warning_ending: "thinking", warning_resume: "reconnecting", server_ended: "thinking",
  },
  speaking: {
    open_consent: "speaking", consent_declined: "speaking", connect: "speaking", socket_open: "speaking",
    closed_terminal: "ended", closed_resumable: "reconnecting", closed_no_token: "ended", ended: "ended",
    talk_start: "speaking", talk_end: "speaking", playback_on: "speaking", playback_off: "thinking",
    utterance_start: "speaking", utterance_end: "speaking", interrupted: "listening",
    investigator_partial: "speaking", investigator_final: "speaking", subject_caption: "speaking",
    turn_committed: "speaking", exchange_count: "speaking", timer_tick: "speaking",
    warning_ending: "speaking", warning_resume: "reconnecting", server_ended: "speaking",
  },
  reconnecting: {
    open_consent: "reconnecting", consent_declined: "reconnecting", connect: "reconnecting",
    socket_open: "listening", closed_terminal: "ended", closed_resumable: "reconnecting",
    closed_no_token: "ended", ended: "ended", talk_start: "reconnecting", talk_end: "reconnecting",
    playback_on: "reconnecting", playback_off: "reconnecting", utterance_start: "reconnecting",
    utterance_end: "reconnecting", interrupted: "reconnecting", investigator_partial: "reconnecting",
    investigator_final: "reconnecting", subject_caption: "reconnecting", turn_committed: "reconnecting",
    exchange_count: "reconnecting", timer_tick: "reconnecting", warning_ending: "reconnecting",
    warning_resume: "reconnecting", server_ended: "reconnecting",
  },
  ended: {
    open_consent: "ended", consent_declined: "ended", connect: "ended", socket_open: "ended",
    closed_terminal: "ended", closed_resumable: "ended", closed_no_token: "ended", ended: "ended",
    talk_start: "ended", talk_end: "ended", playback_on: "ended", playback_off: "ended",
    utterance_start: "ended", utterance_end: "ended", interrupted: "ended", investigator_partial: "ended",
    investigator_final: "ended", subject_caption: "ended", turn_committed: "ended", exchange_count: "ended",
    timer_tick: "ended", warning_ending: "ended", warning_resume: "ended", server_ended: "ended",
  },
};

describe("voiceReducer: FE-VOICE-1, every (state, event) pair", () => {
  const states = representatives();

  it("reaches every state it is tabled for", () => {
    for (const [name, state] of Object.entries(states)) expect(state.status).toBe(name);
  });

  const cells = (Object.keys(EXPECTED) as VoiceStateName[]).flatMap((s) =>
    (Object.keys(EVENTS) as EventName[]).map((e): [VoiceStateName, EventName, VoiceStateName] => [s, e, EXPECTED[s][e]]),
  );
  it.each(cells)("%s + %s -> %s", (from, event, to) => {
    const state = states[from];
    expect(voiceReducer(state, EVENTS[event](state)).status).toBe(to);
  });

  it("ended absorbs every later event and returns the same state object", () => {
    const ended = states.ended;
    for (const make of Object.values(EVENTS)) expect(voiceReducer(ended, make(ended))).toBe(ended);
  });

  it("never mutates its input", () => {
    for (const state of Object.values(states)) {
      const frozen = Object.freeze({ ...state });
      for (const make of Object.values(EVENTS)) {
        expect(() => voiceReducer(frozen, make(frozen))).not.toThrow();
      }
    }
  });
});

describe("voiceReducer: lifecycle details", () => {
  it("enforces the consent gate: connect from idle does nothing", () => {
    const s = run([{ type: "connect" }]);
    expect(s).toEqual(initialVoiceState("push_to_talk"));
  });

  it("starts in the mode it is created with; live mode has no recording state", () => {
    const modes: VoiceMode[] = ["live", "push_to_talk"];
    for (const mode of modes) expect(initialVoiceState(mode)).toMatchObject({ mode, status: "idle" });
    expect(run([...OPEN, { type: "talk_start" }], initialVoiceState("live")).status).toBe("listening");
  });

  it("records the terminal close cause and clears live activity, keeping the session's counts", () => {
    const s = run([
      ...OPEN,
      { type: "exchange_count", used: 12, cap: 12 },
      { type: "turn_committed", turnNo: 12, version: 30 },
      { type: "utterance_start", utterance: 7 },
      { type: "playback", utterance: 7 },
      { type: "transcription", role: "subject", text: "Done.", partial: true },
      { type: "transcription", role: "investigator", text: "One more?", partial: false },
      { type: "transcription", role: "investigator", text: "And ", partial: true },
      { type: "warning", reason: "ending_soon", seconds: 60 },
      { type: "talk_start" },
      { type: "socket_closed", code: 4410, resumable: true },
    ]);
    expect(s).toMatchObject({
      status: "ended",
      connection: "ended",
      endedKey: "exchange_cap",
      openUtterance: null,
      questionOpen: false,
      questionLive: false,
      awaitingAnswer: false,
      investigatorSpeaking: false,
      audible: null,
      caption: null,
      talkHeld: false,
      endingSoon: false,
      exchanges: { used: 12, cap: 12 },
      committedTurn: { turnNo: 12, version: 30 },
    });
  });

  it("ends with the client's own key on a client-side end", () => {
    expect(run([...OPEN, { type: "ended", key: "error" }]).endedKey).toBe("error");
  });

  it("resumes at most three times per session with 500, 1000 and 2000 ms, then gives up", () => {
    const drop: VoiceEvent = { type: "socket_closed", code: 1006, resumable: true };
    let s = run(OPEN);
    const delays: (number | null)[] = [];
    for (let i = 0; i < 3; i += 1) {
      s = voiceReducer(s, drop);
      expect(s.status).toBe("reconnecting");
      delays.push(resumeDelayMs(s));
      // Reopening does not refill the budget: S5 7.2 caps resumes per session.
      s = voiceReducer(s, { type: "socket_open" });
      expect(resumeDelayMs(s)).toBeNull();
    }
    expect(delays).toEqual([...RESUME_BACKOFF_MS]);
    expect(RESUME_BACKOFF_MS).toEqual([500, 1000, 2000]);
    s = voiceReducer(s, drop);
    expect(s).toMatchObject({ status: "ended", endedKey: "transient_exhausted", resumeAttempts: 3 });
  });

  it("names the resume subprotocol the relay expects", () => {
    expect(RESUME_SUBPROTOCOL).toBe("voice-resume");
  });

  it("gives up when a resume attempt itself is refused (4503)", () => {
    const s = run([
      ...OPEN,
      { type: "socket_closed", code: 1011, resumable: true },
      { type: "socket_closed", code: 4503, resumable: true },
    ]);
    expect(s).toMatchObject({ status: "ended", endedKey: "resume_failed" });
  });

  it("treats any close after the server's ended frame as final, never as a resume", () => {
    const s = run([...OPEN, { type: "server_ended" }, { type: "socket_closed", code: 1006, resumable: true }]);
    expect(s).toMatchObject({ status: "ended", endedKey: "normal", resumeAttempts: 0 });
  });

  it("lets the close code refine the cause after the server's ended frame", () => {
    const s = run([...OPEN, { type: "server_ended" }, { type: "socket_closed", code: 4409, resumable: true }]);
    expect(s.endedKey).toBe("subject_guard");
  });

  it("shows an upstream resume as reconnecting until the server is active again; a timer tick does not count", () => {
    let s = run([...OPEN, { type: "warning", reason: "connection_lost_resume", seconds: null }]);
    expect(s.status).toBe("reconnecting");
    expect(resumeDelayMs(s)).toBeNull();
    s = voiceReducer(s, { type: "timer_tick", timeRemaining: 100 });
    expect(s.status).toBe("reconnecting");
    s = voiceReducer(s, { type: "utterance_start", utterance: 1 });
    expect(s).toMatchObject({ upstreamResuming: false, status: "thinking" });
  });

  it("clears an upstream resume on every kind of server activity", () => {
    const resumed = run([...OPEN, { type: "warning", reason: "connection_lost_resume", seconds: null }]);
    const activity: VoiceEvent[] = [
      { type: "utterance_start", utterance: 1 },
      { type: "transcription", role: "subject", text: "Yes.", partial: true },
      { type: "turn_committed", turnNo: 1, version: 1 },
      { type: "exchange_count", used: 1, cap: 12 },
    ];
    for (const event of activity) expect(voiceReducer(resumed, event).upstreamResuming).toBe(false);
    const speaking = run(
      [{ type: "utterance_start", utterance: 4 }, { type: "warning", reason: "connection_lost_resume", seconds: null }],
      run(OPEN),
    );
    expect(voiceReducer(speaking, { type: "utterance_end", utterance: 4 }).upstreamResuming).toBe(false);
    expect(voiceReducer(speaking, { type: "interrupted", utterance: 4 }).upstreamResuming).toBe(false);
    // The socket dropping and reopening also ends it.
    const reopened = run([{ type: "socket_closed", code: 1006, resumable: true }, { type: "socket_open" }], resumed);
    expect(reopened).toMatchObject({ upstreamResuming: false, status: "listening" });
  });

  it("keeps an unfinished utterance across a resume, so its continuation audio is attributed and played", () => {
    const dropped = run([
      ...OPEN,
      { type: "utterance_start", utterance: 2 },
      { type: "socket_closed", code: 1006, resumable: true },
    ]);
    // No socket while reconnecting: nothing can arrive to attribute.
    expect(audioUtterance(dropped)).toBeNull();
    const resumed = voiceReducer(dropped, { type: "socket_open" });
    expect(resumed).toMatchObject({ status: "thinking", openUtterance: 2, lastUtterance: 2 });
    expect(audioUtterance(resumed)).toBe(2);
    // The server may also re-announce the utterance it is continuing.
    const reannounced = voiceReducer(resumed, { type: "utterance_start", utterance: 2 });
    expect(audioUtterance(reannounced)).toBe(2);
    // Its continuation, once audible, shows the subject speaking again.
    expect(voiceReducer(reannounced, { type: "playback", utterance: 2 }).status).toBe("speaking");
  });

  it("refuses to reopen an utterance that ended or was interrupted before the drop", () => {
    const resume: VoiceEvent[] = [{ type: "socket_closed", code: 1006, resumable: true }, { type: "socket_open" }, { type: "utterance_start", utterance: 2 }];
    const ended = run([...OPEN, { type: "utterance_start", utterance: 2 }, { type: "utterance_end", utterance: 2 }, ...resume]);
    expect(audioUtterance(ended)).toBeNull();
    const cut = run([...OPEN, { type: "utterance_start", utterance: 2 }, { type: "interrupted", utterance: 2 }, ...resume]);
    expect(audioUtterance(cut)).toBeNull();
  });

  it("keeps a pending answer across a resume, but not an investigator partial whose stream restarted", () => {
    const awaiting = run([
      ...OPEN,
      { type: "transcription", role: "investigator", text: "Why?", partial: false },
      { type: "socket_closed", code: 1006, resumable: true },
      { type: "socket_open" },
    ]);
    expect(awaiting).toMatchObject({ status: "thinking", awaitingAnswer: true });
    const speaking = run([
      ...OPEN,
      { type: "transcription", role: "investigator", text: "So ", partial: true },
      { type: "socket_closed", code: 1006, resumable: true },
      { type: "socket_open" },
    ]);
    expect(speaking.investigatorSpeaking).toBe(false);
  });

  it("keeps a question's correlation across a resume: its late final does not wait for an answer it already got", () => {
    // Codex round 5: partial, its answer starts, the socket drops, then the question's final arrives.
    const answered = run([
      ...OPEN,
      { type: "transcription", role: "investigator", text: "Where were ", partial: true },
      { type: "utterance_start", utterance: 1 },
      { type: "socket_closed", code: 1006, resumable: true },
      { type: "socket_open" },
      { type: "transcription", role: "investigator", text: "you?", partial: false },
      { type: "utterance_end", utterance: 1 },
    ]);
    expect(answered).toMatchObject({ awaitingAnswer: false, investigatorSpeaking: false, status: "listening" });
    expect(voiceBarState({ voice: answered, captureAboveFloor: false })).toBe("listening");
  });

  it("shows the investigator speaking again once their question resumes after a drop", () => {
    const s = run([
      ...OPEN,
      { type: "transcription", role: "investigator", text: "So ", partial: true },
      { type: "socket_closed", code: 1006, resumable: true },
      { type: "socket_open" },
    ]);
    expect(s.investigatorSpeaking).toBe(false);
    const resumed = voiceReducer(s, { type: "transcription", role: "investigator", text: "then?", partial: true });
    expect(resumed.investigatorSpeaking).toBe(true);
    const done = voiceReducer(resumed, { type: "transcription", role: "investigator", text: "", partial: false });
    expect(done).toMatchObject({ investigatorSpeaking: false, awaitingAnswer: true, status: "thinking" });
  });

  it("keeps the timer, the ending-soon notice and the exchange count", () => {
    let s = run([...OPEN, { type: "timer_tick", timeRemaining: 90 }]);
    expect(s.timeRemaining).toBe(90);
    s = voiceReducer(s, { type: "warning", reason: "ending_soon", seconds: 60 });
    expect(s).toMatchObject({ endingSoon: true, timeRemaining: 60 });
    s = voiceReducer(s, { type: "warning", reason: "ending_soon", seconds: null });
    expect(s.timeRemaining).toBe(60);
    s = voiceReducer(s, { type: "exchange_count", used: 5, cap: 12 });
    expect(s.exchanges).toEqual({ used: 5, cap: 12 });
  });
});

describe("voiceReducer: utterances and server activity", () => {
  it("ignores a stale or repeated utterance_start and an utterance_end for another utterance", () => {
    let s = run([...OPEN, { type: "utterance_start", utterance: 5 }]);
    expect(voiceReducer(s, { type: "utterance_start", utterance: 5 })).toBe(s);
    expect(voiceReducer(s, { type: "utterance_start", utterance: 4 })).toBe(s);
    expect(voiceReducer(s, { type: "utterance_end", utterance: 4 })).toBe(s);
    s = voiceReducer(s, { type: "utterance_end", utterance: 5 });
    expect(s).toMatchObject({ openUtterance: null, lastUtterance: 5, status: "listening" });
  });

  it("stays speaking after utterance_end while audio is still queued, until the queue drains", () => {
    let s = run([...OPEN, { type: "utterance_start", utterance: 1 }, { type: "playback", utterance: 1 }]);
    s = voiceReducer(s, { type: "utterance_end", utterance: 1 });
    expect(s.status).toBe("speaking");
    s = voiceReducer(s, { type: "playback", utterance: null });
    expect(s.status).toBe("listening");
  });

  it("speaks only while audio is audible: start-up, an underrun and the recovery read as preparing, preparing, speaking", () => {
    let s = run([...OPEN, { type: "utterance_start", utterance: 1 }]);
    expect(s).toMatchObject({ status: "thinking", openUtterance: 1, audible: null });
    s = voiceReducer(s, { type: "playback", utterance: 1 });
    expect(s.status).toBe("speaking");
    s = voiceReducer(s, { type: "playback", utterance: null });
    expect(s.status).toBe("thinking");
    s = voiceReducer(s, { type: "playback", utterance: 1 });
    expect(s.status).toBe("speaking");
  });

  it("stops playback on interrupted, including for an utterance that already ended but is still playing", () => {
    let s = run([
      ...OPEN,
      { type: "utterance_start", utterance: 2 },
      { type: "playback", utterance: 2 },
      { type: "utterance_end", utterance: 2 },
    ]);
    expect(s.status).toBe("speaking");
    s = voiceReducer(s, { type: "interrupted", utterance: 2 });
    expect(s).toMatchObject({ status: "listening", audible: null, openUtterance: null });
    const stale = run([{ type: "utterance_start", utterance: 3 }], s);
    expect(voiceReducer(stale, { type: "interrupted", utterance: 2 })).toBe(stale);
  });

  it("ignores a playback report for flushed audio that arrives after interrupted", () => {
    const cut = run([
      ...OPEN,
      { type: "utterance_start", utterance: 1 },
      { type: "playback", utterance: 1 },
      { type: "utterance_end", utterance: 1 },
      { type: "utterance_start", utterance: 2 },
      { type: "interrupted", utterance: 2 },
    ]);
    expect(cut.status).toBe("listening");
    // Posted by the worklet before it processed the flush: neither utterance can still be playing.
    expect(voiceReducer(cut, { type: "playback", utterance: 2 })).toBe(cut);
    expect(voiceReducer(cut, { type: "playback", utterance: 1 })).toBe(cut);
    const next = run([{ type: "utterance_start", utterance: 3 }, { type: "playback", utterance: 3 }], cut);
    expect(next.status).toBe("speaking");
  });

  it("marks the investigator's turn ended on a final transcription, and speaking again on a partial", () => {
    let s = run([...OPEN, { type: "transcription", role: "investigator", text: "Who ", partial: true }]);
    expect(s).toMatchObject({ investigatorSpeaking: true, awaitingAnswer: false, status: "listening" });
    s = voiceReducer(s, { type: "transcription", role: "investigator", text: "called?", partial: false });
    expect(s).toMatchObject({ investigatorSpeaking: false, awaitingAnswer: true, status: "thinking" });
    s = voiceReducer(s, { type: "utterance_start", utterance: 1 });
    expect(s).toMatchObject({ awaitingAnswer: false, status: "thinking", openUtterance: 1 });
    s = voiceReducer(s, { type: "playback", utterance: 1 });
    expect(s.status).toBe("speaking");
  });

  it("a question asked over the subject's answer to an earlier question waits for its own answer", () => {
    const s = run([
      ...OPEN,
      { type: "transcription", role: "investigator", text: "Why?", partial: false },
      { type: "utterance_start", utterance: 1 },
      { type: "playback", utterance: 1 },
      { type: "transcription", role: "investigator", text: "Wait.", partial: false },
    ]);
    expect(s).toMatchObject({ awaitingAnswer: true, status: "speaking" });
  });

  it("reads a question transcribed entirely after its answer started as that answer's question", () => {
    // Codex round 6: every committed answer has a question (S5 7.4), so an utterance that started
    // with no completed question is answering one whose transcription is still to come.
    let s = run([
      ...OPEN,
      { type: "utterance_start", utterance: 1 },
      { type: "playback", utterance: 1 },
      { type: "transcription", role: "investigator", text: "Where were ", partial: true },
    ]);
    expect(s.investigatorSpeaking).toBe(false);
    s = run(
      [
        { type: "transcription", role: "investigator", text: "you?", partial: false },
        { type: "utterance_end", utterance: 1 },
        { type: "turn_committed", turnNo: 1, version: 1 },
        { type: "exchange_count", used: 1, cap: 12 },
        { type: "playback", utterance: null },
      ],
      s,
    );
    expect(s).toMatchObject({ awaitingAnswer: false, investigatorSpeaking: false, status: "listening" });
    expect(voiceBarState({ voice: s, captureAboveFloor: false })).toBe("listening");
    // The next question is new and waits for its own answer.
    s = voiceReducer(s, { type: "transcription", role: "investigator", text: "Alone?", partial: false });
    expect(s).toMatchObject({ awaitingAnswer: true, status: "thinking" });
  });

  it("answers a question asked before the previous answer's commit arrived", () => {
    // Round 2's ordering: the commit of turn 1 lands after question 2 is complete.
    const s = run([
      ...OPEN,
      { type: "transcription", role: "investigator", text: "Why?", partial: false },
      { type: "utterance_start", utterance: 1 },
      { type: "utterance_end", utterance: 1 },
      { type: "transcription", role: "investigator", text: "And then?", partial: false },
      { type: "turn_committed", turnNo: 1, version: 1 },
      { type: "exchange_count", used: 1, cap: 12 },
    ]);
    expect(s).toMatchObject({ awaitingAnswer: true, status: "thinking" });
  });

  it.each([
    ["a non-empty final", "you?"],
    ["an empty final", ""],
  ])("does not count a question twice when its commit arrives before %s", (_label, text) => {
    // Codex round 7: the commit already accounts for the question in progress; its final only closes it.
    let s = run([
      ...OPEN,
      { type: "transcription", role: "investigator", text: "Where were ", partial: true },
      { type: "utterance_start", utterance: 1 },
      { type: "playback", utterance: 1 },
      { type: "utterance_end", utterance: 1 },
      { type: "turn_committed", turnNo: 1, version: 1 },
      { type: "exchange_count", used: 1, cap: 12 },
    ]);
    expect(s.investigatorSpeaking).toBe(false);
    s = run([{ type: "transcription", role: "investigator", text, partial: false }, { type: "playback", utterance: null }], s);
    expect(s).toMatchObject({ awaitingAnswer: false, investigatorSpeaking: false, status: "listening" });
    expect(voiceBarState({ voice: s, captureAboveFloor: false })).toBe("listening");
    // The next real question still waits for its answer, and shows as spoken while in progress.
    s = voiceReducer(s, { type: "transcription", role: "investigator", text: "Alone?", partial: true });
    expect(s.investigatorSpeaking).toBe(true);
    s = voiceReducer(s, { type: "transcription", role: "investigator", text: "", partial: false });
    expect(s).toMatchObject({ awaitingAnswer: true, status: "thinking" });
  });

  it("keeps a counted question counted through a repeated exchange_count that reports no new commit", () => {
    const s = run([
      ...OPEN,
      { type: "transcription", role: "investigator", text: "Where were ", partial: true },
      { type: "utterance_start", utterance: 1 },
      { type: "utterance_end", utterance: 1 },
      { type: "exchange_count", used: 1, cap: 12 },
      { type: "exchange_count", used: 1, cap: 12 },
      { type: "transcription", role: "investigator", text: "you?", partial: false },
    ]);
    expect(s).toMatchObject({ awaitingAnswer: false, status: "listening" });
  });

  it("trusts a commit that counted a question in progress: the next late question is still read as late", () => {
    // Question 1's final follows its commit (counted while its partials were open, so certainly its
    // own); question 2's final then also follows its own commit.
    const s = run([
      ...OPEN,
      { type: "transcription", role: "investigator", text: "Where ", partial: true },
      { type: "utterance_start", utterance: 1 },
      { type: "utterance_end", utterance: 1 },
      { type: "exchange_count", used: 1, cap: 12 },
      { type: "transcription", role: "investigator", text: "were you?", partial: false },
      { type: "transcription", role: "investigator", text: "With ", partial: true },
      { type: "utterance_start", utterance: 2 },
      { type: "utterance_end", utterance: 2 },
      { type: "exchange_count", used: 2, cap: 12 },
      { type: "transcription", role: "investigator", text: "whom?", partial: false },
    ]);
    expect(s).toMatchObject({ awaitingAnswer: false, status: "listening" });
  });

  it("absorbs one late final per question two commits counted ahead, then waits for a new question again", () => {
    let s = run([
      ...OPEN,
      { type: "utterance_start", utterance: 1 },
      { type: "utterance_end", utterance: 1 },
      { type: "exchange_count", used: 1, cap: 12 },
      { type: "utterance_start", utterance: 2 },
      { type: "utterance_end", utterance: 2 },
      { type: "exchange_count", used: 2, cap: 12 },
      { type: "transcription", role: "investigator", text: "One?", partial: false },
      { type: "transcription", role: "investigator", text: "Two?", partial: false },
    ]);
    expect(s).toMatchObject({ awaitingAnswer: false, status: "listening", aheadCount: 0 });
    s = voiceReducer(s, { type: "transcription", role: "investigator", text: "Three?", partial: false });
    expect(s).toMatchObject({ awaitingAnswer: true, status: "thinking" });
  });

  it("never stops attributing audio to an open utterance on an inference: a lagging count leaves utterance 3 open", () => {
    // Codex round 10: counts lag two answers behind; the later count must not close utterance 3.
    const s = run([
      ...OPEN,
      { type: "transcription", role: "investigator", text: "One?", partial: false },
      { type: "utterance_start", utterance: 1 },
      { type: "utterance_end", utterance: 1 },
      { type: "transcription", role: "investigator", text: "Two?", partial: false },
      { type: "utterance_start", utterance: 2 },
      { type: "utterance_end", utterance: 2 },
      { type: "exchange_count", used: 1, cap: 12 },
      { type: "transcription", role: "investigator", text: "Three?", partial: false },
      { type: "utterance_start", utterance: 3 },
      { type: "exchange_count", used: 2, cap: 12 },
    ]);
    expect(s.openUtterance).toBe(3);
    expect(audioUtterance(s)).toBe(3);
    expect(voiceReducer(s, { type: "playback", utterance: 3 }).status).toBe("speaking");
  });

  it("reads consecutive late finals without a drop as late, never as lost", () => {
    // Codex round 10: no transport gap, so a question counted before its final is certainly late.
    const s = run([
      ...OPEN,
      { type: "utterance_start", utterance: 1 },
      { type: "utterance_end", utterance: 1 },
      { type: "exchange_count", used: 1, cap: 12 },
      { type: "transcription", role: "investigator", text: "One?", partial: false },
      { type: "transcription", role: "investigator", text: "Two ", partial: true },
      { type: "utterance_start", utterance: 2 },
      { type: "utterance_end", utterance: 2 },
      { type: "exchange_count", used: 2, cap: 12 },
      { type: "transcription", role: "investigator", text: "now?", partial: false },
    ]);
    expect(s).toMatchObject({ questionsDone: 2, answersStarted: 2, awaitingAnswer: false, status: "listening" });
  });

  it("trusts a question whose partials arrive on the new socket when a count after a drop counts it", () => {
    const s = run([
      ...OPEN,
      { type: "socket_closed", code: 1006, resumable: true },
      { type: "socket_open" },
      { type: "transcription", role: "investigator", text: "Where ", partial: true },
      { type: "utterance_start", utterance: 1 },
      { type: "utterance_end", utterance: 1 },
      { type: "exchange_count", used: 1, cap: 12 },
      { type: "transcription", role: "investigator", text: "were you?", partial: false },
      { type: "utterance_start", utterance: 2 },
      { type: "utterance_end", utterance: 2 },
      { type: "exchange_count", used: 2, cap: 12 },
      { type: "transcription", role: "investigator", text: "With whom?", partial: false },
    ]);
    expect(s).toMatchObject({ aheadCount: 0, aheadGuesses: 0, awaitingAnswer: false, status: "listening" });
  });

  it.each([
    ["its partials arrived before the drop", true],
    ["it was counted before the drop", false],
  ])("treats a counted question whose final was outstanding across a drop as possibly lost: %s", (_label, partialFirst) => {
    // Codex round 12: the final is lost in the drop; the next question's final is taken as it, and
    // the next commit corrects that, so only one pending answer is under-reported.
    const lead: VoiceEvent[] = partialFirst
      ? [
          { type: "transcription", role: "investigator", text: "Where ", partial: true },
          { type: "utterance_start", utterance: 1 },
          { type: "socket_closed", code: 1006, resumable: true },
          { type: "socket_open" },
          { type: "utterance_end", utterance: 1 },
          { type: "exchange_count", used: 1, cap: 12 },
        ]
      : [
          { type: "utterance_start", utterance: 1 },
          { type: "utterance_end", utterance: 1 },
          { type: "exchange_count", used: 1, cap: 12 },
          { type: "socket_closed", code: 1006, resumable: true },
          { type: "socket_open" },
        ];
    let s = run([...OPEN, ...lead, { type: "transcription", role: "investigator", text: "Q2?", partial: false }]);
    expect(s.status).toBe("listening");
    s = run([{ type: "utterance_start", utterance: 2 }, { type: "utterance_end", utterance: 2 }, { type: "exchange_count", used: 2, cap: 12 }], s);
    for (let n = 3; n <= 6; n += 1) {
      s = voiceReducer(s, { type: "transcription", role: "investigator", text: `Q${String(n)}?`, partial: false });
      expect(voiceBarState({ voice: s, captureAboveFloor: false })).toBe("preparing_answer");
      s = run([{ type: "utterance_start", utterance: n }, { type: "utterance_end", utterance: n }, { type: "exchange_count", used: n, cap: 12 }], s);
      expect(s).toMatchObject({ aheadCount: 0, status: "listening" });
    }
  });

  it("keeps an unused correction until a count can apply it, when the next question beats the count", () => {
    // Codex round 13: question 3's final arrives before count 2, so count 2 has nothing to correct
    // yet; the correction must survive to count 3 instead of being dropped.
    let s = run([
      ...OPEN,
      { type: "transcription", role: "investigator", text: "Where ", partial: true },
      { type: "utterance_start", utterance: 1 },
      { type: "socket_closed", code: 1006, resumable: true },
      { type: "socket_open" },
      { type: "utterance_end", utterance: 1 },
      { type: "exchange_count", used: 1, cap: 12 },
      { type: "transcription", role: "investigator", text: "Q2?", partial: false },
      { type: "utterance_start", utterance: 2 },
      { type: "utterance_end", utterance: 2 },
      { type: "transcription", role: "investigator", text: "Q3?", partial: false },
      { type: "exchange_count", used: 2, cap: 12 },
      { type: "utterance_start", utterance: 3 },
      { type: "utterance_end", utterance: 3 },
      { type: "exchange_count", used: 3, cap: 12 },
    ]);
    expect(s).toMatchObject({ aheadCount: 0, consumedGuesses: 0, status: "listening" });
    for (let n = 4; n <= 8; n += 1) {
      s = voiceReducer(s, { type: "transcription", role: "investigator", text: `Q${String(n)}?`, partial: false });
      expect(voiceBarState({ voice: s, captureAboveFloor: false })).toBe("preparing_answer");
      s = run([{ type: "utterance_start", utterance: n }, { type: "utterance_end", utterance: n }, { type: "exchange_count", used: n, cap: 12 }], s);
      expect(s).toMatchObject({ aheadCount: 0, status: "listening" });
    }
  });

  it("does not count an empty final with no question in progress as a question", () => {
    const s = run([...OPEN, { type: "transcription", role: "investigator", text: "", partial: false }]);
    expect(s).toMatchObject({ awaitingAnswer: false, status: "listening" });
  });

  it("keeps every observed answer and question through counts that lag, exchange after exchange", () => {
    // Codex round 11: counts lag two answers behind; later counts must not erase observed answers or
    // manufacture late-final credits that swallow new questions.
    let s = run([
      ...OPEN,
      { type: "transcription", role: "investigator", text: "One?", partial: false },
      { type: "utterance_start", utterance: 1 },
      { type: "utterance_end", utterance: 1 },
      { type: "transcription", role: "investigator", text: "Two?", partial: false },
      { type: "utterance_start", utterance: 2 },
      { type: "utterance_end", utterance: 2 },
      { type: "exchange_count", used: 1, cap: 12 },
      { type: "transcription", role: "investigator", text: "Three?", partial: false },
      { type: "utterance_start", utterance: 3 },
      { type: "exchange_count", used: 2, cap: 12 },
      { type: "utterance_end", utterance: 3 },
      { type: "exchange_count", used: 3, cap: 12 },
    ]);
    expect(s).toMatchObject({ questionsDone: 3, answersStarted: 3, aheadCount: 0, status: "listening" });
    for (let n = 4; n <= 7; n += 1) {
      s = voiceReducer(s, { type: "transcription", role: "investigator", text: `Q${String(n)}?`, partial: false });
      expect(voiceBarState({ voice: s, captureAboveFloor: false })).toBe("preparing_answer");
      s = run(
        [
          { type: "utterance_start", utterance: n },
          { type: "utterance_end", utterance: n },
          // The count for this exchange lags until after the next answer would have started.
        ],
        s,
      );
      expect(s.status).toBe("listening");
      s = voiceReducer(s, { type: "exchange_count", used: n, cap: 12 });
      expect(s).toMatchObject({ aheadCount: 0, status: "listening" });
    }
  });

  it("resynchronises at each commit when a question is lost entirely in a drop, healing by the next commit", () => {
    // The question of utterance 1 was transcribed while the socket was down; its commit arrives after.
    // Without relay correlation the next question's transcription cannot be told from utterance 1's
    // late one (S5 7.3 carries none; the round-9 regression above is the other reading), so it is
    // taken as the late one: the bar under-reports that one pending answer (listening, not
    // preparing) until the answer starts, and the following commit restores exact counts.
    let s = run([
      ...OPEN,
      { type: "socket_closed", code: 1006, resumable: true },
      { type: "socket_open" },
      { type: "utterance_start", utterance: 1 },
      { type: "utterance_end", utterance: 1 },
      { type: "turn_committed", turnNo: 1, version: 1 },
      { type: "exchange_count", used: 1, cap: 12 },
      { type: "transcription", role: "investigator", text: "Why?", partial: false },
    ]);
    expect(s).toMatchObject({ awaitingAnswer: false, status: "listening" });
    s = run(
      [
        { type: "utterance_start", utterance: 2 },
        { type: "utterance_end", utterance: 2 },
        { type: "turn_committed", turnNo: 2, version: 1 },
        { type: "exchange_count", used: 2, cap: 12 },
      ],
      s,
    );
    // The second commit corrects the misread question instead of expecting another late one, so the
    // very next question waits for its answer again.
    expect(s).toMatchObject({ questionsDone: 2, answersStarted: 2, aheadCount: 0, status: "listening" });
    s = run([{ type: "transcription", role: "investigator", text: "Next?", partial: false }], s);
    expect(s).toMatchObject({ awaitingAnswer: true, status: "thinking" });
  });

  it("counts commits against the trial's count when the session started, so a mid-trial session is not offset", () => {
    let s = run(
      [
      ...OPEN,
      { type: "transcription", role: "investigator", text: "Why?", partial: false },
      { type: "utterance_start", utterance: 1 },
      { type: "utterance_end", utterance: 1 },
      { type: "transcription", role: "investigator", text: "And?", partial: false },
      { type: "turn_committed", turnNo: 6, version: 1 },
      { type: "exchange_count", used: 6, cap: 12 },
      ],
      initialVoiceState("live", 5),
    );
    expect(s.awaitingAnswer).toBe(true);
    s = run([{ type: "exchange_count", used: 6, cap: 12 }], s);
    expect(s.awaitingAnswer).toBe(true);
  });

  it.each([0, 5])("reconciles from the absolute count when the first count was lost in a drop (%i exchanges before)", (before) => {
    // Codex round 8: exchange 1's count is lost while the socket is down; exchange 2's count reports both.
    const s = run(
      [
        ...OPEN,
        { type: "transcription", role: "investigator", text: "Why?", partial: false },
        { type: "utterance_start", utterance: 1 },
        { type: "utterance_end", utterance: 1 },
        { type: "turn_committed", turnNo: before + 1, version: 1 },
        { type: "socket_closed", code: 1006, resumable: true },
        { type: "socket_open" },
        { type: "transcription", role: "investigator", text: "And then?", partial: false },
        { type: "utterance_start", utterance: 2 },
        { type: "playback", utterance: 2 },
        { type: "utterance_end", utterance: 2 },
        { type: "turn_committed", turnNo: before + 2, version: 1 },
        { type: "exchange_count", used: before + 2, cap: 12 },
        { type: "playback", utterance: null },
      ],
      initialVoiceState("live", before),
    );
    expect(s).toMatchObject({ awaitingAnswer: false, status: "listening" });
    expect(voiceBarState({ voice: s, captureAboveFloor: false })).toBe("listening");
  });

  it("ignores an exchange count older than one already seen", () => {
    let s = run([
      ...OPEN,
      { type: "transcription", role: "investigator", text: "Why?", partial: false },
      { type: "utterance_start", utterance: 1 },
      { type: "utterance_end", utterance: 1 },
      { type: "exchange_count", used: 1, cap: 12 },
      { type: "transcription", role: "investigator", text: "And?", partial: false },
      { type: "utterance_start", utterance: 2 },
      { type: "utterance_end", utterance: 2 },
      { type: "exchange_count", used: 2, cap: 12 },
    ]);
    s = run([{ type: "exchange_count", used: 1, cap: 12 }, { type: "transcription", role: "investigator", text: "Next?", partial: false }], s);
    expect(s).toMatchObject({ awaitingAnswer: true, status: "thinking", exchanges: { used: 2, cap: 12 } });
  });

  it("leaves the whole state unchanged for a stale or repeated count, while a newer answer awaits its commit", () => {
    // Codex round 9: a stale count used to pull the started answers back below the open exchange.
    const s = run([
      ...OPEN,
      { type: "transcription", role: "investigator", text: "One?", partial: false },
      { type: "utterance_start", utterance: 1 },
      { type: "utterance_end", utterance: 1 },
      { type: "exchange_count", used: 1, cap: 12 },
      { type: "transcription", role: "investigator", text: "Two?", partial: false },
      { type: "utterance_start", utterance: 2 },
      { type: "utterance_end", utterance: 2 },
      { type: "exchange_count", used: 2, cap: 12 },
      { type: "transcription", role: "investigator", text: "Three?", partial: false },
      { type: "utterance_start", utterance: 3 },
      { type: "utterance_end", utterance: 3 },
    ]);
    expect(s.status).toBe("listening");
    expect(voiceReducer(s, { type: "exchange_count", used: 1, cap: 12 })).toBe(s);
    expect(voiceReducer(s, { type: "exchange_count", used: 2, cap: 12 })).toBe(s);
  });

  it("closes an utterance whose end marker was lost in a drop once its commit is counted", () => {
    // Codex round 9: every started answer committed, so none is still open.
    const s = run([
      ...OPEN,
      { type: "transcription", role: "investigator", text: "Why?", partial: false },
      { type: "utterance_start", utterance: 1 },
      { type: "socket_closed", code: 1006, resumable: true },
      { type: "socket_open" },
      { type: "turn_committed", turnNo: 1, version: 1 },
      { type: "exchange_count", used: 1, cap: 12 },
    ]);
    // The display reads it as finished; audio attribution changes only on utterance markers.
    expect(s).toMatchObject({ openUtterance: 1, settledUtterance: 1, awaitingAnswer: false, status: "listening" });
    expect(voiceBarState({ voice: s, captureAboveFloor: false })).toBe("listening");
    // A commit for an earlier answer leaves a newer open utterance open.
    const newer = run(
      [
        { type: "transcription", role: "investigator", text: "And?", partial: false },
        { type: "utterance_start", utterance: 2 },
        { type: "utterance_end", utterance: 2 },
        { type: "transcription", role: "investigator", text: "Then?", partial: false },
        { type: "utterance_start", utterance: 3 },
        { type: "exchange_count", used: 2, cap: 12 },
      ],
      s,
    );
    expect(newer).toMatchObject({ openUtterance: 3, settledUtterance: 1, status: "thinking" });
  });

  it("closes a question whose partials were lost with its late final, once a commit counted it", () => {
    // Codex round 9: resume, the answer starts and commits, then the question's final arrives alone.
    let s = run([
      ...OPEN,
      { type: "socket_closed", code: 1006, resumable: true },
      { type: "socket_open" },
      { type: "utterance_start", utterance: 1 },
      { type: "utterance_end", utterance: 1 },
      { type: "turn_committed", turnNo: 1, version: 1 },
      { type: "exchange_count", used: 1, cap: 12 },
      { type: "transcription", role: "investigator", text: "Where were you?", partial: false },
    ]);
    expect(s).toMatchObject({ awaitingAnswer: false, status: "listening" });
    // A genuinely new question afterwards still waits for its answer.
    s = run(
      [
        { type: "transcription", role: "investigator", text: "Alone?", partial: true },
        { type: "transcription", role: "investigator", text: "", partial: false },
      ],
      s,
    );
    expect(s).toMatchObject({ awaitingAnswer: true, status: "thinking" });
  });

  it("does not wait for an answer to a question the subject already answered, whatever order its final arrives in", () => {
    // Codex round 3, sequence 1: the question's final transcription arrives after its answer ended.
    const s = run([
      ...OPEN,
      { type: "transcription", role: "investigator", text: "Where were ", partial: true },
      { type: "utterance_start", utterance: 1 },
      { type: "playback", utterance: 1 },
      { type: "utterance_end", utterance: 1 },
      { type: "transcription", role: "investigator", text: "you?", partial: false },
      { type: "turn_committed", turnNo: 1, version: 1 },
      { type: "playback", utterance: null },
    ]);
    expect(s).toMatchObject({ awaitingAnswer: false, investigatorSpeaking: false, status: "listening" });
    expect(voiceBarState({ voice: s, captureAboveFloor: false })).toBe("listening");
  });

  it("keeps a question asked during the subject's answer pending through the interruption it causes", () => {
    // Codex round 3, sequence 2: the next question's final arrives while utterance 1 is still open.
    const s = run([
      ...OPEN,
      { type: "transcription", role: "investigator", text: "Why?", partial: false },
      { type: "utterance_start", utterance: 1 },
      { type: "playback", utterance: 1 },
      { type: "transcription", role: "investigator", text: "Stop there.", partial: false },
      { type: "interrupted", utterance: 1 },
    ]);
    expect(s).toMatchObject({ awaitingAnswer: true, status: "thinking" });
    expect(voiceBarState({ voice: s, captureAboveFloor: false })).toBe("preparing_answer");
  });

  it("treats delayed partials of an answered question as finished speech, not as the investigator speaking", () => {
    const s = run([
      ...OPEN,
      { type: "transcription", role: "investigator", text: "Where ", partial: true },
      { type: "utterance_start", utterance: 1 },
      { type: "transcription", role: "investigator", text: "were you?", partial: true },
    ]);
    expect(s).toMatchObject({ investigatorSpeaking: false, awaitingAnswer: false, status: "thinking" });
    expect(voiceBarState({ voice: s, captureAboveFloor: false })).toBe("preparing_answer");
  });

  it("answers every completed question with the next utterance, and only those", () => {
    let s = run([
      ...OPEN,
      { type: "transcription", role: "investigator", text: "First?", partial: false },
      { type: "transcription", role: "investigator", text: "And second?", partial: false },
    ]);
    expect(s.awaitingAnswer).toBe(true);
    s = voiceReducer(s, { type: "utterance_start", utterance: 1 });
    expect(s.awaitingAnswer).toBe(false);
    s = run([{ type: "transcription", role: "investigator", text: "Third ", partial: true }], s);
    s = run([{ type: "utterance_end", utterance: 1 }, { type: "transcription", role: "investigator", text: "one?", partial: false }], s);
    expect(s).toMatchObject({ awaitingAnswer: true, status: "thinking" });
  });

  it("keeps the newest committed turn and ignores an older one", () => {
    let s = run([...OPEN, { type: "turn_committed", turnNo: 3, version: 7 }]);
    s = voiceReducer(s, { type: "turn_committed", turnNo: 2, version: 5 });
    expect(s.committedTurn).toEqual({ turnNo: 3, version: 7 });
    s = voiceReducer(s, { type: "turn_committed", turnNo: 4, version: 9 });
    expect(s.committedTurn).toEqual({ turnNo: 4, version: 9 });
    s = voiceReducer(s, { type: "turn_committed", turnNo: 4, version: 10 });
    expect(s.committedTurn).toEqual({ turnNo: 4, version: 10 });
    s = voiceReducer(s, { type: "turn_committed", turnNo: 4, version: 8 });
    expect(s.committedTurn).toEqual({ turnNo: 4, version: 10 });
  });
});

describe("voiceReducer: FE-VOICE-3, one live caption line", () => {
  it("merges one subject utterance's fragments into one caption line", () => {
    const s = run([
      ...OPEN,
      { type: "utterance_start", utterance: 1 },
      { type: "transcription", role: "subject", text: "I was ", partial: true },
      { type: "transcription", role: "subject", text: "at the ", partial: true },
      { type: "transcription", role: "subject", text: "depot.", partial: false },
    ]);
    expect(s.caption).toEqual({ role: "subject", text: "I was at the depot." });
  });

  it("replaces the line on a role change and ignores empty fragments", () => {
    let s = run([...OPEN, { type: "transcription", role: "investigator", text: "Where?", partial: true }]);
    s = voiceReducer(s, { type: "transcription", role: "subject", text: "", partial: true });
    expect(s.caption).toEqual({ role: "investigator", text: "Where?" });
    s = voiceReducer(s, { type: "transcription", role: "subject", text: "Home.", partial: true });
    expect(s.caption).toEqual({ role: "subject", text: "Home." });
  });

  it("keeps fragments that arrive before their utterance_start", () => {
    const s = run([
      ...OPEN,
      { type: "transcription", role: "subject", text: "I was ", partial: true },
      { type: "utterance_start", utterance: 1 },
      { type: "transcription", role: "subject", text: "at home.", partial: false },
    ]);
    expect(s.caption).toEqual({ role: "subject", text: "I was at home." });
  });

  it("keeps fragments that arrive after their utterance ended, or after the next one started", () => {
    let s = run([
      ...OPEN,
      { type: "utterance_start", utterance: 1 },
      { type: "transcription", role: "subject", text: "I left ", partial: true },
      { type: "utterance_end", utterance: 1 },
      { type: "transcription", role: "subject", text: "early. ", partial: false },
    ]);
    expect(s.caption).toEqual({ role: "subject", text: "I left early. " });
    // A late fragment of utterance 2's speech, before its final, still joins its own line.
    s = run(
      [
        { type: "utterance_start", utterance: 2 },
        { type: "transcription", role: "subject", text: "Then ", partial: true },
        { type: "utterance_end", utterance: 2 },
        { type: "utterance_start", utterance: 3 },
        { type: "transcription", role: "subject", text: "home.", partial: true },
      ],
      s,
    );
    expect(s.caption).toEqual({ role: "subject", text: "Then home." });
    s = run([{ type: "interrupted", utterance: 3 }], s);
    expect(s.caption).toEqual({ role: "subject", text: "Then home." });
  });

  it("keeps each speaker's fragments together when the other speaker's text arrives in between", () => {
    // Codex round 4: a delayed investigator final lands inside the subject's answer.
    let s = run([
      ...OPEN,
      { type: "transcription", role: "subject", text: "I was ", partial: true },
      { type: "transcription", role: "investigator", text: "you?", partial: false },
    ]);
    expect(s.caption).toEqual({ role: "investigator", text: "you?" });
    s = voiceReducer(s, { type: "transcription", role: "subject", text: "at home.", partial: false });
    expect(s.caption).toEqual({ role: "subject", text: "I was at home." });
    // And the investigator's next words do not join a question that already ended.
    s = voiceReducer(s, { type: "transcription", role: "investigator", text: "When?", partial: true });
    expect(s.caption).toEqual({ role: "investigator", text: "When?" });
  });

  it("ends a speaker's line at their final: their next fragment starts a new line", () => {
    const s = run([
      ...OPEN,
      { type: "transcription", role: "subject", text: "One.", partial: false },
      { type: "transcription", role: "subject", text: "Two.", partial: true },
    ]);
    expect(s.caption).toEqual({ role: "subject", text: "Two." });
  });

  it("lets an empty final end the line without changing what it shows", () => {
    let s = run([
      ...OPEN,
      { type: "transcription", role: "subject", text: "Yes", partial: true },
      { type: "transcription", role: "subject", text: "", partial: false },
    ]);
    expect(s.caption).toEqual({ role: "subject", text: "Yes" });
    s = voiceReducer(s, { type: "transcription", role: "subject", text: "No", partial: true });
    expect(s.caption).toEqual({ role: "subject", text: "No" });
  });

  it("keeps the last speech through the commit; the next speaker replaces it", () => {
    let s = run([
      ...OPEN,
      { type: "transcription", role: "subject", text: "No.", partial: false },
      { type: "turn_committed", turnNo: 1, version: 1 },
    ]);
    expect(s.caption).toEqual({ role: "subject", text: "No." });
    s = voiceReducer(s, { type: "transcription", role: "investigator", text: "Why not?", partial: true });
    expect(s.caption).toEqual({ role: "investigator", text: "Why not?" });
  });

  it("keeps the investigator's next question, caption and activity, when the previous turn commits under it", () => {
    const answered = run([
      ...OPEN,
      { type: "transcription", role: "investigator", text: "Were you there?", partial: false },
      { type: "utterance_start", utterance: 1 },
      { type: "transcription", role: "subject", text: "No.", partial: false },
      { type: "utterance_end", utterance: 1 },
    ]);
    const partial = run([{ type: "transcription", role: "investigator", text: "Then why ", partial: true }], answered);
    const committedUnderPartial = voiceReducer(partial, { type: "turn_committed", turnNo: 1, version: 1 });
    expect(committedUnderPartial).toMatchObject({ investigatorSpeaking: true, caption: { role: "investigator", text: "Then why " } });
    expect(voiceBarState({ voice: committedUnderPartial, captureAboveFloor: false })).toBe("investigator_speaking");
    const final = run([{ type: "transcription", role: "investigator", text: "did you go?", partial: false }], partial);
    const committedUnderFinal = voiceReducer(final, { type: "turn_committed", turnNo: 1, version: 1 });
    expect(committedUnderFinal).toMatchObject({ awaitingAnswer: true, status: "thinking" });
    expect(voiceBarState({ voice: committedUnderFinal, captureAboveFloor: false })).toBe("preparing_answer");
    expect(committedUnderFinal.caption).toEqual({ role: "investigator", text: "Then why did you go?" });
  });

  it("keeps the caption across a resume, so the same speech continues the line; the end of the session clears it", () => {
    let s = run([
      ...OPEN,
      { type: "transcription", role: "subject", text: "I was ", partial: true },
      { type: "socket_closed", code: 1006, resumable: true },
    ]);
    expect(s.caption).toEqual({ role: "subject", text: "I was " });
    s = run([{ type: "socket_open" }, { type: "transcription", role: "subject", text: "at home.", partial: true }], s);
    expect(s.caption).toEqual({ role: "subject", text: "I was at home." });
    s = voiceReducer(s, { type: "socket_closed", code: 1000, resumable: false });
    expect(s.caption).toBeNull();
  });

  it("continues the line with a fragment that arrives after its turn committed", () => {
    const s = run([
      ...OPEN,
      { type: "transcription", role: "subject", text: "Yes", partial: true },
      { type: "turn_committed", turnNo: 1, version: 1 },
      { type: "transcription", role: "subject", text: ", really.", partial: false },
    ]);
    expect(s.caption).toEqual({ role: "subject", text: "Yes, really." });
  });

  it("caps a merged caption at the S5 limit, keeping the newest text", () => {
    let s = run([...OPEN, { type: "utterance_start", utterance: 1 }]);
    for (let i = 0; i < 6; i += 1) {
      s = voiceReducer(s, { type: "transcription", role: "subject", text: `${String(i)}${"y".repeat(99)}`, partial: true });
    }
    expect(s.caption?.text).toHaveLength(MAX_CAPTION_CHARS);
    expect(s.caption?.text.endsWith(`5${"y".repeat(99)}`)).toBe(true);
  });

  it("counts the caption limit in code points, as the server does, and never splits a character", () => {
    const astral = "\u{1F600}";
    expect(frameToEvent({ type: "transcription", role: "subject", text: astral.repeat(MAX_CAPTION_CHARS), partial: true })).not.toBeNull();
    let s = run([...OPEN, { type: "utterance_start", utterance: 1 }]);
    s = voiceReducer(s, { type: "transcription", role: "subject", text: astral.repeat(MAX_CAPTION_CHARS), partial: true });
    s = voiceReducer(s, { type: "transcription", role: "subject", text: "z", partial: true });
    expect(Array.from(s.caption?.text ?? "")).toHaveLength(MAX_CAPTION_CHARS);
    expect(s.caption?.text.startsWith(astral)).toBe(true);
    expect(s.caption?.text.endsWith("z")).toBe(true);
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
  it("attributes audio to the open utterance and drops it otherwise", () => {
    const open = run([...OPEN, { type: "utterance_start", utterance: 4 }]);
    expect(audioUtterance(open)).toBe(4);
    expect(audioUtterance(voiceReducer(open, { type: "interrupted", utterance: 4 }))).toBeNull();
    expect(audioUtterance(voiceReducer(open, { type: "utterance_end", utterance: 4 }))).toBeNull();
    expect(audioUtterance(run(OPEN))).toBeNull();
    const dropped = voiceReducer(open, { type: "socket_closed", code: 1006, resumable: true });
    expect(audioUtterance(dropped)).toBeNull();
  });
});

describe("voiceBarState: FE-VOICE-6, connection x capture x server activity x playback", () => {
  const open = run(OPEN, initialVoiceState("live"));
  const ptt = run(OPEN);
  const rows: [string, VoiceState, boolean, string][] = [
    ["idle", initialVoiceState("live"), false, "hidden"],
    ["consent", run([{ type: "open_consent" }]), true, "hidden"],
    ["connecting", run([{ type: "open_consent" }, { type: "connect" }]), true, "connecting"],
    ["reconnecting", run([{ type: "socket_closed", code: 1006, resumable: true }], open), false, "connecting"],
    ["upstream resuming", run([{ type: "warning", reason: "connection_lost_resume", seconds: null }], open), true, "connecting"],
    ["open, quiet, nothing pending", open, false, "listening"],
    ["open, capture above the floor", open, true, "investigator_speaking"],
    ["open, investigator partial transcription, capture below", run([{ type: "transcription", role: "investigator", text: "So", partial: true }], open), false, "investigator_speaking"],
    ["turn ended, no utterance yet, capture below", run([{ type: "transcription", role: "investigator", text: "Why?", partial: false }], open), false, "preparing_answer"],
    ["turn ended, capture above again", run([{ type: "transcription", role: "investigator", text: "Why?", partial: false }], open), true, "investigator_speaking"],
    ["utterance open, playback not started", run([{ type: "utterance_start", utterance: 1 }], open), false, "preparing_answer"],
    ["utterance open, playback not started, investigator talking", run([{ type: "utterance_start", utterance: 1 }], open), true, "investigator_speaking"],
    ["utterance open and audible", run([{ type: "utterance_start", utterance: 1 }, { type: "playback", utterance: 1 }], open), false, "subject_speaking"],
    ["utterance open, investigator talking over it", run([{ type: "utterance_start", utterance: 1 }, { type: "playback", utterance: 1 }], open), true, "subject_speaking"],
    ["utterance open, playback underrun", run([{ type: "utterance_start", utterance: 1 }, { type: "playback", utterance: 1 }, { type: "playback", utterance: null }], open), false, "preparing_answer"],
    ["utterance ended, audio still queued", run([{ type: "utterance_start", utterance: 1 }, { type: "playback", utterance: 1 }, { type: "utterance_end", utterance: 1 }], open), false, "subject_speaking"],
    ["utterance ended, queue drained", run([{ type: "utterance_start", utterance: 1 }, { type: "playback", utterance: 1 }, { type: "utterance_end", utterance: 1 }, { type: "playback", utterance: null }], open), false, "listening"],
    ["interrupted, then a stale playback report", run([{ type: "utterance_start", utterance: 1 }, { type: "playback", utterance: 1 }, { type: "interrupted", utterance: 1 }, { type: "playback", utterance: 1 }], open), false, "listening"],
    ["push-to-talk held, silent", run([{ type: "talk_start" }], ptt), false, "recording"],
    ["push-to-talk released", run([{ type: "talk_start" }, { type: "talk_end" }], ptt), false, "listening"],
    ["ended", run([{ type: "socket_closed", code: 1000, resumable: false }], open), true, "ended"],
  ];
  it.each(rows)("%s", (_label, voice, captureAboveFloor, bar) => {
    expect(voiceBarState({ voice, captureAboveFloor })).toBe(bar);
  });
});

describe("talkLevel and inputLevel: one amplitude from the playback node", () => {
  const still = { reducedMotion: false, paused: false };
  const playing = run([...OPEN, { type: "utterance_start", utterance: 1 }, { type: "playback", utterance: 1 }]);

  it("passes the playback level through only while audio is actually playing", () => {
    expect(talkLevel(playing, 0.6, still)).toBe(0.6);
    expect(talkLevel(run([{ type: "playback", utterance: null }], playing), 0.6, still)).toBe(0);
    expect(talkLevel(run([...OPEN, { type: "utterance_start", utterance: 1 }]), 0.6, still)).toBe(0);
    expect(talkLevel(run(OPEN), 0.6, still)).toBe(0);
  });

  it("drops to 0 on the interrupted event itself, before the analyser decays", () => {
    const interrupted = voiceReducer(playing, { type: "interrupted", utterance: 1 });
    expect(talkLevel(interrupted, 0.9, still)).toBe(0);
    // A playback report the worklet posted before it flushed does not bring the mouth back.
    expect(talkLevel(voiceReducer(interrupted, { type: "playback", utterance: 1 }), 0.9, still)).toBe(0);
  });

  it("stays still under reduced motion or the pause control", () => {
    expect(talkLevel(playing, 0.6, { reducedMotion: true, paused: false })).toBe(0);
    expect(talkLevel(playing, 0.6, { reducedMotion: false, paused: true })).toBe(0);
  });

  it("clamps to 0-1 and reads a non-finite level as silence", () => {
    expect([1.7, -0.2, Number.NaN, Number.POSITIVE_INFINITY].map((l) => talkLevel(playing, l, still))).toEqual([1, 0, 0, 0]);
  });

  it("shows the investigator's own level only above the floor, while the mic is live", () => {
    const live = run(OPEN);
    expect(inputLevel(live, 0.4, 0.05, still)).toBe(0.4);
    expect(inputLevel(live, 0.05, 0.05, still)).toBe(0);
    expect(inputLevel(live, 0.4, 0.05, { reducedMotion: true, paused: false })).toBe(0);
    expect(inputLevel(live, 0.4, 0.05, { reducedMotion: false, paused: true })).toBe(0);
    expect(inputLevel(initialVoiceState("live"), 0.4, 0.05, still)).toBe(0);
    expect(inputLevel(run([{ type: "socket_closed", code: 1000, resumable: false }], live), 0.4, 0.05, still)).toBe(0);
    expect(inputLevel(run([{ type: "open_consent" }, { type: "connect" }]), 0.4, 0.05, still)).toBe(0.4);
    expect(inputLevel(live, 3, 0.05, still)).toBe(1);
  });
});

describe("resumeDelayMs", () => {
  it("is null unless a client resume is pending, including for a malformed state", () => {
    expect(resumeDelayMs(run(OPEN))).toBeNull();
    const reconnecting = run([...OPEN, { type: "socket_closed", code: 1006, resumable: true }]);
    expect(resumeDelayMs(reconnecting)).toBe(500);
    expect(resumeDelayMs({ ...reconnecting, resumeAttempts: 9 })).toBeNull();
  });
});
