"use client";

/**
 * The Playhouse: the run staged as a paper toy theatre (one troupe per rival, the Archive wing, the prompt desk,
 * the critics' box, the curtain and the scrim). Every state is computed from the recorded run by the pure model in
 * `lib/war-room/playhouse.ts` on the office's own display clock; this file only draws it. The thread below stays
 * the full, accessible record.
 */
import "./playhouse.css";

import { ArrowCounterClockwise, EyeSlash, Pause, Play, SealCheck, Warning } from "@phosphor-icons/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";

import { cn } from "@/lib/cn";
import type { AgentCard } from "@/lib/contracts/run-events";
import { STEP_META, STEP_ORDER, type StepId } from "@/lib/pipeline/steps";
import { foldCommand } from "@/lib/war-room/command";
import {
  buildSchedule,
  frameAt,
  liveClock,
  replayClock,
  sentFirst,
  warpKeys,
  type Activity,
  type OfficePlan,
  type Pt,
  type Role,
  type Seat,
  type Verdict,
  planOffice,
} from "@/lib/war-room/office";
import {
  ANALYST_SPOT,
  BACKDROP,
  BOX_TABLE,
  books,
  callsAt,
  callWindows,
  castAt,
  CORNER,
  curtainAt,
  devilAt,
  easelAt,
  flyingAt,
  h2At,
  headline,
  houseTime,
  laneLinesAt,
  parksAt,
  phaseAt,
  placards,
  playbillAt,
  playhouseWarpKeys,
  promptAt,
  PROMPT,
  runSpan,
  scorecards,
  scrimAt,
  SHELVES,
  shelfOf,
  cardShown,
  deskTip,
  seatTip,
  trunkTip,
  spotTargets,
  STAGE_H,
  STAGE_W,
  stageEdges,
  stageLayout,
  trunksAt,
  waitWords,
  type ApprovalLite,
  type BillStatus,
  type Book,
  type CallLite,
  type Shelf,
  type StageLayout,
  type Trunk,
} from "@/lib/war-room/playhouse";
import { sceneAt, seatKnown, type Scene } from "@/lib/war-room/scene";
import { firstWords, nodeStats, type Focus } from "@/lib/war-room/swarm-graph";
import { shortName, type SwarmView } from "@/lib/war-room/swarm";

import { Avatar, AvatarOutline } from "../office-avatars";
import type { OfficeStyleProps } from "../office-styles";
import { useRunFeed } from "../run-feed";
import { AgentCardTip, useReducedMotion } from "../swarm-graph";

const SPEEDS = [1, 2, 4] as const;
const TICK_MS = 100;
/** Puppet size on the stage (the Classic avatar is about 44 units tall at 1). */
const AV = 2.15;

/* the stage opening, the wings and the stalls (stage units) */
const OPEN = { x0: 236, x1: 1300, y0: 112, y1: 800 } as const;
const FLOOR_Y = 600;
const ARCHIVE = { x: 30, y: 176, w: 186, shelfH: 70 } as const;

/* ------------------------------------------------------------------------------------------------ clock */

interface Replay {
  base: number;
  wall: number;
  playing: boolean;
  speed: (typeof SPEEDS)[number];
  /** Paused because the stage went off screen; it resumes when the stage is back. */
  held?: boolean;
}

function replayAt(r: Replay, perf: number): number {
  return r.playing ? r.base + Math.max(0, perf - r.wall) * r.speed : r.base;
}

function subscribeVisibility(cb: () => void): () => void {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
}

/** True while the theatre is on screen and the tab is visible: nothing ticks for a stage nobody can see. */
function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(true);
  const docVisible = useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== "hidden",
    () => true,
  );
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => setInView(entries.some((e) => e.isIntersecting)), { rootMargin: "120px" });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return inView && docVisible;
}

function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------------------------------------ focus */

function toggle(current: Focus, next: Focus): Focus {
  return current === next ? "all" : next;
}

