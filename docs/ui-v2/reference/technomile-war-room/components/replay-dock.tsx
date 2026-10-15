"use client";

import { Check, ClockCounterClockwise, LinkSimple, Pause, Play, SkipBack, SkipForward, X } from "@phosphor-icons/react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { StatusGlyph } from "@/components/pipeline/status-glyph";
import { Segmented } from "@/components/ui/segmented";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { clock, duration } from "@/lib/format";
import { STEP_META } from "@/lib/pipeline/steps";
import { RUN_SPEEDS } from "@/lib/war-room/player";
import { activity, GATE_PLAY_MS, phaseSpans, segmentAt, trackSegments, type PlaybackMap, type ReplayGate, type Timeline, type TrackSegment } from "@/lib/war-room/replay";
import { dayOf, replayHref, replayKey, timeOfDay, zoneName, type ReplayAction } from "@/lib/war-room/replay-controls";
import type { ReplayEngine, ReplayState } from "@/lib/war-room/replay-engine";

import type { RunFeed } from "./run-feed";

/** Do one transport action on the engine. */
function act(engine: ReplayEngine, a: ReplayAction): void {
  if (a.type === "toggle") engine.toggle();
  else if (a.type === "seek") engine.seekBy(a.deltaMs);
  else if (a.type === "jump") engine.jump(a.dir);
  else if (a.type === "start") engine.seek(engine.timeline.t0);
  else engine.seek(engine.timeline.end);
}

/** The link to the moment the replay shows (`?replay=1&t=<seconds from the run's creation>`). */
function momentHref(engine: ReplayEngine): string {
  return replayHref(window.location.href, { replay: true, t: (engine.getState().r - engine.timeline.t0) / 1000 });
}

/** Keep `?t=` on the moment shown after a person moved or paused the replay (playing never rewrites the URL). */
function syncLink(engine: ReplayEngine): void {
  window.history.replaceState(null, "", momentHref(engine));
}

/** After an action: a paused or moved replay keeps its moment in the URL. */
function settle(engine: ReplayEngine, a: ReplayAction): void {
  if (a.type !== "toggle" || !engine.getState().playing) syncLink(engine);
}

const pct = (map: PlaybackMap, r: number) => (map.duration > 0 ? (map.toPlay(r) / map.duration) * 100 : 0);

function stepName(seg: TrackSegment | null): string {
  return seg ? `${seg.id} ${STEP_META[seg.id].name}` : "between steps";
}

/** A gate's true wait, and how long it plays when it is collapsed. */
function waitWords(g: ReplayGate, map: PlaybackMap): string {
  const shown = map.collapsed.includes(g) ? `, played in ${duration(GATE_PLAY_MS)}` : "";
  return g.actedAt === null ? `waiting ${duration(g.waitMs)} when the record ends${shown}` : `waited ${duration(g.waitMs)}${shown}`;
}

/**
 * The full-run replay's transport, docked at the bottom of the run page whichever view is shown: a scrubber over the
 * whole run (stage segments grouped by phase, the H1 and H2 waits marked with their true length), play and pause,
 * stage jumps, speeds, the recorded time of day with seconds and the elapsed time of the run, the gate-wait choice, a
 * link to the moment, and the way out. Keyboard: Space, Left / Right (5 s), Shift with them (stage), Home / End.
 */
export function ReplayDock({ feed }: { feed: RunFeed }) {
  const offer = feed.replayOffer;
  const replay = feed.replay;
  if (!offer.active) return null;
  return (
    <section
      aria-label="Run replay"
      data-replay-dock
      className="sticky bottom-3 z-[var(--z-sticky)] mt-6 overflow-hidden rounded-xl border border-hairline-strong bg-canvas shadow-4"
    >
      {replay ? <Transport engine={replay.engine} state={replay.state} exit={offer.exit} /> : <Preparing exit={offer.exit} problem={offer.problem} />}
    </section>
  );
}

/**
 * The way into the replay, beside the view toggle: offered only once the run is no longer live. While the replay is
 * on, a plain label says so (the dock below has the controls).
 */
