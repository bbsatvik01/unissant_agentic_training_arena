import { describe, expect, it } from "vitest";
import { deriveAgentWork, type WorkFrame } from "../agent-work/model";
import { initialTrialState, trialReducer } from "../trial/trialReducer";
import { LogBuilder, SESSION_ID, snapshot } from "../../test/trial-log";
import type { PoseData } from "../world/worldEvents";
import { ABSENT_CLIP, PROCEDURAL_ACTOR_IDS_V1, PROCEDURAL_CLIPS_V1, proceduralClip } from "./proceduralActors";
import { REVIEWER_ACTOR_ID_V2, REVIEWER_CHAIR_V2, REVIEWER_CLIPS_V2, REVIEWER_COLLIDER_V2, REVIEWER_POSES_V2, REVIEWER_V2, projectReviewerV2, reviewerClipV2, reviewerForSceneV2, reviewerMotionV2, reviewerPlaybackV2, withheldObservationActorsV2, withReviewerColliderV2 } from "./proceduralReviewerV2";

function frame(overrides: Partial<WorkFrame> = {}): WorkFrame {
  return { ...deriveAgentWork({ view: null, arrivals: new Map(), nowMs: 0, paused: false, reducedMotion: false }), ...overrides };
}
const published = { phase: "published", publishedAtMs: 2_000 } as const;
const sample = (clip: string, actor_id = REVIEWER_ACTOR_ID_V2): PoseData => ({ actor_id, position: REVIEWER_V2.position, rotation: [0, 0, 0, 1], animation: { clip, time: 0.7 } });
describe("public review lifecycle and assessment boundary", () => {
  it("shows calm presence without fabricating work before explicit status exists", () => {
    expect(projectReviewerV2(frame(), false, false)).toEqual({ phase: "listening", publishedAtMs: null });
    expect(projectReviewerV2(frame({ available: true, refereeState: "working" }), false, false)).toEqual({ phase: "working", publishedAtMs: null });
    expect(projectReviewerV2(frame({ refereeState: "working" }), false, false)?.phase).toBe("listening");
  });
  it("keeps pending and active assessment empty, including stale practice or already-ready frames", () => {
    for (const assessment of [false, true]) for (const refereeState of ["waiting", "working", "ready", "failed"] as const) {
      const value = frame({ available: true, assessment, refereeState });
      expect(projectReviewerV2(value, true, false)).toBeNull();
      expect(projectReviewerV2(value, true, true)).toBeNull();
      expect(projectReviewerV2({ ...value, assessment: true }, false, false)).toBeNull();
    }
  });
  it("does not distinguish scored/unscored publication and never makes a score gesture", () => {
    for (const assessment of [false, true]) for (const refereeState of ["ready", "failed"] as const) {
      const value = frame({ available: true, assessment, refereeState, items: [{ id: "referee:published", kind: "referee", label: "ignored", turn: null, atMs: 2_000 }] });
      expect(projectReviewerV2(value, false, true)).toEqual(published);
    }
  });
  it("defends both live and replay scene mounts against stale or missing assessment projections", () => {
    for (const value of [undefined, null, { phase: "working", publishedAtMs: null } as const, published]) {
      expect(reviewerForSceneV2(value, true, false)).toBeNull();
      expect(withheldObservationActorsV2(value, true, false)).toEqual(new Set(["coach:question", "coach:flags", "coach:follow_up", REVIEWER_ACTOR_ID_V2]));
    }
    expect(reviewerForSceneV2({ phase: "working", publishedAtMs: null }, false, true)).toBeNull();
    expect(reviewerForSceneV2(published, false, true)).toBe(published);
    expect(withheldObservationActorsV2(published, false, true)).toEqual(new Set(["coach:question", "coach:flags", "coach:follow_up"]));
    expect(withheldObservationActorsV2(undefined, false, false).size).toBe(0);
  });
  it("ignores flags, finding labels, note content, private extras, count and transfer intensity", () => {
    const safe = frame({ available: true, refereeState: "working" });
    const poisoned = { ...safe, cards: 999, updates: 99, phase: 0.9, caption: "deceptive",
      flags: [{ id: "f", label: "truthful", turn: 1, quote: "stress", conflictTurn: null, recordId: null }],
      transfers: [{ id: "private", from: "referee" as const, to: "coach" as const, progress: 0.5 }], score: 0, role: "deceptive", demeanor: "nervous" };
    expect(projectReviewerV2(poisoned, false, false)).toEqual(projectReviewerV2(safe, false, false));
  });
  it("consumes only canonical explicit scoring and published document gates", () => {
    let state = trialReducer(initialTrialState(), { type: "snapshot", snapshot: snapshot() });
    const log = new LogBuilder().ask();
    for (const event of log.frames) state = trialReducer(state, { type: "frame", frame: event });
    if (state.view === null) throw new Error("Missing public view");
    const view = { ...state.view, status: "ended" as const, serverStatus: "completed" as const, debriefReady: SESSION_ID };
    const args = { view, arrivals: new Map([["debrief.ready", 2_000]]), nowMs: 2_700, paused: false, reducedMotion: false };
    const waiting = deriveAgentWork({ ...args, referee: null });
    expect(projectReviewerV2(waiting, false, false)?.phase).toBe("listening");
    expect(projectReviewerV2(deriveAgentWork({ ...args, referee: { status: "scoring" } }), false, false)?.phase).toBe("working");
    for (const scored of [false, true]) expect(projectReviewerV2(deriveAgentWork({ ...args, referee: { session_id: SESSION_ID, scored } }), false, true)).toEqual(published);
    const early = deriveAgentWork({ ...args, view: { ...view, debriefReady: null }, referee: { session_id: SESSION_ID, scored: true } });
    expect(projectReviewerV2(early, false, true)?.phase).toBe("listening");
  });
  it("hands a blank slip only inside the real publication-arrival interval, including backwards seek", () => {
    expect(reviewerPlaybackV2(published, 1_999, false).pose).toBe("listening");
    expect(reviewerPlaybackV2(published, 2_000, false)).toMatchObject({ pose: "handover", time: 0 });
    expect(reviewerPlaybackV2(published, 2_700, false)).toMatchObject({ pose: "handover", time: 0.7 });
    expect(reviewerPlaybackV2(published, 3_400, false).pose).toBe("listening");
    expect(reviewerPlaybackV2(published, 2_700, true)).toMatchObject({ pose: "handover", time: 0.7, clip: reviewerClipV2("handover", true) });
    expect(reviewerPlaybackV2({ ...published, publishedAtMs: null }, 2_700, false).pose).toBe("listening");
    expect(reviewerPlaybackV2(published, Number.NaN, false).pose).toBe("listening");
  });
});
describe("finite reviewer v2 with frozen v1 catalogue", () => {
  it("adds no reviewer identity or clips to either v1 enumeration", () => {
    expect(PROCEDURAL_ACTOR_IDS_V1).not.toContain(REVIEWER_ACTOR_ID_V2);
    for (const clip of REVIEWER_CLIPS_V2) expect(PROCEDURAL_CLIPS_V1).not.toContain(clip);
    expect(new Set(REVIEWER_CLIPS_V2).size).toBe(6);
    for (const pose of REVIEWER_POSES_V2) for (const still of [false, true]) {
      expect(proceduralClip(sample(reviewerClipV2(pose, still)))).toEqual({ family: "reviewer-v2", pose, still });
      expect(proceduralClip(sample(reviewerClipV2(pose, still), "coach:flags"))).toBeNull();
    }
    expect(proceduralClip(sample(ABSENT_CLIP))).toEqual({ family: "absent", actorId: REVIEWER_ACTOR_ID_V2 });
  });
  it("rejects unknown ids, alternate versions, path-like clips and invalid transforms", () => {
    for (const clip of ["precinct.reviewer.v1.working.moving", "precinct.reviewer.v2.pointing.moving", "/avatar.glb", "precinct.reviewer.v3.handover.moving"]) expect(proceduralClip(sample(clip))).toBeNull();
    expect(proceduralClip(sample(REVIEWER_CLIPS_V2[0] ?? "", "reviewer:unknown"))).toBeNull();
    expect(proceduralClip({ ...sample(reviewerClipV2("listening", false)), position: [NaN, 0, 0] })).toBeNull();
  });
  it("uses a separate backed chair at existing bench height and an idempotent collision overlay", () => {
    expect(REVIEWER_V2.position).toEqual([4.95, 0, -17.5]);
    expect(REVIEWER_CHAIR_V2.seatTop).toBe(0.52);
    const base = [{ id: "old", min: [0, 0, 0], max: [1, 1, 1] } as const];
    const next = withReviewerColliderV2(base);
    expect(next).toEqual([...base, REVIEWER_COLLIDER_V2]);
    expect(base).toHaveLength(1); expect(withReviewerColliderV2(next)).toBe(next);
  });
  it("freezes neutral body motion while retaining semantic posture and never outputs mouth weights", () => {
    for (const pose of REVIEWER_POSES_V2) {
      expect(reviewerMotionV2(pose, 0.1, true)).toEqual(reviewerMotionV2(pose, 0.9, true));
      expect(reviewerMotionV2(pose, NaN, false)).toEqual(reviewerMotionV2(pose, 0, false));
      expect(reviewerMotionV2(pose, 0.5, false)).not.toHaveProperty("mouth");
    }
  });
});
