// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ABSENT_CLIP, INVESTIGATOR_V1, seatedClip, staffClip, walkingClip } from "../../lib/precinct/proceduralActors";
import { patrolClipV2 } from "../../lib/precinct/proceduralPatrolV2";
import type { PoseData } from "../../lib/world/worldEvents";
import { PrecinctActorReplay } from "./PrecinctActorReplay";
vi.mock("./PrecinctInterviewCast", () => ({ SeatedFigure: (props: { recorded: PoseData; still: boolean }) => <span data-family="seated" data-time={props.recorded.animation.time} data-still={String(props.still)} /> }));
vi.mock("./PrecinctStaff", () => ({ StaffFigure: (props: { tier: string; recorded: { sample: PoseData; patrolCycle?: string }; actorCapture?: unknown; crowd?: unknown }) => <span data-family="staff" data-cycle={props.recorded.patrolCycle} data-capture={String(props.actorCapture !== undefined)} data-crowd={String(props.crowd !== undefined)} data-tier={props.tier} data-time={props.recorded.sample.animation.time} /> }));
vi.mock("./WalkingAvatar", () => ({ WalkingAvatar: (props: { recorded: { sample: PoseData } }) => <span data-family="walking" data-time={props.recorded.sample.animation.time} /> }));
afterEach(cleanup);
function pose(actor_id: string, clip: string, time = 2): PoseData { return { actor_id, position: [0, 0, 0], rotation: [0, 0, 0, 1], animation: { clip, time } }; }
describe("captured-only scene ownership", () => {
  it("displays only valid present captured actors and retains high-tier staff on low quality", () => {
    const values = [pose("staff:patrol", staffClip("patrol", false)), pose("investigator:walking", walkingClip("run")), pose("investigator:seated", seatedClip(INVESTIGATOR_V1, "listening", false)), pose("staff:analyst", ABSENT_CLIP), pose("staff:sergeant", "arbitrary.glb")];
    const actors = new Map(values.map((value) => [value.actor_id, value]));
    const { container, rerender } = render(<PrecinctActorReplay actors={actors} tier="low" />);
    expect(container.querySelectorAll("span")).toHaveLength(3);
    expect(container.querySelector('[data-family="staff"]')?.getAttribute("data-tier")).toBe("low");
    rerender(<PrecinctActorReplay actors={new Map()} tier="high" />); expect(container.querySelectorAll("span")).toHaveLength(0);
    rerender(<PrecinctActorReplay actors={new Map([["wrong-id", values[0] as PoseData]])} tier="high" />); expect(container.querySelectorAll("span")).toHaveLength(0);
  });
  it("holds the exact captured clip time through paused display and backwards seeks", () => {
    const value = pose("investigator:walking", walkingClip("walk"), 24);
    const { container, rerender } = render(<PrecinctActorReplay actors={new Map([[value.actor_id, value]])} tier="high" />);
    expect(container.querySelector("span")?.getAttribute("data-time")).toBe("24");
    rerender(<PrecinctActorReplay actors={new Map([[value.actor_id, value]])} tier="low" />);
    expect(container.querySelector("span")?.getAttribute("data-time")).toBe("24");
    rerender(<PrecinctActorReplay actors={new Map([[value.actor_id, { ...value, animation: { ...value.animation, time: 2 } }]])} tier="low" />);
    expect(container.querySelector("span")?.getAttribute("data-time")).toBe("2");
  });
});

it("renders only recorded v2 patrol at any tier, holds exact times and carries neither crowd nor capture", () => {
  const value = pose("staff:patrol", patrolClipV2("walk"), 7.4);
  const { container, rerender } = render(<PrecinctActorReplay actors={new Map([[value.actor_id, value]])} tier="low" />);
  const figure = () => container.querySelector("span");
  expect(figure()?.getAttribute("data-cycle")).toBe("walk"); expect(figure()?.getAttribute("data-time")).toBe("7.4");
  expect(figure()?.getAttribute("data-capture")).toBe("false"); expect(figure()?.getAttribute("data-crowd")).toBe("false");
  for (const cycle of ["idle", "still", "walk"] as const) {
    const seek = pose("staff:patrol", patrolClipV2(cycle), 0.2);
    rerender(<PrecinctActorReplay actors={new Map([[seek.actor_id, seek]])} tier="low" />);
    expect(figure()?.getAttribute("data-cycle")).toBe(cycle); expect(figure()?.getAttribute("data-time")).toBe("0.2");
  }
  for (const clip of [ABSENT_CLIP, "precinct.staff.v2.patrol.run", "precinct.staff.v2.patrol./asset.glb"]) {
    const missing = pose("staff:patrol", clip);
    rerender(<PrecinctActorReplay actors={new Map([[missing.actor_id, missing]])} tier="low" />); expect(figure()).toBeNull();
  }
});