function activate(fn: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

function seatInFocus(plan: OfficePlan, view: SwarmView, focus: Focus, seat: Seat): boolean {
  if (focus === "all") return true;
  if (focus.startsWith("agent:")) return seat.agentId === focus.slice(6);
  if (focus.startsWith("edge:")) return seat.agentId !== null && focus.slice(5).split("~").includes(seat.agentId);
  if (focus === "board") return seat.zone === "board";
  const pod = plan.pods.find((p) => p.key === seat.pod);
  return pod?.groupId === focus || (seat.agentId !== null && view.cards[seat.agentId]?.group === focus);
}

/** What the hover or focus card shows, built fresh from the frame on every render. */
type Tip = { kind: "agent"; at: Pt; card: AgentCard; rival: boolean } | { kind: "text"; at: Pt; title: string; lines: string[] };

/** What is hovered or focused: only the target, never its words (they are read from the frame on show). */
type TipTarget = { kind: "agent"; agentId: string; at: Pt } | { kind: "seat"; seat: string; at: Pt } | { kind: "trunk"; pod: string; at: Pt } | { kind: "desk"; at: Pt };

const ROLE_WORD: Record<Role, string> = {
  researcher: "Researcher",
  capture_lead: "Capture lead",
  pricing: "Pricing",
  technical: "Technical",
  past_performance: "Past performance",
  red_team: "Red team",
  analyst: "Home analyst",
  evaluator: "Critic",
  verifier: "Prompter (verifier)",
};

const ACTIVITY_WORD: Partial<Record<Activity, string>> = {
  typing: "in a model call",
  sending: "delivering a line",
  receiving: "receiving a line",
  browsing: "reading sources",
  walking: "reading sources",
  stamping: "stamping claims",
  entering: "taking the stage",
};

const VERDICT_WORD: Record<Verdict, string> = { supported: "held up", partly: "partly", withheld: "withheld" };

/* ------------------------------------------------------------------------------------------------ the theatre */

export default function Playhouse({ view: shownView, record: shownRecord, live, driven, onReplayRun, focus, onFocus, onReplay, recordError, envs, approvals }: OfficeStyleProps) {
  // a full-run replay brings the whole record and its own clock; the theatre plays it at the replay's cursor
  const view = driven?.view ?? shownView;
  const record = driven?.record ?? shownRecord;
  const reduced = useReducedMotion();
  const boxRef = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(boxRef);
  const feed = useRunFeed();
  // a full-run replay brings every recorded call: the windows open at each call's start, so a call in flight at the
  // cursor shows and a later one does not (the inspector's own list holds only calls finished by then)
  const feedCalls = feed?.inspect?.calls;
  const calls = useMemo<CallLite[]>(() => [...(driven?.calls ?? feedCalls ?? [])], [driven?.calls, feedCalls]);
  const approvalList = useMemo<ApprovalLite[]>(
    () => [
      { gate: "h1", createdAt: approvals?.h1?.at ?? null },
      { gate: "h2", createdAt: approvals?.h2?.at ?? null },
    ],
    [approvals],
  );
  const title = useMemo(() => foldCommand(envs).opportunity, [envs]);

  const plan = useMemo(() => planOffice(view, record), [view, record]);
  const layout = useMemo(() => stageLayout(plan), [plan]);
  const timeline = useMemo(
    () => replayClock([...warpKeys(view, record), ...playhouseWarpKeys({ record, approvals: approvalList, calls })]),
    [view, record, approvalList, calls],
  );
  const liveC = useMemo(() => (live ? liveClock(live.skewMs) : null), [live]);
  const clock = driven?.clock ?? liveC ?? timeline;
  const settled = driven ? 0 : live ? live.settledSeq : 0;
  const sched = useMemo(() => buildSchedule(plan, view, record, clock, settled), [plan, view, record, clock, settled]);

  // a replay belongs to a finished run: a run that is live again shows live
  const [stored, setReplay] = useState<Replay | null>(null);
  const replay = live || driven ? null : stored;
  const [wall, setWall] = useState({ ms: 0, perf: 0 });
  const t = driven ? driven.t : replay ? replayAt(replay, wall.perf) : live ? wall.ms : Infinity;
  const playing = replay?.playing ?? false;
  const end = Math.max(sched.end, timeline.span);
  // the last display time anything live changes: schedule beats, lane lines, verdicts, gates, model-call windows
  const liveEnd = useMemo(() => {
    if (!live) return 0;
    let e = sched.end;
    for (const list of [record.notes, record.verifies, record.parks, record.stages, record.fetches]) for (const x of list) e = Math.max(e, clock.at(x.ts));
    for (const c of calls) {
      const ts = c.createdAt ? Date.parse(c.createdAt) : NaN;
      if (Number.isFinite(ts)) e = Math.max(e, clock.at(ts));
    }
    return e;
  }, [live, sched.end, record, clock, calls]);
  // the theatre's own ticker runs for its own replay and a live run; a full-run replay re-renders it at its cursor
  const moving = !driven && (playing || (live !== null && t < liveEnd + 500));
  // a replay holds while the stage is off screen, and picks up where it was when it is back (event callbacks only)
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    let inView = true;
    const apply = () => {
      const now = performance.now();
      const visible = inView && document.visibilityState !== "hidden";
      setReplay((r) => {
        if (!r) return r;
        if (!visible && r.playing) return { ...r, base: replayAt(r, now), wall: now, playing: false, held: true };
        if (visible && r.held) return { ...r, wall: now, playing: true, held: false };
        return r;
      });
    };
    const io = new IntersectionObserver((entries) => {
      inView = entries.some((e) => e.isIntersecting);
      apply();
    }, { rootMargin: "120px" });
    io.observe(el);
    document.addEventListener("visibilitychange", apply);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", apply);
    };
  }, []);
  useEffect(() => {
    if (!moving || !onScreen) return;
    const read = () => {
      const perf = performance.now();
      setWall({ ms: Date.now(), perf });
      setReplay((r) => (r && r.playing && replayAt(r, perf) >= end ? { ...r, base: end, playing: false } : r));
    };
    const first = window.setTimeout(read, 0);
    const h = window.setInterval(read, TICK_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(h);
    };
  }, [moving, onScreen, end]);

  const frame = useMemo(() => frameAt(plan, sched, t), [plan, sched, t]);
  const shownSent = replay || driven ? frame.sent : -1;
  const scoresUp = frame.scores;
  const replayState = useMemo(() => (shownSent < 0 ? null : { sent: sentFirst(sched, shownSent), scores: scoresUp }), [shownSent, sched, scoresUp]);
  useEffect(() => onReplay(replayState), [replayState, onReplay]);

  // the recorded instant this frame shows (the house clock and the gate placards read it)
  // a finished view of a run still parked at a gate reads the wall clock (ticking once a second) for its wait
  const [wallNow, setWallNow] = useState(0);
  const nowRecorded = driven ? driven.recordedAt(t) : replay ? timeline.recordedAt(t) : liveC ? liveC.recordedAt(t) : wallNow > 0 ? wallNow : Infinity;
  const edges = useMemo(() => stageEdges(record, clock, settled), [record, clock, settled]);
  const parks = useMemo(() => parksAt(record, clock, settled), [record, clock, settled]);
  const gate = { edges, parks, approvals: approvalList, clock, nowRecorded };
  const curtain = curtainAt(gate, t);
  const h2 = h2At(gate, t);
  const bill = playbillAt(gate, t);
  const phase = phaseAt(edges, t);
  const ordered = useMemo(() => {
    const byId = new Map(view.messages.map((m) => [m.messageId, m]));
    return sched.sends.flatMap((s) => byId.get(s.msgId) ?? []);
  }, [view.messages, sched.sends]);
  const easel = easelAt({ edges, ordered, sent: frame.sent, h1: curtain.h1, h2 }, t);
  const bookList = useMemo(() => books(record, clock, settled), [record, clock, settled]);
  const flying = flyingAt(bookList, t);
  const trunks = trunksAt(record, clock, settled, t);
  const lines = laneLinesAt(record, clock, settled, t);
  const prompt = promptAt(record, clock, settled, t);
  const windows = useMemo(() => callWindows(calls, clock), [calls, clock]);
  const inFlight = callsAt(windows, t);
  const devil = devilAt(sched, plan, view, t);
  const spots = spotTargets(sched, frame, t);
  const scrim = scrimAt({ edges, view, sched, settledSeq: settled, clock }, t);
  const cards = scorecards({ view, plan, sched }, t);
  const unblind = scrim.state === "clear" || (scrim.state === "none" && frame.scores);
  const signs = unblind ? placards(view.board, plan) : [];
  const said = frame.scores ? headline(view.board) : null;
  const span = useMemo(() => runSpan(record, view), [record, view]);
  // what is known at the frame: a troupe and its props exist only once its rival's lane is named
  const scene = sceneAt({ record, view, clockAt: clock.at, settledSeq: settled }, t);
  const troupes = layout.troupes.filter((tr) => scene.hasRival(tr.key));
  const clockText = span ? houseTime(Math.min(Number.isFinite(nowRecorded) ? nowRecorded : span.last, span.last) - span.first) : "T+00:00";
  const shelfCounts: Record<Shelf, number> = { federal: 0, sec: 0, company: 0, news: 0, other: 0 };
  for (const b of bookList) if (b.start <= t) shelfCounts[b.shelf] += 1;
  for (const f of record.fetches) if (f.seq <= settled) shelfCounts[shelfOf(f.tier)] += 1;

  const rate = replay ? replay.speed : 1;
  const paused = (driven ? !driven.playing : replay !== null && !replay.playing) || !onScreen;
  const done = driven ? !Number.isFinite(driven.t) : !live && (!replay || (!replay.playing && replay.base >= end));
  const animate = !reduced && !paused && !done;

  const [target, setTarget] = useState<TipTarget | null>(null);
  // agent cards count only the messages sent by the frame's time (a replay never reveals what comes later)
  const sentNow = frame.sent;
  const stats = useMemo(() => {
    const sent = sentFirst(sched, sentNow);
    return nodeStats(view, view.messages.filter((m) => sent.has(m.messageId)));
  }, [view, sched, sentNow]);
  const parkedNow = !live && !replay && !driven && ((curtain.h1?.phase ?? null) === "waiting" || (h2 !== null && !h2.decided));
  useEffect(() => {
    if (!parkedNow || !onScreen) return;
    const tick = () => setWallNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const h = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(h);
    };
  }, [parkedNow, onScreen]);
  const hover = useCallback((next: TipTarget | null) => setTarget(next), []);
  // the card's words come from this frame; a target not known at the frame shows nothing
  const tip = ((): Tip | null => {
    if (!target) return null;
    if (target.kind === "agent") {
      const card = scene.hasAgent(target.agentId) ? view.cards[target.agentId] : undefined;
      const seatId = plan.byAgent[target.agentId];
      return card ? { kind: "agent", at: target.at, card, rival: seatId !== undefined && plan.seats[seatId]?.zone === "pod" } : null;
    }
    if (target.kind === "seat") {
      const seat = plan.seats[target.seat];
      if (!seat || !seatKnown(seat, scene)) return null;
      // the seat's card as of this frame: its agent's, once it has arrived (scene.hasAgent), else the place's words
      const card = seat.agentId && scene.hasAgent(seat.agentId) ? view.cards[seat.agentId] : undefined;
      const words = seatTip({ role: ROLE_WORD[seat.role], present: frame.seats[target.seat]?.present ?? false, card });
      return words.kind === "agent" ? { kind: "agent", at: target.at, card: words.card, rival: seat.zone === "pod" } : { kind: "text", at: target.at, title: words.title, lines: words.lines };
    }
    if (target.kind === "trunk") {
      const tr = troupes.find((x) => x.key === target.pod);
      const words = tr ? trunkTip(tr.label, trunks.lanes[target.pod]) : null;
      return words ? { kind: "text", at: target.at, ...words } : null;
    }
    return { kind: "text", at: target.at, ...deskTip(frame.tally, trunks.unattributed) };
  })();

  const startReplay = () => {
    const base = replay && replay.base < end ? replay.base : 0;
    setReplay({ base, wall: performance.now(), playing: true, speed: replay?.speed ?? 1 });
  };
  const pauseReplay = () => replay && setReplay({ ...replay, base: replayAt(replay, performance.now()), playing: false });
  const scrub = (ms: number) => setReplay((r) => ({ base: ms, wall: performance.now(), playing: false, speed: r?.speed ?? 1 }));
  const cycleSpeed = () =>
    setReplay((r) => {
      const speed = SPEEDS[(SPEEDS.indexOf(r?.speed ?? 1) + 1) % SPEEDS.length] ?? 1;
      return r ? { ...r, base: replayAt(r, performance.now()), wall: performance.now(), speed } : { base: end, wall: performance.now(), playing: false, speed };
    });

  const running = edges.filter((e) => e.at <= t).reduce<string | null>((cur, e) => (e.edge === "started" ? e.stage : cur === e.stage ? null : cur), null);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && focus !== "all") {
      e.preventDefault();
      onFocus("all");
    }
  };
  const dimmed = (seat: Seat) => !seatInFocus(plan, view, focus, seat);

  return (
    <div
      ref={boxRef}
      className="rounded-lg border border-hairline bg-canvas"
      data-office-style="playhouse"
      data-stage={running ?? ""}
      data-office-paused={paused || done ? "" : undefined}
      data-office-driven={driven ? "" : undefined}
      onKeyDown={onKey}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-hairline px-4 py-2.5">
        <Caption plan={plan} frame={frame} scene={scene} prompt={prompt} devil={devil.pose === "trap" ? devil.pod : null} live={live !== null} replaying={(replay !== null || driven !== null) && !done} easel={easel} />
        {!live && !driven && onReplayRun && (
          <button type="button" onClick={onReplayRun} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline px-3 text-xs font-medium text-ink-2 hover:bg-surface">
            Full-run replay
          </button>
        )}
        {!live && !driven && end > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              onClick={playing ? pauseReplay : startReplay}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline-strong px-3 font-medium text-ink hover:bg-surface"
            >
              {playing ? <Pause size={14} weight="fill" aria-hidden /> : <Play size={14} weight="fill" aria-hidden />}
              {playing ? "Pause" : replay && replay.base < end ? "Resume" : "Replay the run"}
            </button>
            <input
              type="range"
              min={0}
              max={Math.ceil(end / TICK_MS)}
              value={Math.round(Math.min(t, end) / TICK_MS)}
              onChange={(e) => scrub(Number(e.currentTarget.value) * TICK_MS)}
              aria-label="Playhouse replay position"
              aria-valuetext={`${clockText} run time, ${frame.sent} messages sent`}
              className="w-36 accent-[var(--color-signal)] sm:w-48"
            />
            <span className="w-12 font-mono tabular text-muted">{formatClock(Math.min(t, end))}</span>
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

      <div className="relative overflow-hidden" style={{ background: "var(--ph-house)" }}>
        <svg
          viewBox={`0 0 ${STAGE_W} ${STAGE_H}`}
          className="block h-auto w-full select-none"
          role="group"
          aria-label={`Playhouse: ${troupes.length} troupes, one per rival; ${frame.tally.supported + frame.tally.partly + frame.tally.withheld} claims checked; ${frame.sent} lines delivered. The message thread below holds every message.`}
        >
          <defs>
            <clipPath id="ph-open">
              <rect x={OPEN.x0} y={OPEN.y0} width={OPEN.x1 - OPEN.x0} height={OPEN.y1 - OPEN.y0} />
            </clipPath>
            <pattern id="ph-folds" width={46} height={10} patternUnits="userSpaceOnUse">
              <rect width={46} height={10} fill="var(--ph-curtain)" />
              <rect x={30} width={16} height={10} fill="var(--ph-curtain-fold)" />
            </pattern>
          </defs>
          <House />
          <g clipPath="url(#ph-open)">
            <Backdrop name={phase ? BACKDROP[phase] : "Casting"} />
            <Floor />
            {troupes.map((tr) => (
              <Rostrum key={tr.key} x={tr.x} scale={tr.scale} team={tr.team} />
            ))}
            {/* lane activity lines painted on the backdrop above each troupe (S4-S7) */}
            {troupes.map((tr) => {
              const line = phase === "research" || phase === "verify" ? lines[tr.key] : undefined;
              return line ? <LaneLine key={tr.key} x={tr.x} text={line} scale={tr.scale} /> : null;
            })}
            {troupes.map((tr) => (
              <Pennant
                key={tr.key}
                x={tr.x}
                scale={tr.scale}
                team={tr.team}
                short={tr.short}
                label={tr.label}
                on={tr.groupId !== null && focus === tr.groupId}
                dim={focus !== "all" && tr.groupId !== focus && !focus.startsWith("agent:") && !focus.startsWith("edge:")}
                masked={scrim.state === "masked"}
                {...(tr.groupId ? { onSelect: () => onFocus(toggle(focus, tr.groupId as string)) } : {})}
              />
            ))}
            {/* light pools: every agent in a recorded model call; follow-spots on the two latest */}
            {plan.order.map((id) => {
              const sf = frame.seats[id];
              const p = layout.spots[id];
              const seat = plan.seats[id];
              if (!sf || !p || !seat || !seatKnown(seat, scene) || sf.activity !== "typing") return null;
              return <Pool key={`pool-${id}`} p={p} s={layout.scale[id] ?? 1} spot={spots.includes(id)} />;
            })}
            {troupes.map((tr) => (
              <TrapDoor key={tr.key} p={layout.traps[tr.key] ?? { x: tr.x, y: 772 }} open={devil.pose === "trap" && devil.pod === tr.key} peek={devil.peek.includes(tr.key)} />
            ))}
            {troupes.map((tr) => (
              <TrunkProp key={tr.key} x={tr.x + 92 * tr.scale} trunk={trunks.lanes[tr.key]} scale={tr.scale} label={tr.label} pod={tr.key} onTip={hover} />
            ))}
            {/* the troupes and everyone on stage */}
            {plan.order.map((id) => {
              const seat = plan.seats[id];
              const sf = frame.seats[id];
              const p = layout.spots[id];
              if (!seat || !sf || !p || seat.zone === "board" || seat.zone === "verify" || seat.zone === "red_team" || seat.zone === "analyst") return null;
              if (!seatKnown(seat, scene)) return null;
              return (
                <Puppet
                  key={id}
                  seat={seat}
                  p={p}
                  s={(layout.scale[id] ?? 1) * AV}
                  activity={sf.activity}
                  present={sf.present}
                  view={view}
                  dim={dimmed(seat)}
                  on={seat.agentId !== null && focus === `agent:${seat.agentId}`}
                  focus={focus}
                  onFocus={onFocus}
                  onTip={hover}
                />
              );
            })}
            {/* bubbles: the line an agent is delivering, as a paper scroll */}
            {plan.order.map((id) => {
              const sf = frame.seats[id];
              const p = layout.spots[id];
              const seat = plan.seats[id];
              if (!sf?.bubble || !p || !seat || seat.zone === "board" || !seatKnown(seat, scene)) return null;
              return <Scroll key={`b-${sf.bubble.msgId}`} p={p} s={layout.scale[id] ?? 1} text={sf.bubble.text} failed={sf.bubble.failed} />;
            })}
            <Scrim state={scrim} />
            {signs.map((sg) => {
              const tr = troupes.find((x) => x.key === sg.pod);
              return tr ? <Placard key={sg.pod} x={tr.x} code={sg.code} share={sg.share} incumbent={sg.incumbent} animate={animate} /> : null;
            })}
            <Curtain open={curtain.open} h1={curtain.h1} />
          </g>
          <Proscenium title={title} said={said} clockText={clockText} />
          <Archive counts={shelfCounts} lamp={inFlight.archive} flying={flying.flying} />
          <Devil plan={plan} layout={layout} devil={devil} frame={frame.seats} view={view} focus={focus} onFocus={onFocus} onTip={hover} dim={(s) => dimmed(s)} />
          <Box
            plan={plan}
            layout={layout}
            frame={frame.seats}
            cards={cards}
            view={view}
            focus={focus}
            onFocus={onFocus}
            onTip={hover}
            dim={(s) => dimmed(s)}
          />
          <PromptDesk plan={plan} frame={frame.seats} prompt={prompt} writing={inFlight.prompt} tally={frame.tally} view={view} onTip={hover} />
          <Stalls plan={plan} layout={layout} frame={frame.seats} view={view} focus={focus} onFocus={onFocus} onTip={hover} dim={(s) => dimmed(s)} easel={easel} h2={h2} />
          <HouseBoard tally={frame.tally} />
          {!reduced &&
            flying.flying.map((b) => {
              const to = researcherHead(plan, layout, b.lane);
              return to ? <FlyingBook key={b.id} book={b} to={to} t={t} rate={rate} paused={!animate} /> : null;
            })}
          {!reduced &&
            frame.flights.map((f) => {
              const from = headAt(layout, f.from);
              const to = f.to === "board" ? { x: BOX_TABLE.x, y: BOX_TABLE.y - 40 } : headAt(layout, f.to);
              return from && to ? <FlyingScroll key={f.id} id={f.id} from={from} to={to} start={f.start} end={f.end} t={t} rate={rate} paused={!animate} /> : null;
            })}
        </svg>
        {tip && <TipCard tip={tip} stats={stats} />}
      </div>

      <Playbill bill={bill} />
      <p className="border-t border-hairline px-4 py-2 text-xs text-muted">
        Every cue is a recorded event at its recorded time: a book for each S4 fetch, from the shelf of its source tier; the backdrop line is the
        lane&apos;s own activity line; a slip at the prompt desk for each S7 verdict; a pool of light for exactly a model call&apos;s recorded window; a
        scroll for each S9 message; the devil through the star trap for a red-team challenge; the scrim screens the troupes while the simulated board
        scores masked offerors, then lifts at its result. Hover or focus anyone for their card; click a troupe or an agent to show only those messages in
        the thread below.
        {recordError && <span className="text-danger"> Research and verification events could not be read ({recordError}); the swarm still shows.</span>}
      </p>
    </div>
  );
}

