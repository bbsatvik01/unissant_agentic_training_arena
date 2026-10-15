"use client";

import "@xyflow/react/dist/base.css";

import {
  ArrowBendUpLeft,
  ArrowsIn,
  CornersOut,
  Crosshair,
  FileText,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  Microphone,
  Pause,
  Play,
  Star,
  Strategy,
  Tray,
  X,
} from "@phosphor-icons/react";
import { Background, BackgroundVariant, ReactFlow, ReactFlowProvider, useReactFlow, ViewportPortal, type Node, type NodeProps } from "@xyflow/react";
import { scaleLinear } from "d3-scale";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "@/lib/cn";
import type { AgentMessage } from "@/lib/contracts/run-events";
import { rivalPods, type OfficeRecord } from "@/lib/war-room/office";
import { agentName, shortName, type GroupKind, type SwarmView } from "@/lib/war-room/swarm";
import { GRAPH_SPEEDS, localClock, localNow, nextSpeed, pause, play, seek, setSpeed, type LocalClock } from "@/lib/war-room/swarm-clock";
import { nodeStats, type Focus, type NodeStats } from "@/lib/war-room/swarm-graph";
import { DIM, edgeGeometry, highlight, layoutNetwork, neighbours, pairKey, ribbonWidth, type EdgeGeometry, type NetAgent, type NetLayout } from "@/lib/war-room/swarm-net";
import { buildStrip, nearestTick, sliderText, stepTick, type Strip, type StripTick } from "@/lib/war-room/swarm-strip";
import {
  ariaFor,
  buildModel,
  captionFor,
  feedSettledAt,
  formatSince,
  formatSpan,
  lod,
  replayFrame,
  roundSeek,
  scheduleFeed,
  stepTarget,
  swarmAt,
  type FeedSchedule,
  type SwarmFrame,
  type SwarmModel,
} from "@/lib/war-room/swarm-time";

import { AgentCardTip } from "./agent-card-tip";
import { ROLE_ICON } from "./roles";
import { useReducedMotion } from "./use-reduced-motion";
import { FrameStore, useFrame } from "./use-swarm-frame";

/* ------------------------------------------------------------------------------------------------ colour */

const HUB_TINT: Partial<Record<GroupKind, string>> = { red_team: "office-red", analyst: "office-home", board: "office-board" };

function tintOf(kind: GroupKind, team: number): string {
  return HUB_TINT[kind] ?? `team-${((team % 6) + 6) % 6}`;
}

function teamVars(kind: GroupKind, team: number): CSSProperties {
  const t = tintOf(kind, team);
  return { "--team": `var(--color-${t})`, "--team-strong": `var(--color-${t}-strong)` } as CSSProperties;
}

/** The strong colour of whoever is drawn as `node` (an agent or an anchor). */
function strongOf(layout: NetLayout, node: string): string {
  const a = layout.byId[node];
  if (a) return `var(--color-${tintOf(a.kind, a.team)}-strong)`;
  if (node === "anchor:red_team") return "var(--color-office-red-strong)";
  if (node === "anchor:analyst") return "var(--color-office-home-strong)";
  if (node === "anchor:board") return "var(--color-office-board-strong)";
  const pod = layout.pods.find((p) => `anchor:${p.groupId}` === node);
  return `var(--color-${tintOf("rival", pod?.team ?? 0)}-strong)`;
}

const KIND_GLYPH: Record<AgentMessage["kind"], typeof FileText> = {
  brief: FileText,
  strategy: Strategy,
  challenge: Crosshair,
  response: ArrowBendUpLeft,
  interview: Microphone,
  rating: Star,
};

/** Wall time when a feed delivery is seen (the schedule records it; the frame loop reads the same clock). */
function wallNow(): number {
  return Date.now();
}

/* ------------------------------------------------------------------------------------------------ context */

interface Graph {
  store: FrameStore;
  view: SwarmView;
  layout: NetLayout;
  geoms: Map<string, EdgeGeometry>;
  /** Directed edges of the whole record: key -> [from, to]. */
  edges: [string, string, string][];
  lit: (node: string) => boolean;
  litEdge: (from: string, to: string) => boolean;
  dimming: boolean;
  focus: Focus;
  toggle: (f: Focus) => void;
  hover: (f: Focus | null) => void;
  reserved: boolean;
  /** An agent's counts as of the frame (a replay never shows totals it has not reached). */
  statsOf: (id: string) => NodeStats | undefined;
}

const GraphContext = createContext<Graph | null>(null);

function useGraph(): Graph {
  const g = useContext(GraphContext);
  if (!g) throw new Error("graph context missing");
  return g;
}

/* ------------------------------------------------------------------------------------------------ view */

export interface SwarmGraphViewProps {
  view: SwarmView;
  record: OfficeRecord | null;
  running: boolean;
  focus: Focus;
  onFocus: (f: Focus) => void;
  /** The graph's own replay moved: the thread shows messages recorded up to this time (null: all of them). */
  onCutoff?: (t: number | null) => void;
  /** A run-level replay drives the feed: the graph's own replay is hidden. */
  runReplay?: boolean;
  /** The run-level replay's clock: while it is active the graph draws every frame at its cursor. */
  replay?: GraphReplay | null;
}

/** What the graph needs from a run-level replay (components/war-room/use-run-replay.ts). */
export interface GraphReplay {
  /** Recorded time now, smooth between the replay's ticks. */
  recordedNow: () => number;
  seek: (recorded: number) => void;
  /** The cursor's recorded time: it changes on every seek, pause and tick. */
  at: number;
  speed: number;
  playing: boolean;
  ended: boolean;
  /** The whole record: the graph lays out every slot from it and draws it as of the cursor. */
  full: SwarmView;
}

export default function SwarmGraphView(props: SwarmGraphViewProps) {
  return (
    <ReactFlowProvider>
      <GraphCard {...props} />
    </ReactFlowProvider>
  );
}

const NO_RECORD: OfficeRecord = { lanes: [], fetches: [], verifies: [], stages: [], parks: [], notes: [], lastSeq: 0 };
const COMETS = 32;
const RIPPLES = 16;
const TAIL = 12;