export function ReplayEntry({ feed }: { feed: RunFeed }) {
  const offer = feed.replayOffer;
  if (!offer.available && !offer.active) return null;
  if (offer.active) {
    return (
      <span className="inline-flex h-8 items-center gap-2 rounded-full border border-hairline-strong bg-surface px-3 text-sm font-medium text-ink" data-replay-badge>
        <ClockCounterClockwise size={15} aria-hidden />
        Replay of the recorded run
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={offer.enter}
      data-replay-enter
      className="inline-flex h-8 items-center gap-2 rounded-md border border-hairline-strong bg-canvas px-3 text-sm font-medium text-ink hover:border-control hover:bg-surface"
    >
      <ClockCounterClockwise size={15} aria-hidden />
      Replay the run
      {offer.totalMs !== null && <span className="font-mono text-xs text-muted tabular">{clock(offer.totalMs)}</span>}
    </button>
  );
}

function Preparing({ exit, problem }: { exit: () => void; problem: string | null }) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm text-ink-2" aria-busy="true" role="status">
      <ClockCounterClockwise size={18} aria-hidden className="animate-pulse-soft text-muted" />
      {problem ? (
        <span className="text-danger">The run&apos;s record could not be read ({problem}).</span>
      ) : (
        <span>Reading the run&apos;s record from its first event to its last; the replay starts once all of it is here.</span>
      )}
      <ExitButton exit={exit} />
    </div>
  );
}

function ExitButton({ exit }: { exit: () => void }) {
  return (
    <button
      type="button"
      onClick={exit}
      aria-label="Exit replay"
      className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-ink-2 hover:bg-surface-2 hover:text-ink sm:px-2.5"
    >
      <X size={14} aria-hidden />
      <span className="hidden sm:inline">Exit replay</span>
      <span className="sm:hidden">Exit</span>
    </button>
  );
}

function Transport({ engine, state, exit }: { engine: ReplayEngine; state: ReplayState; exit: () => void }) {
  const tl = engine.timeline;
  const map = state.map;
  const segments = useMemo(() => trackSegments(tl), [tl]);
  const current = segmentAt(segments, state.r);

  // the replay keys anywhere on the page (a focused control keeps the keys it owns; the scrubber handles its own)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      const a = replayKey({ key: e.key, shift: e.shiftKey, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, tag: el?.tagName ?? null, role: el?.getAttribute("role") ?? null, editable: el?.isContentEditable ?? false });
      if (!a) return;
      e.preventDefault();
      act(engine, a);
      settle(engine, a);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine]);

  const run = (a: ReplayAction) => {
    act(engine, a);
    settle(engine, a);
  };

  return (
    <div className="px-3 pb-2.5 pt-2 sm:px-4">
      <Scrubber engine={engine} tl={tl} map={map} segments={segments} r={state.r} playing={state.playing} />
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2 sm:gap-x-4">
        <div className="flex items-center gap-0.5 sm:gap-1">
          <IconButton label="Previous stage" shortcut="Shift+ArrowLeft" hint="Shift Left" onClick={() => run({ type: "jump", dir: -1 })}>
            <SkipBack size={16} weight="fill" aria-hidden />
          </IconButton>
          <button
            type="button"
            onClick={() => run({ type: "toggle" })}
            aria-label={state.playing ? "Pause the replay" : "Play the replay"}
            aria-keyshortcuts="Space"
            data-replay-play
            className="inline-flex size-9 items-center justify-center rounded-full bg-ink text-on-ink shadow-2 transition-transform duration-[var(--duration-instant)] hover:bg-ink-2 active:scale-95 sm:size-10"
          >
            {state.playing ? <Pause size={18} weight="fill" aria-hidden /> : <Play size={18} weight="fill" aria-hidden className="translate-x-px" />}
          </button>
          <IconButton label="Next stage" shortcut="Shift+ArrowRight" hint="Shift Right" onClick={() => run({ type: "jump", dir: 1 })}>
            <SkipForward size={16} weight="fill" aria-hidden />
          </IconButton>
        </div>
        <Clock tl={tl} r={state.r} />
        <NowStep seg={current} map={map} ended={state.ended} finalStatus={tl.finalStatus} />
        <div className="ml-auto flex flex-wrap items-center gap-1 sm:gap-2">
          <Segmented
            label="Replay speed"
            value={String(state.speed)}
            onChange={(v) => engine.setSpeed(Number(v))}
            className="bg-canvas"
            itemClassName="h-7 px-2 font-mono text-xs tabular"
            options={RUN_SPEEDS.map((s) => ({ value: String(s), label: `${s}x`, name: `${s} times speed` }))}
          />
          <WaitsSwitch engine={engine} on={state.includeWaits} collapsible={tl.gates.some((g) => g.waitMs > GATE_PLAY_MS)} />
          <CopyMoment engine={engine} />
          <ExitButton exit={exit} />
        </div>
      </div>
      <Announcer seg={current} />
    </div>
  );
}

