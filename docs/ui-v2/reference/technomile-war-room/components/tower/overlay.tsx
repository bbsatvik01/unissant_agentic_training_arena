"use client";

/**
 * The Bid Tower's DOM layer over the scene: every word and number in product type, positioned in the scene's own
 * coordinates (percentages of its box), and the real controls: a button per agent (a roving tab stop; arrows move
 * by floor, Home and End jump, Enter or Space filters the thread, Escape clears) and a button per floor and room
 * that filters the thread to that team.
 */
import { useCallback, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import type { BoardResult } from "@/lib/contracts/run-events";
import type { OfficePlan, Seat } from "@/lib/war-room/office";
import { shortName, type SwarmView } from "@/lib/war-room/swarm";
import { firstWords, type Focus, type NodeStats } from "@/lib/war-room/swarm-graph";
import { agentCardAt, type AgentNow, type TowerFrame, type TowerModel } from "@/lib/war-room/tower/frame";
import { pct, X, type Row, type TowerLayout } from "@/lib/war-room/tower/layout";
import { nearestInDirection, readingOrder, type NavDir } from "@/lib/war-room/tower/nav";
import { clockLabel, seconds } from "@/lib/war-room/tower/world";

import { ROLE_NAME } from "../office-avatars";
import { AgentCardTip } from "../swarm-graph";

/* ------------------------------------------------------------------------------------------------ words */

export function seatName(seat: Seat, plan: OfficePlan, view: SwarmView): string {
  const card = seat.agentId ? view.cards[seat.agentId] : undefined;
  if (card) return card.name;
  if (seat.role === "researcher") return `${shortName(plan.pods.find((p) => p.key === seat.pod)?.label ?? seat.pod ?? "Home")} researcher`;
  if (seat.role === "verifier") return "Verifier";
  return `${ROLE_NAME[seat.role]} (no card yet)`;
}

/** What an agent is doing, in words (the aria label, the caption and the hover card share it). */
export function towerActivityWords(a: AgentNow, frame: TowerFrame, model: TowerModel): string {
  const leg = a.leg;
  if (leg?.kind === "cabin") return "Riding the lift.";
  if (leg?.kind === "wait") return "Waiting for the lift.";
  if (leg?.kind === "walk") return leg.carrying ? "Walking back with printouts." : leg.to.y > leg.from.y || leg.to.x <= X.door + 20 ? "Walking to the lift." : "Walking to a desk.";
  if (leg?.kind === "stay") {
    const trip = model.trips.find((t) => t.seat === a.seat);
    const carrel = frame.carrels.find((c) => c.lane === trip?.lane);
    return carrel?.last ? `In the records archive: ${carrel.last.host} (${carrel.last.status}).` : "In the records archive.";
  }
  switch (a.activity) {
    case "typing":
      return "Working at the desk on a model call.";
    case "sending":
      return "Sending a message.";
    case "receiving":
      return "Received a message.";
    case "stamping":
      return "Stamping verdicts.";
    default:
      return a.placement === "absent" ? "Not in the building yet." : a.present ? "At the desk." : "Desk empty until the agent's card is recorded.";
  }
}

export function seatInFocus(plan: OfficePlan, view: SwarmView, focus: Focus, seat: Seat): boolean {
  if (focus === "all") return true;
  if (focus.startsWith("agent:")) return seat.agentId === focus.slice(6);
  if (focus.startsWith("edge:")) return seat.agentId !== null && focus.slice(5).split("~").includes(seat.agentId);
  if (focus === "board") return seat.zone === "board";
  const pod = plan.pods.find((p) => p.key === seat.pod);
  return pod?.groupId === focus || (seat.agentId !== null && view.cards[seat.agentId]?.group === focus);
}

function toggle(current: Focus, next: Focus): Focus {
  return current === next ? "all" : next;
}

/* ------------------------------------------------------------------------------------------------ the overlay */

export interface OverlayProps {
  layout: TowerLayout;
  model: TowerModel;
  frame: TowerFrame;
  plan: OfficePlan;
  view: SwarmView;
  focus: Focus;
  onFocus: (f: Focus) => void;
  hover: string | null;
  onHover: (fn: (h: string | null) => string | null) => void;
  stats: Record<string, NodeStats>;
  tabStop: string | null;
  onTabStop: (id: string) => void;
  board: BoardResult | null;
  /** The display time the run started (the lobby clock counts from it). */
  origin: number;
}

const box = (layout: TowerLayout, x: number, y: number, w: number, h: number): CSSProperties => ({
  left: `${(x / layout.w) * 100}%`,
  top: `${(y / layout.h) * 100}%`,
  width: `${(w / layout.w) * 100}%`,
  height: `${(h / layout.h) * 100}%`,
});

export function Overlay(p: OverlayProps) {
  const { layout, frame, plan, view, focus, onFocus } = p;
  const rows = layout.rows;
  const roof = rows[layout.roof] as Row;
  const upper = rows[layout.upper] as Row;
  const ground = rows[layout.ground] as Row;
  const basement = rows[layout.basement] as Row;
  // a floor's filter is offered only once its agent is in the building at this frame
  const here = (agentId: string | undefined) => {
    const seat = agentId ? plan.byAgent[agentId] : undefined;
    return seat !== undefined && frame.agents[seat]?.present === true ? agentId : undefined;
  };
  const firstRed = here(view.groups.find((g) => g.kind === "red_team")?.agents[0]?.agentId);
  const analyst = here(view.groups.find((g) => g.kind === "analyst")?.agents[0]?.agentId);
  const boardHere = Object.values(frame.agents).some((x) => x.present && plan.seats[x.seat]?.zone === "board");
  const at = (x: number, y: number) => pct(layout, x, y);

  return (
    <div className="pointer-events-none absolute inset-0">
      {/* room and floor labels */}
      <FloorTag style={at(X.in0 + 6, roof.top + 50)} label="R" name="Board room" on={focus === "board"} onClick={boardHere ? () => onFocus(toggle(focus, "board")) : null} aria="Board room: show the board's messages" />
      <RoomTag style={at(660, roof.top + 52)}>Decision deck</RoomTag>
      <FloorTag style={at(X.in0 + 6, upper.top + 3)} label={upper.label} name="Red team" tone="danger" on={firstRed !== undefined && focus === `agent:${firstRed}`} onClick={firstRed ? () => onFocus(toggle(focus, `agent:${firstRed}`)) : null} aria="Red team: show the red team's messages" />
      <FloorTag style={at(608, upper.top + 3)} name="Home office" on={analyst !== undefined && focus === `agent:${analyst}`} onClick={analyst ? () => onFocus(toggle(focus, `agent:${analyst}`)) : null} aria="Home office: show the analyst's messages" />
      {layout.rivalRows.map((r) => {
        const row = rows[r] as Row;
        const pod = row.pod ? plan.pods.find((x) => x.key === row.pod) : undefined;
        if (!pod || frame.vacant.includes(pod.key)) {
          return (
            <FloorTag key={r} style={at(X.in0 + 6, row.top + 3)} label={row.label} name="Vacant" muted onClick={null} aria={`${row.label}: vacant`}>
              <span className="text-faint"> until a rival&apos;s lane is recorded</span>
            </FloorTag>
          );
        }
        const src = frame.sources[pod.key];
        const tally = frame.laneTally[pod.key];
        const checked = tally ? tally.supported + tally.partly + tally.withheld : 0;
        return (
          <FloorTag
            key={r}
            style={at(X.in0 + 6, row.top + 3)}
            label={row.label}
            name={shortName(pod.label)}
            team={pod.team}
            on={pod.groupId !== null && focus === pod.groupId}
            onClick={pod.groupId ? () => onFocus(toggle(focus, pod.groupId ?? "all")) : null}
            aria={`${pod.label}: show this team's messages`}
          >
            {src && src.fetched > 0 && (
              <span className="font-mono tabular text-muted">
                {" "}
                {src.fetched} {src.fetched === 1 ? "source" : "sources"}
              </span>
            )}
            {checked > 0 && tally && (
              <span className="font-mono tabular text-muted">
                , {tally.supported + tally.partly} of {checked} claims held
              </span>
            )}
          </FloorTag>
        );
      })}
      <RoomTag style={at(X.in0 + 42, ground.top + 3)}>
        <span className="font-semibold text-ink-2">G</span> Lobby <span className="font-mono tabular text-muted">{Number.isFinite(frame.t) ? clockLabel(p.model.back(Math.max(frame.t, p.origin)), p.model.back(p.origin)) : ""}</span>
      </RoomTag>
      <RoomTag style={at(432, ground.top + 3)}>Dossier presses</RoomTag>
      <RoomTag style={at(612, ground.top + 3)}>Notary booth</RoomTag>
      <RoomTag style={at(912, ground.top + 3)}>Price to win</RoomTag>
      <RoomTag style={at(X.in0 + 54, basement.top + 2)}>
        <span className="font-semibold text-ink-2">B1</span> Records archive
      </RoomTag>
      <RoomTag style={at(652, basement.top + 2)}>
        Machine room{" "}
        <span className="font-mono tabular text-muted">
          {frame.calls.started} calls, {frame.calls.inFlight.length} in flight, ${frame.calls.usd.toFixed(3)}
        </span>
      </RoomTag>
      {frame.scene.endpoints.map((e) => {
        const rack = layout.racks[p.model.racks.rackOf(e)];
        return rack ? (
          <span key={e} className="tw-t-xs absolute -translate-x-1/2 font-mono text-muted" style={at(rack.x, basement.floor - 61)}>
            {e}
          </span>
        ) : null;
      })}
      <Tally layout={layout} frame={frame} />
      <LaneTickers layout={layout} frame={frame} />
      <GateSign layout={layout} frame={frame} />
      <Scoreboard layout={layout} board={frame.scores ? p.board : null} />
      <Pins layout={layout} frame={frame} plan={plan} />
      <AgentButtons {...p} />
      <HoverCard {...p} />
      <Bubbles layout={layout} frame={frame} plan={plan} view={view} focus={focus} />
      {frame.popups.map((pop) => (
        <span
          key={pop.id}
          className={cn(
            "tw-popup tw-t-xs rounded-sm px-1 font-medium shadow-1",
            pop.tone === "danger" ? "bg-danger-soft text-danger" : pop.tone === "signal" ? "bg-ink text-on-ink" : pop.tone === "mono" ? "bg-canvas font-mono text-ink-2" : "bg-canvas text-ink",
          )}
          style={at(pop.x, pop.y)}
        >
          {pop.text}
        </span>
      ))}
    </div>
  );
}

function FloorTag({
  style,
  label,
  name,
  team,
  tone,
  muted = false,
  on = false,
  onClick,
  aria,
  children,
}: {
  style: CSSProperties;
  label?: string;
  name: string;
  team?: number;
  tone?: "danger";
  muted?: boolean;
  on?: boolean;
  onClick: (() => void) | null;
  aria: string;
  children?: ReactNode;
}) {
  const body = (
    <>
      {label && <span className={cn("mr-1 rounded-xs px-1 font-mono font-semibold tabular", on ? "bg-on-ink text-ink" : "bg-ink text-on-ink")}>{label}</span>}
      {team !== undefined && <span className="mr-1 inline-block size-[0.6em] rounded-full align-middle" style={{ background: `var(--color-team-${team})` }} />}
      <span className={cn("font-semibold", muted ? "text-faint" : tone === "danger" ? "text-danger" : on ? "text-on-ink" : "text-ink")}>{name}</span>
      {children}
    </>
  );
  const cls = "tw-t-sm absolute whitespace-nowrap rounded-sm px-1 py-px";
  if (!onClick) return <span className={cn(cls, "pointer-events-none")} style={style}>{body}</span>;
  return (
    <button type="button" aria-pressed={on} aria-label={aria} onClick={onClick} className={cn(cls, "pointer-events-auto cursor-pointer text-left hover:bg-canvas/80", on ? "bg-ink [&_.text-muted]:text-on-ink/80" : "bg-canvas/70")} style={style}>
      {body}
    </button>
  );
}

function RoomTag({ style, children }: { style: CSSProperties; children: ReactNode }) {
  return (
    <span className="tw-t-xs absolute whitespace-nowrap rounded-sm bg-canvas/70 px-1 text-ink-2" style={style}>
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------------------------------------ room readouts */

function Tally({ layout, frame }: { layout: TowerLayout; frame: TowerFrame }) {
  const ground = layout.rows[layout.ground] as Row;
  const t = frame.tally;
  return (
    <span className="tw-t-xs absolute whitespace-nowrap font-mono tabular text-ink-2" style={pct(layout, 790, ground.top + 16)}>
      <span className="font-semibold text-ink">{t.supported}</span> supported <span className="font-semibold text-ink">{t.partly}</span> partly <span className="font-semibold text-danger">{t.withheld}</span> withheld
    </span>
  );
}

function LaneTickers({ layout, frame }: { layout: TowerLayout; frame: TowerFrame }) {
  return (
    <>
      {layout.rivalRows.map((r) => {
        const row = layout.rows[r] as Row;
        if (!row.pod || frame.vacant.includes(row.pod)) return null;
        const line = frame.lines[row.pod];
        if (!line) return null;
        return (
          <span key={r} className="tw-t-xs absolute flex max-w-[30%] items-center gap-1 overflow-hidden whitespace-nowrap font-mono text-muted" style={pct(layout, 600, row.top + 3)}>
            <span className="size-[0.5em] shrink-0 rounded-full bg-signal" aria-hidden />
            <span key={line} className="truncate animate-rise">
              {line}
            </span>
          </span>
        );
      })}
    </>
  );
}

function GateSign({ layout, frame }: { layout: TowerLayout; frame: TowerFrame }) {
  const basement = layout.rows[layout.basement] as Row;
  const roof = layout.rows[layout.roof] as Row;
  const h1 = frame.gates.h1;
  const h2 = frame.gates.h2;
  return (
    <>
      {h1.state !== "open" && (
        <span
          className={cn("tw-t-xs absolute whitespace-nowrap rounded-sm border px-1 font-medium", h1.state === "approved" ? "border-hairline-strong bg-canvas text-ink" : "border-danger/40 bg-danger-soft text-danger")}
          style={pct(layout, X.door + 4, basement.floor - 70)}
        >
          {h1.state === "waiting" ? `H1 Plan review: your call, waiting${h1.waitedMs !== null ? ` ${clockLabel(h1.waitedMs, 0)}` : ""}` : h1.state === "approved" ? "Plan approved" : "H1 locked until the plan is approved"}
        </span>
      )}
      {(h2.state === "waiting" || h2.state === "approved") && (
        <span
          className={cn("tw-t-xs absolute whitespace-nowrap rounded-sm border px-1 font-medium", h2.state === "approved" ? "border-hairline-strong bg-canvas text-ink" : "border-signal/50 bg-cream text-ink")}
          style={pct(layout, 664, roof.floor - 96)}
        >
          {h2.state === "waiting" ? `H2 Decision: your call, waiting${h2.waitedMs !== null ? ` ${clockLabel(h2.waitedMs, 0)}` : ""}` : "Decision recorded"}
        </span>
      )}
    </>
  );
}

function Scoreboard({ layout, board }: { layout: TowerLayout; board: BoardResult | null }) {
  const roof = layout.rows[layout.roof] as Row;
  if (!board) return null;
  const rows = [...board.rows].filter((r) => r.code).sort((a, b) => a.code.localeCompare(b.code));
  return (
    <div className="tw-t-xs absolute flex items-end gap-[0.6cqw] rounded-sm bg-canvas/85 px-1.5 py-1 shadow-1 animate-pop" style={pct(layout, 150, roof.top + 58)}>
      {rows.map((r) => (
        <div key={r.group} className="flex flex-col items-center gap-0.5">
          <span className="font-mono tabular text-ink">{Math.round(r.share * 100)}%</span>
          <span className="block h-[0.35em] w-[3.2cqw] overflow-hidden rounded-full bg-surface-2">
            <span className="tw-bar block h-full rounded-full bg-chart-mid" style={{ width: `${Math.max(4, Math.round(r.share * 100))}%` }} />
          </span>
          <span className="font-mono font-semibold text-ink-2">
            {r.code}
            {r.incumbent && <span className="ml-0.5 text-faint">inc.</span>}
          </span>
        </div>
      ))}
      <span className="ml-1 max-w-[12cqw] whitespace-normal text-faint">
        {board.members} evaluators, {board.runs} runs. Simulated.
      </span>
    </div>
  );
}

function Pins({ layout, frame, plan }: { layout: TowerLayout; frame: TowerFrame; plan: OfficePlan }) {
  const upper = layout.rows[layout.upper] as Row;
  const pins = frame.pins.slice(-4);
  if (pins.length === 0) return null;
  return (
    <div className="absolute flex gap-[0.4cqw]" style={{ ...pct(layout, 856, upper.top + 13), width: `${(226 / layout.w) * 100}%` }}>
      {pins.map((pin) => {
        const pod = plan.pods.find((p) => p.key === pin.pod);
        return (
          <span key={pin.id} className="tw-t-xs min-w-0 flex-1 rounded-xs bg-canvas px-1 py-0.5 leading-tight text-ink-2 shadow-1 animate-pop">
            <span className="block truncate font-semibold text-ink">
              {pod && <span className="mr-0.5 inline-block size-[0.55em] rounded-full align-middle" style={{ background: `var(--color-team-${pod.team})` }} />}
              {pod ? shortName(pod.label) : "Interview"}
            </span>
            <span className="block truncate">{pin.text}</span>
          </span>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ agents */

function AgentButtons(p: OverlayProps) {
  const { layout, frame, plan, view, focus, onFocus, onHover, model, stats, tabStop, onTabStop } = p;
  const refs = useRef(new Map<string, HTMLElement>());
  const items = readingOrder(
    Object.values(layout.seats)
      .filter((s) => frame.agents[s.id]?.placement === "seat" || frame.agents[s.id]?.leg?.kind === "stay")
      .map((s) => ({ id: s.id, row: s.row, x: s.x })),
  );
  const stop = tabStop && items.some((i) => i.id === tabStop) ? tabStop : (items[0]?.id ?? null);
  const move = useCallback(
    (to: string | null) => {
      if (!to) return;
      onTabStop(to);
      refs.current.get(to)?.focus();
    },
    [onTabStop],
  );
  const onKey = (id: string) => (e: KeyboardEvent) => {
    const dir: Record<string, NavDir> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
    if (dir[e.key]) {
      e.preventDefault();
      move(nearestInDirection(items, id, dir[e.key] as NavDir));
    } else if (e.key === "Home") {
      e.preventDefault();
      move(items[0]?.id ?? null);
    } else if (e.key === "End") {
      e.preventDefault();
      move(items.at(-1)?.id ?? null);
    } else if (e.key === "Escape") {
      onFocus("all");
    }
  };
  return (
    <>
      {items.map(({ id }) => {
        const seat = plan.seats[id];
        const spot = layout.seats[id];
        const a = frame.agents[id];
        if (!seat || !spot || !a) return null;
        const row = layout.rows[spot.row] as Row;
        const away = a.leg?.kind === "stay";
        const x = away ? a.leg?.from.x ?? spot.x : spot.x;
        const floor = away ? a.leg?.from.y ?? row.floor : row.floor;
        // an agent not in the building yet at this frame shows no card, name or filter
        const card = a.present && seat.agentId ? view.cards[seat.agentId] : undefined;
        const s = card && seat.agentId ? stats[seat.agentId] : undefined;
        const words = towerActivityWords(a, frame, model);
        const label = `${a.present ? seatName(seat, plan, view) : `${ROLE_NAME[seat.role]} (not in the building yet)`}. ${words}${s ? ` ${s.sent} sent, ${s.received} received.` : ""}${card ? " Show this agent's messages." : ""}`;
        const common = {
          ref: (el: HTMLElement | null) => {
            if (el) refs.current.set(id, el);
            else refs.current.delete(id);
          },
          tabIndex: id === stop ? 0 : -1,
          "aria-label": label,
          "data-agent": seat.agentId ?? id,
          onKeyDown: onKey(id),
          onFocus: () => {
            onTabStop(id);
            onHover(() => id);
          },
          onBlur: () => onHover((h) => (h === id ? null : h)),
          onPointerEnter: () => onHover(() => id),
          onPointerLeave: () => onHover((h) => (h === id ? null : h)),
          className: "tw-agent-btn pointer-events-auto",
          style: box(layout, x, floor - 2, 40, 44),
        };
        if (card && seat.agentId) {
          const target = `agent:${seat.agentId}`;
          return <button key={id} type="button" {...common} aria-pressed={focus === target} onClick={() => onFocus(toggle(focus, target))} />;
        }
        return <div key={id} role="img" {...common} />;
      })}
    </>
  );
}

function Bubbles({ layout, frame, plan, view, focus }: { layout: TowerLayout; frame: TowerFrame; plan: OfficePlan; view: SwarmView; focus: Focus }) {
  return (
    <>
      {frame.bubbles.map((b) => {
        const seat = plan.seats[b.seat];
        const spot = layout.seats[b.seat];
        if (!seat || !spot) return null;
        const row = layout.rows[spot.row] as Row;
        const edge = spot.x < 220 ? "left" : spot.x > layout.w - 240 ? "right" : "mid";
        const card = seat.agentId ? view.cards[seat.agentId] : undefined;
        const team = card && seat.zone === "pod" ? `${shortName(card.groupLabel)} ` : "";
        const dim = !seatInFocus(plan, view, focus, seat);
        return (
          <div
            key={`b-${b.msgId}`}
            className={cn("absolute w-max max-w-[16cqw] -translate-y-full", edge === "mid" ? "-translate-x-1/2" : edge === "right" ? "-translate-x-[88%]" : "-translate-x-[12%]", dim && "opacity-40")}
            style={pct(layout, spot.x, row.floor - 44)}
          >
            <div className={cn("tw-t-xs animate-pop rounded-md border bg-canvas px-1.5 py-1 leading-snug text-ink-2 shadow-2", b.failed ? "border-danger/60" : "border-hairline-strong")}>
              {seat.team >= 0 && <span className="mr-1 inline-block size-[0.6em] rounded-full align-middle" style={{ background: `var(--color-team-${seat.team})` }} />}
              <span className="font-semibold text-ink">
                {team}
                {ROLE_NAME[seat.role]}
              </span>{" "}
              {b.rejected ? <span className="text-danger">Not run: budget spent</span> : b.rated > 0 ? `Rated ${b.rated} offerors` : firstWords(b.text, 6)}
              {(b.cites > 0 || b.dropped > 0) && !b.rejected && (
                <span className="ml-1 font-mono text-faint">
                  {b.cites > 0 && `${b.cites} cites`}
                  {b.dropped > 0 && <span className="text-danger"> -{b.dropped} dropped</span>}
                </span>
              )}
              {b.failed && !b.rejected && <span className="ml-1 font-medium text-danger">failed</span>}
            </div>
          </div>
        );
      })}
    </>
  );
}

/** The model time behind a message, for the hover card. */
export function modelTime(ms: number): string {
  return `${seconds(ms)} model time`;
}

/* ------------------------------------------------------------------------------------------------ the hover card */

/** The hovered or focused agent's card, beside its desk: only for an agent present at the frame, with its message
 *  counts up to the cursor (the stats the tower is given). */
function HoverCard({ layout, frame, plan, view, hover, stats }: OverlayProps) {
  const shown = agentCardAt(frame, plan, view, hover);
  const spot = hover ? layout.seats[hover] : undefined;
  if (!shown || !spot) return null;
  const row = layout.rows[spot.row] as Row;
  const right = spot.x > layout.w * 0.62;
  const below = row.floor < layout.h * 0.35;
  return (
    <div
      role="tooltip"
      className={cn("absolute z-[var(--z-tooltip)] w-72 animate-fade-in", right ? "-translate-x-full" : "", below ? "" : "-translate-y-full")}
      style={pct(layout, spot.x, below ? row.floor + 4 : row.floor - 48)}
    >
      <AgentCardTip card={shown.card} rival={shown.rival} stats={stats[shown.card.agentId]} />
    </div>
  );
}