function GraphCard({ view: feedView, record, running, focus, onFocus, onCutoff, runReplay = false, replay = null }: SwarmGraphViewProps) {
  const reduced = useReducedMotion();
  const card = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  // a run-level replay: the whole record, drawn at the replay's cursor (never on the wall clock)
  const drive = runReplay ? replay : null;
  const view = drive?.full ?? feedView;
  const pods = useMemo(() => rivalPods(view, record ?? NO_RECORD), [view, record]);
  const layout = useMemo(() => layoutNetwork(view, pods, { compact }), [view, pods, compact]);
  const model = useMemo(() => buildModel(view, layout), [view, layout]);
  const strip = useMemo(() => buildStrip(model, layout), [model, layout]);
  const store = useMemo(() => new FrameStore(), []);

  // feed mode: every message is drawn when it arrives (the first read is settled history)
  const [sched, setSched] = useState<{ view: SwarmView; s: FeedSchedule } | null>(null);
  if (!drive && sched?.view !== feedView) setSched({ view: feedView, s: scheduleFeed(sched?.s ?? null, feedView, wallNow()) });
  // leaving a run-level replay starts the feed afresh: what it shows then is history, not new arrivals
  if (drive && sched !== null) setSched(null);
  const schedule = !drive && sched?.view === feedView ? sched.s : null;
  const display = useMemo(() => (schedule ? buildModel(view, layout, schedule) : model), [schedule, view, layout, model]);

  // local mode: the graph's own replay of a finished run, on the recorded clock
  const [clock, setClock] = useState<LocalClock | null>(null);
  const localOn = clock !== null && !running && !runReplay;
  const playable = !running && !runReplay && model.messages.length > 0;

  const edges = useMemo(() => Object.values(model.edges).map((e) => [e.key, e.from, e.to] as [string, string, string]), [model]);
  const geoms = useMemo(() => {
    const out = new Map<string, EdgeGeometry>();
    for (const [key, from, to] of edges) {
      const g = edgeGeometry(layout, from, to);
      if (g) out.set(key, g);
    }
    return out;
  }, [edges, layout]);
  const nbrs = useMemo(() => neighbours(edges.map(([, from, to]) => ({ from, to }))), [edges]);

  const [hovered, setHovered] = useState<Focus | null>(null);
  const active = hovered ?? (focus === "all" ? null : focus);
  const recordedClock = localOn || drive !== null;
  const graph = useMemo<Graph>(() => {
    const { lit, litEdge, dimming } = highlight(active, layout, nbrs);
    return {
      store,
      view,
      layout,
      geoms,
      edges,
      lit,
      litEdge,
      dimming,
      focus,
      toggle: (f) => onFocus(focus === f ? "all" : f),
      hover: setHovered,
      reserved: localOn,
      statsOf: (id) => nodeStats(view, recordedClock ? view.messages.filter((m) => Date.parse(m.ts) <= store.recorded) : view.messages)[id],
    };
  }, [active, nbrs, layout, store, view, geoms, edges, focus, onFocus, localOn, recordedClock]);

  // nothing is drawn while the tab is hidden or the graph is scrolled away; it redraws from the clock on return
  const visible = useRef(true);
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const el = card.current;
    let onScreen = true;
    const update = () => {
      const now = onScreen && document.visibilityState !== "hidden";
      if (now && !visible.current) setShown((n) => n + 1);
      visible.current = now;
    };
    const io = typeof IntersectionObserver === "undefined" || !el ? null : new IntersectionObserver(([e]) => {
      onScreen = e?.isIntersecting ?? true;
      update();
    });
    if (io && el) io.observe(el);
    document.addEventListener("visibilitychange", update);
    return () => {
      io?.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  // the one animation loop: every frame is swarmAt(model, t); React re-renders only on discrete changes
  const clockRef = useRef(clock);
  const cutoffRef = useRef(onCutoff);
  useEffect(() => {
    clockRef.current = clock;
    cutoffRef.current = onCutoff;
  }, [clock, onCutoff]);
  useEffect(() => {
    let raf = 0;
    let lastText = 0;
    let lastCut = 0;
    const tick = () => {
      const wall = Date.now();
      const c = clockRef.current;
      if (!visible.current) {
        // offscreen: nothing is drawn, but the graph's own replay keeps moving the thread's cutoff from its clock
        if (localOn && c && !drive) {
          const rec = localNow(c, wall);
          if (wall - lastCut > 250) {
            lastCut = wall;
            cutoffRef.current?.(rec);
          }
          if (c.playing && rec < c.max) raf = requestAnimationFrame(tick);
          else if (c.playing) setClock(pause(c, wall));
        }
        return;
      }
      let frame: SwarmFrame;
      let recorded: number;
      let speed = 1;
      let keep: boolean;
      if (drive) {
        recorded = drive.playing ? drive.recordedNow() : drive.at;
        speed = drive.speed;
        frame = replayFrame(model, recorded, { speed, ended: drive.ended, reduced });
        keep = drive.playing && !drive.ended;
      } else if (localOn && c) {
        recorded = localNow(c, wall);
        speed = c.speed;
        // at the end of the record everything settles: no comet or ring is left frozen mid-flight
        frame = replayFrame(model, recorded, { speed, ended: recorded >= c.max, reduced });
        keep = c.playing && recorded < c.max;
        if (c.playing && recorded >= c.max) setClock(pause(c, wall));
      } else {
        frame = swarmAt(display, wall, { live: true, knownAt: (id) => schedule?.known[id], reduced });
        recorded = frame.latest?.recorded ?? NaN;
        keep = schedule !== null && wall < feedSettledAt(schedule);
      }
      store.publish(frame, recorded);
      paint(store, frame, layout, geoms, speed, reduced, wall - lastText > 100);
      if (wall - lastText > 100) lastText = wall;
      if (keep) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [drive, localOn, clock, model, display, schedule, store, layout, geoms, reduced, shown]);

  // the thread follows the graph's own replay
  const sent = useFrame(store, useCallback((f: SwarmFrame | null) => f?.sent ?? 0, []));
  const scored = useFrame(store, useCallback((f: SwarmFrame | null) => f?.board.status === "scored", []));
  useEffect(() => {
    onCutoff?.(localOn ? store.recorded : null);
  }, [localOn, sent, scored, onCutoff, store]);

  const flow = useReactFlow();
  const fitNetwork = useCallback(() => void flow.fitView({ padding: 0.03, duration: 0 }), [flow]);
  useEffect(() => {
    const el = card.current;
    if (!el) return;
    let t = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        setCompact(el.clientWidth < 720);
        fitNetwork();
      }, 150);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      window.clearTimeout(t);
    };
  }, [fitNetwork]);
  useEffect(() => {
    const t = window.setTimeout(fitNetwork, 30);
    return () => window.clearTimeout(t);
  }, [compact, fitNetwork]);

  const nodes = useMemo(() => flowNodes(layout), [layout]);

  const startAt = useCallback(
    (ts: number, autoplay: boolean) => {
      if (!playable) return;
      const wall = Date.now();
      setClock((c) => {
        const base = c ?? localClock(model.start - 1000, model.end, wall);
        const at = seek(base, ts, wall);
        return autoplay ? play(at, wall) : at;
      });
    },
    [playable, model.start, model.end],
  );
  const seekTo = useCallback(
    (ts: number) => {
      if (!playable) return;
      const wall = Date.now();
      setClock((c) => (c ? seek(c, ts, wall) : pause(seek(localClock(model.start - 1000, model.end, wall), ts, wall), wall)));
    },
    [playable, model.start, model.end],
  );
  const nowT = () => (clockRef.current ? localNow(clockRef.current, Date.now()) : model.end);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      onFocus("all");
      setHovered(null);
      return;
    }
    // a modified key belongs to the browser or the system (Ctrl+F, Cmd+F find in page)
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement).getAttribute("role") === "slider") return;
    if (e.key === "f") fitNetwork();
    else if (playable && (e.key === "," || e.key === ".")) {
      const to = stepTarget(model, nowT(), e.key === "." ? 1 : -1, "message");
      if (to !== null) seekTo(to);
    } else if (playable && (e.key === "<" || e.key === ">")) {
      const to = stepTarget(model, nowT(), e.key === ">" ? 1 : -1, "round");
      if (to !== null) seekTo(to);
    } else return;
    e.preventDefault();
  };

  const legendId = "swarm-graph-legend";
  const world = layout.world;
  return (
    <GraphContext.Provider value={graph}>
      <div ref={card} onKeyDown={onKey} className="swarm-graph overflow-hidden rounded-lg border border-hairline bg-canvas" data-swarm-graph="v2">
        <a href="#swarm-thread" className="sr-only focus:not-sr-only focus:absolute focus:z-10 focus:m-2 focus:rounded focus:bg-canvas focus:px-2 focus:py-1 focus:text-xs">
          Skip to the message thread
        </a>
        <Hud
          model={model}
          running={running}
          local={localOn ? clock : null}
          driven={drive ? { speed: drive.speed, playing: drive.playing } : null}
          playable={playable}
          onPlay={() => {
            const wall = Date.now();
            if (!clock) startAt(model.start - 1000, true);
            else setClock(clock.playing ? pause(clock, wall) : play(clock, wall));
          }}
          onSpeed={() => clock && setClock(setSpeed(clock, nextSpeed(clock.speed), Date.now()))}
          onExit={() => setClock(null)}
          onRound={(r) => {
            const to = roundSeek(model, r);
            if (to !== null) startAt(to, clock?.playing ?? true);
          }}
          onFit={fitNetwork}
          onZoom={(d) => void (d > 0 ? flow.zoomIn({ duration: reduced ? 0 : 160 }) : flow.zoomOut({ duration: reduced ? 0 : 160 }))}
          onFull={() => {
            const el = card.current;
            if (!el) return;
            if (document.fullscreenElement) void document.exitFullscreen();
            else void el.requestFullscreen?.();
          }}
        />
        <div
          role="group"
          aria-label={`Agent network: ${layout.agents.length} agents in ${layout.pods.length} rival teams, the red team, the home analyst and the evaluation board. The message thread below holds every message in full.`}
          aria-describedby={legendId}
          className="relative w-full"
          style={{ aspectRatio: `${world.w} / ${world.h}`, maxHeight: compact ? 640 : 680, minHeight: compact ? 360 : 400 }}
        >
          <ReactFlow
            nodes={nodes}
            edges={[]}
            nodeTypes={NODE_TYPES}
            nodeOrigin={[0, 0]}
            fitView
            fitViewOptions={{ padding: 0.03 }}
            minZoom={0.2}
            maxZoom={2.5}
            translateExtent={[
              [-200, -160],
              [world.w + 200, world.h + 160],
            ]}
            zoomOnScroll={false}
            preventScrolling={false}
            zoomOnPinch
            zoomOnDoubleClick={false}
            panOnScroll={false}
            panOnDrag
            selectionOnDrag={false}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            autoPanOnNodeFocus={false}
            disableKeyboardA11y
            deleteKeyCode={null}
            selectionKeyCode={null}
            multiSelectionKeyCode={null}
            onlyRenderVisibleElements={false}
            colorMode="light"
            proOptions={{ hideAttribution: true }}
            onPaneClick={() => setHovered(null)}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--color-hairline-strong)" />
            <ViewportPortal>
              <FlightLayer world={world} />
            </ViewportPortal>
          </ReactFlow>
        </div>
        <CaptionBar model={recordedClock ? model : display} view={view} />
        <StripView
          strip={strip}
          model={model}
          layout={layout}
          live={running}
          local={recordedClock}
          playable={playable || drive !== null}
          onSeek={(ts) => (drive ? drive.seek(ts) : startAt(ts, clock?.playing ?? false))}
        />
        <Legend id={legendId} />
      </div>
    </GraphContext.Provider>
  );
}