function IconButton({ label, shortcut, hint, onClick, children }: { label: string; shortcut: string; hint: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tip label={`${label} (${hint})`}>
      <button type="button" onClick={onClick} aria-label={label} aria-keyshortcuts={shortcut} className="inline-flex size-7 items-center justify-center rounded-full text-ink-2 hover:bg-surface-2 hover:text-ink sm:size-8">
        {children}
      </button>
    </Tip>
  );
}

/** The recorded time of day with seconds (the viewer's time zone) and the run's elapsed and total time. */
function Clock({ tl, r }: { tl: Timeline; r: number }) {
  return (
    <div className="flex items-baseline gap-2 sm:gap-3" data-replay-clock>
      <span className="font-mono text-lg font-medium text-ink tabular sm:text-xl" aria-label={`Recorded time ${timeOfDay(r)} ${zoneName(r)}`}>
        {timeOfDay(r)}
        <span className="ml-1 text-micro font-normal text-muted">{zoneName(r)}</span>
      </span>
      <span className="font-mono text-xs text-ink-2 tabular sm:text-sm" aria-label={`${clock(r - tl.t0)} of ${clock(tl.end - tl.t0)} into the run`}>
        {clock(r - tl.t0)}
        <span className="text-faint"> / {clock(tl.end - tl.t0)}</span>
      </span>
    </div>
  );
}

/** The step at the cursor, with a gate's true wait. */
function NowStep({ seg, map, ended, finalStatus }: { seg: TrackSegment | null; map: PlaybackMap; ended: boolean; finalStatus: string }) {
  if (ended) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-sm text-ink" data-replay-step="end" title="The views show the run as it stands now">
        <StatusGlyph status={finalStatus === "decided" ? "approved" : "done"} gate={finalStatus === "decided"} size={12} />
        <span className="font-medium">End of the record</span>
        <span className="text-xs text-ink-2">{finalStatus.replaceAll("_", " ")}</span>
      </span>
    );
  }
  if (!seg) return <span className="text-sm text-muted">Between steps</span>;
  const gate = seg.gate;
  return (
    <span
      className={cn("inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-sm", gate ? "border border-cream-edge bg-cream-deep text-ink" : "bg-surface-2 text-ink")}
      data-replay-step={seg.id}
    >
      <StatusGlyph status={gate ? "waiting" : "running"} gate={gate !== null} size={12} />
      <span className="font-mono text-xs font-semibold">{seg.id}</span>
      <span className="truncate font-medium">{STEP_META[seg.id].name}</span>
      {gate && <span className="truncate text-xs text-ink-2">{waitWords(gate, map)}</span>}
    </span>
  );
}

function WaitsSwitch({ engine, on, collapsible }: { engine: ReplayEngine; on: boolean; collapsible: boolean }) {
  return (
    <Tip
      label={
        collapsible
          ? "The human waits at H1 and H2 play in 3 seconds by default. Switch on to play them in real time. The clock always shows the recorded time."
          : "This run's gate waits are under 3 seconds, so they play in real time."
      }
    >
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Include gate waits"
        disabled={!collapsible}
        onClick={() => engine.setIncludeWaits(!on)}
        className="inline-flex h-8 items-center gap-2 rounded-md px-2 text-xs font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-45"
      >
        <span aria-hidden className={cn("relative h-4 w-7 rounded-full border transition-colors duration-[var(--duration-fast)]", on ? "border-ink bg-ink" : "border-control bg-canvas")}>
          <span className={cn("absolute top-1/2 size-2.5 -translate-y-1/2 rounded-full transition-transform duration-[var(--duration-fast)]", on ? "translate-x-[13px] bg-on-ink" : "translate-x-[2px] bg-control")} />
        </span>
        <span className="hidden sm:inline">Include gate waits</span>
        <span className="sm:hidden">Gate waits</span>
      </button>
    </Tip>
  );
}