function headAt(layout: StageLayout, seat: string): Pt | null {
  const p = layout.spots[seat];
  if (!p) return null;
  return { x: p.x, y: p.y - 44 * AV * (layout.scale[seat] ?? 1) * 0.85 };
}

function researcherHead(plan: OfficePlan, layout: StageLayout, lane: string): Pt | null {
  const pod = plan.pods.find((p) => p.key === lane);
  const seat = pod?.seats.find((s) => plan.seats[s]?.role === "researcher");
  if (seat) return headAt(layout, seat);
  const home = Object.values(plan.seats).find((s) => s.zone === "analyst" && s.role === "researcher");
  return home ? headAt(layout, home.id) : null;
}

/* ------------------------------------------------------------------------------------------------ the house */

const House = memo(function House() {
  return (
    <g aria-hidden>
      <rect width={STAGE_W} height={STAGE_H} fill="var(--ph-house)" />
      {/* the stalls */}
      <rect x={0} y={OPEN.y1 + 22} width={STAGE_W} height={STAGE_H - OPEN.y1 - 22} fill="color-mix(in oklab, var(--ph-house) 82%, var(--ph-arch-edge))" />
    </g>
  );
});

const Backdrop = memo(function Backdrop({ name }: { name: string }) {
  return (
    <g aria-hidden>
      <rect x={OPEN.x0} y={OPEN.y0} width={OPEN.x1 - OPEN.x0} height={FLOOR_Y - OPEN.y0 + 4} fill="var(--ph-backdrop)" />
      {/* the painted cloth: a few cut-paper flats, then the part of the pipeline in big letters */}
      <path
        d={`M${OPEN.x0} ${FLOOR_Y - 60} Q ${OPEN.x0 + 180} ${FLOOR_Y - 130} ${OPEN.x0 + 360} ${FLOOR_Y - 80} T ${OPEN.x0 + 720} ${FLOOR_Y - 96} T ${OPEN.x1} ${FLOOR_Y - 70} L ${OPEN.x1} ${FLOOR_Y + 4} L ${OPEN.x0} ${FLOOR_Y + 4}Z`}
        fill="color-mix(in oklab, var(--ph-backdrop) 90%, var(--ph-arch-edge))"
      />
      <text x={(OPEN.x0 + OPEN.x1) / 2} y={OPEN.y0 + 150} textAnchor="middle" className="font-serif" fontSize={64} fontWeight={600} fill="var(--ph-backdrop-ink)" letterSpacing={2}>
        {name}
      </text>
    </g>
  );
});

const Floor = memo(function Floor() {
  const boards = Array.from({ length: 9 }, (_, i) => FLOOR_Y + 22 * (i + 1));
  return (
    <g aria-hidden>
      <rect x={OPEN.x0} y={FLOOR_Y} width={OPEN.x1 - OPEN.x0} height={OPEN.y1 - FLOOR_Y} fill="var(--ph-floor)" />
      {boards.map((y) => (
        <line key={y} x1={OPEN.x0} y1={y} x2={OPEN.x1} y2={y} stroke="var(--ph-floor-line)" strokeWidth={1} />
      ))}
    </g>
  );
});

