import { describe, expect, it } from "vitest";

import { CAPTURE_FLOOR, CaptureEdges, HANGOVER_MS, liveVoiceView, voiceShownCount, withLiveVoice } from "./liveWorld";
import { initialVoiceState, voiceReducer, type VoiceEvent, type VoiceState } from "./voiceMachine";
import type { WorldState } from "../world/worldState";

const WORLD: WorldState = {
  status: "awaiting_question",
  mode: "practice",
  subject: { pose: "idle", speech: null },
  investigator: { speech: null },
  coaches: [],
  wall: [],
  flag: null,
  pet: "idle",
  seal: null,
  debriefReady: false,
  shot: "room",
  caption: "Waiting for the next question.",
  exchanges: { used: 0, cap: 12 },
} as unknown as WorldState;

function fold(events: readonly VoiceEvent[]): VoiceState {
  return events.reduce(voiceReducer, initialVoiceState("live"));
}

const OPEN: VoiceEvent[] = [{ type: "open_consent" }, { type: "connect" }, { type: "socket_open" }];

describe("liveWorld", () => {
  it("shows the subject speaking while its audio is audible, with a close shot and its caption", () => {
    const voice = fold([...OPEN, { type: "utterance_start", utterance: 1 }, { type: "transcription", role: "subject", text: "I was in", partial: true }, { type: "playback", utterance: 1 }]);
    const world = withLiveVoice(WORLD, liveVoiceView(voice, false), "Jordan");
    expect(world.subject.pose).toBe("speaking");
    expect(world.subject.speech?.text).toBe("I was in");
    expect(world.shot).toBe("subject_close");
    expect(world.caption).toBe("Jordan is answering.");
  });

  it("shows the investigator speaking from the microphone, then the subject about to answer", () => {
    const speaking = fold([...OPEN, { type: "investigator_audio" }]);
    const w1 = withLiveVoice(WORLD, liveVoiceView(speaking, true), "Jordan");
    expect(w1.investigator.speech?.text).toBe("...");
    expect(w1.shot).toBe("over_shoulder");
    expect(w1.caption).toBe("You are speaking.");
    const waiting = voiceReducer(speaking, { type: "investigator_silence" });
    const w2 = withLiveVoice(WORLD, liveVoiceView(waiting, false), "Jordan");
    expect(w2.subject.pose).toBe("thinking");
    expect(w2.caption).toBe("Jordan is about to answer.");
    const idle = withLiveVoice(WORLD, liveVoiceView(fold(OPEN), false), "Jordan");
    expect(idle.caption).toBe("Jordan is listening.");
  });

  it("leaves an ended world alone and shows nobody talking before the socket opens", () => {
    const ended = { ...WORLD, status: "ended" } as WorldState;
    expect(withLiveVoice(ended, liveVoiceView(fold(OPEN), true), "J")).toBe(ended);
    const view = liveVoiceView(initialVoiceState("live"), true);
    expect(view).toMatchObject({ subject: null, investigatorSpeaking: false });
  });

  it("turns the microphone level into capture edges with a hangover", () => {
    const edges = new CaptureEdges();
    expect(edges.next(0, 0)).toBe(null);
    expect(edges.next(CAPTURE_FLOOR * 2, 10)).toEqual({ type: "investigator_audio" });
    expect(edges.active).toBe(true);
    expect(edges.next(CAPTURE_FLOOR * 2, 20)).toBe(null);
    expect(edges.next(0, 100)).toBe(null);
    expect(edges.next(0, 100 + HANGOVER_MS - 1)).toBe(null);
    expect(edges.next(0, 100 + HANGOVER_MS)).toEqual({ type: "investigator_silence" });
    expect(edges.active).toBe(false);
  });

  it("counts the exchange whose answer is being spoken, up to the cap", () => {
    const counted = fold([...OPEN, { type: "exchange_count", used: 2, cap: 12 }]);
    expect(voiceShownCount(counted, 0)).toBe(2);
    expect(voiceShownCount(voiceReducer(counted, { type: "utterance_start", utterance: 1 }), 0)).toBe(3);
    expect(voiceShownCount(initialVoiceState("live"), 5)).toBe(5);
    const full = fold([...OPEN, { type: "exchange_count", used: 12, cap: 12 }, { type: "utterance_start", utterance: 1 }]);
    expect(voiceShownCount(full, 0)).toBe(12);
  });
});
