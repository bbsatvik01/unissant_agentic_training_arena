import type { WorkFrame, WorkStyle } from "../agent-work/model";
import type { Tier } from "../world/quality";

/** Texture UV origin is lower left; the SVG atlas's origin is upper left. */
export function monitorStyleAtUv(u: number, v: number): WorkStyle | null {
  if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1) return null;
  if (v >= 0.5) return u >= 0.5 ? "case-board" : "office";
  return u >= 0.5 ? "tower" : "playhouse";
}

/** One shared atlas cadence, never one independent motion clock per screen. */
export function monitorBudget(tier: Tier): { readonly seconds: number; readonly width: number; readonly height: number } {
  if (tier === "high") return { seconds: 0.25, width: 1024, height: 576 };
  if (tier === "medium") return { seconds: 0.5, width: 768, height: 432 };
  return { seconds: 1, width: 512, height: 288 };
}

/** Fail closed during a practice-to-assessment transition, even if the previous frame is still queued. */
export function observationWork(frame: WorkFrame, assessment: boolean): WorkFrame {
  if (!assessment && !frame.assessment) return frame;
  return {
    ...frame, assessment: true, cards: 0, updates: 0, flags: [], transfers: [],
    agents: frame.agents.map((agent) => agent.id === "coach"
      ? { ...agent, count: 0, status: "withheld", task: "Coaching withheld in assessment" }
      : agent),
    items: frame.items.filter((item) => item.kind === "evidence" || item.kind === "referee"),
    caption: "Assessment. Coaching is withheld; only public session activity is shown.",
  };
}
