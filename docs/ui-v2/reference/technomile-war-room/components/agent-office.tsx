"use client";

import { ArrowCounterClockwise, Pause, Play } from "@phosphor-icons/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import type { InspectCall } from "@/lib/live/inspect";
import type { BoardResult } from "@/lib/contracts/run-events";
import {
  buildSchedule,
  DOOR,
  FLIGHT_MS,
  frameAt,
  iso,
  liveClock,
  OFFICE_H,
  OFFICE_W,
  planOffice,
  pointAlong,
  replayClock,
  sentFirst,
  stageAt,
  warpKeys,
  WALL_H,
  type BeatClock,
  type Flight,
  type OfficeFrame,
  type OfficePlan,
  type OfficeRecord,
  type Pt,
  type Seat,
  type SeatFrame,
  type Verdict,
  type Walk,
  BOARD_TABLE,
  FLOOR_D,
  FLOOR_W,
  KIOSK_SLOTS,
  RED_SEAT,
  VERIFY_SEAT,
  ANALYST_SEAT,
} from "@/lib/war-room/office";
import { shortName, type SwarmView } from "@/lib/war-room/swarm";
import { firstWords, nodeStats, type Focus } from "@/lib/war-room/swarm-graph";

import { Avatar, AvatarBadge, ROLE_NAME, ROLE_NOTE } from "./office-avatars";
import { AgentCardTip } from "./agent-card-tip";
import { useReducedMotion } from "./use-reduced-motion";

const SPEEDS = [1, 2, 4] as const;
const TICK_MS = 100;

/* ------------------------------------------------------------------------------------------------ geometry */

type S = { sx: number; sy: number };
const pts = (list: readonly S[]) => list.map((p) => `${p.sx},${p.sy}`).join(" ");
const at = (x: number, y: number, z = 0) => iso({ x, y }, z);

function rect(x0: number, y0: number, x1: number, y1: number, z = 0): string {
  return pts([at(x0, y0, z), at(x1, y0, z), at(x1, y1, z), at(x0, y1, z)]);
}

/** An axis-aligned box on the floor: its top and the two faces the viewer sees. */
function Box({ x0, y0, x1, y1, h, z = 0, className, top, left, right }: { x0: number; y0: number; x1: number; y1: number; h: number; z?: number; className?: string; top: string; left: string; right: string }) {
  return (
    <g className={className}>
      <polygon points={pts([at(x0, y1, z), at(x1, y1, z), at(x1, y1, z + h), at(x0, y1, z + h)])} className={left} />
      <polygon points={pts([at(x1, y0, z), at(x1, y1, z), at(x1, y1, z + h), at(x1, y0, z + h)])} className={right} />
      <polygon points={rect(x0, y0, x1, y1, z + h)} className={top} />
    </g>
  );
}

const DESK = { top: "fill-canvas stroke-hairline-strong", left: "fill-surface-2 stroke-hairline-strong", right: "fill-hairline stroke-hairline-strong" };
const DESK_H = 18;
/** Characters are drawn at this scale on the floor. */
const AV = 1.3;

/* ------------------------------------------------------------------------------------------------ clock */

interface Replay {
  base: number;
  wall: number;
  playing: boolean;
  speed: (typeof SPEEDS)[number];
}

/** A replay's display time at `perf` (a `performance.now()` reading). */
function replayAt(r: Replay, perf: number): number {
  return r.playing ? r.base + Math.max(0, perf - r.wall) * r.speed : r.base;
}

function replayNow(r: Replay): number {
  return replayAt(r, performance.now());
}

/* ------------------------------------------------------------------------------------------------ the view */

/** Where a replay of the office stands, for the thread and the board table under it. */
export interface OfficeReplay {
  sent: Set<string>;
  scores: boolean;
}

export interface OfficeLive {
  settledSeq: number;
  skewMs: number;
}

/**
 * A full-run replay drives the office: its display clock (playback time at the replay's speed, so a walk or a
 * bubble keeps its length at any speed while a model call keeps its recorded share), the display time at the
 * cursor and between ticks, and the whole record, so an agent is shown at its desk from the model call's recorded
 * start, before the message it produced has been delivered.
 */
export interface OfficeDrive {
  clock: BeatClock;
  t: number;
  now: () => number;
  playing: boolean;
  view: SwarmView;
  record: OfficeRecord;
  /** The recorded time a display time shows (the inverse of `clock.at`); Infinity for the final frame. */
  recordedAt: (display: number) => number;
  /** Every recorded model call of the run: a view shows a call from its start (createdAt minus latency) to its end. */
  calls: readonly InspectCall[];
  /** Move the run's replay to a recorded time. */
  seek: (recorded: number) => void;
}

/**
 * The agent office: the swarm and the research that fed it, drawn as an office floor. `live` (a running run) plays
 * new events as they arrive; `driven` (a full-run replay) draws the run at the replay's cursor; otherwise the office
 * shows the run's final state and can replay it (`onReplayRun`: the run page's full-run replay instead of the office's
 * own). The thread below stays the accessible, complete record; `onReplay` tells it which messages a replay has
 * reached and whether the board's scores are up yet (null = not replaying: everything).
 */
