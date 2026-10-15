import { describe, expect, it } from "vitest";

import {
  audibleMouth, castBudget, INTERVIEW_TABLE, interviewCamera, INVESTIGATOR_EYES, INVESTIGATOR_SEAT,
  OBSERVATION_MONITOR, OBSERVATION_SCREEN_PANES, OBSERVATION_SEATS, projectInterviewCast, SEATED_PELVIS,
  seatedLeg, seatedMotion, SEAT_TOP, SUBJECT_EYES, SUBJECT_SEAT, type CastWorldProjection,
} from "./interviewStage";

const WORLD: CastWorldProjection = {
  mode: "practice", subject: { pose: "speaking", speech: { turn: 1, text: "The public answer.", startedAt: 200 } },
  investigator: { speech: { turn: 1, text: "When was that?", startedAt: 0 } },
  coaches: [{ desk: "question", pose: "typing" }, { desk: "flags", pose: "thinking" }, { desk: "follow_up", pose: "idle" }],
};

describe("authored precinct interview layout", () => {
  it("uses the existing chairs and table, converted from Blender coordinates", () => {
    expect(SUBJECT_SEAT).toEqual({ position: [8.65, 0, -14.18], facing: 0 });
    expect(INVESTIGATOR_SEAT).toEqual({ position: [8.65, 0, -12.22], facing: Math.PI });
    expect(INTERVIEW_TABLE.center).toEqual([8.7, 0.76, -13.2]);
    expect(SEAT_TOP).toBe(0.52);
    expect(SEATED_PELVIS).toBeCloseTo(0.62);
    expect(Object.values(OBSERVATION_SEATS).map((seat) => seat.position)).toEqual([[6.2, 0, -17.5], [8.1, 0, -17.5], [10, 0, -17.5]]);
  });
  it("keeps four viewports inside the one existing observation screen", () => {
    expect(OBSERVATION_SCREEN_PANES.map((pane) => pane.style)).toEqual(["classic", "case-board", "playhouse", "bid-tower"]);
    for (const pane of OBSERVATION_SCREEN_PANES) {
      expect(Math.abs(pane.position[0] - OBSERVATION_MONITOR.position[0]) + pane.size[0] / 2).toBeLessThan(OBSERVATION_MONITOR.size[0] / 2);
      expect(Math.abs(pane.position[1] - OBSERVATION_MONITOR.position[1]) + pane.size[1] / 2).toBeLessThan(OBSERVATION_MONITOR.size[1] / 2);
      expect(pane.position[2]).toBeLessThan(OBSERVATION_MONITOR.position[2]);
      expect(pane.rotation).toEqual([0, Math.PI, 0]);
    }
  });
});

describe("cast allow-list", () => {
  it("copies only speech and lifecycle, stripping unrelated top-level and nested content", () => {
    const extras = { ...WORLD, finding: "never enters the renderer", score: 100,
      subject: { ...WORLD.subject, hiddenCaseFacts: ["secret"], speech: { turn: 1, text: "The public answer.", startedAt: 200, secret: "hidden" } } };
    const result = projectInterviewCast(extras);
    expect(result).toEqual(WORLD);
    expect(result?.subject).not.toBe(WORLD.subject);
    expect(result?.subject.speech).not.toBe(extras.subject.speech);
  });
  it("hides coaching in assessment even when a stale practice projection is supplied", () => {
    expect(projectInterviewCast({ ...WORLD, mode: "assessment" })?.coaches).toEqual([]);
  });
  it("filters absent coaches and maps flag/card reactions to a neutral lifecycle", () => {
    expect(projectInterviewCast({ ...WORLD, coaches: [{ desk: "question", pose: "away" }, { desk: "flags", pose: "pointing" }, { desk: "follow_up", pose: "handing" }] })?.coaches).toEqual([{ desk: "flags", pose: "idle" }, { desk: "follow_up", pose: "idle" }]);
    expect(projectInterviewCast(null)).toBeNull();
    expect(projectInterviewCast({ ...WORLD, subject: { pose: "idle", speech: null }, investigator: { speech: null } })?.subject.speech).toBeNull();
  });
});

