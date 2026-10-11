/**
 * The world's state (D-020) from the reducer view and the session clock, played over the F01 recording and over
 * built logs: who speaks when, what the observation room does, when the signature moments fire, and the rules
 * that keep the subject's pose free of content (PRB-4) and coaching out of assessment (S6 5.4).
 */
import { describe, expect, it } from "vitest";

import raw from "../../fixtures/recordings/F01-truthful.json";
import { LogBuilder, snapshot } from "../../test/trial-log";
import type { TrialFrame } from "../contracts/generated/types";
import { initialTrialState, trialReducer, type TrialView } from "../trial/trialReducer";
import { speechDurationMs } from "./cadence";
import { parseRecording } from "./parseRecording";
import { noteArrival, seek, startCursor, type Recording } from "./recording";
import { deriveWorld, EVIDENCE_MS, FLAG_MS, HAND_MS, SEAL_MS, type WorldInput, type WorldState } from "./worldState";

function load(): Recording {
  const result = parseRecording(structuredClone(raw));
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.recording;
}

const REC = load();

function at(t: number, extra: Partial<WorldInput> = {}): WorldState {
  const cursor = seek(REC, startCursor(REC), t);
  const world = deriveWorld({
    view: cursor.state.view,
    nowMs: t,
    arrivals: cursor.arrivals,
    subjectName: "Jordan Pell",
    investigatorActive: false,
    reducedMotion: false,
    paused: false,
    ...extra,
  });
  if (world === null) throw new Error("no world");
  return world;
}

function when(type: string, pick: (frame: TrialFrame) => boolean = () => true): number {
  const event = REC.events.find((e) => e.frame.type === type && pick(e.frame));
  if (event === undefined) throw new Error(`no ${type}`);
  return event.at_ms;
}

const turn = (n: number) => (f: TrialFrame) => "turn_no" in f.data && f.data.turn_no === n;

/** A world from a built log, every frame arriving at its index x 1000 ms. */
function fromLog(log: LogBuilder, mode: "practice" | "assessment", nowMs: number): WorldState | null {
  let state = trialReducer(initialTrialState(), { type: "snapshot", snapshot: snapshot({ mode }) });
  let arrivals: ReadonlyMap<string, number> = new Map([["snapshot", 0]]);
  log.frames.forEach((frame, i) => {
    state = trialReducer(state, { type: "frame", frame });
    arrivals = noteArrival(arrivals, frame, (i + 1) * 1000);
  });
  return deriveWorld({ view: state.view, nowMs, arrivals, subjectName: "S", investigatorActive: false, reducedMotion: false, paused: false });
}

