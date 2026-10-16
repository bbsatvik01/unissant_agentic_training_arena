import { describe, expect, it } from "vitest";
import type { PoseData } from "../world/worldEvents";
import { ABSENT_CLIP, bodyPoseV1, INVESTIGATOR_V1, isProceduralActorSample, proceduralClip, PROCEDURAL_ACTOR_IDS_V1, PROCEDURAL_CLIPS_V1, publicSubjectV1, SEATED_ACTORS_V1, seatedClip, seatedGazeV1, staffActorId, staffClip, walkingClip } from "./proceduralActors";
import { PRECINCT_STAFF } from "./proceduralStaffV1";
const sample = (actor_id: string, clip: string): PoseData => ({ actor_id, position: [0, 0, 0], rotation: [0, 0, 0, 1], animation: { clip, time: 2 } });
describe("finite original public body registry", () => {
  it("pins all existing public personas and rejects unknown future subjects", () => {
    expect(SEATED_ACTORS_V1).toHaveLength(13);
    expect(publicSubjectV1("Jordan Pell")?.avatar).toBe("Male_Adult_05");
    expect(publicSubjectV1("unknown future subject")).toBeUndefined();
    expect(INVESTIGATOR_V1.actorId).toBe("investigator:seated");
    expect(new Set(PROCEDURAL_CLIPS_V1).size).toBe(PROCEDURAL_CLIPS_V1.length);
    expect(PROCEDURAL_CLIPS_V1.every((clip) => clip.length <= 160)).toBe(true);
  });
  it("accepts every finite clip only for its exact registered actor", () => {
    const visited = new Set<string>([ABSENT_CLIP]);
    for (const staff of PRECINCT_STAFF) for (const still of [false, true]) {
      const clip = staffClip(staff.id, still); visited.add(clip);
      expect(proceduralClip(sample(staffActorId(staff.id), clip))).toEqual({ family: "staff", staff, still });
    }
    for (const actor of SEATED_ACTORS_V1) for (const pose of ["idle", "listening", "speaking", "thinking", "typing"] as const) for (const still of [false, true]) {
      const clip = seatedClip(actor, pose, still); visited.add(clip);
      expect(proceduralClip(sample(actor.actorId, clip))).toEqual({ family: "seated", actor, pose, still });
      expect(proceduralClip(sample("staff:patrol", clip))).toBeNull();
    }
    for (const cycle of ["idle", "walk", "run", "still"] as const) {
      const clip = walkingClip(cycle); visited.add(clip);
      expect(proceduralClip(sample("investigator:walking", clip))).toEqual({ family: "walking", cycle });
    }
    for (const id of PROCEDURAL_ACTOR_IDS_V1) expect(proceduralClip(sample(id, ABSENT_CLIP))).toEqual({ family: "absent", actorId: id });
    expect(visited).toEqual(new Set(PROCEDURAL_CLIPS_V1));
  });
  it("fails closed on unknown identity, wrong family, arbitrary paths, extra fields and invalid transforms", () => {
    const valid = sample("investigator:walking", walkingClip("walk"));
    expect(isProceduralActorSample(valid)).toBe(true);
    for (const value of [sample("alien", ABSENT_CLIP), sample("staff:patrol", walkingClip("walk")), sample("staff:patrol", staffClip("analyst", false)), sample("staff:patrol", "/avatars/remote.glb"),
      { ...valid, position: [Infinity, 0, 0] }, { ...valid, rotation: [0, 0, 0, 0] }, { ...valid, rotation: [0, 0, 0, 2] }, { ...valid, hidden: "extra" }]) {
      expect(isProceduralActorSample(value as PoseData)).toBe(false);
    }
  });
  it("pins public gaze and neutral lifecycle mapping without hidden inputs", () => {
    for (const pose of ["idle", "listening", "speaking", "thinking", "typing"]) expect(bodyPoseV1(pose)).toBe(pose);
    expect(bodyPoseV1("pointing")).toBe("idle");
    for (const actor of SEATED_ACTORS_V1) {
      expect(seatedGazeV1(actor, "idle")).toEqual(actor.kind === "subject" ? [8.65, 1.41, -12.31] : [8.65, 1.36, -14.12]);
      if (actor.kind === "coach") for (const pose of ["typing", "thinking"] as const) expect(seatedGazeV1(actor, pose)).toEqual([actor.position[0], 0.9, -16.7]);
    }
  });
});
