"use client";

/**
 * The Bid Tower: the run drawn as a cutaway office building, one floor per rival, read top to bottom like a Gantt
 * chart. The roof is the board room and the decision deck, the upper floor the red team and the home office, the
 * ground floor the dossier presses, the notary booth and the ledger, the basement the records archive (locked by
 * the H1 gate) and the machine room whose racks light from the recorded model calls.
 *
 * Every state comes from the pure tower model (`lib/war-room/tower`) on the office's own display clock: the same
 * replay clock as Classic (long quiet stretches cut), or the live clock. The tower adds no transport of its own
 * beyond the office replay's play, scrub and speed. The thread below stays the full, accessible record.
 */
import "../tower/tower.css";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent } from "react";

import { usePreferences } from "@/components/shell/preferences";
import type { Approvals } from "@/lib/pipeline/rail";
import { buildSchedule, frameAt, liveClock, replayClock, sentFirst, warpKeys, planOffice } from "@/lib/war-room/office";
import { nodeStats } from "@/lib/war-room/swarm-graph";
import { buildModel, towerFrame } from "@/lib/war-room/tower/frame";
import { buildTower } from "@/lib/war-room/tower/layout";
import { foldTower } from "@/lib/war-room/tower/record";
import { logAt, runBounds, towerWarpKeys, type TowerInputs } from "@/lib/war-room/tower/world";

import type { OfficeStyleProps } from "../office-styles";
import { useRunFeed } from "../run-feed";
import { useReducedMotion } from "../swarm-graph";
import { Caption, Controls, EventLog, Legend, SPEEDS, StepStrip, type Speed } from "../tower/hud";
import { Overlay, seatInFocus, towerActivityWords, seatName } from "../tower/overlay";
import { Shell } from "../tower/shell";
import { Stage, useMotion, type SeatInfo } from "../tower/stage";

const TICK_MS = 100;
const NO_APPROVALS: Approvals = { h1: null, h2: null };

interface Replay {
  base: number;
  wall: number;
  playing: boolean;
  speed: Speed;
  /** Paused because the tower went off screen; it resumes when the tower is back. */
  held?: boolean;
}

function replayAt(r: Replay, perf: number): number {
  return r.playing ? r.base + Math.max(0, perf - r.wall) * r.speed : r.base;
}

function subscribeVisibility(cb: () => void): () => void {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
}

/** True while the tower is on screen and the tab is visible: nothing ticks for a scene nobody can see. */
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