describe("deriveWorld", () => {
  it("is null before the snapshot", () => {
    expect(deriveWorld({ view: null, nowMs: 0, arrivals: new Map(), subjectName: "S", investigatorActive: false, reducedMotion: false, paused: false })).toBe(null);
  });

  it("opens on an idle subject, an idle observation room and a celebrating companion (session ready)", () => {
    const w = at(10);
    expect(w.subject.pose).toBe("idle");
    expect(w.coaches.map((c) => c.pose)).toEqual(["idle", "idle", "idle"]);
    expect(w.pet.state).toBe("celebrating");
    expect(w.shot).toBe("room");
    expect(w.caption).toBe("Waiting for the next question.");
    expect(w.exchanges).toEqual({ used: 0, cap: 12 });
  });

  it("has the subject listen while the question is spoken, then prepare, then speak the answer at reading pace", () => {
    const q = when("question.accepted", turn(2));
    const a = when("subject.answer", turn(2));
    expect(at(q + 100).subject.pose).toBe("listening");
    expect(at(q + 100).investigator.speech?.turn).toBe(2);
    expect(at(a - 50).subject.pose).toBe("thinking");
    expect(at(a - 50).caption).toBe("Jordan Pell is preparing an answer.");
    const speaking = at(a + 100);
    expect(speaking.subject.pose).toBe("speaking");
    expect(speaking.subject.speech).toMatchObject({ turn: 2, startedAt: a });
    expect(speaking.caption).toBe("Jordan Pell is answering. Coach is reading the answer.");
    expect(at(a + 600).caption).toBe("Jordan Pell is answering. Coach is reading T2.");
    const text = speaking.subject.speech?.text ?? "";
    expect(at(a + speechDurationMs(text) + 10).subject.speech).toBe(null);
  });

  it("puts the observation room to work between the answer and the card, then hands the card over", () => {
    const working = when("coach.working", turn(3));
    const card = when("coach.card", turn(3));
    const w = at(working + 50);
    expect(w.status).toBe("coach_working");
    expect(w.coaches.map((c) => c.pose)).toEqual(["typing", "thinking", "typing"]);
    expect(w.pet.state).toBe("thinking");
    expect(w.caption).toMatch(/Coach is reading T3\.$/);
    expect(at(card + 10).coaches.every((c) => c.pose === "handing")).toBe(true);
    expect(at(card + HAND_MS + 10).coaches.every((c) => c.pose === "handing")).toBe(false);
  });

  it("has the companion notice a card with a flag and nod at a well-formed question, each for one window", () => {
    const flagged = when("coach.card", turn(1));
    expect(at(flagged + 100).pet.state).toBe("noticing");
    const nod = when("coach.card", turn(2));
    expect(at(nod + 100).pet.state).toBe("encouraging");
    expect(at(nod + 1700).pet.state).toBe("idle");
  });

  it("pins a released record as fresh for its flight, cutting to the wall, then keeps it on the wall", () => {
    const release = when("evidence.released", (f) => f.type === "evidence.released" && f.data.record_id === "rec-03");
    const w = at(release + 100);
    expect(w.wall.find((p) => p.record_id === "rec-03")).toMatchObject({ fresh: true, trigger: "requested", releasedAtTurn: 3, releasedAt: release });
    expect(w.shot).toBe("wall");
    expect(w.caption).toContain("Record released:");
    const later = at(release + EVIDENCE_MS + 10);
    expect(later.wall.find((p) => p.record_id === "rec-03")?.fresh).toBe(false);
  });

  it("points out the evidence-conflict flag (contradiction noticed) toward the cited record, then lets it go", () => {
    const card = when("coach.card", turn(5));
    const w = at(card + HAND_MS + 100);
    expect(w.flag).toEqual({ kind: "evidence_conflict", turn: 4, conflictTurn: null, conflictRecord: "rec-05" });
    expect(w.coaches.find((c) => c.desk === "flags")?.pose).toBe("pointing");
    expect(w.shot).toBe("room");
    expect(at(card + FLAG_MS + 10).flag).toBe(null);
  });

  it("points a contradiction between two turns out from the observation room (mirror shot)", () => {
    const card = when("coach.card", turn(5));
    const t = card + HAND_MS + 100;
    const cursor = seek(REC, startCursor(REC), t);
    const view = cursor.state.view;
    if (view === null) throw new Error("no view");
    const last = view.cards.at(-1);
    if (last === undefined) throw new Error("no card");
    const flag = { ...last.card.flags[0], kind: "contradiction", conflict_turn_id: "t03", conflict_quote: "I stayed in the doorway the whole time.", conflict_record_id: null, conflict_record_quote: null } as (typeof last.card.flags)[number];
    const edited = { ...view, cards: [...view.cards.slice(0, -1), { ...last, card: { ...last.card, flags: [flag] } }] };
    const w = deriveWorld({ view: edited, nowMs: t, arrivals: cursor.arrivals, subjectName: "S", investigatorActive: false, reducedMotion: false, paused: false });
    expect(w?.flag).toEqual({ kind: "contradiction", turn: 4, conflictTurn: 3, conflictRecord: null });
    expect(w?.shot).toBe("mirror");
  });

  it("does not point out a conflict flag whose citation failed the server's check or the shared predicate", () => {
    const card = when("coach.card", turn(5));
    const t = card + HAND_MS + 100;
    const cursor = seek(REC, startCursor(REC), t);
    const view = cursor.state.view;
    const last = view?.cards.at(-1);
    if (view === null || last === undefined) throw new Error("no card");
    const base = { nowMs: t, arrivals: cursor.arrivals, subjectName: "S", investigatorActive: false, reducedMotion: false, paused: false };
    const withCard = (c: typeof last.card) => ({ ...view, cards: [...view.cards.slice(0, -1), { ...last, card: c }] });
    const ref = last.card.flags[0]?.flag_ref ?? "";
    const serverFailed = withCard({ ...last.card, validation: { ...last.card.validation, flags: { [ref]: { citation_ok: false, demeanor_based: false, duplicate: false } } } });
    expect(deriveWorld({ ...base, view: serverFailed })?.flag).toBe(null);
    const notFound = withCard({ ...last.card, flags: last.card.flags.map((f) => ({ ...f, quote: "She said B-10 instead." })) });
    expect(deriveWorld({ ...base, view: notFound })?.flag).toBe(null);
    const recordMismatch = withCard({ ...last.card, flags: last.card.flags.map((f) => ({ ...f, conflict_record_quote: "Words the statement never had." })) });
    expect(deriveWorld({ ...base, view: recordMismatch })?.flag).toBe(null);
  });

  it("stamps the seal when the trial is finalized, then ends with the companion asleep and the debrief ready", () => {
    const finalized = when("trial.finalized");
    const sealing = at(finalized + 100);
    expect(sealing.seal).toMatchObject({ fresh: true, at: finalized });
    expect(sealing.shot).toBe("table");
    expect(sealing.caption).toBe("Session ended. Finding committed and sealed.");
    const end = at(finalized + SEAL_MS + 10);
    expect(end.seal?.fresh).toBe(false);
    expect(at(REC.durationMs).debriefReady).toBe(true);
    expect(end.pet.state).toBe("sleeping");
    expect(end.subject.pose).toBe("idle");
  });

  it("shows the pet still under reduced motion or the pause control, same pose", () => {
    const t = when("coach.card", turn(1)) + 100;
    expect(at(t, { reducedMotion: true }).pet).toEqual({ state: "noticing", motion: "still" });
    expect(at(t, { paused: true }).pet.motion).toBe("still");
  });

  it("lets the companion listen while the investigator types", () => {
    expect(at(30_000 > REC.durationMs ? 0 : 2_200, { investigatorActive: true }).pet.state).toBe("listening");
  });
});

