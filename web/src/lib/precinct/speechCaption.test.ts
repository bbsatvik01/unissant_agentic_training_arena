import { describe, expect, it } from "vitest";
import { initialVoiceState, type VoiceState } from "../voice/voiceMachine";
import type { SpokenCaption } from "../voice/speechCaption";
import { precinctSpeechCaption } from "./speechCaption";
const spoken: SpokenCaption = { identity: {}, role: "coach", speaker: "Coach · Follow-up desk", text: "Try asking: Which record?" };
const base = { active: true, assessment: false, spoken, voice: null, subjectName: "Jordan Pell" };
const voice = (patch: Partial<VoiceState> = {}) => ({ state: { ...initialVoiceState("live"), connection: "open" as const, ...patch }, captureAboveFloor: false });

describe("public precinct speech projection", () => {
  it("uses only the actual queued caption and labels synthesized playback honestly", () => {
    expect(precinctSpeechCaption(base)).toEqual({ role: spoken.role, speaker: spoken.speaker, text: spoken.text, label: "Read-aloud · synthesized speech" });
    expect(precinctSpeechCaption({ ...base, spoken: null })).toBeNull();
    expect(precinctSpeechCaption({ ...base, active: false })).toBeNull();
    expect(precinctSpeechCaption({ ...base, assessment: true })).toBeNull();
    expect(precinctSpeechCaption({ ...base, assessment: true, spoken: { ...spoken, role: "subject" } })).not.toBeNull();
  });
  it("shows exact partial public text in arrival order without pairing it to the audible speaker", () => {
    const state = voice({ audible: 4, captions: [{ role: "subject", text: "Earlier subject words.", done: true }, { role: "investigator", text: "Which receipt <not markup>", done: false }] });
    expect(precinctSpeechCaption({ ...base, voice: state })).toEqual({ role: "investigator", speaker: "You · trainee", text: "Which receipt <not markup>", label: "Live transcript · partial · timing may differ from audio" });
    expect(precinctSpeechCaption({ ...base, voice: voice({ captions: [{ role: "subject", text: "The public answer.", done: true }] }) })?.label).toBe("Live transcript · timing may differ from audio");
  });
  it("uses honest activity-only fallback with no old stored answer, ellipsis, or invented transcript", () => {
    const live = voice({ audible: 3, transcript: [{ exchangeNo: 1, lines: [{ role: "subject", text: "Old stored answer must not be guessed.", partial: false }] }] });
    expect(precinctSpeechCaption({ ...base, voice: live })?.text).toBe("Audio is playing. Transcript text is not available yet.");
    expect(precinctSpeechCaption({ ...base, voice: { ...voice(), captureAboveFloor: true } })?.text).toBe("Microphone activity. Transcript text is not available yet.");
    expect(precinctSpeechCaption({ ...base, voice: voice({ investigatorActive: true }) })?.speaker).toBe("You · trainee");
    expect(precinctSpeechCaption({ ...base, voice: voice({ captions: [{ role: "subject", text: "  ", done: false }] }) })).toBeNull();
  });
  it("clears on pause, room leave, terminal/error state; draining captions stay only while audio remains", () => {
    const live = voice({ audible: 2, captions: [{ role: "subject", text: "Public words", done: false }] });
    expect(precinctSpeechCaption({ ...base, active: false, voice: live })).toBeNull();
    for (const connection of ["idle", "consent", "connecting", "ended"] as const) expect(precinctSpeechCaption({ ...base, voice: voice({ ...live.state, connection }) })).toBeNull();
    expect(precinctSpeechCaption({ ...base, voice: voice({ connection: "draining", audible: 2 }) })?.speaker).toBe("Jordan Pell");
    expect(precinctSpeechCaption({ ...base, voice: voice({ connection: "draining", investigatorActive: true }) })).toBeNull();
  });
});