function CopyMoment({ engine }: { engine: ReplayEngine }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tip label={copied ? "Link copied" : "Copy a link to this moment"}>
      <button
        type="button"
        aria-label="Copy a link to this moment"
        onClick={() => {
          void navigator.clipboard?.writeText(momentHref(engine)).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="inline-flex size-8 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 hover:text-ink"
      >
        {copied ? <Check size={15} aria-hidden /> : <LinkSimple size={15} aria-hidden />}
      </button>
    </Tip>
  );
}

/** Says each new step once, politely, for screen readers (the views' own text stays the full record). */
function Announcer({ seg }: { seg: TrackSegment | null }) {
  return (
    <p className="sr-only" aria-live="polite">
      {seg ? `${stepName(seg)} ${seg.gate ? "reached" : "started"} at ${timeOfDay(seg.r0)}` : ""}
    </p>
  );
}

/* ------------------------------------------------------------------------------------------------ scrubber */

/**
 * The whole run on one track. Stages are segments placed by playback time (a collapsed gate wait is narrow, marked
 * with a diamond and its true length), grouped under their phase; the played part is solid, the step at the cursor
 * is in the signal colour. Drag or click to seek; for the keyboard and assistive tech it is a slider that takes the
 * replay keys.
 */
function Scrubber({ engine, tl, map, segments, r, playing }: { engine: ReplayEngine; tl: Timeline; map: PlaybackMap; segments: TrackSegment[]; r: number; playing: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; r: number } | null>(null);
  const dragging = useRef(false);
  const total = tl.end - tl.t0;
  const current = segmentAt(segments, r);

  const timeAtX = useCallback(
    (clientX: number) => {
      const el = box.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
      return { x: f * 100, r: map.toRecorded(f * map.duration) };
    },
    [map],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const hit = timeAtX(e.clientX);
    if (!hit) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    engine.seek(hit.r);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const hit = timeAtX(e.clientX);
    setHover(hit);
    if (dragging.current && hit) engine.seek(hit.r);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    syncLink(engine);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const a = replayKey({ key: e.key, shift: e.shiftKey, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, scrubber: true });
    if (!a) return;
    e.preventDefault();
    act(engine, a);
    settle(engine, a);
  };

  const hoverSeg = hover ? segmentAt(segments, hover.r) : null;
  const bars = useMemo(() => activity(tl, map, ACTIVITY_BARS), [tl, map]);
  return (
    <div className="relative select-none">
      <Phases map={map} segments={segments} />
      <div
        ref={box}
        role="slider"
        tabIndex={0}
        aria-label="Replay position"
        aria-valuemin={0}
        aria-valuemax={Math.round(total / 1000)}
        aria-valuenow={Math.round((r - tl.t0) / 1000)}
        aria-valuetext={`${timeOfDay(r)} ${zoneName(r)}, ${clock(r - tl.t0)} of ${clock(total)}, ${stepName(current)}`}
        aria-keyshortcuts="Space ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home End"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
        className="group relative h-7 cursor-pointer sm:h-10 touch-none rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
        data-replay-scrubber
      >
        <Activity bars={bars} />
        <Segments segments={segments} map={map} r={r} playing={playing} />
        {tl.gates.map((g) => (
          <span
            key={g.id}
            aria-hidden
            className="pointer-events-none absolute bottom-[7px] size-2.5 -translate-x-1/2 rotate-45 rounded-[2px] border border-ink bg-cream-deep"
            style={{ left: `${pct(map, g.parkAt)}%` }}
            data-gate-marker={g.id}
          />
        ))}
        {/* the playhead: a line through the activity and the track, and a knob, moved by transform only */}
        <div aria-hidden className={cn("pointer-events-none absolute inset-0", playing && "transition-transform duration-100 ease-linear")} style={{ transform: `translateX(${pct(map, r)}%)` }}>
          <div className="absolute bottom-0.5 left-0 top-0 w-0.5 -translate-x-1/2 rounded-full bg-signal" />
          <div className="absolute bottom-[5px] left-0 size-3.5 -translate-x-1/2 rounded-full border-2 border-canvas bg-signal shadow-2 transition-transform duration-[var(--duration-fast)] group-hover:scale-110" />
        </div>
        {hover && (
          <div
            aria-hidden
            className="pointer-events-none absolute bottom-[calc(100%-0.875rem)] z-[var(--z-tooltip)] -translate-x-1/2 whitespace-nowrap rounded-sm bg-ink px-2 py-1 text-xs text-on-ink shadow-3"
            style={{ left: `${Math.min(92, Math.max(8, hover.x))}%` }}
          >
            <span className="font-mono tabular">{timeOfDay(hover.r)}</span>
            <span className="opacity-70"> {clock(hover.r - tl.t0)}</span>
            <span className="ml-1.5">{stepName(hoverSeg)}</span>
            {hoverSeg?.gate && <span className="opacity-70">, {waitWords(hoverSeg.gate, map)}</span>}
          </div>
        )}
      </div>
      <div className="mt-0.5 flex items-baseline justify-between gap-3 font-mono text-micro text-faint tabular">
        <span aria-hidden>
          {dayOf(tl.t0)} · {timeOfDay(tl.t0)} {zoneName(tl.t0)}
        </span>
        {tl.gates.length > 0 && (
          <span className="hidden min-w-0 truncate font-sans text-muted sm:inline" data-replay-gates>
            {tl.gates.map((g, i) => (
              <span key={g.id}>
                {i > 0 && <span aria-hidden> · </span>}
                <span className="font-mono font-semibold text-ink-2">{g.id}</span> {waitWords(g, map)}
              </span>
            ))}
          </span>
        )}
        <span aria-hidden>{timeOfDay(tl.end)}</span>
      </div>
    </div>
  );
}

/** The width of an element, kept current as it resizes (0 before it is measured). */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** About how wide a phase name is in the micro size, with its tick (a narrower phase shows the tick alone). */
const labelPx = (label: string) => label.length * 6.6 + 10;

/** Phase names over the track, each over its span (a phase too narrow for its name keeps only its tick). */
const Phases = memo(function Phases({ map, segments }: { map: PlaybackMap; segments: TrackSegment[] }) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  return (
    <div ref={box} aria-hidden className="relative mb-0.5 h-4 text-micro font-medium text-muted">
      {phaseSpans(segments).map((s) => {
        const left = pct(map, s.r0);
        const span = Math.max(0, pct(map, s.r1) - left);
        const fits = width > 0 && (span / 100) * width >= labelPx(s.label);
        return (
          <div key={s.phase} className="absolute top-0 flex h-4 items-end overflow-hidden" style={{ left: `${left}%`, width: `${span}%` }} title={s.label}>
            <span className="whitespace-nowrap border-l border-hairline-strong pl-1 leading-none">{fits ? s.label : " "}</span>
          </div>
        );
      })}
    </div>
  );
});