export function AgentOffice({
  view,
  record,
  live,
  driven = null,
  onReplayRun,
  focus,
  onFocus,
  onReplay,
  recordError,
}: {
  view: SwarmView;
  record: OfficeRecord;
  live: OfficeLive | null;
  driven?: OfficeDrive | null;
  onReplayRun?: (() => void) | undefined;
  focus: Focus;
  onFocus: (f: Focus) => void;
  onReplay: (r: OfficeReplay | null) => void;
  recordError: string | null;
}) {
  const reduced = useReducedMotion();
  // the floor holds the seats known by now; a replay schedules beats from the whole record on its own clock
  const plan = useMemo(() => planOffice(view, record), [view, record]);
  const beatView = driven?.view ?? view;
  const beatRecord = driven?.record ?? record;
  const driveClock = driven?.clock ?? null;
  const replayTimeline = useMemo(() => replayClock(warpKeys(view, record)), [view, record]);
  const clock = useMemo(() => driveClock ?? (live ? liveClock(live.skewMs) : replayTimeline), [driveClock, live, replayTimeline]);
  const settled = driveClock ? 0 : live ? live.settledSeq : 0;
  const sched = useMemo(() => buildSchedule(plan, beatView, beatRecord, clock, settled), [plan, beatView, beatRecord, clock, settled]);

  // a replay belongs to a finished run: a run that is live again shows live
  const [stored, setReplay] = useState<Replay | null>(null);
  const replay = live || driven ? null : stored;

  // the clock the frame is drawn at, read by the ticker (never during render); a full-run replay brings its own
  const [wall, setWall] = useState({ ms: 0, perf: 0 });
  const t = driven ? driven.t : replay ? replayAt(replay, wall.perf) : live ? wall.ms : Infinity;
  const moving = driven ? driven.playing : (replay?.playing ?? false) || (live !== null && t < sched.end + 500);
  const end = sched.end;
  useEffect(() => {
    if (!moving || driven) return;
    const read = () => {
      const perf = performance.now();
      setWall({ ms: Date.now(), perf });
      // a replay stops at the end of the run
      setReplay((r) => (r && r.playing && replayAt(r, perf) >= end ? { ...r, base: end, playing: false } : r));
    };
    const first = window.setTimeout(read, 0);
    const h = window.setInterval(read, TICK_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(h);
    };
  }, [moving, end, driven]);

  const frame = useMemo(() => frameAt(plan, sched, t), [plan, sched, t]);
  const shownSent = replay || driven ? frame.sent : -1;
  // the thread follows a replay: a new set only when another message has been sent
  const scoresUp = frame.scores;
  const replayState = useMemo(() => (shownSent < 0 ? null : { sent: sentFirst(sched, shownSent), scores: scoresUp }), [shownSent, sched, scoresUp]);
  useEffect(() => onReplay(replayState), [replayState, onReplay]);

  const driveNow = driven?.now ?? null;
  const now = useMemo(() => driveNow ?? (() => (replay ? replayAt(replay, performance.now()) : live ? Date.now() : Infinity)), [driveNow, replay, live]);
  const running = moving && !reduced;

  const stats = useMemo(() => nodeStats(view, view.messages), [view]);
  const stage = stageAt(sched, t);
  const [hover, setHover] = useState<string | null>(null);
  const hovered = hover ? plan.seats[hover] : undefined;

  const playing = replay?.playing ?? false;
  const startReplay = () => {
    const base = replay && replay.base < sched.end ? replay.base : 0;
    setReplay({ base, wall: performance.now(), playing: true, speed: replay?.speed ?? 1 });
  };
  const pauseReplay = () => replay && setReplay({ ...replay, base: replayNow(replay), playing: false });
  const scrub = (ms: number) => setReplay((r) => ({ base: ms, wall: performance.now(), playing: false, speed: r?.speed ?? 1 }));
  const cycleSpeed = () =>
    setReplay((r) => {
      const speed = SPEEDS[(SPEEDS.indexOf(r?.speed ?? 1) + 1) % SPEEDS.length] ?? 1;
      return r ? { ...r, base: replayNow(r), wall: performance.now(), speed } : { base: sched.end, wall: performance.now(), playing: false, speed };
    });

  const agentsIn = new Set(frame.flights.map((f) => f.from));
  const dimmed = (seat: Seat) => !seatInFocus(plan, view, focus, seat) && !agentsIn.has(seat.id);

  return (
    <div
      className="rounded-lg border border-hairline bg-canvas"
      data-agent-office
      data-office-paused={(driven ? !driven.playing : replay !== null && !replay.playing) ? "" : undefined}
      data-office-driven={driven ? "" : undefined}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-hairline px-4 py-2.5">
        <Caption plan={plan} view={view} record={record} frame={frame} stage={stage} live={live !== null} replaying={replay !== null || (driven !== null && Number.isFinite(driven.t))} />
        {!live && !driven && onReplayRun && (
          <button
            type="button"
            onClick={onReplayRun}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline-strong px-3 text-xs font-medium text-ink hover:bg-surface"
          >
            <Play size={14} weight="fill" aria-hidden />
            Replay the run
          </button>
        )}
        {!live && !driven && !onReplayRun && sched.end > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              onClick={playing ? pauseReplay : startReplay}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline-strong px-3 font-medium text-ink hover:bg-surface"
            >
              {playing ? <Pause size={14} weight="fill" aria-hidden /> : <Play size={14} weight="fill" aria-hidden />}
              {playing ? "Pause" : replay && replay.base < sched.end ? "Resume" : "Replay the run"}
            </button>
            <input
              type="range"
              min={0}
              max={Math.ceil(sched.end / TICK_MS)}
              value={Math.round(Math.min(t, sched.end) / TICK_MS)}
              onChange={(e) => scrub(Number(e.currentTarget.value) * TICK_MS)}
              aria-label="Office replay position"
              aria-valuetext={`${frame.sent} of ${view.messages.length} messages sent`}
              className="w-36 accent-[var(--color-signal)] sm:w-48"
            />
            <span className="w-12 font-mono tabular text-muted">{formatClock(Math.min(t, sched.end))}</span>
            <button type="button" onClick={cycleSpeed} aria-label={`Replay speed ${replay?.speed ?? 1}x`} className="h-8 rounded-md border border-hairline px-2 font-mono tabular text-ink-2 hover:bg-surface">
              {replay?.speed ?? 1}x
            </button>
            {replay && (
              <button type="button" onClick={() => setReplay(null)} className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-ink-2 hover:bg-surface">
                <ArrowCounterClockwise size={14} aria-hidden />
                Final state
              </button>
            )}
          </div>
        )}
      </div>

      <div className="relative overflow-hidden">
        <svg viewBox={`0 0 ${OFFICE_W} ${OFFICE_H}`} className="block h-auto w-full select-none" role="group" aria-label={officeLabel(plan, view, record)}>
          <Floor plan={plan} view={view} focus={focus} onFocus={onFocus} />
          <Rooms frame={frame} stage={stage} board={view.board} reduced={reduced} />
          {plan.order.map((id) => {
            const seat = plan.seats[id];
            const sf = frame.seats[id];
            if (!seat || !sf) return null;
            return (
              <Workstation
                key={id}
                seat={seat}
                sf={sf}
                view={view}
                dim={dimmed(seat)}
                on={seat.agentId !== null && focus === `agent:${seat.agentId}`}
                stats={seat.agentId ? stats[seat.agentId] : undefined}
                onFocus={onFocus}
                focus={focus}
                onHover={setHover}
                record={record}
              />
            );
          })}
          <PodLabels plan={plan} />
          {plan.order.map((id) => {
            const seat = plan.seats[id];
            const sf = frame.seats[id];
            if (!seat || !sf || !(sf.away || sf.walk)) return null;
            return <Mover key={`m-${id}`} seat={seat} sf={sf} now={now} running={running} reduced={reduced} />;
          })}
          {!reduced && frame.flights.map((f) => <Envelope key={f.id} flight={f} plan={plan} now={now} running={running} />)}
        </svg>
        <Overlays plan={plan} frame={frame} />
        {hovered && <SeatTip seat={hovered} view={view} stats={hovered.agentId ? stats[hovered.agentId] : undefined} frame={frame} record={record} />}
      </div>

      <Legend plan={plan} />
      <p className="border-t border-hairline px-4 py-2 text-xs text-muted">
        Every movement is a recorded event: a model call is the agent at its desk, a message is a speech bubble and an envelope, a burst of S4 fetches is
        the rival&apos;s researcher at the web terminal, an S7 verdict is a stamp. Hover or focus an agent for its card; click an agent or a team to show
        only those messages in the thread below.
        {recordError && <span className="text-danger"> Research and verification events could not be read ({recordError}); the swarm still shows.</span>}
      </p>
    </div>
  );
}