export default function BidTower({ view: shownView, record: shownRecord, live, driven, onReplayRun, focus, onFocus, onReplay, recordError, envs, approvals }: OfficeStyleProps) {
  // a full-run replay brings the whole record and its own clock; the tower plays it at the replay's cursor
  const view = driven?.view ?? shownView;
  const record = driven?.record ?? shownRecord;
  const reduced = useReducedMotion();
  const prefs = usePreferences();
  const theme = prefs.theme === "dark" ? "dark" : "light";
  const boxRef = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(boxRef);
  const feed = useRunFeed();
  const history = feed?.history ?? null;
  // a full-run replay brings every recorded call; the tower shows each from its start, so in-flight calls show at the cursor
  const calls = driven?.calls ?? feed?.inspect?.calls ?? null;
  const tower = useMemo(() => foldTower(envs), [envs]);
  const inputs = useMemo<TowerInputs>(() => ({ view, record, tower, history, approvals: approvals ?? NO_APPROVALS, calls }), [view, record, tower, history, approvals, calls]);

  const plan = useMemo(() => planOffice(view, record), [view, record]);
  const layout = useMemo(() => buildTower(plan), [plan]);
  const timeline = useMemo(
    () => replayClock([...warpKeys(view, record), ...towerWarpKeys(tower, calls, history, approvals ?? NO_APPROVALS)]),
    [view, record, tower, calls, history, approvals],
  );
  const liveC = useMemo(() => (live ? liveClock(live.skewMs) : null), [live]);
  const clock = driven?.clock ?? liveC ?? timeline;
  const settled = driven ? 0 : live ? live.settledSeq : 0;
  const recordedAt = driven?.recordedAt ?? (liveC ?? timeline).recordedAt;
  const sched = useMemo(() => buildSchedule(plan, view, record, clock, settled), [plan, view, record, clock, settled]);
  const model = useMemo(() => {
    const bounds = runBounds(inputs);
    const origin = bounds ? clock.at(bounds.start) : 0;
    const end = Math.max(sched.end, bounds ? clock.at(bounds.end) : 0);
    return buildModel({ inputs, layout, plan, sched, clock, settledSeq: settled, origin, end, back: recordedAt });
  }, [inputs, layout, plan, sched, clock, settled, recordedAt]);
  const end = live ? model.end : Math.max(model.end, timeline.span);

  // a replay belongs to a finished run: a run that is live again shows live
  const [stored, setReplay] = useState<Replay | null>(null);
  const replay = live || driven ? null : stored;
  const [wall, setWall] = useState({ ms: 0, perf: 0 });
  const t = driven ? driven.t : replay ? replayAt(replay, wall.perf) : live ? wall.ms : Infinity;
  const playing = replay?.playing ?? false;
  // live: keep ticking until the last recorded moment and every walk, ride and leg it set off have finished
  const liveEnd = useMemo(() => {
    let e = model.end;
    for (const r of model.lift.rides) if (Number.isFinite(r.end)) e = Math.max(e, r.end);
    for (const rider of Object.values(model.riders)) for (const leg of rider.legs) if (Number.isFinite(leg.end)) e = Math.max(e, leg.end);
    return e;
  }, [model]);
  // the tower's own ticker runs for its own replay and a live run; a full-run replay re-renders it at its cursor
  const moving = !driven && (playing || (live !== null && t < liveEnd + 500));
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

  // a replay holds while the tower is off screen, and picks up where it was when it is back (event callbacks only)
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

  const office = useMemo(() => frameAt(plan, sched, t), [plan, sched, t]);
  // a finished view of a run still parked at a gate: its wait reads the wall clock since the recorded park, once a second
  const [wallNow, setWallNow] = useState(0);
  const finalWall = !live && !replay && !driven && wallNow > 0 ? wallNow : null;
  const frame = useMemo(() => towerFrame(model, office, t, reduced, finalWall), [model, office, t, reduced, finalWall]);
  const parkedNow = !live && !replay && !driven && (frame.gates.h1.state === "waiting" || frame.gates.h2.state === "waiting");
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
  const shownSent = replay || driven ? office.sent : -1;
  const scoresUp = office.scores;
  const replayState = useMemo(() => (shownSent < 0 ? null : { sent: sentFirst(sched, shownSent), scores: scoresUp }), [shownSent, sched, scoresUp]);
  useEffect(() => onReplay(replayState), [replayState, onReplay]);

  // the animation-frame loop: walkers, the cabin and capsules move between the 10 Hz renders
  const driveNow = driven?.now ?? null;
  const now = useMemo(() => driveNow ?? (() => (replay ? replayAt(replay, performance.now()) : live ? Date.now() : Infinity)), [driveNow, replay, live]);
  const paused = (driven ? !driven.playing : replay !== null && !replay.playing) || !onScreen;
  const done = driven ? !Number.isFinite(driven.t) : !live && (!replay || (!replay.playing && replay.base >= end));
  const motion = useMotion(now, !reduced && !paused && !done && (moving || (driven?.playing ?? false)));

  const [hover, setHover] = useState<string | null>(null);
  const [tabStop, setTabStop] = useState<string | null>(null);
  const sentSet = useMemo(() => sentFirst(sched, office.sent), [sched, office.sent]);
  // agent cards and labels count only the messages sent by the frame's time
  const stats = useMemo(() => nodeStats(view, view.messages.filter((m) => sentSet.has(m.messageId))), [view, sentSet]);
  const challenges = view.messages.filter((m) => m.kind === "challenge" && sentSet.has(m.messageId)).length;
  const seats: SeatInfo[] = plan.order.flatMap((id) => {
    const seat = plan.seats[id];
    if (!seat) return [];
    return [{ id, role: seat.role, team: seat.team, dim: !seatInFocus(plan, view, focus, seat), on: seat.agentId !== null && focus === `agent:${seat.agentId}` }];
  });
  const pressesRunning = frame.calling.includes("S6") || (!calls?.length && frame.running.includes("S6"));
  const briefReady = frame.finished.S13 !== undefined;

  const lines: string[] = [];
  for (const id of plan.order) {
    const a = frame.agents[id];
    const seat = plan.seats[id];
    if (!a || !seat || !a.present || a.placement === "absent" || (a.activity === "idle" && !a.leg)) continue;
    lines.push(`${seatName(seat, plan, view)}: ${towerActivityWords(a, frame, model).replace(/\.$/, "").toLowerCase()}`);
  }

  const startReplay = () => {
    const base = replay && replay.base < end ? replay.base : 0;
    setReplay({ base, wall: performance.now(), playing: true, speed: replay?.speed ?? 1 });
  };
  const pauseReplay = () => replay && setReplay({ ...replay, base: replayAt(replay, performance.now()), playing: false });
  const scrub = (ms: number) => setReplay((r) => ({ base: Math.max(0, Math.min(end, ms)), wall: performance.now(), playing: false, speed: r?.speed ?? 1 }));
  const cycleSpeed = () =>
    setReplay((r) => {
      const speed = SPEEDS[(SPEEDS.indexOf(r?.speed ?? 1) + 1) % SPEEDS.length] ?? 1;
      return r ? { ...r, base: replayAt(r, performance.now()), wall: performance.now(), speed } : { base: end, wall: performance.now(), playing: false, speed };
    });
  // H1 or H2 waiting on screen in a replay: offer to skip to the gate's recorded answer
  const gateSkip = (() => {
    if (!replay) return null;
    for (const g of [frame.gates.h1, frame.gates.h2]) {
      if (g.state === "waiting" && g.skipTo !== null && Number.isFinite(g.skipTo) && g.skipTo > t) return { to: g.skipTo, label: "Skip the wait" };
    }
    return null;
  })();

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && focus !== "all") {
      e.preventDefault();
      onFocus("all");
    }
  };
  const mode = live ? "Live" : (replay || driven) && !done ? "Replay" : "Final state";
  const rows = logAt(model.log, t);

  return (
    <div
      ref={boxRef}
      className="tw-root rounded-lg border border-hairline bg-canvas"
      data-office-style="tower"
      data-stage={frame.step ?? ""}
      data-tower-paused={paused ? "" : undefined}
      data-office-paused={paused ? "" : undefined}
      data-office-driven={driven ? "" : undefined}
      onKeyDown={onKey}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-hairline px-4 py-2.5">
        <Caption mode={mode} frame={frame} lines={lines} />
        {!live && !driven && onReplayRun && (
          <button type="button" onClick={onReplayRun} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline px-3 text-xs font-medium text-ink-2 hover:bg-surface">
            Full-run replay
          </button>
        )}
        {!live && !driven && end > 0 && (
          <Controls
            t={t}
            end={end}
            origin={model.origin}
            playing={playing}
            replaying={replay !== null}
            speed={replay?.speed ?? 1}
            sent={office.sent}
            skip={gateSkip}
            onPlay={startReplay}
            onPause={pauseReplay}
            onScrub={scrub}
            onSpeed={cycleSpeed}
            onFinal={() => setReplay(null)}
            back={model.back}
          />
        )}
      </div>
      <div className="border-b border-hairline px-4 py-2">
        <StepStrip strip={frame.strip} current={frame.step} />
      </div>

      <div className="tw-fit" style={{ "--tw-ratio": `${layout.w} / ${layout.h}` } as CSSProperties}>
        <div
          className="tw-scene"
          role="group"
          aria-label={`Bid Tower: ${frame.scene.rivals.length} rival floors; ${frame.tally.supported + frame.tally.partly + frame.tally.withheld} claims checked; ${office.sent} messages sent. The message thread below holds every message.`}
        >
          <Shell layout={layout} phase={frame.phase} theme={theme} known={frame.scene.rivals.join("|")} />
          <Stage
            layout={layout}
            frame={frame}
            lift={model.lift}
            racks={model.racks}
            seats={seats}
            reduced={reduced}
            motion={motion}
            hover={hover}
            briefReady={briefReady}
            challenges={challenges}
            pressesRunning={pressesRunning}
          />
          <Overlay
            layout={layout}
            model={model}
            frame={frame}
            plan={plan}
            view={view}
            focus={focus}
            onFocus={onFocus}
            hover={hover}
            onHover={setHover}
            stats={stats}
            tabStop={tabStop}
            onTabStop={setTabStop}
            board={view.board}
            origin={model.origin}
          />
        </div>
      </div>

      <EventLog rows={rows} origin={model.origin} onSeek={live ? null : driven ? (ms) => driven.seek(driven.recordedAt(ms)) : scrub} back={model.back} />
      <Legend pods={plan.pods.filter((p) => !frame.vacant.includes(p.key)).map((p) => ({ key: p.key, label: p.label, team: p.team }))} />
      <p className="border-t border-hairline px-4 py-2 text-xs text-muted">
        Every movement is a recorded event: a researcher rides down to the records archive when its lane starts and back with printouts; a rack
        light is a recorded model call; a slip at the notary booth is an S7 verdict, filed to its rival&apos;s in-tray; a capsule in the brass tubes is
        an S9 message; the board meets on the roof. Times shown are the office replay&apos;s; model-call windows are model time, summed over
        attempts. Hover or focus an agent for its card; click an agent or a floor to show only those messages in the thread below.
        {recordError && <span className="text-danger"> Research and verification events could not be read ({recordError}); the swarm still shows.</span>}
      </p>
    </div>
  );
}