/** How many bars the activity histogram has across the track. */
const ACTIVITY_BARS = 120;

/** The recorded events along the track, as faint bars (square-root scaled, so a burst does not flatten the rest). */
const Activity = memo(function Activity({ bars }: { bars: number[] }) {
  const max = Math.max(1, ...bars);
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-x-0 top-0.5 hidden h-4 w-full sm:block" viewBox={`0 0 ${bars.length} 1`} preserveAspectRatio="none" data-replay-activity>
      {bars.map((c, i) => {
        if (c === 0) return null;
        const h = Math.max(0.14, Math.sqrt(c / max));
        return <rect key={i} x={i + 0.14} width={0.72} y={1 - h} height={h} className="fill-ink/20" />;
      })}
    </svg>
  );
});

/** The stage and gate segments: played, at the cursor (filled to the playhead), or still ahead. */
function Segments({ segments, map, r, playing }: { segments: TrackSegment[]; map: PlaybackMap; r: number; playing: boolean }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-[7px] h-2.5 overflow-hidden rounded-full bg-hairline">
      {/* the played stretch, under the segments: the time between steps (a launch, an approval) reads as played too */}
      <div className={cn("absolute inset-0 origin-left bg-ink/25", playing && "transition-transform duration-100 ease-linear")} style={{ transform: `scaleX(${map.duration > 0 ? map.toPlay(r) / map.duration : 0})` }} />
      {segments.map((s) => {
        const p0 = map.toPlay(s.r0);
        const p1 = map.toPlay(s.r1);
        const left = map.duration > 0 ? (p0 / map.duration) * 100 : 0;
        const width = map.duration > 0 ? (Math.max(0, p1 - p0) / map.duration) * 100 : 0;
        const gate = s.gate !== null;
        const here = r >= s.r0 && r < s.r1;
        const fill = here ? Math.min(1, Math.max(0, (map.toPlay(r) - p0) / Math.max(1e-6, p1 - p0))) : r >= s.r1 ? 1 : 0;
        return (
          <div
            key={`${s.kind}-${s.id}-${s.r0}`}
            className={cn("absolute inset-y-0 overflow-hidden border-l border-canvas", gate ? "bg-cream-deep" : s.status === "failed" ? "bg-danger-soft" : "bg-hairline-strong/60")}
            style={{ left: `${left}%`, width: `${width}%` }}
            data-segment={s.id}
          >
            {gate && <div className="hatch absolute inset-0" />}
            <div
              className={cn(
                "absolute inset-0 origin-left",
                here ? "bg-signal" : gate ? "bg-cream-edge" : s.status === "failed" ? "bg-danger" : "bg-ink",
                s.status === "degraded" && !here && "hatch",
                playing && here && "transition-transform duration-100 ease-linear",
              )}
              style={{ transform: `scaleX(${fill})` }}
            />
          </div>
        );
      })}
    </div>
  );
}