/* ------------------------------------------------------------------------------------------------ paint */

/** The per-frame imperative writes: work rings and timers, edge heat, comets and ripples (transform, opacity and
 *  attributes on pooled elements only). */
function paint(store: FrameStore, frame: SwarmFrame, layout: NetLayout, geoms: Map<string, EdgeGeometry>, speed: number, reduced: boolean, text: boolean) {
  const el = store.elements;
  for (const [id, a] of Object.entries(frame.agents)) {
    const task = a.tasks[0];
    const ring = el.get(`ring:${id}`) as HTMLElement | undefined;
    if (ring) ring.style.setProperty("--p", task ? String(reduced ? 1 : task.progress) : "0");
    if (text) {
      const timer = el.get(`timer:${id}`);
      if (timer) timer.textContent = task ? `${(task.elapsed / 1000).toFixed(1)} s` : "";
    }
  }
  for (const [key, e] of Object.entries(frame.edges)) {
    const node = el.get(`heat:${key}`) as SVGElement | undefined;
    if (node) node.style.opacity = String(e.heat);
  }
  const detail = lod(speed);
  for (let i = 0; i < COMETS; i++) {
    const g = el.get(`comet:${i}`) as SVGGElement | undefined;
    if (!g) continue;
    const f = frame.flights[i];
    const geo = f ? geoms.get(f.edgeKey) : undefined;
    if (!f || !geo) {
      g.style.opacity = "0";
      continue;
    }
    const p = geo.pointAt(f.u);
    g.style.opacity = String(f.fade);
    g.style.color = strongOf(layout, f.from);
    const head = g.querySelector("[data-head]");
    head?.setAttribute("transform", `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
    g.toggleAttribute("data-failed", f.failed);
    const use = g.querySelector("use");
    if (use) {
      use.setAttribute("href", `#swarm-glyph-${f.kind}`);
      use.style.opacity = detail.glyph && !f.failed ? "1" : "0";
    }
    const dots = g.querySelectorAll("[data-tail]");
    dots.forEach((d, k) => {
      if (k >= detail.tail || f.failed) {
        d.setAttribute("opacity", "0");
        return;
      }
      const q = geo.pointAt(Math.max(0, f.u - (k + 1) * 0.016));
      d.setAttribute("cx", q.x.toFixed(1));
      d.setAttribute("cy", q.y.toFixed(1));
      d.setAttribute("opacity", String(0.55 * (1 - k / detail.tail)));
    });
  }
  for (let i = 0; i < RIPPLES; i++) {
    const c = el.get(`ripple:${i}`) as SVGCircleElement | undefined;
    if (!c) continue;
    const r = frame.ripples[i];
    const at = r ? (layout.byId[r.at] ?? layout.anchorById[r.at]) : undefined;
    if (!r || !at) {
      c.setAttribute("opacity", "0");
      continue;
    }
    const grow = r.kind === "launch" ? 0.9 : 0.6;
    c.setAttribute("cx", String(at.x));
    c.setAttribute("cy", String(at.y));
    c.setAttribute("r", (at.r * (1 + grow * r.p) + 2).toFixed(1));
    c.setAttribute("opacity", ((1 - r.p) * 0.8).toFixed(2));
    c.style.color = r.kind === "launch" ? strongOf(layout, r.at) : "var(--color-ink-2)";
  }
}

/* ------------------------------------------------------------------------------------------------ nodes */

type StageNode = Node<Record<string, never>, "stage">;
type EdgesNode = Node<Record<string, never>, "edges">;
type AgentNodeT = Node<{ agent: NetAgent }, "agent">;

function flowNodes(layout: NetLayout): Node[] {
  const { w, h } = layout.world;
  const whole = { position: { x: 0, y: 0 }, width: w, height: h, style: { pointerEvents: "none" as const }, draggable: false, selectable: false };
  const out: Node[] = [
    { id: "stage", type: "stage", zIndex: 0, data: {}, ...whole },
    { id: "edges", type: "edges", zIndex: 1, data: {}, ...whole },
  ];
  for (const a of layout.agents) {
    const box = a.rect ?? { x: a.x - a.r, y: a.y - a.r, w: 2 * a.r, h: 2 * a.r };
    out.push({ id: `a:${a.id}`, type: "agent", zIndex: 2, position: { x: box.x, y: box.y }, width: box.w, height: box.h, data: { agent: a }, draggable: false, selectable: false });
  }
  return out;
}

const Stage = memo(function Stage(_: NodeProps<StageNode>) {
  void _;
  const { layout } = useGraph();
  return (
    <div className="relative" style={{ width: layout.world.w, height: layout.world.h }}>
      {layout.pods.map((p) => (
        <Pod key={p.key} pod={p} />
      ))}
      <Bench />
      <HubLabel x={layout.red.x} y={layout.red.y + layout.red.r + 26} text="Red team" tone="var(--color-office-red-strong)" />
      <HubLabel x={layout.analyst.x} y={layout.analyst.y - layout.analyst.r - 18} text="Home analyst" tone="var(--color-office-home-strong)" />
    </div>
  );
});