function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function officeLabel(plan: OfficePlan, view: SwarmView, record: OfficeRecord): string {
  return `Agent office: ${plan.pods.length} rival teams, ${Object.keys(view.cards).length} agents, ${record.fetches.length} sources fetched, ${record.verifies.length} claims verified, ${view.messages.length} messages. The message thread below holds every message in full.`;
}

function seatInFocus(plan: OfficePlan, view: SwarmView, focus: Focus, seat: Seat): boolean {
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

function onActivate(fn: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

/* ------------------------------------------------------------------------------------------------ the floor */

const Floor = memo(function Floor({ plan, view, focus, onFocus }: { plan: OfficePlan; view: SwarmView; focus: Focus; onFocus: (f: Focus) => void }) {
  const grid: ReactNode[] = [];
  for (let x = 1; x < FLOOR_W; x++) {
    const a = at(x, 0);
    const b = at(x, FLOOR_D);
    grid.push(<line key={`gx${x}`} x1={a.sx} y1={a.sy} x2={b.sx} y2={b.sy} />);
  }
  for (let y = 1; y < FLOOR_D; y++) {
    const a = at(0, y);
    const b = at(FLOOR_W, y);
    grid.push(<line key={`gy${y}`} x1={a.sx} y1={a.sy} x2={b.sx} y2={b.sy} />);
  }
  return (
    <g>
      {/* back walls: left (the web terminal's) and right (the door, the verification desk and the board room) */}
      <polygon points={pts([at(0, 0), at(0, FLOOR_D), at(0, FLOOR_D, WALL_H), at(0, 0, WALL_H)])} className="fill-surface-2" />
      <polygon points={pts([at(0, 0), at(FLOOR_W, 0), at(FLOOR_W, 0, WALL_H), at(0, 0, WALL_H)])} className="fill-surface" />
      <polyline points={pts([at(0, FLOOR_D, WALL_H), at(0, 0, WALL_H), at(FLOOR_W, 0, WALL_H)])} fill="none" className="stroke-hairline-strong" strokeWidth={1.5} />
      <line x1={at(0, 0).sx} y1={at(0, 0).sy} x2={at(0, 0, WALL_H).sx} y2={at(0, 0, WALL_H).sy} className="stroke-hairline-strong" />
      {/* skirting */}
      <polygon points={pts([at(0, 0), at(0, FLOOR_D), at(0, FLOOR_D, 5), at(0, 0, 5)])} className="fill-hairline" />
      <polygon points={pts([at(0, 0), at(FLOOR_W, 0), at(FLOOR_W, 0, 5), at(0, 0, 5)])} className="fill-hairline" />
      <polygon points={rect(0, 0, FLOOR_W, FLOOR_D)} className="fill-canvas stroke-hairline-strong" />
      <g className="stroke-hairline-soft" strokeWidth={1}>
        {grid}
      </g>

      {/* the door */}
      <polygon points={pts([at(DOOR.x - 0.5, 0), at(DOOR.x + 0.5, 0), at(DOOR.x + 0.5, 0, 66), at(DOOR.x - 0.5, 0, 66)])} className="fill-hairline stroke-hairline-strong" />
      <circle cx={at(DOOR.x + 0.32, 0, 32).sx} cy={at(DOOR.x + 0.32, 0, 32).sy} r={1.6} className="fill-faint" />

      {/* rival pods: a tinted rug each, clickable to filter the thread to that rival */}
      {plan.pods.map((pod) => {
        const c = pod.center;
        const selectable = pod.groupId !== null;
        const on = selectable && focus === pod.groupId;
        return (
          <g
            key={pod.key}
            data-pod={pod.key}
            {...(selectable && pod.groupId
              ? {
                  role: "button",
                  tabIndex: 0,
                  "aria-pressed": on,
                  "aria-label": `${pod.label}: show this team's messages`,
                  onClick: () => onFocus(toggle(focus, pod.groupId ?? "all")),
                  onKeyDown: onActivate(() => onFocus(toggle(focus, pod.groupId ?? "all"))),
                  className: "cursor-pointer outline-none [&:focus-visible>polygon]:stroke-signal",
                }
              : { "aria-hidden": true })}
          >
            <polygon
              points={rect(c.x - 3.05, c.y - 1.95, c.x + 2.0, c.y + 2.05)}
              style={{ fill: `color-mix(in oklab, var(--color-team-${pod.team}) ${on ? 34 : 20}%, var(--color-canvas))` }}
              className={cn(on ? "stroke-ink" : "stroke-[color-mix(in_oklab,var(--color-ink)_14%,transparent)]")}
              strokeWidth={on ? 1.6 : 1}
            />
          </g>
        );
      })}

      {/* the red-team corner */}
      <polygon points={rect(RED_SEAT.x - 1.6, RED_SEAT.y - 1.3, RED_SEAT.x + 3.0, RED_SEAT.y + 2.2)} style={{ fill: "color-mix(in oklab, var(--color-danger) 10%, var(--color-canvas))" }} className="stroke-[color-mix(in_oklab,var(--color-danger)_35%,transparent)]" strokeDasharray="4 3" />
      <FloorLabel p={{ x: RED_SEAT.x + 1.6, y: RED_SEAT.y + 2.55 }} text="Red team" className="fill-danger" />

      {/* the board room: glass walls with a doorway on the corridor side */}
      <g
        data-room="board"
        role="button"
        tabIndex={0}
        aria-pressed={focus === "board"}
        aria-label="Board room: show the board's messages"
        onClick={() => onFocus(toggle(focus, "board"))}
        onKeyDown={onActivate(() => onFocus(toggle(focus, "board")))}
        className="cursor-pointer outline-none [&:focus-visible>polygon]:stroke-signal"
      >
        <polygon points={rect(14.6, 0, FLOOR_W, 4.7)} className={cn(focus === "board" ? "fill-surface-2 stroke-ink" : "fill-surface stroke-hairline-strong")} />
      </g>
      <FloorLabel p={{ x: 20.2, y: 4.35 }} text="Board room" className="fill-ink-2" />
      <FloorLabel p={{ x: (ANALYST_SEAT.x + 11.1) / 2 + 0.4, y: 2.3 }} text={view.groups.find((g) => g.kind === "analyst")?.label ?? "Home team"} className="fill-ink-2" />
    </g>
  );
});

/** Each rival's name under the front corner of its pod, drawn over the desks so a pod in front never hides it. */
const PodLabels = memo(function PodLabels({ plan }: { plan: OfficePlan }) {
  return (
    <g aria-hidden className="pointer-events-none">
      {plan.pods.map((pod) => {
        const lp = at(pod.center.x + 2.0, pod.center.y + 2.05);
        return (
          <text
            key={pod.key}
            x={lp.sx}
            y={lp.sy + 20}
            textAnchor="middle"
            paintOrder="stroke"
            strokeWidth={4}
            strokeLinejoin="round"
            style={{ fill: `color-mix(in oklab, var(--color-team-${pod.team}) 45%, var(--color-ink))`, stroke: "var(--color-canvas)" }}
            className="text-[13px] font-bold"
          >
            {shortName(pod.label)}
          </text>
        );
      })}
    </g>
  );
});

function FloorLabel({ p, text, className }: { p: Pt; text: string; className?: string }) {
  const s = at(p.x, p.y);
  return (
    <text x={s.sx} y={s.sy} textAnchor="middle" className={cn("pointer-events-none text-[12px] font-semibold", className)}>
      {text}
    </text>
  );
}

/** The rooms' working parts: the web terminal, the verification desk with its stamp and tally, the board table. */
function Rooms({ frame, stage, board, reduced }: { frame: OfficeFrame; stage: string | null; board: BoardResult | null; reduced: boolean }) {
  const browsing = Object.values(frame.seats).some((s) => s.activity === "browsing");
  const terminalOn = browsing || stage === "S4";
  const verifyOn = frame.stamp !== null || stage === "S7";
  const y0 = KIOSK_SLOTS[0]?.y ?? 3.7;
  const y1 = KIOSK_SLOTS.at(-1)?.y ?? 8.7;
  const screen = (a: number, b: number, z0: number, z1: number) => pts([at(0, a, z0), at(0, b, z0), at(0, b, z1), at(0, a, z1)]);
  const tallyAt = at(VERIFY_SEAT.x + 0.2, 0, WALL_H - 24);
  const table = BOARD_TABLE;
  const rows = board ? [...board.rows].filter((r) => r.code).sort((a, b) => a.code.localeCompare(b.code)) : [];
  return (
    <g>
      {/* web terminal: a wall of screens; lit while a researcher is at it or S4 is running */}
      <polygon points={screen(y0 - 0.7, y1 + 0.7, 18, 84)} className="fill-[var(--color-office-device)]" />
      <polygon points={screen(y0 - 0.55, y1 + 0.55, 22, 80)} className={cn("transition-opacity duration-[var(--duration-slow)]", terminalOn ? "fill-signal opacity-25" : "fill-canvas opacity-10")} />
      {[0, 1, 2].map((i) => {
        const a = y0 - 0.4 + i * ((y1 - y0 + 0.8) / 3);
        const b = a + (y1 - y0 + 0.8) / 3 - 0.2;
        return (
          <g key={i}>
            <polygon points={screen(a, b, 28, 74)} className={cn(terminalOn ? "fill-canvas opacity-90" : "fill-canvas opacity-30")} />
            <polygon points={screen(a, b, 66, 74)} className="fill-hairline-strong" />
            {[0, 1, 2].map((j) => (
              <polygon key={j} points={screen(a + 0.15, a + 0.15 + (b - a) * (0.75 - j * 0.18), 56 - j * 9, 59 - j * 9)} className={cn(terminalOn ? "fill-faint" : "fill-hairline")} />
            ))}
          </g>
        );
      })}
      <WallLabel s={at(0, (y0 + y1) / 2, WALL_H + 14)} text="Web terminal" on={terminalOn} />

      {/* verification: a sign with the running tally of verdicts */}
      <WallLabel s={at(VERIFY_SEAT.x + 0.2, 0, WALL_H - 6)} text="Verification" on={verifyOn} />
      <g className="font-mono text-[11px] tabular">
        <text x={tallyAt.sx} y={tallyAt.sy} textAnchor="middle" className="fill-ink-2">
          <tspan className="fill-ink font-semibold">{frame.tally.supported}</tspan> supported{" "}
          <tspan className="fill-ink font-semibold">{frame.tally.partly}</tspan> partly{" "}
          <tspan className="fill-danger font-semibold">{frame.tally.withheld}</tspan> withheld
        </text>
      </g>
      <Stamp frame={frame} reduced={reduced} />

      {/* the board-room table, with each offeror's simulated share once the board has scored */}
      <Box x0={table.x - 1.9} y0={table.y - 0.45} x1={table.x + 1.9} y1={table.y + 0.45} h={DESK_H} top="fill-surface stroke-hairline-strong" left="fill-surface-2 stroke-hairline-strong" right="fill-hairline stroke-hairline-strong" />
      {frame.scores &&
        rows.map((r, i) => {
          const s = at(table.x - 1.5 + (i * 3.0) / Math.max(1, rows.length - 1), table.y + 0.95, 0);
          return (
            <g key={r.group} transform={`translate(${s.sx} ${s.sy})`} className="animate-pop">
              <line x1={0} y1={0} x2={0} y2={-8} className="stroke-ink-2" strokeWidth={1.4} />
              <rect x={-19} y={-23} width={38} height={15} rx={3} className="fill-ink" />
              <text x={0} y={-12.5} textAnchor="middle" className="fill-on-ink font-mono text-[10px] font-semibold tabular">
                {r.code} {Math.round(r.share * 100)}%
              </text>
            </g>
          );
        })}
    </g>
  );
}

function WallLabel({ s, text, on }: { s: S; text: string; on: boolean }) {
  return (
    <g>
      <text x={s.sx} y={s.sy} textAnchor="middle" className={cn("text-[12px] font-semibold", on ? "fill-accent" : "fill-muted")}>
        {text}
      </text>
    </g>
  );
}

const VERDICT_LABEL: Record<Verdict, string> = { supported: "Supported", partly: "Partly", withheld: "Withheld" };

function Stamp({ frame, reduced }: { frame: OfficeFrame; reduced: boolean }) {
  const desk = { x: VERIFY_SEAT.x + 0.42, y: VERIFY_SEAT.y + 0.42 };
  const s = at(desk.x + 0.25, desk.y - 0.1, DESK_H);
  const stamp = frame.stamp;
  return (
    <g transform={`translate(${s.sx} ${s.sy})`} aria-hidden>
      <g key={stamp?.id ?? "rest"} className={cn("office-stamp-arm", stamp && !reduced && "is-down")}>
        <rect x={-3} y={-17} width={6} height={9} rx={2} className="fill-[var(--color-office-device)]" />
        <rect x={-6} y={-8} width={12} height={4} rx={1} className="fill-ink" />
      </g>
      {stamp && (
        <g key={`v-${stamp.id}`} className="animate-pop">
          <rect x={-38} y={-92} width={76} height={17} rx={3} className={cn(stamp.verdict === "withheld" ? "fill-danger-soft stroke-danger" : stamp.verdict === "partly" ? "fill-cream-deep stroke-cream-edge" : "fill-canvas stroke-ink-2")} strokeWidth={1.2} />
          <text x={0} y={-80} textAnchor="middle" className={cn("font-mono text-[10.5px] font-semibold", stamp.verdict === "withheld" ? "fill-danger" : "fill-ink")}>
            {/* a burst stamps many claims at once: its size, with the breakdown in the tally on the wall */}
            {stamp.count > 1 ? `${stamp.count} checked` : VERDICT_LABEL[stamp.verdict]}
          </text>
        </g>
      )}
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ desks and agents */

function Workstation({
  seat,
  sf,
  view,
  dim,
  on,
  stats,
  focus,
  onFocus,
  onHover,
  record,
}: {
  seat: Seat;
  sf: SeatFrame;
  view: SwarmView;
  dim: boolean;
  on: boolean;
  stats: ReturnType<typeof nodeStats>[string] | undefined;
  focus: Focus;
  onFocus: (f: Focus) => void;
  onHover: (fn: (h: string | null) => string | null) => void;
  record: OfficeRecord;
}) {
  const s = iso(seat.at);
  const d = { x: seat.at.x + 0.42, y: seat.at.y + 0.42 };
  const seated = sf.present && !sf.away && !sf.walk;
  const card = seat.agentId ? view.cards[seat.agentId] : undefined;
  const interactive = card !== undefined && seated;
  const typing = sf.activity === "typing";
  const board = seat.zone === "board";
  const name = card?.name ?? seatName(seat, record);
  const label = `${name}. ${activityWords(sf)}${stats ? ` ${stats.sent} sent, ${stats.received} received.` : ""}${interactive ? " Show this agent's messages." : ""}`;
  const select = () => interactive && seat.agentId && onFocus(toggle(focus, `agent:${seat.agentId}`));
  // the whole workstation (chair, agent, desk) answers the pointer; the agent itself takes keyboard focus
  return (
    <g
      data-seat={seat.id}
      onPointerEnter={() => seated && onHover(() => seat.id)}
      onPointerLeave={() => onHover((h) => (h === seat.id ? null : h))}
      onClick={select}
      className={cn("transition-opacity duration-[var(--duration-base)]", dim && "opacity-35", interactive && "cursor-pointer")}
    >
      {/* the chair (seen behind the agent; empty until the agent's card is recorded) */}
      <rect x={s.sx - 12} y={s.sy - 36} width={24} height={26} rx={8} className="fill-surface-2 stroke-hairline-strong" />
      {seated && (
        <g
          transform={`translate(${s.sx} ${s.sy - 6}) scale(${AV})`}
          data-agent={seat.agentId ?? seat.id}
          {...(interactive && seat.agentId
            ? {
                role: "button",
                tabIndex: 0,
                "aria-pressed": on,
                "aria-label": label,
                onKeyDown: onActivate(select),
                className: "outline-offset-4",
              }
            : // a researcher or the verifier: no messages to filter, but its card is reachable from the keyboard
              { role: "img", tabIndex: 0, "aria-label": label, className: "outline-offset-4" })}
          onFocus={() => onHover(() => seat.id)}
          onBlur={() => onHover((h) => (h === seat.id ? null : h))}
        >
          <ellipse data-ring cx={0} cy={-15} rx={17} ry={23} fill="none" className={cn("stroke-signal transition-opacity", on ? "opacity-100" : "opacity-0")} strokeWidth={2} />
          {/* a soft screen glow on the face while the model call is in flight */}
          <ellipse cx={0} cy={-17} rx={13} ry={11} className={cn("fill-signal transition-opacity duration-[var(--duration-base)]", typing ? "opacity-20" : "opacity-0")} />
          <Avatar role={seat.role} team={seat.team} activity={sf.activity} blinkDelay={hashDelay(seat.id)} />
        </g>
      )}
      {!board && (
        <>
          <Box x0={d.x - 0.4} y0={d.y - 0.4} x1={d.x + 0.4} y1={d.y + 0.4} h={DESK_H} {...DESK} />
          {/* the monitor, on the desk's right; its screen lights while the agent works */}
          <Box x0={d.x + 0.12} y0={d.y - 0.36} x1={d.x + 0.36} y1={d.y - 0.28} z={DESK_H} h={17} top="fill-[var(--color-office-device)]" left="fill-[var(--color-office-device)]" right="fill-[var(--color-office-device-2)]" />
          <polygon
            points={pts([at(d.x + 0.12, d.y - 0.28, DESK_H + 3), at(d.x + 0.36, d.y - 0.28, DESK_H + 3), at(d.x + 0.36, d.y - 0.28, DESK_H + 15), at(d.x + 0.12, d.y - 0.28, DESK_H + 15)])}
            className={cn("transition-opacity duration-[var(--duration-base)]", typing || sf.activity === "sending" ? "fill-signal opacity-90" : "fill-faint opacity-40")}
          />
        </>
      )}
      {seated && sf.activity === "receiving" && <circle cx={s.sx + 15} cy={s.sy - 54} r={4.5} className="fill-signal animate-pop" />}
    </g>
  );
}

function hashDelay(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 5200;
  return h;
}

function seatName(seat: Seat, record: OfficeRecord): string {
  if (seat.role === "researcher") {
    const lane = record.lanes.find((l) => l.key === seat.pod);
    return `${lane?.label ?? "Rival"} researcher`;
  }
  if (seat.role === "verifier") return "Verifier";
  return `${ROLE_NAME[seat.role]} (no card yet)`;
}

function activityWords(sf: SeatFrame): string {
  switch (sf.activity) {
    case "typing":
      return "Working at the desk on a model call.";
    case "sending":
      return "Sending a message.";
    case "receiving":
      return "Received a message.";
    case "walking":
      return sf.carrying ? "Walking back with a document." : "Walking to the web terminal.";
    case "browsing":
      return sf.visit ? `At the web terminal: ${sf.visit.host}.` : "At the web terminal.";
    case "stamping":
      return "Stamping verdicts.";
    case "entering":
      return "Walking into the board room.";
    default:
      return sf.present ? "At the desk." : "Not in the office yet.";
  }
}

/** An agent away from the desk: walking (moved every frame from the clock, transform only) or standing at the terminal. */
function Mover({ seat, sf, now, running, reduced }: { seat: Seat; sf: SeatFrame; now: () => number; running: boolean; reduced: boolean }) {
  const ref = useRef<SVGGElement>(null);
  const walk = sf.walk;
  const place = useCallback(
    (w: Walk | null) => {
      const el = ref.current;
      if (!el) return 1;
      if (!w) {
        const p = iso(sf.at);
        el.style.transform = `translate(${p.sx}px, ${p.sy}px)`;
        return 1;
      }
      const f = reduced ? 1 : Math.min(1, Math.max(0, (now() - w.start) / Math.max(1, w.end - w.start)));
      const p = iso(pointAlong(w.path, easeInOut(f)));
      el.style.transform = `translate(${p.sx}px, ${p.sy}px)`;
      return f;
    },
    [sf.at, now, reduced],
  );
  useEffect(() => {
    let raf = 0;
    const step = () => {
      const f = place(walk);
      if (walk && f < 1 && running) raf = requestAnimationFrame(step);
    };
    step();
    return () => cancelAnimationFrame(raf);
  }, [walk, place, running]);
  const start = walk ? iso(walk.path[0] ?? sf.at) : iso(sf.at);
  const back = sf.activity === "browsing";
  return (
    <g ref={ref} style={{ transform: `translate(${start.sx}px, ${start.sy}px)` }} aria-hidden data-mover={seat.id}>
      <g transform={`scale(${AV})`}>
        <Avatar role={seat.role} team={seat.team} activity={sf.activity} facing={back ? "back" : "front"} seated={false} carrying={sf.carrying} blinkDelay={hashDelay(seat.id)} />
      </g>
    </g>
  );
}

function easeInOut(f: number): number {
  return f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
}

function headOf(plan: OfficePlan, id: string): S {
  if (id === "board") return at(BOARD_TABLE.x, BOARD_TABLE.y, 26);
  const seat = plan.seats[id];
  return seat ? iso(seat.at, 40) : at(0, 0);
}

/** An envelope flying from the sender's desk to a recipient's, on a shallow arc. */
function Envelope({ flight, plan, now, running }: { flight: Flight; plan: OfficePlan; now: () => number; running: boolean }) {
  const ref = useRef<SVGGElement>(null);
  const a = headOf(plan, flight.from);
  const b = headOf(plan, flight.to);
  useEffect(() => {
    let raf = 0;
    const step = () => {
      const el = ref.current;
      if (!el) return;
      const f = Math.min(1, Math.max(0, (now() - flight.start) / FLIGHT_MS));
      const e = 1 - (1 - f) ** 3;
      const lift = Math.sin(Math.PI * e) * (34 + Math.hypot(b.sx - a.sx, b.sy - a.sy) * 0.12);
      const x = a.sx + (b.sx - a.sx) * e;
      const y = a.sy + (b.sy - a.sy) * e - lift;
      el.style.transform = `translate(${x}px, ${y}px) rotate(${(b.sx - a.sx) * 0.02 * (1 - e)}deg)`;
      el.style.opacity = f > 0.92 ? String(Math.max(0, (1 - f) / 0.08)) : "1";
      if (f < 1 && running) raf = requestAnimationFrame(step);
    };
    step();
    return () => cancelAnimationFrame(raf);
  }, [flight, a.sx, a.sy, b.sx, b.sy, now, running]);
  return (
    <g ref={ref} style={{ transform: `translate(${a.sx}px, ${a.sy}px)` }} aria-hidden>
      <rect x={-7} y={-5} width={14} height={10} rx={1.5} className="fill-canvas stroke-ink-2" strokeWidth={1.1} />
      <path d="M-7,-4.5 L0,1 L7,-4.5" fill="none" className="stroke-ink-2" strokeWidth={1.1} />
      <rect x={-2} y={-1} width={4} height={2.6} rx={0.6} className="fill-signal" />
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ overlays */

const pct = (s: S) => ({ left: `${(s.sx / OFFICE_W) * 100}%`, top: `${(s.sy / OFFICE_H) * 100}%` });

/** Speech bubbles (a message's first words) and the web terminal's list of sources being read. With reduced motion
 *  they appear and go without movement; the caption above the floor says what is happening in words. */
function Overlays({ plan, frame }: { plan: OfficePlan; frame: OfficeFrame }) {
  const bubbles = Object.entries(frame.seats)
    .filter(([, sf]) => sf.bubble !== null)
    .sort((a, b) => (a[1].bubble?.start ?? 0) - (b[1].bubble?.start ?? 0))
    .slice(-3);
  const browsing = Object.entries(frame.seats).filter(([, sf]) => sf.activity === "browsing" && sf.visit);
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {bubbles.map(([id, sf]) => {
        const seat = plan.seats[id];
        const b = sf.bubble;
        if (!seat || !b) return null;
        const s = iso(seat.at, 62);
        const edge = s.sx < 150 ? "left" : s.sx > OFFICE_W - 150 ? "right" : "mid";
        return (
          <div
            key={`b-${b.msgId}`}
            className={cn("absolute w-max max-w-[12rem] -translate-y-full", edge === "mid" ? "-translate-x-1/2" : edge === "right" ? "-translate-x-[85%]" : "-translate-x-[15%]")}
            style={pct(s)}
          >
            <div className={cn("animate-pop rounded-lg border bg-canvas px-2.5 py-1.5 text-xs leading-snug text-ink-2 shadow-2", b.failed ? "border-danger/50" : "border-hairline-strong")}>
              {seat.team >= 0 && <span className="mr-1 inline-block size-2 rounded-full align-middle" style={{ background: `var(--color-team-${seat.team})` }} />}
              <span className="font-semibold text-ink">{ROLE_NAME[seat.role]}</span> {firstWords(b.text, 6)}
            </div>
          </div>
        );
      })}
      {browsing.length > 0 && (
        <div className="absolute left-[1.2%] top-[2%] w-[22%] min-w-[15rem]">
          <div className="animate-pop overflow-hidden rounded-md border border-hairline-strong bg-canvas text-xs shadow-2">
            <div className="flex items-center gap-1 border-b border-hairline bg-surface-2 px-2 py-1">
              <span className="size-1.5 rounded-full bg-hairline-strong" />
              <span className="size-1.5 rounded-full bg-hairline-strong" />
              <span className="size-1.5 rounded-full bg-hairline-strong" />
              <span className="ml-1.5 font-medium text-ink-2">Web terminal: sources being read</span>
            </div>
            <ul className="divide-y divide-hairline-soft">
              {browsing.map(([id, sf]) => {
                const seat = plan.seats[id];
                const v = sf.visit;
                if (!seat || !v) return null;
                return (
                  <li key={id} className="flex items-center gap-2 px-2 py-1">
                    <span className="size-2 shrink-0 rounded-full" style={{ background: seat.team >= 0 ? `var(--color-team-${seat.team})` : "var(--color-office-home)" }} />
                    <span className="w-20 shrink-0 truncate font-medium text-ink">{laneName(plan, seat)}</span>
                    <span key={v.host + v.at} className="min-w-0 flex-1 truncate font-mono text-ink-2 animate-rise">
                      {v.host}
                    </span>
                    {v.status !== "ok" ? <span className="font-mono text-danger">{v.status}</span> : <span className="font-mono text-faint tabular">#{sf.visits}</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function laneName(plan: OfficePlan, seat: Seat): string {
  return shortName(plan.pods.find((p) => p.key === seat.pod)?.label ?? "Home team");
}

function bubbleWho(seat: Seat, view: SwarmView): string {
  const card = seat.agentId ? view.cards[seat.agentId] : undefined;
  const team = card && seat.zone === "pod" ? `${shortName(card.groupLabel)} ` : "";
  return `${team}${ROLE_NAME[seat.role]}`;
}

function SeatTip({ seat, view, stats, frame, record }: { seat: Seat; view: SwarmView; stats: ReturnType<typeof nodeStats>[string] | undefined; frame: OfficeFrame; record: OfficeRecord }) {
  const s = iso(seat.at, 20);
  const right = s.sx > OFFICE_W * 0.62;
  const card = seat.agentId ? view.cards[seat.agentId] : undefined;
  const sf = frame.seats[seat.id];
  return (
    <div
      role="tooltip"
      className={cn("pointer-events-none absolute z-[var(--z-tooltip)] w-64 -translate-y-1/2 animate-fade-in", right && "-translate-x-full")}
      style={{ left: `calc(${(s.sx / OFFICE_W) * 100}% ${right ? "-" : "+"} 26px)`, top: `${(s.sy / OFFICE_H) * 100}%` }}
    >
      {card ? (
        <AgentCardTip card={card} rival={seat.zone === "pod"} stats={stats} />
      ) : (
        <div className="rounded-lg border border-hairline-strong bg-canvas px-3 py-2.5 text-xs shadow-md">
          <div className="text-sm font-semibold text-ink">{seatName(seat, record)}</div>
          <p className="mt-1 text-muted">{seatNote(seat, record, frame)}</p>
          {sf && <p className="mt-1 text-ink-2">{activityWords(sf)}</p>}
        </div>
      )}
    </div>
  );
}

function seatNote(seat: Seat, record: OfficeRecord, frame: OfficeFrame): string {
  if (seat.role === "researcher") {
    const n = record.fetches.filter((f) => f.lane === seat.pod).length;
    return `S4 research lane for this rival: ${n} ${n === 1 ? "source" : "sources"} fetched from public records.`;
  }
  if (seat.role === "verifier") {
    const t = frame.tally;
    return `S7 checks each claim against its source: ${t.supported} supported, ${t.partly} partly, ${t.withheld} withheld so far.`;
  }
  return "This desk fills when the agent's card is recorded.";
}

/* ------------------------------------------------------------------------------------------------ caption and legend */

function Caption({ plan, view, record, frame, stage, live, replaying }: { plan: OfficePlan; view: SwarmView; record: OfficeRecord; frame: OfficeFrame; stage: string | null; live: boolean; replaying: boolean }) {
  const lines: string[] = [];
  for (const [id, sf] of Object.entries(frame.seats)) {
    const seat = plan.seats[id];
    if (!seat || sf.activity === "idle" || sf.activity === "receiving") continue;
    const who = seat.role === "researcher" ? `${shortName(record.lanes.find((l) => l.key === seat.pod)?.label ?? "")} researcher` : seat.agentId ? bubbleWho(seat, view) : ROLE_NAME[seat.role];
    lines.push(`${who}: ${activityWords(sf).replace(/\.$/, "").toLowerCase()}`);
  }
  const quiet = live ? (stage ? `Stage ${stage.slice(1).padStart(2, "0")} is running; nothing new to show yet.` : "Waiting for the next event.") : replaying ? "Between events." : finalWords(view, record);
  return (
    <p className="line-clamp-2 min-h-10 min-w-0 flex-1 text-sm text-ink-2" aria-live="off">
      <span className="mr-2 font-semibold text-ink">{live ? "Live" : replaying ? "Replay" : "Final state"}</span>
      {lines.length ? lines.slice(0, 3).join("; ") + (lines.length > 3 ? `; and ${lines.length - 3} more` : "") : quiet}
    </p>
  );
}

function finalWords(view: SwarmView, record: OfficeRecord): string {
  const parts = [];
  if (record.fetches.length) parts.push(`${record.fetches.length} sources fetched`);
  if (record.verifies.length) parts.push(`${record.verifies.length} claims checked`);
  if (view.messages.length) parts.push(`${view.messages.length} messages`);
  if (view.board) parts.push("board scored");
  return parts.length ? `${parts.join(", ")}.` : "No recorded activity yet.";
}

function Legend({ plan }: { plan: OfficePlan }) {
  const roles = ["researcher", "capture_lead", "pricing", "technical", "past_performance", "red_team", "analyst", "evaluator", "verifier"] as const;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hairline px-4 py-2.5">
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5" aria-label="Who is who">
        {roles.map((r) => (
          <li key={r} className="flex items-center gap-1.5 text-xs">
            <AvatarBadge role={r} team={r === "red_team" || r === "analyst" || r === "evaluator" || r === "verifier" ? -1 : 0} size={24} />
            <span>
              <span className="font-medium text-ink">{ROLE_NAME[r]}</span> <span className="text-muted">{ROLE_NOTE[r]}</span>
            </span>
          </li>
        ))}
      </ul>
      {plan.pods.length > 0 && (
        <ul className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" aria-label="Team colours">
          {plan.pods.map((p) => (
            <li key={p.key} className="flex items-center gap-1.5 text-ink-2">
              <span className="size-2.5 rounded-full" style={{ background: `var(--color-team-${p.team})` }} />
              {shortName(p.label)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

