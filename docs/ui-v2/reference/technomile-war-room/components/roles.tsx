import { ClockCounterClockwise, Cpu, Crown, CurrencyDollar, Scales, Sword, UserFocus, type Icon } from "@phosphor-icons/react";

/** One icon per swarm role, shared by the agent graph, the thread and the War game page. */
export const ROLE_ICON: Record<string, Icon> = {
  pricing: CurrencyDollar,
  technical: Cpu,
  past_performance: ClockCounterClockwise,
  capture_lead: Crown,
  red_team: Sword,
  evaluator: Scales,
  analyst: UserFocus,
};

export const ROLE_SHORT: Record<string, string> = {
  pricing: "Pricing",
  technical: "Technical",
  past_performance: "Past perf.",
  capture_lead: "Capture lead",
  red_team: "Red team",
  evaluator: "Evaluator",
  analyst: "Analyst",
};

export function RoleIcon({ role, size = 14 }: { role: string; size?: number }) {
  const C = ROLE_ICON[role] ?? UserFocus;
  return <C size={size} weight="duotone" aria-hidden className="shrink-0" />;
}