function HubLabel({ x, y, text, tone }: { x: number; y: number; text: string; tone: string }) {
  return (
    <span className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap text-[12px] font-semibold" style={{ left: x, top: y, color: tone }}>
      {text}
    </span>
  );
}

function Pod({ pod }: { pod: NetLayout["pods"][number] }) {
  const g = useGraph();
  const id = pod.groupId;
  const sel = useCallback(
    (f: SwarmFrame | null) => {
      const p = id ? f?.pods[id] : undefined;
      return p ? `${p.present ? 1 : 0}|${p.count}|${p.round}|${p.result ? `${p.result.code}|${p.result.share}|${p.result.incumbent ? 1 : 0}` : ""}` : "0|0|0|";
    },
    [id],
  );
  const [present, count, round, code = "", share = "", incumbent = ""] = useFrame(g.store, sel).split("|");
  const on = id !== null && g.focus === id;
  const dim = g.dimming && !(id && (g.lit(`anchor:${id}`) || g.layout.agents.some((a) => a.groupId === id && g.lit(a.id))));
  const here = present === "1";
  const pct = share ? Math.round(Number(share) * 100) : null;
  const compact = g.layout.compact;
  return (
    <div
      className={cn(
        "swarm-pod absolute rounded-2xl border transition-opacity duration-[var(--duration-base)]",
        here ? "border-solid" : "border-dashed",
        on && "is-on",
      )}
      style={{ ...teamVars("rival", pod.team), left: pod.rect.x, top: pod.rect.y, width: pod.rect.w, height: pod.rect.h, opacity: dim ? DIM : 1 }}
      data-present={here ? "" : undefined}
    >
      <button
        type="button"
        disabled={!id}
        aria-pressed={on}
        aria-label={`${pod.label} capture team: ${count} messages${Number(round) > 0 ? `, round ${round}` : ""}${pct !== null ? `, ${pct}% of the simulated vote` : ""}. Show this team's messages.`}
        onClick={() => id && g.toggle(id)}
        onPointerEnter={() => id && g.hover(id)}
        onPointerLeave={() => g.hover(null)}
        className={cn(
          "pointer-events-auto absolute inset-x-0 flex items-center gap-1.5 rounded-t-2xl px-3 text-left",
          compact ? "bottom-0 h-[26px] justify-center rounded-b-2xl rounded-t-none px-1" : "top-0 h-[28px]",
        )}
      >
        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: "var(--team-strong)" }} />
        <span className="min-w-0 truncate text-[13px] font-semibold text-ink">{compact ? shortName(pod.label) : pod.label}</span>
        {!compact && code && (
          <span className="ml-1 inline-flex h-4 shrink-0 items-center rounded-sm bg-surface-2 px-1 font-mono text-[10px] text-ink-2" title="The code the board saw">
            {code}
          </span>
        )}
        {!compact && incumbent === "1" && <span className="shrink-0 rounded-full border border-cream-edge bg-cream px-1.5 text-[10px] leading-4 text-ink">incumbent</span>}
        {!compact && (
          <span className="ml-auto shrink-0 font-mono text-[11px] tabular text-muted">
            {pct !== null ? (
              <span className="font-semibold text-ink" title="Simulated vote share">
                {pct}%
              </span>
            ) : (
              <>
                {count} msgs{Number(round) > 0 ? ` · ${Number(round) === 4 ? "B" : `R${round}`}` : ""}
              </>
            )}
          </span>
        )}
      </button>
      {!compact && pct !== null && (
        <div className="absolute inset-x-4 top-[27px] h-[3px] overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--team-strong)_14%,transparent)]" aria-hidden>
          <div className="h-full origin-left rounded-full animate-grow" style={{ width: `${pct}%`, background: "var(--team-strong)" }} />
        </div>
      )}
      {!here && !compact && <span className="absolute bottom-2 left-3 text-[11px] text-faint">Joins at S9 Role-play</span>}
    </div>
  );
}

function Bench() {
  const g = useGraph();
  const { rect, inbox } = g.layout.bench;
  const sel = useCallback((f: SwarmFrame | null) => (f ? `${f.board.convened ? 1 : 0}|${f.board.proposals}|${f.board.status}|${f.board.from.length}` : "0|0|waiting|0"), []);
  const [convened, proposals, status, senders] = useFrame(g.store, sel).split("|");
  const on = g.focus === "board";
  const dim = g.dimming && !g.lit("anchor:board") && !g.layout.agents.some((a) => a.kind === "board" && g.lit(a.id));
  const statusText = status === "scored" ? "Scored · simulated, not a forecast" : status === "scoring" ? "Scoring" : "Waiting for proposals";
  const rivals = g.layout.pods.length;
  return (
    <>
      <div
        className={cn("swarm-pod absolute rounded-2xl border transition-opacity duration-[var(--duration-base)]", convened === "1" ? "border-solid" : "border-dashed", on && "is-on")}
        style={{ ...teamVars("board", -1), left: rect.x, top: rect.y, width: rect.w, height: rect.h, opacity: dim ? DIM : 1 }}
      >
        <button
          type="button"
          aria-pressed={on}
          aria-label={`Evaluation board: ${statusText}. Show the board's messages.`}
          onClick={() => g.toggle("board")}
          onPointerEnter={() => g.hover("board")}
          onPointerLeave={() => g.hover(null)}
          className="pointer-events-auto absolute inset-x-0 bottom-0 flex h-[30px] items-center justify-between gap-2 rounded-b-2xl px-3 text-left"
        >
          <span className="text-[13px] font-semibold text-ink">Evaluation board</span>
          {!g.layout.compact && <span className={cn("text-[11px]", status === "scored" ? "font-semibold text-danger" : "text-muted")}>{statusText}</span>}
        </button>
      </div>
      <div
        className="swarm-inbox absolute flex items-center justify-center gap-1 rounded-full border text-[11px] font-medium text-ink"
        style={{ ...teamVars("board", -1), left: inbox.x, top: inbox.y, width: inbox.w, height: inbox.h, opacity: dim ? DIM : 1 }}
        title={`${senders} of ${rivals} rivals have sent their response`}
      >
        <Tray size={13} weight="duotone" aria-hidden />
        Proposals
        <span key={proposals} className="font-mono tabular animate-pop">
          {proposals}
        </span>
      </div>
    </>
  );
}

const Edges = memo(function Edges(_: NodeProps<EdgesNode>) {
  void _;
  const g = useGraph();
  return (
    <svg width={g.layout.world.w} height={g.layout.world.h} className="overflow-visible" aria-hidden>
      {g.edges.map(([key, from, to]) => (
        <Ribbon key={key} edgeKey={key} from={from} to={to} />
      ))}
    </svg>
  );
});

