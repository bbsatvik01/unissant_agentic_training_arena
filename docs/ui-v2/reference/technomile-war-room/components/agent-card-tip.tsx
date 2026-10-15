import type { ReactNode } from "react";

import type { AgentCard } from "@/lib/contracts/run-events";
import type { NodeStats } from "@/lib/war-room/swarm-graph";

import { ROLE_SHORT } from "./roles";

/** An agent's card on hover or keyboard focus (the graph and the office share it); `extra` adds live rows. */
export function AgentCardTip({ card: c, rival, stats, extra }: { card: AgentCard; rival: boolean; stats: NodeStats | undefined; extra?: ReactNode }) {
  return (
    <div className="rounded-lg border border-hairline-strong bg-canvas px-3 py-2.5 text-xs shadow-md">
      <div className="text-sm font-semibold text-ink">{c.name}</div>
      <div className="mt-0.5 text-muted">
        {ROLE_SHORT[c.role] ?? c.role}
        {rival ? `, ${c.groupLabel}` : ""}
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-micro tabular text-ink-2">
        <dt className="text-faint">messages</dt>
        <dd>{stats ? `${stats.sent} sent, ${stats.received} received` : "none yet"}</dd>
        <dt className="text-faint">tokens</dt>
        <dd>{stats ? `${stats.inputTokens.toLocaleString("en-US")} in / ${stats.outputTokens.toLocaleString("en-US")} out` : "-"}</dd>
        <dt className="text-faint">stage</dt>
        <dd>{c.stage}</dd>
      </dl>
      {extra}
      <p className="mt-2 text-muted">Reads {c.reads}.</p>
    </div>
  );
}