function Rostrum({ x, scale, team }: { x: number; scale: number; team: number }) {
  const w = 196 * scale;
  return (
    <g aria-hidden>
      <rect x={x - w / 2} y={636} width={w} height={10} rx={2} fill={`color-mix(in oklab, var(--color-team-${team}) 55%, var(--ph-wood))`} stroke="var(--ph-ink-edge)" strokeWidth={1.5} />
      <rect x={x - w / 2 + 4} y={646} width={w - 8} height={34} fill={`color-mix(in oklab, var(--color-team-${team}) 30%, var(--ph-wood))`} stroke="var(--ph-ink-edge)" strokeWidth={1.5} />
      <line x1={x - w / 2 + 4} y1={663} x2={x + w / 2 - 4} y2={663} stroke="var(--ph-wood-edge)" strokeWidth={1} />
    </g>
  );
}

function wrap(text: string, max: number, lines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max) {
      out.push(cur.trim());
      cur = w;
      if (out.length === lines) break;
    } else cur = `${cur} ${w}`;
  }
  if (out.length < lines && cur.trim()) out.push(cur.trim());
  if (out.length === lines && words.join(" ").length > out.join(" ").length) out[lines - 1] = `${(out[lines - 1] ?? "").replace(/\s*\S*$/, "")}...`;
  return out.slice(0, lines);
}

function LaneLine({ x, text, scale }: { x: number; text: string; scale: number }) {
  const ls = wrap(text, Math.round(24 * scale), 3);
  return (
    <g aria-hidden>
      {ls.map((l, i) => (
        <text key={i} x={x} y={386 + i * 15} textAnchor="middle" className="font-mono" fontSize={11.5} fill="var(--color-ink-2)">
          {l}
        </text>
      ))}
    </g>
  );
}

function Pennant({
  x,
  scale,
  team,
  short,
  label,
  on,
  dim,
  masked,
  onSelect,
}: {
  x: number;
  scale: number;
  team: number;
  short: string;
  label: string;
  on: boolean;
  dim: boolean;
  masked: boolean;
  onSelect?: () => void;
}) {
  const w = Math.min(178 * scale, Math.max(96, short.length * 12 + 36));
  const name = masked ? "SCREENED" : short.toUpperCase();
  const fontSize = Math.min(16, (w - 26) / (name.length * 0.68));
  const y = 448;
  const d = `M${x - w / 2} ${y} H${x + w / 2} V${y + 34} L${x + w / 2 - 14} ${y + 24} L${x + w / 2 - 28} ${y + 34} H${x - w / 2 + 28} L${x - w / 2 + 14} ${y + 24} L${x - w / 2} ${y + 34}Z`;
  const interactive = onSelect !== undefined;
  return (
    <g
      {...(interactive
        ? { role: "button", tabIndex: 0, "aria-pressed": on, "aria-label": `${label}: show this troupe's messages`, onClick: onSelect, onKeyDown: activate(onSelect) }
        : { "aria-hidden": true })}
      className={cn("outline-none transition-opacity duration-[var(--duration-base)]", interactive && "cursor-pointer", dim && "opacity-35")}
    >
      <line x1={x - w / 2 + 6} y1={y - 10} x2={x + w / 2 - 6} y2={y - 10} stroke="var(--ph-ink-edge)" strokeWidth={1.5} />
      <line x1={x - w / 2 + 10} y1={y - 10} x2={x - w / 2 + 10} y2={y} stroke="var(--ph-ink-edge)" strokeWidth={1} />
      <line x1={x + w / 2 - 10} y1={y - 10} x2={x + w / 2 - 10} y2={y} stroke="var(--ph-ink-edge)" strokeWidth={1} />
      <path d={d} fill="none" stroke="var(--color-stage-paper)" strokeWidth={5} strokeLinejoin="round" />
      <path d={d} fill={`color-mix(in oklab, var(--color-team-${team}) 80%, var(--ph-backdrop))`} stroke={on ? "var(--color-signal)" : "var(--ph-ink-edge)"} strokeWidth={on ? 3 : 1.5} strokeLinejoin="round" />
      <text x={x} y={y + 21} textAnchor="middle" fontSize={fontSize} fontWeight={700} letterSpacing={0.4} fill="#1f1f1f">
        {name}
      </text>
    </g>
  );
}

function Pool({ p, s, spot }: { p: Pt; s: number; spot: boolean }) {
  const rx = 52 * s;
  return (
    <g aria-hidden pointerEvents="none" className="ph-pool">
      {spot && <path d={`M${p.x - 18} ${OPEN.y0} L${p.x - rx} ${p.y} L${p.x + rx} ${p.y} L${p.x + 18} ${OPEN.y0}Z`} fill="var(--ph-light)" opacity={0.55} />}
      <ellipse cx={p.x} cy={p.y + 2} rx={rx} ry={13 * s} fill="var(--ph-light-core)" />
    </g>
  );
}

function TrapDoor({ p, open, peek }: { p: Pt; open: boolean; peek: boolean }) {
  return (
    <g aria-hidden>
      <ellipse cx={p.x} cy={p.y} rx={34} ry={8} fill={open ? "var(--ph-ink-edge)" : "color-mix(in oklab, var(--ph-floor) 80%, var(--ph-ink-edge))"} stroke="var(--ph-ink-edge)" strokeWidth={1} opacity={open ? 0.85 : 0.6} />
      {peek && !open && (
        <g>
          <path d={`M${p.x - 12} ${p.y - 2} l-4 -14 l10 9Z M${p.x + 12} ${p.y - 2} l4 -14 l-10 9Z`} fill="var(--color-office-red)" stroke="var(--ph-ink-edge)" strokeWidth={1.2} strokeLinejoin="round" />
        </g>
      )}
    </g>
  );
}

