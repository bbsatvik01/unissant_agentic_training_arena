/** Captured actors only. No fallback cast, live clock, audio, reducer, or capture callback. */
import { Suspense } from "react";
import { proceduralClip } from "../../lib/precinct/proceduralActors";
import type { Tier } from "../../lib/world/quality";
import type { PoseData } from "../../lib/world/worldEvents";
import { ReviewerFigureV2 } from "./PrecinctReviewPanel";
import { SeatedFigure } from "./PrecinctInterviewCast";
import { StaffFigure } from "./PrecinctStaff";
import { WalkingAvatar } from "./WalkingAvatar";
const CLOSED_MOUTH = () => null;
const HELD_CLOCK = { current: 0 };
const NO_TRAVEL = { current: { distance: 0, speed: 0 } };
export function PrecinctActorReplay({ actors, tier, hiddenActors, withheldActors }: {
  readonly actors: ReadonlyMap<string, PoseData>; readonly tier: Tier; readonly hiddenActors?: ReadonlySet<string>; readonly withheldActors?: ReadonlySet<string>;
}) {
  return <group name="precinct-recorded-actors">{Array.from(actors).map(([id, sample]) => {
    if (withheldActors?.has(id)) return null;
    const clip = id === sample.actor_id ? proceduralClip(sample) : null;
    if (clip === null || clip.family === "absent") return null;
    const visible = !hiddenActors?.has(id);
    return <Suspense key={`${id}:${clip.family}`} fallback={null}><group visible={visible}>
      {clip.family === "reviewer-v2" ? <ReviewerFigureV2 lifecycle={{ phase: "listening", publishedAtMs: null }} clock={HELD_CLOCK} still={clip.still} tier={tier} recorded={{ sample, clip }} />
        : clip.family === "staff" ? <StaffFigure staff={clip.staff} paused reducedMotion tier={tier} recorded={{ sample, still: clip.still }} />
        : clip.family === "patrol-v2" ? <StaffFigure staff={clip.staff} paused reducedMotion tier={tier} recorded={{ sample, patrolCycle: clip.cycle }} />
        : clip.family === "seated" ? <SeatedFigure actor={clip.actor} pose={clip.pose} still={clip.still} tier={tier} clock={HELD_CLOCK} readMouth={CLOSED_MOUTH} recorded={sample} />
        : <WalkingAvatar travel={NO_TRAVEL} still recorded={{ sample, cycle: clip.cycle }} />}
    </group></Suspense>;
  })}</group>;
}