function Ribbon({ edgeKey, from, to }: { edgeKey: string; from: string; to: string }) {
  const g = useGraph();
  const geo = g.geoms.get(edgeKey);
  const sel = useCallback((f: SwarmFrame | null) => f?.edges[edgeKey]?.count ?? 0, [edgeKey]);
  const count = useFrame(g.store, sel);
  if (!geo || count === 0) return null;
  const pair = pairKey(from, to);
  const lit = g.litEdge(from, to);
  const strong = strongOf(g.layout, from);
  const grad = `swarm-grad-${edgeKey.replace(/[^\w-]/g, "_")}`;
  const d = geo.ribbon(ribbonWidth(count));
  return (
    <g
      className="swarm-edge pointer-events-auto cursor-pointer"
      style={{ opacity: g.dimming ? (lit ? 1 : DIM * 0.5) : undefined }}
      onClick={() => g.toggle(`edge:${pair}`)}
      onPointerEnter={() => g.hover(`edge:${pair}`)}
      onPointerLeave={() => g.hover(null)}
      data-edge={edgeKey}
    >
      <defs>
        <linearGradient id={grad} gradientUnits="userSpaceOnUse" x1={geo.start.x} y1={geo.start.y} x2={geo.end.x} y2={geo.end.y}>
          <stop offset="0" stopColor={strong} stopOpacity={0.9} />
          <stop offset="1" stopColor={strong} stopOpacity={0.35} />
        </linearGradient>
      </defs>
      <path d={geo.d} fill="none" stroke="transparent" strokeWidth={18} />
      <path d={d} fill={`url(#${grad})`} className={cn("swarm-ribbon", g.dimming && lit && "is-lit")} />
      <path ref={g.store.register(`heat:${edgeKey}`)} d={d} fill={strong} style={{ opacity: 0 }} />
    </g>
  );
}

const AgentNode = memo(function AgentNode({ data }: NodeProps<AgentNodeT>) {
  const { agent: a } = data;
  const g = useGraph();
  const sel = useCallback(
    (f: SwarmFrame | null) => {
      const s = f?.agents[a.id];
      return s ? `${s.present ? 1 : 0}|${s.status}|${s.tasks.length}|${s.failed ? 1 : 0}|${s.rejected ? 1 : 0}` : "1|idle|0|0|0";
    },
    [a.id],
  );
  const [present, status = "idle", tasks = "0", failed, rejected] = useFrame(g.store, sel).split("|");
  const aria = useFrame(g.store, useCallback((f: SwarmFrame | null) => (f ? ariaFor(g.view, a.id, f) : a.label), [g.view, a.id, a.label]));
  const [tip, setTip] = useState(false);
  const focusKey = a.id.startsWith("team:") ? a.groupId : `agent:${a.id}`;
  const on = g.focus === focusKey;
  const lit = g.lit(a.id) || (a.kind !== "rival" && g.lit(`anchor:${a.kind}`));
  const here = present === "1";
  const Icon = ROLE_ICON[a.role] ?? ROLE_ICON.capture_lead!;
  const card = g.view.cards[a.id];
  const style = { ...teamVars(a.kind, a.team), opacity: g.dimming && !lit ? DIM : 1 } as CSSProperties;
  const enter = (v: boolean) => {
    setTip(v);
    g.hover(v ? (a.id.startsWith("team:") ? a.id : `agent:${a.id}`) : null);
  };
  const common = {
    type: "button" as const,
    "aria-pressed": on,
    "aria-label": `${aria}. Show this agent's messages.`,
    onClick: () => g.toggle(focusKey),
    onPointerEnter: () => enter(true),
    onPointerLeave: () => enter(false),
    onFocus: () => enter(true),
    onBlur: () => enter(false),
    "data-status": here ? status : "absent",
    "data-failed": failed === "1" ? "" : undefined,
    "data-on": on ? "" : undefined,
  };
  // in the compact layout the pod header names a team and the bench is too narrow for seat names
  const below = a.shape === "disc" && a.kind !== "red_team" && a.kind !== "analyst" && !g.layout.compact;
  const tipSide = a.x > g.layout.world.w * 0.6 ? "left" : "right";
  return (
    <div className="swarm-agent relative h-full w-full transition-opacity duration-[var(--duration-base)]" style={style}>
      {a.shape === "pill" ? (
        <button {...common} className={cn("swarm-pill pointer-events-auto relative flex h-full w-full items-center gap-1.5 overflow-hidden rounded-full border px-2.5 text-left", !here && "is-absent")}>
          <Icon size={14} weight="duotone" aria-hidden className="shrink-0 text-[var(--team-strong)]" />
          <span className="truncate text-[12px] font-medium text-ink">{a.label}</span>
          <span ref={g.store.register(`timer:${a.id}`)} className="ml-auto font-mono text-[10px] tabular text-muted" />
          <span ref={g.store.register(`ring:${a.id}`)} aria-hidden className="swarm-bar absolute inset-x-0 bottom-0 h-[2px]" />
        </button>
      ) : (
        <button {...common} className={cn("swarm-disc pointer-events-auto relative flex h-full w-full items-center justify-center rounded-full border-2", !here && "is-absent")}>
          <span ref={g.store.register(`ring:${a.id}`)} aria-hidden className="swarm-ring" data-many={Number(tasks) > 1 ? "" : undefined} />
          <Icon size={a.r > 24 ? 22 : 17} weight="duotone" aria-hidden className="swarm-icon" />
          {failed === "1" && <span aria-hidden className="swarm-diamond" />}
          {rejected === "1" && <span className="absolute -right-3 -top-2 rounded-full border border-hairline-strong bg-canvas px-1 text-[9px] leading-3 text-muted">not run</span>}
          {Number(tasks) > 1 && <span className="absolute -right-2 -top-1 rounded-full bg-ink px-1 font-mono text-[10px] leading-4 text-on-ink">{tasks}</span>}
        </button>
      )}
      {below && (
        <span className="pointer-events-none absolute left-1/2 top-full mt-1 flex -translate-x-1/2 flex-col items-center whitespace-nowrap leading-tight">
          <span className="text-[11px] font-medium text-ink-2">{a.label}</span>
          <span ref={g.store.register(`timer:${a.id}`)} className="font-mono text-[10px] tabular text-muted" />
        </span>
      )}
      {!below && a.shape === "disc" && !g.layout.compact && (
        <span ref={g.store.register(`timer:${a.id}`)} className="pointer-events-none absolute left-full top-1/2 ml-2 -translate-y-1/2 font-mono text-[10px] tabular text-muted" />
      )}
      {tip && card && (
        <div role="tooltip" className={cn("pointer-events-none absolute top-1/2 z-10 w-64 -translate-y-1/2 animate-fade-in", tipSide === "right" ? "left-full ml-3" : "right-full mr-3")}>
          <AgentCardTip card={card} rival={a.kind === "rival"} stats={g.statsOf(a.id)} />
        </div>
      )}
    </div>
  );
});

const NODE_TYPES = { stage: Stage, edges: Edges, agent: AgentNode };

/* ------------------------------------------------------------------------------------------------ flights */

function FlightLayer({ world }: { world: { w: number; h: number } }) {
  const g = useGraph();
  return (
    <svg width={world.w} height={world.h} className="pointer-events-none absolute left-0 top-0 overflow-visible" aria-hidden>
      <defs>
        {(Object.keys(KIND_GLYPH) as AgentMessage["kind"][]).map((k) => {
          const G = KIND_GLYPH[k];
          return (
            <symbol key={k} id={`swarm-glyph-${k}`} viewBox="0 0 256 256">
              <G size={256} weight="bold" color="#fff" />
            </symbol>
          );
        })}
        <radialGradient id="swarm-glow">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.45" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
      </defs>
      {Array.from({ length: RIPPLES }, (_, i) => (
        <circle key={`r${i}`} ref={g.store.register(`ripple:${i}`)} r={0} fill="none" stroke="currentColor" strokeWidth={2} opacity={0} />
      ))}
      {Array.from({ length: COMETS }, (_, i) => (
        <g key={`c${i}`} ref={g.store.register(`comet:${i}`)} className="swarm-comet" style={{ opacity: 0 }}>
          {Array.from({ length: TAIL }, (__, k) => (
            <circle key={k} data-tail r={Math.max(1.2, 3.2 - k * 0.18)} fill="currentColor" opacity={0} />
          ))}
          <g data-head>
            <circle r={13} fill="url(#swarm-glow)" />
            <circle className="swarm-head" r={6} fill="currentColor" stroke="var(--color-canvas)" strokeWidth={1.5} />
            <rect className="swarm-fail" x={-5} y={-5} width={10} height={10} transform="rotate(45)" fill="var(--color-danger)" />
            <use x={-3.6} y={-3.6} width={7.2} height={7.2} />
          </g>
        </g>
      ))}
    </svg>
  );
}

