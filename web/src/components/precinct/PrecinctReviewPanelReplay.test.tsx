// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ABSENT_CLIP, SEATED_ACTORS_V1, seatedClip } from "../../lib/precinct/proceduralActors";
import { REVIEWER_ACTOR_ID_V2, reviewerClipV2 } from "../../lib/precinct/proceduralReviewerV2";
import type { PoseData } from "../../lib/world/worldEvents";
import { PrecinctActorReplay } from "./PrecinctActorReplay";

vi.mock("./PrecinctReviewPanel", () => ({ ReviewerFigureV2: (props: { clock: { current: number }; recorded: { sample: PoseData }; actorCapture?: unknown; readMouth?: unknown }) => <span data-reviewer="true" data-time={props.recorded.sample.animation.time} data-clock={props.clock.current} data-capture={String(props.actorCapture !== undefined)} data-audio={String(props.readMouth !== undefined)} /> }));
vi.mock("./PrecinctInterviewCast", () => ({ SeatedFigure: () => <span data-coach="true" /> }));
vi.mock("./PrecinctStaff", () => ({ StaffFigure: () => null }));
vi.mock("./WalkingAvatar", () => ({ WalkingAvatar: () => null }));
afterEach(cleanup);
const sample = (clip = reviewerClipV2("handover", false), time = 0.7): PoseData => ({ actor_id: REVIEWER_ACTOR_ID_V2, position: [4.95, 0, -17.5], rotation: [0, 0, 0, 1], animation: { clip, time } });
describe("review-panel captured-only rendering", () => {
  it("has no fallback reviewer, capture or audio and honors exact captured time through backward seek", () => {
    const value = sample();
    const { container, rerender } = render(<PrecinctActorReplay actors={new Map([[value.actor_id, value]])} tier="low" />);
    const reviewer = () => container.querySelector("[data-reviewer]");
    expect(reviewer()?.getAttribute("data-time")).toBe("0.7");
    expect(reviewer()?.getAttribute("data-clock")).toBe("0");
    expect(reviewer()?.getAttribute("data-capture")).toBe("false");
    expect(reviewer()?.getAttribute("data-audio")).toBe("false");
    rerender(<PrecinctActorReplay actors={new Map([[value.actor_id, sample(reviewerClipV2("handover", false), 0.1)]])} tier="high" />);
    expect(reviewer()?.getAttribute("data-time")).toBe("0.1");
    for (const actors of [new Map(), new Map([[value.actor_id, { ...value, animation: { clip: ABSENT_CLIP, time: 0.1 } }]]), new Map([["wrong-id", value]])]) {
      rerender(<PrecinctActorReplay actors={actors} tier="high" />); expect(reviewer()).toBeNull();
    }
  });
  it("does not mount withheld assessment reviewers or coaches, even if imported samples contain them", () => {
    const value = sample(); const actor = SEATED_ACTORS_V1.find((item) => item.kind === "coach");
    if (actor === undefined) throw new Error("Missing coach fixture");
    const coach: PoseData = { ...value, actor_id: actor.actorId, animation: { clip: seatedClip(actor, "typing", false), time: 2 } };
    const actors = new Map([[value.actor_id, value], [coach.actor_id, coach]]);
    const { container, rerender } = render(<PrecinctActorReplay actors={actors} tier="high" withheldActors={new Set([value.actor_id, coach.actor_id])} />);
    expect(container.querySelector("span")).toBeNull();
    rerender(<PrecinctActorReplay actors={actors} tier="high" withheldActors={new Set([coach.actor_id])} />);
    expect(container.querySelector("[data-reviewer]")).not.toBeNull();
    expect(container.querySelector("[data-coach]")).toBeNull();
  });
});