describe("seated camera anchors", () => {
  it("defaults to seated first person, without a visible investigator head", () => {
    expect(interviewCamera("first", false)).toEqual({ mode: "first", position: INVESTIGATOR_EYES, target: [8.65, 1.12, -14.12], fov: 52, showInvestigator: false });
    expect(interviewCamera("first", false).target[1]).toBeLessThan(SUBJECT_EYES[1]);
    expect(SUBJECT_EYES).toEqual([8.65, 1.36, -14.12]); // Framing never changes the actor gaze anchor.
    expect(interviewCamera("free", false)).toEqual(interviewCamera("first", false));
  });
  it("offers a third-person shoulder view and a bounded paused free orbit", () => {
    const third = interviewCamera("third", false);
    expect(third.showInvestigator).toBe(true);
    expect(third.mode).toBe("third");
    expect(third.position[2]).toBeGreaterThan(INVESTIGATOR_SEAT.position[2]);
    for (const yaw of [-10, 0, 1, 3, 10, NaN]) for (const pitch of [-100, 0, 100, NaN]) {
      const free = interviewCamera("free", true, { yaw, pitch, distance: 100 });
      expect(free.mode).toBe("free"); expect(free.showInvestigator).toBe(true);
      expect(free.position.every(Number.isFinite)).toBe(true);
      expect(free.position[1]).toBeGreaterThanOrEqual(1); expect(free.position[1]).toBeLessThanOrEqual(2.7);
      expect(free.position[2]).toBeGreaterThanOrEqual(-15.45); expect(free.position[2]).toBeLessThanOrEqual(-10.55);
    }
    expect(interviewCamera("free", true, { yaw: 0, pitch: 0, distance: NaN }).position.every(Number.isFinite)).toBe(true);
  });
});

describe("audio and deterministic presentation", () => {
  it("never invents speech from text timing or animates paused/reduced-motion mouths", () => {
    expect(audibleMouth(null, false)).toEqual({}); expect(audibleMouth({}, false)).toEqual({});
    expect(audibleMouth({ aa: 1, O: 0.3 }, true)).toEqual({});
    expect(audibleMouth({ aa: 1.8, O: 0.3, E: -1, I: NaN, U: Infinity, sil: 1 }, false)).toEqual({ aa: 1, O: 0.3 });
  });
  it("keeps the low-tier cast and reduces update cost rather than changing lifecycle", () => {
    expect(castBudget("low")).toEqual({ frameSeconds: 1 / 15, shadows: false });
    expect(castBudget("medium")).toEqual({ frameSeconds: 1 / 30, shadows: false });
    expect(castBudget("high")).toEqual({ frameSeconds: 1 / 60, shadows: true });
  });
  it("is stable when replay revisits a time and quiet when paused or motion is reduced", () => {
    const first = seatedMotion(2123, 42, "speaking", false, 0.7);
    seatedMotion(99_000, 42, "typing", false, 0.7);
    expect(seatedMotion(2123, 42, "speaking", false, 0.7)).toEqual(first);
    expect(seatedMotion(2123, 42, "typing", true, 0.7)).toEqual({ breath: 0, head: 0, hands: 0, blink: 0 });
    expect(seatedMotion(2123, 42, "typing", false, 0.7).hands).not.toBe(0);
    expect(seatedMotion(2123, 42, "idle", false, 0.7).head).toBe(0);
    expect(seatedMotion(80, 0, "idle", false, 0).blink).toBeCloseTo(1);
    expect(Object.values(seatedMotion(NaN, Infinity, "speaking", false, NaN)).every(Number.isFinite)).toBe(true);
  });
});

describe("seated leg fitting", () => {
  it("preserves measured leg lengths and plants the ankle at its standing height", () => {
    for (const [upper, lower, hip, ankle] of [[0.399, 0.397, 0.62, 0.101], [0.425, 0.423, 0.62, 0.08]] as const) {
      const pose = seatedLeg(upper, lower, hip, ankle);
      expect(Math.hypot(...pose.knee)).toBeCloseTo(upper, 6);
      expect(Math.hypot(pose.ankle[0] - pose.knee[0], pose.ankle[1] - pose.knee[1])).toBeCloseTo(lower, 6);
      expect(hip + pose.ankle[0]).toBeCloseTo(ankle, 6);
      expect(pose.knee[1]).toBeGreaterThan(0.25);
    }
  });
  it("clamps impossible measurements and never emits non-finite coordinates", () => {
    for (const args of [[NaN, Infinity, NaN, NaN, NaN], [0, -1, 20, -20, 0], [1, 0.05, 0, 0, 0.05]] as const) {
      const pose = seatedLeg(args[0], args[1], args[2], args[3], args[4]);
      expect([...pose.knee, ...pose.ankle].every(Number.isFinite)).toBe(true);
    }
  });
});