/* ------------------------------------------------------------------------------------------------ HUD */

function Hud(props: {
  model: SwarmModel;
  running: boolean;
  local: LocalClock | null;
  /** A run-level replay drives the graph (its transport is the replay dock). */
  driven: { speed: number; playing: boolean } | null;
  playable: boolean;
  onPlay: () => void;
  onSpeed: () => void;
  onExit: () => void;
  onRound: (r: number) => void;
  onFit: () => void;
  onZoom: (d: number) => void;
  onFull: () => void;
}) {
  const { model, running, local, driven, playable } = props;
  const g = useGraph();
  const round = useFrame(g.store, useCallback((f: SwarmFrame | null) => f?.round ?? 0, []));
  const clockRef = g.store.register("hud:clock");
  const total = model.messages.length;
  const span = Number.isFinite(model.end) && Number.isFinite(model.start) ? formatSpan(model.end - model.start) : "0:00";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline px-3 py-2">
      {running ? (
        <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-hairline-strong px-2.5 text-xs font-medium text-ink">
          <span className="size-2 rounded-full bg-signal animate-pulse-soft" aria-hidden />
          Live: each message is drawn as it is recorded
        </span>
      ) : driven ? (
        <span className="inline-flex h-7 items-center rounded-full bg-ink px-2.5 font-mono text-xs font-medium text-on-ink">{driven.playing ? `RUN REPLAY ${driven.speed}x` : "Run replay paused"}</span>
      ) : local ? (
        <span className="inline-flex h-7 items-center rounded-full bg-ink px-2.5 font-mono text-xs font-medium text-on-ink">{local.playing ? `REPLAY ${local.speed}x` : "Paused"}</span>
      ) : (
        <span className="text-xs text-muted">{total > 0 ? `Final state: ${total} messages in ${span}.` : "No messages yet."}</span>
      )}
      <span ref={clockRef} className="font-mono text-xs tabular text-ink-2" aria-hidden />
      <ol className="flex items-center gap-1" aria-label="Swarm rounds">
        {[1, 2, 3, 4].map((r) => {
          const ran = model.roundStarts.some((s) => s.round === r);
          return (
            <li key={r}>
              <button
                type="button"
                disabled={!playable || !ran}
                aria-current={r === round ? "step" : undefined}
                aria-label={`${r === 4 ? "Board" : `Round ${r}`}${playable && ran ? ": replay from its first message" : ""}`}
                onClick={() => props.onRound(r)}
                className={cn(
                  "h-7 min-w-7 rounded-full border px-2 font-mono text-xs tabular transition-colors",
                  r === round ? "border-ink bg-ink text-on-ink" : r < round ? "border-hairline-strong text-ink-2" : "border-hairline text-faint",
                  playable && ran && r !== round && "hover:bg-surface-2",
                )}
              >
                {r === 4 ? "B" : r}
              </button>
            </li>
          );
        })}
      </ol>
      <div className="ml-auto flex items-center gap-1">
        {playable && (
          <>
            <button type="button" onClick={props.onPlay} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline-strong px-3 text-xs font-medium text-ink hover:bg-surface">
              {local?.playing ? <Pause size={14} weight="fill" aria-hidden /> : <Play size={14} weight="fill" aria-hidden />}
              {local?.playing ? "Pause" : local ? "Resume" : "Replay the swarm"}
            </button>
            {local && (
              <>
                <button type="button" onClick={props.onSpeed} aria-label={`Replay speed ${local.speed}x; change`} className="h-8 rounded-md border border-hairline px-2 font-mono text-xs tabular text-ink-2 hover:bg-surface">
                  {local.speed}x
                </button>
                <button type="button" onClick={props.onExit} aria-label="Leave the replay: show the final state" className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-ink-2 hover:bg-surface">
                  <X size={13} aria-hidden /> Final state
                </button>
              </>
            )}
          </>
        )}
        <span className="mx-1 h-5 w-px bg-hairline" aria-hidden />
        <IconButton label="Zoom out" onClick={() => props.onZoom(-1)}>
          <MagnifyingGlassMinus size={15} aria-hidden />
        </IconButton>
        <IconButton label="Zoom in" onClick={() => props.onZoom(1)}>
          <MagnifyingGlassPlus size={15} aria-hidden />
        </IconButton>
        <IconButton label="Fit the network (f)" onClick={props.onFit}>
          <ArrowsIn size={15} aria-hidden />
        </IconButton>
        <IconButton label="Full screen" onClick={props.onFull}>
          <CornersOut size={15} aria-hidden />
        </IconButton>
      </div>
      <FocusChip />
      <span className="sr-only">{GRAPH_SPEEDS.length} replay speeds. Keys inside the graph: comma and period step one message, angle brackets one round, f fits, Escape clears.</span>
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="inline-flex size-8 items-center justify-center rounded-md text-ink-2 hover:bg-surface">
      {children}
    </button>
  );
}

/** The keyboard path to a conversation: with an agent pinned, one button per agent it exchanged messages with. */
function Conversations({ id }: { id: string }) {
  const g = useGraph();
  const incident = useMemo(() => g.edges.filter(([, from, to]) => from === id || to === id), [g.edges, id]);
  // counts as of the frame: a replay never lists conversations it has not reached
  const counts = useFrame(
    g.store,
    useCallback((f: SwarmFrame | null) => incident.map(([key]) => f?.edges[key]?.count ?? 0).join(","), [incident]),
  ).split(",");
  const pairs = new Map<string, { other: string; count: number }>();
  incident.forEach(([, from, to], i) => {
    const n = Number(counts[i] ?? 0);
    if (n === 0) return;
    const other = from === id ? to : from;
    const p = pairs.get(other) ?? { other, count: 0 };
    p.count += n;
    pairs.set(other, p);
  });
  if (pairs.size === 0) return null;
  const name = (n: string) => (n.startsWith("anchor:") ? agentName(g.view, n.slice(7)) : n.startsWith("team:") ? (g.view.groups.find((x) => x.id === n.slice(5))?.label ?? n) : agentName(g.view, n));
  return (
    <ul className="flex w-full flex-wrap gap-1" aria-label="Conversations of the pinned agent">
      {[...pairs.values()].map((p) => (
        <li key={p.other}>
          <button type="button" onClick={() => g.toggle(`edge:${pairKey(id, p.other)}`)} className="h-7 rounded-full border border-hairline px-2.5 text-xs text-ink-2 hover:bg-surface-2">
            With {name(p.other)}: {p.count} {p.count === 1 ? "message" : "messages"}
          </button>
        </li>
      ))}
    </ul>
  );
}