describe("the rules the world carries", () => {
  it("gives the same subject poses whatever the cards say (PRB-4: lifecycle and timing only)", () => {
    const flip = (view: TrialView): TrialView => ({
      ...view,
      cards: view.cards.map((c) => ({ ...c, card: { ...c.card, answer_category: c.card.answer_category === "responsive" ? "possible_evasion" : "responsive", flags: [] } })),
      runningFinding: null,
    });
    for (let t = 0; t <= REC.durationMs; t += 700) {
      const cursor = seek(REC, startCursor(REC), t);
      const base = { nowMs: t, arrivals: cursor.arrivals, subjectName: "S", investigatorActive: false, reducedMotion: false, paused: false };
      const view = cursor.state.view;
      if (view === null) continue;
      expect(deriveWorld({ ...base, view: flip(view) })?.subject).toEqual(deriveWorld({ ...base, view })?.subject);
    }
  });

  it("keeps assessment free of coaching: empty observation room, sleeping companion, no flag moment", () => {
    const log = new LogBuilder("assessment").ask().ask();
    const w = fromLog(log, "assessment", 3500);
    expect(w?.mode).toBe("assessment");
    expect(w?.coaches.every((c) => c.pose === "away")).toBe(true);
    expect(w?.pet.state).toBe("sleeping");
    expect(w?.flag).toBe(null);
  });

  it("does not point out a gap flag; only conflicts are a contradiction moment", () => {
    const log = new LogBuilder("practice").ask();
    const w = fromLog(log, "practice", log.frames.length * 1000 + 2000);
    expect(w?.flag).toBe(null);
  });

  it("names the other derived statuses in words", () => {
    const capped = new LogBuilder("practice");
    for (let i = 0; i < 12; i += 1) capped.ask();
    expect(fromLog(capped, "practice", 999_999)?.caption).toBe("This interview has reached its length limit; commit your finding.");
    expect(fromLog(new LogBuilder("practice").ask().end("infra_failed"), "practice", 999_999)?.caption).toBe("The session stopped because of a technical fault.");
    expect(fromLog(new LogBuilder("practice").ask().end("budget_truncated"), "practice", 999_999)?.caption).toBe("The session stopped because the spend limit was reached.");
    const quarantined = fromLog(new LogBuilder("practice").ask().end("subject_quarantined"), "practice", 999_999)?.caption ?? "";
    expect(quarantined).toBe("The session was stopped for a platform check. It is not counted.");
    expect(quarantined).not.toMatch(/attack|injection|deceptive|lying/i);
    const thinking = new LogBuilder("practice");
    thinking.frames.push(...new LogBuilder("practice").ask({ coach: "none" }).frames.slice(0, 2));
    expect(fromLog(thinking, "practice", 2500)?.subject.pose).toBe("thinking");
  });

  it("shows the finalizing step while the finding is saved", () => {
    let state = trialReducer(initialTrialState(), { type: "snapshot", snapshot: snapshot() });
    state = trialReducer(state, { type: "finding_submitted" });
    const w = deriveWorld({ view: state.view, nowMs: 0, arrivals: new Map(), subjectName: "S", investigatorActive: false, reducedMotion: false, paused: false });
    expect(w?.caption).toBe("Saving the finding.");
    expect(w?.coaches.map((c) => c.pose)).toEqual(["idle", "idle", "idle"]);
  });

  it("says the coach is reading even before the working hint names the turn", () => {
    const log = new LogBuilder("practice").ask({ coach: "none" });
    const w = fromLog(log, "practice", 60_000);
    expect(w?.status).toBe("coach_working");
    expect(w?.caption).toBe("Coach is reading the answer.");
  });
});