function TrunkProp({ x, trunk, scale, label, pod, onTip }: { x: number; trunk: Trunk | undefined; scale: number; label: string; pod: string; onTip: (t: TipTarget | null) => void }) {
  if (!trunk) return null;
  const read = trunk.ok;
  const checked = trunk.supported + trunk.partly + trunk.withheld;
  const y = 728;
  const w = 64 * scale;
  const tipNow = () => onTip({ kind: "trunk", pod, at: { x, y: y - 6 } });
  return (
    <g
      role="img"
      tabIndex={0}
      aria-label={`${shortName(label)} trunk: ${read} sources read, ${checked} claims checked, ${trunk.withheld} withheld`}
      onPointerEnter={tipNow}
      onPointerLeave={() => onTip(null)}
      onFocus={tipNow}
      onBlur={() => onTip(null)}
      className="outline-none"
    >
      <rect x={x - w / 2} y={y} width={w} height={34 * scale} rx={4} fill="var(--color-stage-paper)" stroke="var(--color-stage-paper)" strokeWidth={5} />
      <rect x={x - w / 2} y={y} width={w} height={34 * scale} rx={4} fill="var(--ph-wood)" stroke="var(--ph-ink-edge)" strokeWidth={1.5} />
      <line x1={x - w / 2} y1={y + 10 * scale} x2={x + w / 2} y2={y + 10 * scale} stroke="var(--ph-ink-edge)" strokeWidth={1} />
      <text x={x} y={y + 25 * scale} textAnchor="middle" className="font-mono tabular" fontSize={13} fontWeight={700} fill="var(--color-ink)">
        {read}
      </text>
      {checked > 0 && (
        <text x={x} y={y + 34 * scale + 13} textAnchor="middle" className="font-mono tabular" fontSize={10.5} fill="var(--color-ink-2)">
          <tspan x={x}>{`${trunk.supported} held${trunk.partly ? `, ${trunk.partly} partly` : ""}`}</tspan>
          <tspan x={x} dy={12}>{`${trunk.withheld} withheld`}</tspan>
        </text>
      )}
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ puppets */

function puppetActivity(a: Activity): Activity {
  // the Playhouse researcher reads at its place (books fly to it); nobody walks the stage
  if (a === "walking") return "browsing";
  return a;
}

function Puppet({
  seat,
  p,
  s,
  activity,
  present,
  view,
  dim,
  on,
  focus,
  onFocus,
  onTip,
}: {
  seat: Seat;
  p: Pt;
  s: number;
  activity: Activity;
  present: boolean;
  view: SwarmView;
  dim: boolean;
  on: boolean;
  focus: Focus;
  onFocus: (f: Focus) => void;
  onTip: (t: TipTarget | null) => void;
}) {
  // nothing about an agent shows before it is on stage at this frame: no card, no name, no filter
  const card = cardShown(seat.agentId ? view.cards[seat.agentId] : undefined, present);
  const agentId = card ? seat.agentId : null;
  const act = puppetActivity(activity);
  const word = ACTIVITY_WORD[act];
  const label = `${card?.name ?? ROLE_WORD[seat.role]}${present ? (word ? `, ${word}` : "") : ", not on stage yet"}${agentId ? ". Show this agent's messages." : ""}`;
  const tipNow = () =>
    card && agentId
      ? onTip({ kind: "agent", agentId, at: { x: p.x, y: p.y - 44 * s } })
      : onTip({ kind: "seat", seat: seat.id, at: { x: p.x, y: p.y - 44 * s } });
  const select = () => agentId && onFocus(toggle(focus, `agent:${agentId}`));
  return (
    <g
      role={agentId ? "button" : "img"}
      tabIndex={0}
      aria-label={label}
      {...(agentId ? { "aria-pressed": on, onClick: select, onKeyDown: activate(select) } : {})}
      onPointerEnter={tipNow}
      onPointerLeave={() => onTip(null)}
      onFocus={tipNow}
      onBlur={() => onTip(null)}
      className={cn("outline-none transition-opacity duration-[var(--duration-base)]", agentId && "cursor-pointer", dim && "opacity-35")}
    >
      <g transform={`translate(${p.x} ${p.y}) scale(${s})`}>
        {present && (card || seat.role === "researcher") ? (
          <Avatar role={seat.role} team={seat.team} activity={act} seated={false} paper blinkDelay={hash(seat.id)} />
        ) : (
          <AvatarOutline role={seat.role} />
        )}
        {on && <ellipse cx={0} cy={0.5} rx={13} ry={4.4} fill="none" stroke="var(--color-signal)" strokeWidth={1.4} />}
      </g>
    </g>
  );
}

/** A recorded instant as local wall-clock time with seconds. */
function clockOf(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function hash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 5200;
}

function Devil({
  plan,
  layout,
  devil,
  frame,
  view,
  focus,
  onFocus,
  onTip,
  dim,
}: {
  plan: OfficePlan;
  layout: StageLayout;
  devil: ReturnType<typeof devilAt>;
  frame: Record<string, { activity: Activity; present: boolean }>;
  view: SwarmView;
  focus: Focus;
  onFocus: (f: Focus) => void;
  onTip: (t: TipTarget | null) => void;
  dim: (s: Seat) => boolean;
}) {
  const seat = Object.values(plan.seats).find((s) => s.zone === "red_team" && s.role === "red_team");
  if (!seat) return null;
  const sf = frame[seat.id];
  const card = cardShown(seat.agentId ? view.cards[seat.agentId] : undefined, sf?.present ?? false);
  const trap = devil.pose === "trap" ? layout.traps[devil.pod] : undefined;
  const p = trap ?? CORNER;
  const s = AV;
  // before its card is recorded the devil is scenery: no filter, no card
  const agentId = card ? seat.agentId : null;
  const label = `Red team (the devil)${trap ? ", challenging a troupe through the star trap" : ", waiting in the corner"}${agentId ? ". Show its messages." : ", not on stage yet."}`;
  const select = () => agentId && onFocus(toggle(focus, `agent:${agentId}`));
  const tipNow = () => agentId && onTip({ kind: "agent", agentId, at: { x: p.x, y: p.y - 60 } });
  return (
    <g
      role={agentId ? "button" : "img"}
      tabIndex={0}
      aria-label={label}
      {...(agentId ? { "aria-pressed": focus === `agent:${agentId}`, onClick: select, onKeyDown: activate(select) } : {})}
      onPointerEnter={tipNow}
      onPointerLeave={() => onTip(null)}
      onFocus={tipNow}
      onBlur={() => onTip(null)}
      className={cn("outline-none transition-opacity duration-[var(--duration-base)]", agentId && "cursor-pointer", dim(seat) && "opacity-35")}
    >
      {!trap && <ellipse cx={CORNER.x} cy={CORNER.y + 4} rx={40} ry={10} fill="var(--ph-ink-edge)" opacity={0.7} />}
      <g className="ph-devil" style={{ transform: `translate(${p.x}px, ${p.y + (trap ? 0 : 18)}px)` }}>
        <g transform={`scale(${s})`}>
          {sf?.present && card ? <Avatar role="red_team" team={-1} activity={puppetActivity(sf.activity)} seated={false} paper /> : <AvatarOutline role="red_team" />}
        </g>
      </g>
    </g>
  );
}

function Scroll({ p, s, text, failed }: { p: Pt; s: number; text: string; failed: boolean }) {
  const lines = wrap(firstWords(text, 14), 26, 2);
  const w = 210;
  const h = 18 + lines.length * 16;
  const x = Math.min(OPEN.x1 - w - 6, Math.max(OPEN.x0 + 6, p.x - w / 2));
  const y = p.y - 44 * AV * s - h - 16;
  return (
    <g aria-hidden className="animate-fade-in">
      <rect x={x} y={y} width={w} height={h} rx={4} fill="var(--color-stage-paper)" stroke="var(--color-stage-paper)" strokeWidth={5} />
      <rect x={x} y={y} width={w} height={h} rx={4} fill="var(--ph-book)" stroke={failed ? "var(--color-danger)" : "var(--ph-ink-edge)"} strokeWidth={1.5} strokeDasharray={failed ? "5 3" : undefined} />
      <path d={`M${p.x - 6} ${y + h} L${p.x} ${y + h + 10} L${p.x + 6} ${y + h}`} fill="var(--ph-book)" stroke="var(--ph-ink-edge)" strokeWidth={1.5} strokeLinejoin="round" />
      {lines.map((l, i) => (
        <text key={i} x={x + 10} y={y + 20 + i * 16} fontSize={13} fill="var(--color-ink)">
          {l}
        </text>
      ))}
    </g>
  );
}

function Scrim({ state }: { state: ReturnType<typeof scrimAt> }) {
  const shown = state.state === "masked";
  return (
    <g aria-hidden pointerEvents="none" className="ph-scrim" style={{ opacity: shown ? 1 : 0 }}>
      <rect x={OPEN.x0} y={370} width={OPEN.x1 - OPEN.x0} height={OPEN.y1 - 370} fill="var(--ph-scrim)" />
      {Array.from({ length: 34 }, (_, i) => (
        <line key={i} x1={OPEN.x0 + i * 32} y1={370} x2={OPEN.x0 + i * 32} y2={OPEN.y1} stroke="var(--ph-floor-line)" strokeWidth={0.8} opacity={0.6} />
      ))}
      <text x={(OPEN.x0 + OPEN.x1) / 2} y={560} textAnchor="middle" fontSize={26} fontWeight={700} fill="var(--color-ink-2)" letterSpacing={1}>
        Names screened while the board scores
      </text>
      <text x={(OPEN.x0 + OPEN.x1) / 2} y={594} textAnchor="middle" className="font-mono" fontSize={17} fill="var(--color-muted)">
        {state.state === "masked" && state.codes.length ? `Rated so far: ${state.codes.map((c) => `Offeror ${c}`).join(", ")}` : "Offerors are rated by code, not by name"}
      </text>
    </g>
  );
}

function Placard({ x, code, share, incumbent, animate }: { x: number; code: string; share: number; incumbent: boolean; animate: boolean }) {
  const y = 492;
  return (
    <g aria-hidden className={animate ? "ph-swing" : undefined}>
      <line x1={x - 22} y1={y - 8} x2={x - 22} y2={y} stroke="var(--ph-ink-edge)" strokeWidth={1} />
      <line x1={x + 22} y1={y - 8} x2={x + 22} y2={y} stroke="var(--ph-ink-edge)" strokeWidth={1} />
      <rect x={x - 58} y={y} width={116} height={50} rx={3} fill="var(--color-stage-paper)" stroke="var(--color-stage-paper)" strokeWidth={5} />
      <rect x={x - 58} y={y} width={116} height={50} rx={3} fill="var(--ph-book)" stroke="var(--ph-ink-edge)" strokeWidth={1.5} />
      <text x={x} y={y + 18} textAnchor="middle" className="font-mono" fontSize={12} fill="var(--color-muted)">
        {code ? `Offeror ${code}` : "Offeror"}
        {incumbent ? " · inc." : ""}
      </text>
      <text x={x} y={y + 41} textAnchor="middle" className="font-mono tabular" fontSize={22} fontWeight={700} fill="var(--color-ink)">
        {Math.round(share * 100)}%
      </text>
    </g>
  );
}

function Curtain({ open, h1 }: { open: boolean; h1: ReturnType<typeof curtainAt>["h1"] }) {
  const w = OPEN.x1 - OPEN.x0;
  const h = OPEN.y1 - OPEN.y0;
  const bottom = Array.from({ length: Math.ceil(w / 46) }, (_, i) => `Q ${OPEN.x0 + i * 46 + 23} ${OPEN.y1 + 14} ${OPEN.x0 + (i + 1) * 46} ${OPEN.y1}`).join(" ");
  return (
    <g className="ph-curtain" {...(open ? { "data-open": "" } : {})} aria-hidden={open}>
      <path d={`M${OPEN.x0} ${OPEN.y0} H${OPEN.x1} V${OPEN.y1} H${OPEN.x0}Z`} fill="url(#ph-folds)" />
      <path d={`M${OPEN.x0} ${OPEN.y1} ${bottom}`} fill="var(--ph-curtain)" stroke="var(--ph-curtain-edge)" strokeWidth={2} />
      <rect x={OPEN.x0} y={OPEN.y1 - 30} width={w} height={6} fill="var(--ph-arch-gilt)" opacity={0.7} />
      {h1 ? (
        <g role="img" aria-label={h1.phase === "waiting" ? `H1 plan review: waiting for your approval since ${clockOf(h1.parkTs)}${h1.waitedMs !== null ? `, ${waitWords(h1.waitedMs)} so far` : ""}` : `H1 plan approved${h1.waitedMs !== null ? ` after ${waitWords(h1.waitedMs)}` : ""}`}>
          <rect x={OPEN.x0 + w / 2 - 230} y={OPEN.y0 + h / 2 - 90} width={460} height={170} rx={6} fill="var(--color-cream)" stroke="var(--color-cream-edge)" strokeWidth={2} />
          <text x={OPEN.x0 + w / 2} y={OPEN.y0 + h / 2 - 48} textAnchor="middle" className="font-mono" fontSize={15} fill="var(--color-ink-2)" letterSpacing={1.4}>
            H1 · PLAN REVIEW
          </text>
          <text x={OPEN.x0 + w / 2} y={OPEN.y0 + h / 2 - 6} textAnchor="middle" fontSize={30} fontWeight={700} fill="var(--color-ink)">
            {h1.phase === "waiting" ? "Waiting for your approval" : "Approved"}
          </text>
          <text x={OPEN.x0 + w / 2} y={OPEN.y0 + h / 2 + 36} textAnchor="middle" className="font-mono tabular" fontSize={17} fill="var(--color-ink-2)">
            {h1.phase === "waiting"
              ? `parked ${clockOf(h1.parkTs)}${h1.waitedMs !== null ? `, waited ${waitWords(h1.waitedMs)} so far` : ""}`
              : h1.waitedMs !== null
                ? `after ${waitWords(h1.waitedMs)} at the gate`
                : `parked ${clockOf(h1.parkTs)}`}
          </text>
        </g>
      ) : (
        !open && (
          <text x={OPEN.x0 + w / 2} y={OPEN.y0 + h / 2} textAnchor="middle" className="font-serif" fontSize={34} fill="color-mix(in oklab, var(--ph-curtain) 40%, #ffffff)">
            Casting the bidders
          </text>
        )
      )}
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ the arch */

const Proscenium = memo(function Proscenium({ title, said, clockText }: { title: string | null; said: string | null; clockText: string }) {
  const cx = (OPEN.x0 + OPEN.x1) / 2;
  const scallop = Array.from({ length: 23 }, (_, i) => {
    const x0 = OPEN.x0 + (i * (OPEN.x1 - OPEN.x0)) / 23;
    const x1 = OPEN.x0 + ((i + 1) * (OPEN.x1 - OPEN.x0)) / 23;
    return `Q ${(x0 + x1) / 2} ${OPEN.y0 + 22} ${x1} ${OPEN.y0}`;
  }).join(" ");
  return (
    <g>
      {/* the arch: two pillars and the header, cut paper with an ink edge */}
      <path
        d={`M${OPEN.x0 - 26} ${OPEN.y1 + 22} V${OPEN.y0 - 40} Q ${cx} ${OPEN.y0 - 96} ${OPEN.x1 + 26} ${OPEN.y0 - 40} V${OPEN.y1 + 22} H${OPEN.x1} V${OPEN.y0} H${OPEN.x0} V${OPEN.y1 + 22}Z`}
        fill="var(--ph-arch)"
        stroke="var(--ph-ink-edge)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        aria-hidden
      />
      <path d={`M${OPEN.x0 - 14} ${OPEN.y1 + 22} V${OPEN.y0 - 32} Q ${cx} ${OPEN.y0 - 84} ${OPEN.x1 + 14} ${OPEN.y0 - 32} V${OPEN.y1 + 22}`} fill="none" stroke="var(--ph-arch-gilt)" strokeWidth={2} aria-hidden />
      {/* the valance */}
      <path d={`M${OPEN.x0} ${OPEN.y0 - 4} H${OPEN.x1} V${OPEN.y0} ${scallop} `} fill="var(--ph-curtain)" stroke="var(--ph-curtain-edge)" strokeWidth={1.5} aria-hidden />
      <rect x={OPEN.x0} y={OPEN.y0 - 40} width={OPEN.x1 - OPEN.x0} height={40} fill="var(--ph-curtain)" stroke="var(--ph-curtain-edge)" strokeWidth={1.5} aria-hidden />
      <text x={cx} y={OPEN.y0 - 14} textAnchor="middle" className={said ? "font-serif" : undefined} fontSize={said ? 19 : 17} fontWeight={600} fill="#f4efe6">
        {said ?? (title ? firstWords(title, 12) : "The Black Hat Playhouse")}
      </text>
      {/* the house clock above the arch: recorded run time */}
      <g aria-label={`Run time ${clockText}`} role="img">
        <rect x={cx - 66} y={8} width={132} height={34} rx={17} fill="#1f1f1f" stroke="var(--ph-arch-gilt)" strokeWidth={1.5} />
        <text x={cx} y={31} textAnchor="middle" className="font-mono tabular" fontSize={18} fontWeight={700} fill="#f4efe6">
          {clockText}
        </text>
      </g>
    </g>
  );
});

const HouseBoard = memo(function HouseBoard({ tally }: { tally: Record<Verdict, number> }) {
  const total = tally.supported + tally.partly + tally.withheld;
  const cx = (OPEN.x0 + OPEN.x1) / 2;
  return (
    <g role="img" aria-label={`S7 claims checked: ${total}; ${tally.supported} held up, ${tally.partly} partly, ${tally.withheld} withheld`}>
      <rect x={cx - 250} y={OPEN.y1 + 2} width={500} height={20} rx={3} fill="#1f1f1f" />
      <text x={cx} y={OPEN.y1 + 17} textAnchor="middle" className="font-mono tabular" fontSize={13} fill="#f4efe6" letterSpacing={0.5}>
        {total ? `S7 CLAIMS CHECKED ${total}  ·  HELD UP ${tally.supported}  ·  PARTLY ${tally.partly}  ·  WITHHELD ${tally.withheld}` : "S7 CLAIMS CHECKED 0"}
      </text>
    </g>
  );
});

/* ------------------------------------------------------------------------------------------------ the wings */

function shelfY(i: number): number {
  return ARCHIVE.y + 40 + i * ARCHIVE.shelfH;
}

function Archive({ counts, lamp, flying }: { counts: Record<Shelf, number>; lamp: number; flying: readonly Book[] }) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const hosts = [...flying].reverse().slice(0, 3);
  return (
    <g role="img" aria-label={`The Archive: ${total} sources pulled; ${SHELVES.map((s) => `${s.label} ${counts[s.id]}`).join(", ")}${lamp ? `; ${lamp} research model calls in flight` : ""}`}>
      <rect x={ARCHIVE.x} y={ARCHIVE.y} width={ARCHIVE.w} height={40 + SHELVES.length * ARCHIVE.shelfH + 8} rx={4} fill="var(--ph-wood)" stroke="var(--ph-ink-edge)" strokeWidth={1.5} />
      <text x={ARCHIVE.x + ARCHIVE.w / 2} y={ARCHIVE.y + 26} textAnchor="middle" fontSize={16} fontWeight={700} fill="var(--color-ink)" letterSpacing={1}>
        THE ARCHIVE
      </text>
      {lamp > 0 && (
        <g className="ph-pool">
          <circle cx={ARCHIVE.x + ARCHIVE.w - 16} cy={ARCHIVE.y + 20} r={7} fill="var(--color-signal)" />
          <circle cx={ARCHIVE.x + ARCHIVE.w - 16} cy={ARCHIVE.y + 20} r={16} fill="var(--ph-light)" />
        </g>
      )}
      {SHELVES.map((s, i) => {
        const y = shelfY(i);
        const n = counts[s.id];
        const spines = Math.min(n, 16);
        return (
          <g key={s.id}>
            <rect x={ARCHIVE.x + 8} y={y + ARCHIVE.shelfH - 10} width={ARCHIVE.w - 16} height={5} fill="var(--ph-wood-edge)" />
            {Array.from({ length: spines }, (_, k) => (
              <rect
                key={k}
                x={ARCHIVE.x + 12 + k * 10}
                y={y + 22 + ((k * 7) % 9)}
                width={8}
                height={ARCHIVE.shelfH - 32 - ((k * 7) % 9)}
                rx={1}
                fill={k % 3 === 0 ? "var(--ph-book)" : k % 3 === 1 ? "color-mix(in oklab, var(--ph-book) 80%, var(--ph-arch-gilt))" : "color-mix(in oklab, var(--ph-book) 85%, var(--ph-curtain))"}
                stroke="var(--ph-ink-edge)"
                strokeWidth={0.8}
              />
            ))}
            <text x={ARCHIVE.x + 12} y={y + 15} fontSize={12} fontWeight={600} fill="var(--color-ink-2)">
              {s.label}
            </text>
            <text x={ARCHIVE.x + ARCHIVE.w - 12} y={y + 15} textAnchor="end" className="font-mono tabular" fontSize={12} fill="var(--color-muted)">
              {n}
            </text>
          </g>
        );
      })}
      {/* the call board: the hosts being pulled right now */}
      <rect x={ARCHIVE.x} y={ARCHIVE.y + 40 + SHELVES.length * ARCHIVE.shelfH + 16} width={ARCHIVE.w} height={74} rx={3} fill="#1f1f1f" />
      {hosts.length ? (
        hosts.map((b, i) => (
          <text key={b.id} x={ARCHIVE.x + 10} y={ARCHIVE.y + 40 + SHELVES.length * ARCHIVE.shelfH + 36 + i * 20} className="font-mono" fontSize={12} fill={b.status === "ok" ? "#f4efe6" : "#9a968f"}>
            {b.host.slice(0, 22)}
            {b.status !== "ok" ? ` (${b.status})` : ""}
          </text>
        ))
      ) : (
        <text x={ARCHIVE.x + 10} y={ARCHIVE.y + 40 + SHELVES.length * ARCHIVE.shelfH + 36} className="font-mono" fontSize={12} fill="#9a968f">
          {total ? `${total} pulled` : "no pulls yet"}
        </text>
      )}
    </g>
  );
}

function Box({
  plan,
  layout,
  frame,
  cards,
  view,
  focus,
  onFocus,
  onTip,
  dim,
}: {
  plan: OfficePlan;
  layout: StageLayout;
  frame: Record<string, { activity: Activity; present: boolean }>;
  cards: ReturnType<typeof scorecards>;
  view: SwarmView;
  focus: Focus;
  onFocus: (f: Focus) => void;
  onTip: (t: TipTarget | null) => void;
  dim: (s: Seat) => boolean;
}) {
  const critics = Object.values(plan.seats)
    .filter((s) => s.zone === "board")
    .sort((a, b) => a.id.localeCompare(b.id));
  const on = focus === "board";
  const x = 1312;
  const y = 214;
  const select = () => onFocus(toggle(focus, "board"));
  return (
    <g>
      <g role="button" tabIndex={0} aria-pressed={on} aria-label="The critics' box: the simulated, de-identified board. Show its messages." onClick={select} onKeyDown={activate(select)} className="cursor-pointer outline-none">
        <rect x={x} y={y} width={270} height={200} rx={6} fill="var(--ph-arch)" stroke={on ? "var(--color-signal)" : "var(--ph-ink-edge)"} strokeWidth={on ? 3 : 1.5} />
        <text x={x + 135} y={y + 24} textAnchor="middle" fontSize={15} fontWeight={700} fill="var(--color-ink)" letterSpacing={1}>
          THE CRITICS
        </text>
        <text x={x + 135} y={y + 42} textAnchor="middle" fontSize={11.5} fill="var(--color-muted)">
          simulated board, not a forecast
        </text>
      </g>
      {critics.map((seat) => {
        const p = layout.spots[seat.id];
        const sf = frame[seat.id];
        if (!p || !sf) return null;
        return (
          <Puppet
            key={seat.id}
            seat={seat}
            p={p}
            s={1.7}
            activity={sf.activity}
            present={sf.present}
            view={view}
            dim={dim(seat)}
            on={seat.agentId !== null && focus === `agent:${seat.agentId}`}
            focus={focus}
            onFocus={onFocus}
            onTip={onTip}
          />
        );
      })}
      {/* the balustrade, in front of the critics */}
      <rect x={x + 10} y={324} width={250} height={14} rx={3} fill="var(--ph-wood)" stroke="var(--ph-ink-edge)" strokeWidth={1.5} aria-hidden />
      {Array.from({ length: 11 }, (_, i) => (
        <rect key={i} x={x + 18 + i * 22.6} y={338} width={8} height={24} rx={3} fill="var(--ph-wood)" stroke="var(--ph-ink-edge)" strokeWidth={1} aria-hidden />
      ))}
      {/* the scorecards hung under the rail: the recorded 1-5 ratings per offeror code */}
      {cards.slice(-3).map((c, i) => (
        <g key={c.msgId} role="img" aria-label={`${c.focus} critic: ${c.pairs.length ? c.pairs.map(([k, v]) => `offeror ${k} rated ${v}`).join(", ") : c.state === "completed" ? "no ratings recorded" : "no valid scorecard"}`}>
          <rect x={x + 12 + i * 84} y={366} width={78} height={44} rx={3} fill="var(--ph-book)" stroke="var(--ph-ink-edge)" strokeWidth={1.2} />
          <text x={x + 51 + i * 84} y={379} textAnchor="middle" fontSize={10} fontWeight={700} fill="var(--color-ink-2)">
            {c.focus.slice(0, 13)}
          </text>
          <text x={x + 51 + i * 84} y={395} textAnchor="middle" className="font-mono tabular" fontSize={10.5} fill="var(--color-ink)">
            {c.pairs
              .slice(0, 3)
              .map(([k, v]) => `${k}${v}`)
              .join(" ")}
          </text>
          <text x={x + 51 + i * 84} y={406} textAnchor="middle" className="font-mono tabular" fontSize={10.5} fill="var(--color-ink)">
            {c.pairs
              .slice(3, 6)
              .map(([k, v]) => `${k}${v}`)
              .join(" ")}
          </text>
        </g>
      ))}
    </g>
  );
}

const VERDICT_ICON = { supported: SealCheck, partly: Warning, withheld: EyeSlash } as const;

function PromptDesk({
  plan,
  frame,
  prompt,
  writing,
  tally,
  view,
  onTip,
}: {
  plan: OfficePlan;
  frame: Record<string, { activity: Activity; present: boolean }>;
  prompt: ReturnType<typeof promptAt>;
  writing: Record<string, number>;
  tally: Record<Verdict, number>;
  view: SwarmView;
  onTip: (t: TipTarget | null) => void;
}) {
  const seat = Object.values(plan.seats).find((s) => s.zone === "verify");
  const sf = seat ? frame[seat.id] : undefined;
  const x = PROMPT.x;
  const y = PROMPT.y;
  const total = tally.supported + tally.partly + tally.withheld;
  const writes = Object.entries(writing);
  const tipNow = () => onTip({ kind: "desk", at: { x, y: y - 120 } });
  const slip = prompt.slip;
  return (
    <g>
      <g transform={`translate(${x} ${y - 6}) scale(1.9)`} aria-hidden>
        {seat && sf?.present && seat.agentId && view.cards[seat.agentId] ? (
          <Avatar role="verifier" team={-1} activity={sf.activity === "stamping" ? "typing" : puppetActivity(sf.activity)} seated paper />
        ) : (
          <Avatar role="verifier" team={-1} seated paper />
        )}
      </g>
      <g role="img" tabIndex={0} aria-label={`Prompt desk: ${total} claims checked`} onPointerEnter={tipNow} onPointerLeave={() => onTip(null)} onFocus={tipNow} onBlur={() => onTip(null)} className="outline-none">
        <path d={`M${x - 92} ${y - 4} H${x + 92} L${x + 100} ${y + 40} H${x - 100}Z`} fill="var(--ph-wood)" stroke="var(--ph-ink-edge)" strokeWidth={1.5} strokeLinejoin="round" />
        <text x={x} y={y + 26} textAnchor="middle" fontSize={13} fontWeight={700} fill="var(--color-ink)" letterSpacing={1}>
          PROMPT DESK
        </text>
      </g>
      {writes.length > 0 && (
        <text x={x} y={y + 60} textAnchor="middle" className="font-mono" fontSize={12} fill="var(--color-ink-2)">
          {writes.map(([k, n]) => (n > 1 ? `${k} x${n}` : k)).join(", ")}
        </text>
      )}
      {/* the slip: one verdict's words, or a burst's count; a withheld claim has its own slip with a redaction bar */}
      {slip && (
        <g key={`s-${slip.seq}`} className="animate-fade-in" aria-hidden>
          <rect x={x - 130} y={y - 196} width={260} height={56} rx={3} fill="var(--ph-book)" stroke="var(--ph-ink-edge)" strokeWidth={1.4} />
          {slip.kind === "one" ? (
            <>
              <VerdictMark verdict={slip.verdict} x={x - 120} y={y - 186} />
              <text x={x - 92} y={y - 172} fontSize={12.5} fill="var(--color-ink)">
                {slip.words.slice(0, 30)}
              </text>
              <text x={x - 92} y={y - 154} className="font-mono" fontSize={11.5} fill="var(--color-muted)">
                {VERDICT_WORD[slip.verdict]}
              </text>
            </>
          ) : (
            <>
              <text x={x} y={y - 170} textAnchor="middle" className="font-mono tabular" fontSize={18} fontWeight={700} fill="var(--color-ink)">
                {slip.checked} checked
              </text>
              <text x={x} y={y - 151} textAnchor="middle" fontSize={11.5} fill="var(--color-muted)">
                one burst of verdicts
              </text>
            </>
          )}
        </g>
      )}
      {prompt.withheld && (
        <g key={`w-${prompt.withheld.seq}`} aria-hidden>
          <rect x={x - 130} y={y - 132} width={260} height={46} rx={3} fill="var(--ph-book)" stroke="var(--color-danger)" strokeWidth={1.4} />
          <text x={x - 118} y={y - 113} fontSize={12.5} fill="var(--color-ink-2)">
            {prompt.withheld.words.slice(0, 34)}
          </text>
          <rect className="ph-strike" x={x - 120} y={y - 122} width={Math.min(236, prompt.withheld.words.slice(0, 34).length * 6.6)} height={13} fill="var(--color-ink)" />
          <text x={x - 118} y={y - 95} className="font-mono" fontSize={11} fontWeight={700} fill="var(--color-danger)">
            WITHHELD: NOT SUPPORTED BY ITS SOURCE
          </text>
        </g>
      )}
      {prompt.strike && <circle key={prompt.strike} className="ph-strike" cx={x + 106} cy={y - 10} r={9} fill="none" stroke="var(--color-signal)" strokeWidth={2.4} aria-hidden />}
    </g>
  );
}

function VerdictMark({ verdict, x, y }: { verdict: Verdict; x: number; y: number }) {
  const Icon = VERDICT_ICON[verdict];
  return <Icon x={x} y={y} size={22} weight={verdict === "supported" ? "fill" : "bold"} className={verdict === "withheld" ? "text-danger" : "text-ink"} aria-hidden />;
}

function Stalls({
  plan,
  layout,
  frame,
  view,
  focus,
  onFocus,
  onTip,
  dim,
  easel,
  h2,
}: {
  plan: OfficePlan;
  layout: StageLayout;
  frame: Record<string, { activity: Activity; present: boolean }>;
  view: SwarmView;
  focus: Focus;
  onFocus: (f: Focus) => void;
  onTip: (t: TipTarget | null) => void;
  dim: (s: Seat) => boolean;
  easel: { title: string; sub: string };
  h2: ReturnType<typeof h2At>;
}) {
  const home = Object.values(plan.seats).filter((s) => s.zone === "analyst");
  const ex = 1150;
  const ey = 832;
  return (
    <g>
      {/* the director's table */}
      <rect x={ANALYST_SPOT.x - 60} y={ANALYST_SPOT.y - 26} width={190} height={14} rx={3} fill="var(--ph-wood)" stroke="var(--ph-ink-edge)" strokeWidth={1.5} aria-hidden />
      {home.map((seat) => {
        const p = layout.spots[seat.id];
        const sf = frame[seat.id];
        if (!p || !sf) return null;
        return (
          <Puppet
            key={seat.id}
            seat={seat}
            p={{ x: p.x, y: p.y - 18 }}
            s={1.6}
            activity={sf.activity}
            present={sf.present}
            view={view}
            dim={dim(seat)}
            on={seat.agentId !== null && focus === `agent:${seat.agentId}`}
            focus={focus}
            onFocus={onFocus}
            onTip={onTip}
          />
        );
      })}
      <text x={ANALYST_SPOT.x + 160} y={ANALYST_SPOT.y - 6} fontSize={12} fill="var(--color-muted)" aria-hidden>
        the director&apos;s table
      </text>
      {/* the easel: the act, or the gate by name; cream only when a person decides (H2) */}
      <g role="status" aria-label={`${easel.title}: ${easel.sub}`}>
        <line x1={ex + 20} y1={ey + 60} x2={ex + 50} y2={ey - 6} stroke="var(--ph-ink-edge)" strokeWidth={2} />
        <line x1={ex + 140} y1={ey + 60} x2={ex + 110} y2={ey - 6} stroke="var(--ph-ink-edge)" strokeWidth={2} />
        <rect x={ex} y={ey - 10} width={160} height={62} rx={3} fill={h2 ? "var(--color-cream)" : "var(--ph-book)"} stroke={h2 ? "var(--color-cream-edge)" : "var(--ph-ink-edge)"} strokeWidth={1.5} />
        <text x={ex + 80} y={ey + 14} textAnchor="middle" fontSize={16} fontWeight={700} fill="var(--color-ink)">
          {easel.title}
        </text>
        <text x={ex + 80} y={ey + 34} textAnchor="middle" fontSize={11} fill="var(--color-ink-2)">
          {easel.sub.length > 28 ? `${easel.sub.slice(0, 27)}...` : easel.sub}
        </text>
        {h2 && (
          <text x={ex + 80} y={ey + 48} textAnchor="middle" className="font-mono" fontSize={10} fill="var(--color-ink-2)">
            {h2.decided
              ? h2.waitedMs !== null
                ? `recorded after ${waitWords(h2.waitedMs)}`
                : "recorded"
              : `parked ${clockOf(h2.parkTs)}${h2.waitedMs !== null ? `, waiting ${waitWords(h2.waitedMs)}` : ""}`}
          </text>
        )}
      </g>
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ flights */

/** A one-shot motion along an arc, driven by the compositor (transform and opacity only), started at the frame's
 *  progress so a scrub or a late mount picks it up mid-flight; paused with the replay. */
function useFlight(ref: React.RefObject<SVGGElement | null>, from: Pt, to: Pt, start: number, end: number, t: number, rate: number, paused: boolean, lift: number) {
  const anim = useRef<Animation | null>(null);
  const progress = Math.min(1, Math.max(0, (t - start) / Math.max(1, end - start)));
  const latest = useRef({ progress, paused });
  useEffect(() => {
    latest.current = { progress, paused };
  });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.animate !== "function") return;
    const dur = Math.max(1, (end - start) / Math.max(1, rate));
    const mid = { x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - lift };
    const a = el.animate(
      [
        { transform: `translate(${from.x}px, ${from.y}px)`, opacity: 0 },
        { transform: `translate(${from.x}px, ${from.y}px)`, opacity: 1, offset: 0.08 },
        { transform: `translate(${mid.x}px, ${mid.y}px)`, opacity: 1, offset: 0.5 },
        { transform: `translate(${to.x}px, ${to.y}px)`, opacity: 1, offset: 0.92 },
        { transform: `translate(${to.x}px, ${to.y}px)`, opacity: 0 },
      ],
      { duration: dur, easing: "linear", fill: "both" },
    );
    a.currentTime = latest.current.progress * dur;
    if (latest.current.paused) a.pause();
    anim.current = a;
    return () => {
      a.cancel();
      anim.current = null;
    };
  }, [ref, from.x, from.y, to.x, to.y, start, end, rate, lift]);
  // paused (or scrubbed): hold the flight at the frame's own progress; playing again resumes from there
  useEffect(() => {
    const a = anim.current;
    if (!a) return;
    const dur = Math.max(1, (end - start) / Math.max(1, rate));
    if (paused) {
      a.pause();
      a.currentTime = progress * dur;
    } else if (a.playState === "paused") {
      a.currentTime = progress * dur;
      a.play();
    }
  }, [paused, progress, start, end, rate]);
}

function FlyingBook({ book, to, t, rate, paused }: { book: Book; to: Pt; t: number; rate: number; paused: boolean }) {
  const ref = useRef<SVGGElement>(null);
  const i = SHELVES.findIndex((s) => s.id === book.shelf);
  const from = { x: ARCHIVE.x + ARCHIVE.w - 20, y: shelfY(Math.max(0, i)) + 36 };
  useFlight(ref, from, to, book.start, book.end, t, rate, paused, 90);
  const bad = book.status !== "ok";
  return (
    <g ref={ref} aria-hidden style={{ opacity: 0 }}>
      <rect x={-11} y={-8} width={22} height={16} rx={2} fill="var(--color-stage-paper)" stroke="var(--color-stage-paper)" strokeWidth={4} />
      <rect x={-11} y={-8} width={22} height={16} rx={2} fill={bad ? "var(--color-surface-2)" : "var(--ph-book)"} stroke={book.status === "error" ? "var(--color-danger)" : "var(--ph-ink-edge)"} strokeWidth={1.4} strokeDasharray={bad ? "3 2" : undefined} />
      <line x1={0} y1={-8} x2={0} y2={8} stroke="var(--ph-ink-edge)" strokeWidth={1} />
    </g>
  );
}

function FlyingScroll({ id, from, to, start, end, t, rate, paused }: { id: string; from: Pt; to: Pt; start: number; end: number; t: number; rate: number; paused: boolean }) {
  const ref = useRef<SVGGElement>(null);
  useFlight(ref, from, to, start, end, t, rate, paused, 70);
  return (
    <g ref={ref} aria-hidden style={{ opacity: 0 }} data-flight={id}>
      <rect x={-13} y={-6} width={26} height={12} rx={6} fill="var(--color-stage-paper)" stroke="var(--color-stage-paper)" strokeWidth={4} />
      <rect x={-13} y={-6} width={26} height={12} rx={6} fill="var(--ph-book)" stroke="var(--ph-ink-edge)" strokeWidth={1.4} />
      <circle cx={-13} cy={0} r={4} fill="var(--ph-arch-gilt)" stroke="var(--ph-ink-edge)" strokeWidth={1} />
      <circle cx={13} cy={0} r={4} fill="var(--ph-arch-gilt)" stroke="var(--ph-ink-edge)" strokeWidth={1} />
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ captions */

function Caption({
  plan,
  frame,
  scene,
  prompt,
  devil,
  live,
  replaying,
  easel,
}: {
  plan: OfficePlan;
  frame: ReturnType<typeof frameAt>;
  scene: Scene;
  prompt: ReturnType<typeof promptAt>;
  devil: string | null;
  live: boolean;
  replaying: boolean;
  easel: { title: string; sub: string };
}) {
  const lines: string[] = [];
  // only agents the scene knows: a rival not yet named is never named here
  for (const id of castAt(plan, frame, scene)) {
    const sf = frame.seats[id];
    const seat = plan.seats[id];
    if (!sf || !seat) continue;
    const word = ACTIVITY_WORD[puppetActivity(sf.activity)];
    if (!word) continue;
    const pod = plan.pods.find((p) => p.key === seat.pod);
    lines.push(`${pod ? `${shortName(pod.label)} ` : ""}${ROLE_WORD[seat.role].toLowerCase()} ${word}`);
  }
  if (devil) {
    const pod = scene.hasRival(devil) ? plan.pods.find((p) => p.key === devil) : undefined;
    lines.unshift(`Red team challenging ${pod ? shortName(pod.label) : "a troupe"}`);
  }
  if (prompt.withheld) lines.unshift(`Withheld: "${prompt.withheld.words}"`);
  return (
    <p className="line-clamp-2 min-h-10 min-w-0 flex-1 text-sm text-ink-2" aria-live="off">
      <span className="mr-2 font-semibold text-ink">{live ? "Live" : replaying ? "Replay" : "Final state"}</span>
      <span className="mr-2 font-medium text-ink">{easel.title}.</span>
      {lines.length ? lines.slice(0, 3).join("; ") + (lines.length > 3 ? `; and ${lines.length - 3} more` : "") : easel.sub}
    </p>
  );
}

function TipCard({ tip, stats }: { tip: Tip; stats: ReturnType<typeof nodeStats> }) {
  const right = tip.at.x > STAGE_W * 0.62;
  const below = tip.at.y < STAGE_H * 0.32;
  const style = { left: `${(tip.at.x / STAGE_W) * 100}%`, top: `${(tip.at.y / STAGE_H) * 100}%` };
  return (
    <div role="tooltip" className={cn("pointer-events-none absolute z-[var(--z-tooltip)] w-72 animate-fade-in", right ? "-translate-x-full" : "", below ? "" : "-translate-y-full")} style={style}>
      {tip.kind === "agent" ? (
        <AgentCardTip card={tip.card} rival={tip.rival} stats={stats[tip.card.agentId]} />
      ) : (
        <div className="rounded-lg border border-hairline-strong bg-canvas px-3 py-2.5 text-xs shadow-md">
          <div className="text-sm font-semibold text-ink">{tip.title}</div>
          {tip.lines.map((l, i) => (
            <p key={i} className={cn("mt-1", i === 0 ? "text-ink-2" : "text-muted")}>
              {l}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

const BILL_STYLE: Record<BillStatus, string> = {
  not_started: "border-hairline text-faint",
  running: "border-signal bg-signal-soft text-ink",
  done: "border-hairline-strong text-ink-2",
  degraded: "border-warning text-ink-2",
  failed: "border-danger text-danger",
  not_built: "border-dashed border-hairline text-muted",
  waiting: "border-cream-edge bg-cream text-ink",
  approved: "border-cream-edge text-ink-2",
};

const BILL_WORD: Record<BillStatus, string> = {
  not_started: "not started",
  running: "running",
  done: "done",
  degraded: "done with gaps",
  failed: "failed",
  not_built: "skipped",
  waiting: "waiting for you",
  approved: "approved",
};

function Playbill({ bill }: { bill: Partial<Record<StepId, BillStatus>> }) {
  return (
    <ol className="flex flex-wrap gap-1.5 border-t border-hairline px-4 py-2.5" aria-label="Playbill: each stage and gate as recorded">
      {STEP_ORDER.map((id) => {
        const st = bill[id] ?? "not_started";
        return (
          <li key={id} title={`${id} ${STEP_META[id].name}: ${BILL_WORD[st]}`} className={cn("rounded border px-1.5 py-0.5 font-mono text-micro tabular", BILL_STYLE[st])}>
            <span className="sr-only">{`${id} ${STEP_META[id].name}: ${BILL_WORD[st]}`}</span>
            <span aria-hidden>{id}</span>
          </li>
        );
      })}
    </ol>
  );
}