function FocusChip() {
  const g = useGraph();
  if (g.focus === "all") return null;
  const f = g.focus;
  const pinned = f.startsWith("agent:") ? f.slice(6) : g.layout.byId[`team:${f}`] ? `team:${f}` : null;
  const label = f.startsWith("agent:")
    ? agentName(g.view, f.slice(6))
    : f.startsWith("edge:")
      ? f
          .slice(5)
          .split("~")
          .map((id) => (id.startsWith("anchor:") ? agentName(g.view, id.slice(7)) : agentName(g.view, id)))
          .join(" and ")
      : f === "board"
        ? "Evaluation board"
        : (g.view.groups.find((x) => x.id === f)?.label ?? f);
  return (
    <>
      <button type="button" onClick={() => g.toggle(f)} className="inline-flex h-7 items-center gap-1.5 rounded-full border border-ink bg-ink pl-3 pr-2 text-xs font-medium text-on-ink">
        Showing: {label}
        <X size={12} aria-label="clear the focus" />
      </button>
      {pinned && <Conversations id={pinned} />}
    </>
  );
}

/* ------------------------------------------------------------------------------------------------ caption */

function CaptionBar({ model, view }: { model: SwarmModel; view: SwarmView }) {
  const g = useGraph();
  const sel = useCallback((f: SwarmFrame | null) => {
    if (!f) return "none||-1";
    const c = captionFor(f, model, view);
    return `${c.kind}|${c.line}|${c.team}|${c.detail}`;
  }, [model, view]);
  const [kind = "none", line = "", team = "-1", ...rest] = useFrame(g.store, sel).split("|");
  const detail = rest.join("|");
  // one polite announcement at most every 1.5 s; the thread stays the complete record
  const [spoken, setSpoken] = useState("");
  const last = useRef(0);
  useEffect(() => {
    const wait = Math.max(0, 1500 - (Date.now() - last.current));
    const t = window.setTimeout(() => {
      last.current = Date.now();
      setSpoken(line);
    }, wait);
    return () => window.clearTimeout(t);
  }, [line]);
  return (
    <div className="flex min-h-[52px] items-start gap-2 border-t border-hairline px-4 py-2" style={teamVars(Number(team) >= 0 ? "rival" : "board", Number(team))}>
      <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", kind === "none" && "opacity-0")} style={{ background: kind === "board" ? "var(--color-danger)" : "var(--team-strong)" }} />
      <div className="min-w-0">
        <p className={cn("font-mono text-xs tabular", kind === "board" ? "font-semibold text-danger" : "text-ink")}>{line || "Waiting for the next recorded message."}</p>
        {detail && <p className="mt-0.5 truncate text-xs text-muted">{detail}</p>}
      </div>
      <span className="sr-only" aria-live="polite">
        {spoken}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ strip */

const LANE_H = 20;
const BAND_H = 24;
const AXIS_H = 22;

function StripView({ strip, model, layout, live, local, playable, onSeek }: { strip: Strip; model: SwarmModel; layout: NetLayout; live: boolean; local: boolean; playable: boolean; onSeek: (ts: number) => void }) {
  const g = useGraph();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  const [open, setOpen] = useState(readStripOpen);
  const [hover, setHover] = useState<StripTick | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);
  const labelW = width < 640 ? 92 : 136;
  const x = useMemo(() => scaleLinear().domain([strip.from, strip.to]).range([labelW, Math.max(labelW + 10, width - 10)]).clamp(true), [strip, labelW, width]);
  const laneY = useMemo(() => Object.fromEntries(strip.lanes.map((l, i) => [l.id, BAND_H + i * LANE_H])), [strip]);
  const height = BAND_H + strip.lanes.length * LANE_H + AXIS_H;
  const t = useFrame(
    g.store,
    useCallback(() => (local ? Math.min(strip.to, Math.max(strip.from, Math.round(g.store.recorded / 100) * 100)) : strip.to), [local, g.store, strip.to, strip.from]),
  );
  // per-frame playhead: transform only
  const head = useRef<SVGGElement>(null);
  const ghost = useRef<SVGRectElement>(null);
  useEffect(() => {
    const place = () => {
      const ts = local ? g.store.recorded : strip.to;
      const px = x(ts);
      head.current?.setAttribute("transform", `translate(${px.toFixed(1)} 0)`);
      if (ghost.current) {
        ghost.current.setAttribute("x", px.toFixed(1));
        ghost.current.setAttribute("width", Math.max(0, x.range()[1]! - px).toFixed(1));
      }
      const hud = g.store.elements.get("hud:clock");
      const rec = g.store.recorded;
      if (hud) hud.textContent = Number.isFinite(rec) ? formatSince(rec - model.origin) : "";
    };
    place();
    return g.store.subscribe(place);
  }, [g.store, x, local, strip.to, model.origin, open]);

  const ticks = [];
  const ticksStart = Math.ceil((strip.from - model.origin) / 15000) * 15000;
  const every = width < 640 ? 30000 : 15000;
  for (let ms = Math.max(0, ticksStart); model.origin + ms <= strip.to; ms += every) ticks.push(ms);
  const roundSpans = [1, 2, 3, 4]
    .map((r) => {
      const ts = strip.ticks.filter((k) => model.byId[k.messageId]?.round === r).map((k) => k.ts);
      return ts.length ? { r, a: Math.min(...ts), b: Math.max(...ts) } : null;
    })
    .filter((s): s is { r: number; a: number; b: number } => s !== null);

  const seekAtPx = (px: number) => {
    if (!playable) return;
    let ts = x.invert(px);
    const near = nearestTick(strip.ticks, ts);
    if (near && Math.abs(x(near.ts) - px) < 5) ts = near.ts;
    onSeek(ts);
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    // a modified key belongs to the browser or the system (Alt+Left goes back)
    if (!playable || e.altKey || e.ctrlKey || e.metaKey) return;
    const now = local ? g.store.recorded : strip.to;
    let to: number | null = null;
    if (e.key === "ArrowRight") to = stepTick(strip.ticks, now, 1)?.ts ?? null;
    else if (e.key === "ArrowLeft") to = stepTick(strip.ticks, now, -1)?.ts ?? null;
    else if (e.key === "PageUp") to = now + 10_000;
    else if (e.key === "PageDown") to = now - 10_000;
    else if (e.key === "Home") to = strip.from;
    else if (e.key === "End") to = strip.to;
    else return;
    e.preventDefault();
    e.stopPropagation();
    if (to !== null) onSeek(Math.min(strip.to, Math.max(strip.from, to)));
  };

  if (strip.ticks.length === 0) return null;
  return (
    <div className="border-t border-hairline">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          try {
            window.localStorage.setItem("swarm-strip", open ? "closed" : "open");
          } catch {
            // storage can be blocked; the choice lasts this page only
          }
        }}
        className="flex w-full items-center justify-between px-4 py-1.5 text-left text-xs font-medium text-ink-2 hover:bg-surface"
      >
        <span>Timeline: every model call and message at its recorded time</span>
        <span className="font-mono text-micro text-faint">since S9 Role-play started at {new Date(model.origin).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
      </button>
      {open && (
        <div ref={box} className="relative px-0 pb-2">
          <svg
            width={width}
            height={height}
            role="slider"
            tabIndex={0}
            aria-label="Swarm timeline"
            aria-valuemin={0}
            aria-valuemax={Math.round((strip.to - strip.from) / 1000)}
            aria-valuenow={Math.round((t - strip.from) / 1000)}
            aria-valuetext={sliderText(strip, model.origin, t)}
            aria-disabled={!playable}
            onKeyDown={onKey}
            onClick={(e) => seekAtPx(e.clientX - e.currentTarget.getBoundingClientRect().left)}
            onPointerMove={(e) => {
              const near = nearestTick(strip.ticks, x.invert(e.clientX - e.currentTarget.getBoundingClientRect().left));
              setHover(near && Math.abs(x(near.ts) - (e.clientX - e.currentTarget.getBoundingClientRect().left)) < 8 ? near : null);
            }}
            onPointerLeave={() => setHover(null)}
            className={cn("block select-none outline-none focus-visible:outline-2 focus-visible:outline-signal", playable && "cursor-pointer")}
          >
            {roundSpans.map((s, i) => (
              <g key={s.r}>
                <rect x={x(s.a)} y={11 + (i % 2) * 7} width={Math.max(2, x(s.b) - x(s.a))} height={4} rx={2} className="fill-hairline-strong" />
                <text x={x(s.a) - 3} y={15 + (i % 2) * 7} textAnchor="end" className="fill-faint font-mono text-[9px]">
                  {s.r === 4 ? "B" : `R${s.r}`}
                </text>
              </g>
            ))}
            {strip.lanes.map((l, i) => {
              const y = BAND_H + i * LANE_H;
              const lit = !g.dimming || g.lit(`anchor:${l.id}`) || layout.agents.some((a) => (a.kind === "rival" ? a.groupId : a.kind) === l.id && g.lit(a.id));
              return (
                <g key={l.id} opacity={lit ? 1 : DIM} style={teamVars(l.kind === "rival" ? "rival" : l.kind, l.team)}>
                  <line x1={labelW} x2={width - 10} y1={y + LANE_H - 0.5} y2={y + LANE_H - 0.5} className="stroke-hairline-soft" />
                  <circle cx={10} cy={y + LANE_H / 2} r={3.5} fill="var(--team-strong)" />
                  <text x={20} y={y + LANE_H / 2 + 4} className="fill-ink-2 text-[11px]">
                    <title>{l.label}</title>
                    {truncate(l.kind === "rival" ? shortName(l.label) : l.label, labelW < 100 ? 10 : 15)}
                  </text>
                </g>
              );
            })}
            {strip.bars.map((b) => {
              const y = laneY[b.lane] ?? 0;
              const rows = strip.rows[b.lane] ?? 1;
              const rh = Math.min(4, (LANE_H - 6) / rows);
              const lane = strip.lanes.find((l) => l.id === b.lane);
              const tint = lane?.kind === "rival" || b.team >= 0 ? `var(--color-team-${b.team >= 0 ? b.team % 6 : 0}-strong)` : `var(--color-${HUB_TINT[lane?.kind ?? "board"]}-strong)`;
              return <rect key={`${b.messageId}`} x={x(b.start)} y={y + 3 + b.row * rh} width={Math.max(1, x(b.end) - x(b.start))} height={Math.max(1.5, rh - 1)} fill={tint} fillOpacity={0.45} />;
            })}
            {strip.ticks.map((k) => {
              const y = laneY[k.lane] ?? 0;
              const px = x(k.ts);
              const stroke = k.state === "failed" ? "var(--color-danger)" : strongOf(layout, model.byId[k.messageId]?.from ?? "");
              return (
                <g key={k.messageId} opacity={hover && hover.messageId !== k.messageId ? 0.55 : 1}>
                  <line x1={px} x2={px} y1={y + 2} y2={y + LANE_H - 2} stroke={stroke} strokeWidth={1.5} strokeDasharray={k.state === "completed" ? undefined : "2 2"} />
                  {k.targets.map((tl) => {
                    const ty = (laneY[tl] ?? 0) + LANE_H / 2;
                    return (
                      <g key={tl}>
                        <line x1={px} x2={px} y1={y + LANE_H / 2} y2={ty} stroke={stroke} strokeOpacity={0.4} strokeWidth={1} />
                        <circle cx={px} cy={ty} r={2.5} fill={stroke} />
                      </g>
                    );
                  })}
                  {k.state === "failed" && <rect x={px - 3} y={y + LANE_H / 2 - 3} width={6} height={6} transform={`rotate(45 ${px} ${y + LANE_H / 2})`} fill="var(--color-danger)" />}
                  {k.dropped > 0 && <circle cx={px} cy={y + 3} r={2.5} fill="none" stroke="var(--color-danger)" strokeWidth={1} />}
                </g>
              );
            })}
            {ticks.map((ms) => (
              <g key={ms} transform={`translate(${x(model.origin + ms)} ${height - AXIS_H})`}>
                <line y1={-2} y2={4} className="stroke-hairline-strong" />
                <text y={16} textAnchor="middle" className="fill-faint font-mono text-[10px]">
                  +{formatSpan(ms)}
                </text>
              </g>
            ))}
            {local && <rect ref={ghost} y={BAND_H} height={strip.lanes.length * LANE_H} className="fill-canvas" fillOpacity={0.72} />}
            {(local || live) && (
              <g ref={head}>
                <line y1={2} y2={height - AXIS_H} className="stroke-signal" strokeWidth={1.5} />
                <circle cy={BAND_H - 6} r={4} className="fill-signal" />
              </g>
            )}
          </svg>
          {hover && (
            <p className="pointer-events-none px-4 pt-1 font-mono text-micro tabular text-ink-2">
              {formatSince(hover.ts - model.origin, true)} · {new Date(hover.ts).toLocaleTimeString("en-US")} · {captionLine(model, hover.messageId, g.view)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** The strip's remembered disclosure (per viewer; storage can be blocked, then it starts open). The graph renders on
 *  the client only, so reading storage here cannot mismatch a server render. */
function readStripOpen(): boolean {
  try {
    return window.localStorage.getItem("swarm-strip") !== "closed";
  } catch {
    return true;
  }
}

function captionLine(model: SwarmModel, id: string, view: SwarmView): string {
  const m = model.byId[id];
  if (!m) return "";
  return `${m.kind} · ${agentName(view, m.sender)} -> ${m.item.to.map((t) => agentName(view, t)).join(", ")} · ${(m.latencyMs / 1000).toFixed(1)} s · ${m.item.usage.inputTokens + m.item.usage.outputTokens} tokens`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}...`;
}

/* ------------------------------------------------------------------------------------------------ legend */

function Legend({ id }: { id: string }) {
  return (
    <ul id={id} className="flex flex-wrap gap-x-5 gap-y-1.5 border-t border-hairline px-4 py-2.5 text-xs text-muted">
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="flex gap-0.5">
          {[0, 1, 2, 3].map((t) => (
            <span key={t} className="size-2 rounded-full" style={{ background: `var(--color-team-${t}-strong)` }} />
          ))}
        </span>
        Colour is the rival team
      </li>
      <li className="flex items-center gap-1.5">
        <svg width="26" height="10" aria-hidden>
          <path d="M1 2 L25 4 L25 6 L1 8 Z" className="fill-ink-2" />
        </svg>
        A conversation, wide at the sender; wider carried more
      </li>
      <li className="flex items-center gap-1.5">
        <svg width="14" height="14" aria-hidden>
          <circle cx="7" cy="7" r="5" className="fill-signal" />
        </svg>
        A message in flight, at its recorded time
      </li>
      <li className="flex items-center gap-1.5">
        <svg width="16" height="16" aria-hidden>
          <circle cx="8" cy="8" r="6" fill="none" className="stroke-hairline-strong" strokeWidth="2" />
          <path d="M8 2 A6 6 0 0 1 14 8" fill="none" className="stroke-ink-2" strokeWidth="2" />
        </svg>
        A model call running, with its elapsed time
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="size-3 rounded-full border border-dashed border-hairline-strong" />
        Not joined yet
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="size-2 rotate-45 bg-danger" />
        Failed call
      </li>
    </ul>
  );
}
