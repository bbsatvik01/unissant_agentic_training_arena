/** Ticker wording for phase edges and for recorded events that have no detailed view yet. */
import type { FeedItem } from "./state";

const PHASE_NAME: Readonly<Record<string, string>> = { prepare: "Prepare phase", execute: "Research phase" };

/** One phase edge as a ticker line (the run state names the gate it parks at). */
export function phaseLine(p: NonNullable<FeedItem["phase"]>): string {
  if (p.edge === "started") return `${PHASE_NAME[p.name] ?? p.name} started`;
  if (p.edge === "failed") return `Phase failed (${p.code})`;
  const gate: Readonly<Record<string, string>> = {
    awaiting_plan_approval: "waiting for plan approval (H1)",
    awaiting_decision: "waiting for the decision (H2)",
    awaiting_review: "waiting for review (H2)",
  };
  return `Phase finished: ${gate[p.state] ?? p.state.replaceAll("_", " ")}`;
}

/** A recorded event type as words ("AGENT_MESSAGE" -> "Agent message"). */
export function eventName(name: string): string {
  const words = name.toLowerCase().replaceAll("_", " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Event";
}
