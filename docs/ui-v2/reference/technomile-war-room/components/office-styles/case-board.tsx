"use client";

/**
 * The Case Board office style: the run pinned up as an investigator's wall, built card by card from the run's own
 * record. Each rival gets a row read left to right in pipeline order: its dossier card, its crew polaroids, an index
 * card for every S4 fetch, a claims ledger that S5-S6 lines are typed onto and S7 verdicts stamp, the S9 memos with
 * ink threads to their recipients and red threads to the evidence codes they cite, and a slot the S10 board's
 * codename card lands in. The shared desks sit along the bottom, the run's clock, stages and gates across the top.
 *
 * Every card, stamp and thread is one recorded event at its recorded time (lib/war-room/command.ts and case-board.ts
 * fold the record; lib/war-room/office.ts maps it to agent activity and places it on the display clock). The message
 * thread under the board stays the accessible, complete record.
 */
import { ArrowCounterClockwise, EyeSlash, Pause, Play, SealCheck, Warning } from "@phosphor-icons/react";
import Link from "next/link";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import type { AgentCard, BoardResult } from "@/lib/contracts/run-events";
import type { Approvals } from "@/lib/pipeline/rail";
import { STAGES, type StageId } from "@/lib/stages";
import {
  boardKeys,
  boardSlotRow,
  CHIP_ROWS,
  codenameRects,
  codesOf,
  CREW_ROLES,
  EVIDENCE_PER_MEMO,
  fanRects,
  initials,
  isFetchEcho,
  laneText,
  memosByRow,
  planBoard,
  ratingsOf,
  roundEmphasis,
  tagRects,
  tagsByRow,
  threadPath,
  threadsAt,
  VIEW_H,
  VIEW_W,
  wrapText,
  type BoardLayout,
  type CrewRole,
  type EvidenceTag,
  type Pt,
  type Rect,
  type RowLayout,
  type Thread,
  rovingIndex,
  dossierTipWords,
} from "@/lib/war-room/case-board";
import {
  fetchesAt,
  foldCommand,
  formatHeld,
  formatTime,
  formatTPlus,
  formatWall,
  gatesAt,
  notableAt,
  runClock,
  shownAt,
  stageStatesAt,
  stampBeats,
  stampCountAt,
  tallyAt,
  type CmdError,
  type CmdFetch,
  type CmdLine,
  type CmdVerdict,
  type CommandRecord,
  type DisplayCtx,
  type FetchCounts,
  type Gate,
  type GateView,
  type StageState,
  type StampBeat,
  type VerdictCounts,
} from "@/lib/war-room/command";
import { sceneAt, type Scene } from "@/lib/war-room/scene";
import { buildSchedule, frameAt, liveClock, planOffice, replayClock, sentFirst, warpKeys, type OfficePlan, type Role, type Schedule } from "@/lib/war-room/office";
import { formatUsd, interviewOf, KIND_LABEL, shortName, type SwarmItem, type SwarmView } from "@/lib/war-room/swarm";
import { edgeKey, firstWords, nodeStats, recipients, type Focus } from "@/lib/war-room/swarm-graph";

import { AvatarBadge, ROLE_NAME } from "../office-avatars";
import type { OfficeStyleProps } from "../office-styles";
import { ROLE_SHORT } from "../roles";
import { useRunFeed } from "../run-feed";
import { AgentCardTip, useReducedMotion } from "../swarm-graph";
import { CAPTION, clip, Lines, Paper, PinHead, pinOf, Pinned, Polaroid, SHADOW, StampMark, Tape, teamColour, TIER_ICON, TIER_LABEL, VERDICT_LABEL, VerdictGlyph, type PolaroidState } from "./case-board-parts";

const SPEEDS = [1, 2, 4] as const;
const TICK_MS = 100;
/** An item animates when it arrives on screen within this long of its display time (a jump never replays a filing). */
const FRESH_MS = 1200;
/** The notable claim on a ledger changes at most twice a second during a burst. */
const NOTABLE_STEP_MS = 500;
const MILESTONE_GAP_MS = 2000;

/* ------------------------------------------------------------------------------------------------ clock */

interface Replay {
  base: number;
  wall: number;
  playing: boolean;
  speed: (typeof SPEEDS)[number];
  /** Display time at which filing animations were switched on (play pressed); earlier items never animate. */
  animFrom: number;
  /** Paused because the board went off screen; it resumes when the board is back. */
  held?: boolean;
}

function replayAt(r: Replay, perf: number): number {
  return r.playing ? r.base + Math.max(0, perf - r.wall) * r.speed : r.base;
}

function subscribeVisibility(cb: () => void): () => void {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
}

/** Ticks only while the board is on screen and the tab is visible: nothing runs for a board nobody can see. */
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

/** The latest recorded instant the run knows about: the final poster's clock reads there. */
function latestRecorded(cmd: CommandRecord, view: SwarmView, approvals: Approvals | null): number {
  let r = -Infinity;
  const take = (ms: number) => {
    if (Number.isFinite(ms) && ms > r) r = ms;
  };
  for (const list of [cmd.fetches, cmd.verdicts, cmd.lines, cmd.stages, cmd.parks, cmd.errors]) for (const x of list) take(x.ts);
  for (const m of view.messages) take(Date.parse(m.ts));
  if (view.boardSeen) take(Date.parse(view.boardSeen.ts));
  for (const a of [approvals?.h1?.at, approvals?.h2?.at]) if (a) take(Date.parse(a));
  return r;
}

/* ------------------------------------------------------------------------------------------------ board state */

interface SeatInfo {
  seatId: string;
  agentId: string | null;
  role: Role;
  card: AgentCard | undefined;
  state: PolaroidState;
  /** The message whose model call is in flight. */
  calling: SwarmItem | null;
  fresh: boolean;
}

interface StampShown {
  beat: StampBeat;
  count: number;
  fresh: boolean;
}

interface SlotShown {
  code: string;
  share: number;
  notScored: boolean;
  /** The codename card's place in the jury column (it travels from there). */
  from: Rect | null;
  order: number;
}

interface RowState {
  index: number;
  key: string;
  label: string;
  groupId: string | null;
  team: number;
  lay: RowLayout;
  crew: Record<CrewRole, SeatInfo>;
  fetch: { cards: CmdFetch[]; counts: FetchCounts };
  freshFetch: ReadonlySet<number>;
  fanLine: CmdLine | null;
  ledgerLine: CmdLine | null;
  counts: VerdictCounts | null;
  notable: CmdVerdict | null;
  stamps: StampShown[];
  tags: EvidenceTag[];
  freshTags: ReadonlySet<string>;
  memos: SwarmItem[];
  memoFresh: boolean;
  slot: SlotShown | null;
  slotFresh: boolean;
  incumbent: boolean;
  /** Claims the S6 gates passed (the row's dossier size), from its recorded line. */
  claims: number | null;
}

const AREA_OF: Partial<Record<StageId, Area[]>> = {
  S4: ["fan"],
  S5: ["ledger"],
  S6: ["ledger"],
  S7: ["ledger"],
  S9: ["crew", "memo", "desks"],
  S10: ["jury", "slot"],
};
type Area = "dossier" | "crew" | "fan" | "ledger" | "memo" | "slot" | "jury" | "desks";

const STAGE_NAME: Readonly<Record<string, string>> = Object.fromEntries(STAGES.map((s) => [s.id, s.name]));

/* ------------------------------------------------------------------------------------------------ the view */

export default function CaseBoard({ view: shownView, record: shownRecord, live, driven, onReplayRun, focus, onFocus, onReplay, recordError, envs, approvals }: OfficeStyleProps) {
  // a full-run replay brings the whole record and its own clock; the board shows it at the replay's cursor
  const view = driven?.view ?? shownView;
  const record = driven?.record ?? shownRecord;
  const reduced = useReducedMotion();
  const feed = useRunFeed();
  const boxRef = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(boxRef);

  const plan = useMemo(() => planOffice(view, record), [view, record]);
  const cmd = useMemo(() => foldCommand(envs), [envs]);
  const layout = useMemo(() => planBoard(plan), [plan]);
  const timeline = useMemo(() => replayClock([...warpKeys(view, record), ...boardKeys(cmd, approvals)]), [view, record, cmd, approvals]);
  const liveC = useMemo(() => (live ? liveClock(live.skewMs) : null), [live]);
  const clock = driven?.clock ?? liveC ?? timeline;
  const settled = driven ? 0 : live ? live.settledSeq : 0;
  const sched = useMemo(() => buildSchedule(plan, view, record, clock, settled), [plan, view, record, clock, settled]);
  const ctx = useMemo<DisplayCtx>(() => ({ clock, settledSeq: settled }), [clock, settled]);
  const beats = useMemo(() => stampBeats(cmd, ctx), [cmd, ctx]);
  const finalR = useMemo(() => latestRecorded(cmd, view, approvals), [cmd, view, approvals]);

  // a replay belongs to a finished run: a run that is live again shows live
  const [stored, setReplay] = useState<Replay | null>(null);
  const replay = live || driven ? null : stored;
  const [wall, setWall] = useState({ ms: 0, perf: 0 });
  const t = driven ? driven.t : replay ? replayAt(replay, wall.perf) : live ? wall.ms : Infinity;
  const playing = driven ? driven.playing : (replay?.playing ?? false);
  // the board's own ticker runs for its own replay and a live run; a full-run replay re-renders it at its cursor
  const moving = !driven && ((replay?.playing ?? false) || live !== null);
  const replayEnd = timeline.span;
  useEffect(() => {
    if (!moving || !onScreen) return;
    const read = () => {
      const perf = performance.now();
      setWall({ ms: Date.now(), perf });
      setReplay((r) => (r && r.playing && replayAt(r, perf) >= replayEnd ? { ...r, base: replayEnd, playing: false } : r));
    };
    const first = window.setTimeout(read, 0);
    const h = window.setInterval(read, TICK_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(h);
    };
  }, [moving, onScreen, replayEnd]);

  // a replay holds while the board is off screen, and picks up where it was when it is back (event callbacks only)
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

  const R = driven ? (Number.isFinite(t) ? driven.recordedAt(t) : finalR) : replay ? timeline.recordedAt(t) : liveC ? liveC.recordedAt(t) : finalR;
  const gates = useMemo(() => gatesAt(cmd, approvals, R), [cmd, approvals, R]);

  // a run parked at a gate shows how long it has waited, ticking once a second
  const waiting = !live && !replay && !driven && (gates.H1.state === "waiting" || gates.H2.state === "waiting");
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    if (!waiting || !onScreen) return;
    const tick = () => setNowMs(Date.now());
    const first = window.setTimeout(tick, 0);
    const h = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(h);
    };
  }, [waiting, onScreen]);

  const animOn = !reduced && (live !== null || playing);
  const animFrom = replay ? replay.animFrom : -Infinity;

  // what is known at the frame: every rival name and agent on the board reads from it
  const scene = useMemo(() => sceneAt({ record, view, clockAt: clock.at, settledSeq: settled }, t), [record, view, clock, settled, t]);
  const S = useMemo(
    () => boardAt({ plan, view, cmd, layout, sched, ctx, beats, t, R, approvals, animOn, animFrom, settled, scene }),
    [plan, view, cmd, layout, sched, ctx, beats, t, R, approvals, animOn, animFrom, settled, scene],
  );

  // the thread below follows a replay: a new set only when another message has been sent
  const shownSent = replay || driven ? S.sentCount : -1;
  const scoresUp = S.scores;
  const replayState = useMemo(() => (shownSent < 0 ? null : { sent: sentFirst(sched, shownSent), scores: scoresUp }), [shownSent, sched, scoresUp]);
  useEffect(() => onReplay(replayState), [replayState, onReplay]);

  const startReplay = () => {
    const base = replay && replay.base < replayEnd ? replay.base : 0;
    setReplay({ base, wall: performance.now(), playing: true, speed: replay?.speed ?? 1, animFrom: base });
  };
  const pauseReplay = () => replay && setReplay({ ...replay, base: replayAt(replay, performance.now()), playing: false });
  const scrub = (ms: number) => setReplay((r) => ({ base: ms, wall: performance.now(), playing: false, speed: r?.speed ?? 1, animFrom: Infinity }));
  const cycleSpeed = () =>
    setReplay((r) => {
      const speed = SPEEDS[(SPEEDS.indexOf(r?.speed ?? 1) + 1) % SPEEDS.length] ?? 1;
      if (!r) return { base: replayEnd, wall: performance.now(), playing: false, speed, animFrom: Infinity };
      return { ...r, base: replayAt(r, performance.now()), wall: performance.now(), speed };
    });

  // the hover / focus card
  const [target, setTarget] = useState<TipTarget | null>(null);
  const hover = useCallback((next: TipTarget | null) => setTarget(next), []);
  // agent cards count only the messages sent by the frame's time (a replay never reveals what comes later)
  const sentNow = S.sentCount;
  // the open card is read from this frame: a target the frame does not know shows nothing
  const sentAtFrame = useMemo(() => sentFirst(sched, S.sentCount), [sched, S.sentCount]);
  const tip = tipAt(target, S, view, scene, sentAtFrame);
  const stats = useMemo(() => {
    const sent = sentFirst(sched, sentNow);
    return nodeStats(view, view.messages.filter((m) => sent.has(m.messageId)));
  }, [view, sched, sentNow]);

  const done = driven ? !Number.isFinite(driven.t) : !live && (!replay || (!replay.playing && replay.base >= replayEnd));
  const pushIn = !reduced && replay !== null && !replay.playing && replay.base >= replayEnd && replay.animFrom !== Infinity;
  const holdMs = (g: GateView) => (g.state === "waiting" && waiting && g.parkTs !== null && nowMs > 0 ? Math.max(0, nowMs - g.parkTs) : g.heldMs);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && focus !== "all") {
      e.preventDefault();
      onFocus("all");
    }
  };

  return (
    <div
      ref={boxRef}
      className="rounded-lg border border-hairline bg-canvas"
      data-office-style="case"
      data-stage={S.running ?? ""}
      data-case-board
      data-office-paused={(driven ? !driven.playing : replay !== null && !replay.playing) || !onScreen || done ? "" : undefined}
      data-office-driven={driven ? "" : undefined}
      onKeyDown={onKey}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-hairline px-4 py-2.5">
        <Caption S={S} live={live !== null} replaying={replay !== null || (driven !== null && Number.isFinite(driven.t))} done={done} />
        {!live && !driven && onReplayRun && (
          <button type="button" onClick={onReplayRun} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline px-3 text-xs font-medium text-ink-2 hover:bg-surface">
            Full-run replay
          </button>
        )}
        {!live && !driven && replayEnd > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              onClick={playing ? pauseReplay : startReplay}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline-strong px-3 font-medium text-ink hover:bg-surface"
            >
              {playing ? <Pause size={14} weight="fill" aria-hidden /> : <Play size={14} weight="fill" aria-hidden />}
              {playing ? "Pause" : replay && replay.base < replayEnd ? "Resume" : "Replay the run"}
            </button>
            <input
              type="range"
              min={0}
              max={Math.ceil(replayEnd / TICK_MS)}
              value={Math.round(Math.min(t, replayEnd) / TICK_MS)}
              onChange={(e) => scrub(Number(e.currentTarget.value) * TICK_MS)}
              aria-label="Case board replay position"
              aria-valuetext={`${S.clockText.tPlus} run time, ${S.sentCount} messages sent`}
              className="w-36 accent-[var(--color-signal)] sm:w-48"
            />
            <span className="w-12 font-mono tabular text-muted">{formatClock(Math.min(t, replayEnd))}</span>
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

      <div className="cb-cork relative overflow-hidden">
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className={cn("block h-auto w-full select-none", pushIn && "cb-push")}
          role="group"
          aria-label={boardLabel(S)}
        >
          <Header S={S} L={layout} holdMs={holdMs} runId={feed?.runId ?? null} parkedLive={waiting} />
          {S.rows.length === 0 ? (
            <EmptyRows />
          ) : (
            <>
              <AreaLayer area="dossier" S={S}>
                {S.rows.map((row) => (
                  <Dossier key={row.key} row={row} S={S} focus={focus} onFocus={onFocus} onTip={hover} />
                ))}
              </AreaLayer>
              <AreaLayer area="crew" S={S}>
                {S.rows.map((row) => (
                  <Crew key={row.key} row={row} focus={focus} onFocus={onFocus} onTip={hover} stats={stats} dim={!rowInFocus(focus, row, view)} />
                ))}
              </AreaLayer>
              <AreaLayer area="fan" S={S}>
                {S.rows.map((row) => (
                  <Fan key={row.key} row={row} dim={!rowInFocus(focus, row, view)} onTip={hover} />
                ))}
              </AreaLayer>
              <AreaLayer area="ledger" S={S}>
                {S.rows.map((row) => (
                  <Ledger key={row.key} row={row} dim={!rowInFocus(focus, row, view)} onTip={hover} S={S} />
                ))}
              </AreaLayer>
              <AreaLayer area="memo" S={S}>
                {S.rows.map((row) => (
                  <Memos key={row.key} row={row} view={view} focus={focus} onFocus={onFocus} onTip={hover} dim={!rowInFocus(focus, row, view)} />
                ))}
              </AreaLayer>
              <AreaLayer area="slot" S={S}>
                {S.rows.map((row) => (
                  <Slot key={row.key} row={row} dim={focus !== "all" && focus !== "board" && !rowInFocus(focus, row, view)} reduced={reduced || !onScreen} board={S.board} />
                ))}
              </AreaLayer>
              {layout.overflow && <Overflow L={layout} labels={layout.overflow.keys.filter((k) => scene.hasRival(k)).map((k) => plan.pods.find((p) => p.key === k)?.label ?? k)} />}
            </>
          )}
          <AreaLayer area="jury" S={S}>
            <Jury S={S} L={layout} focus={focus} onFocus={onFocus} onTip={hover} stats={stats} />
          </AreaLayer>
          <AreaLayer area="desks" S={S}>
            <Desks S={S} L={layout} focus={focus} onFocus={onFocus} onTip={hover} />
          </AreaLayer>
          <Threads S={S} L={layout} view={view} focus={focus} reduced={reduced} />
        </svg>
        {tip && <TipCard tip={tip} view={view} stats={stats} />}
      </div>

      <Legend S={S} />
      <p className="border-t border-hairline px-4 py-2 text-xs text-muted">
        Every card is a recorded event at its recorded time: an index card for each S4 fetch, a line typed onto a rival&apos;s ledger for each S5-S6
        step, a stamp for each burst of S7 verdicts, a memo for each S9 message with an ink thread to whoever received it and a red thread to each
        evidence code it cites. Hover or focus a card for its record; click a rival, an agent or a memo to show only those messages in the thread below.
        {recordError && <span className="text-danger"> Research and verification events could not be read ({recordError}); the swarm still shows.</span>}
      </p>
      <Milestones S={S} active={live !== null || playing} />
    </div>
  );
}

function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------------------------------------ deriving the board */

interface BoardInput {
  plan: OfficePlan;
  view: SwarmView;
  cmd: CommandRecord;
  layout: BoardLayout;
  sched: Schedule;
  ctx: DisplayCtx;
  beats: StampBeat[];
  t: number;
  R: number;
  approvals: Approvals | null;
  animOn: boolean;
  animFrom: number;
  settled: number;
  /** What is known at the frame (rivals named, agents carded): the board shows nothing else. */
  scene: Scene;
}

type BoardState = ReturnType<typeof boardAt>;

function boardAt({ plan, view, cmd, layout, sched, ctx, beats, t, R, approvals, animOn, animFrom, settled, scene }: BoardInput) {
  const fresh = (seq: number, at: number) => animOn && seq > settled && at > animFrom && at <= t && t - at < FRESH_MS;
  const frame = frameAt(plan, sched, t);
  const sent = sentFirst(sched, frame.sent);
  const filed = memosByRow(view, sent);
  const tags = tagsByRow(view, sent, cmd);
  const tally = tallyAt(cmd, t, ctx);
  const byId = new Map(view.messages.map((m) => [m.messageId, m]));
  const sendAt = (m: SwarmItem) => ctx.clock.at(Date.parse(m.ts));
  const typingFor = new Map<string, SwarmItem>();
  for (const b of sched.beats) {
    if (b.kind !== "type" || t < b.start || t >= b.end) continue;
    const m = byId.get(b.id.slice(5));
    if (m) typingFor.set(b.seat, m);
  }
  const s5 = cmd.stages.find((s) => s.stage === "S5" && s.edge === "started")?.ts ?? Infinity;
  const pinned = cmd.snapshot ? shownAt(cmd.snapshot, t, ctx) : plan.pods.length > 0;
  const board = view.board && frame.scores ? view.board : null;
  const codes = codesOf(view, sent);
  const codeRects = codenameRects(layout, codes.length);

  const seatInfo = (seatId: string, role: Role): SeatInfo => {
    const seat = plan.seats[seatId];
    const sf = frame.seats[seatId];
    const calling = typingFor.get(seatId) ?? null;
    // an agent not on the board yet at this frame has no id, card or filter to show
    const agentId = sf?.present ? (seat?.agentId ?? null) : null;
    const seen = agentId ? view.cardSeen[agentId] : undefined;
    const from = sched.presentFrom[seatId] ?? Infinity;
    return {
      seatId,
      agentId,
      role,
      card: agentId ? view.cards[agentId] : undefined,
      calling,
      fresh: seen !== undefined && Number.isFinite(from) && fresh(seen.seq, from),
      state: {
        present: sf?.present ?? false,
        activity: sf?.activity ?? "idle",
        workingMs: calling && Number.isFinite(R) ? Math.max(0, R - (Date.parse(calling.ts) - calling.usage.latencyMs)) : null,
        field: sf?.activity === "walking" || sf?.activity === "browsing",
        received: sf?.activity === "receiving",
      },
    };
  };

  const rows: RowState[] = (pinned ? layout.rows.filter((lay) => scene.hasRival(lay.key)) : []).map((lay) => {
    const pod = plan.pods[lay.index];
    const key = lay.key;
    const groupId = pod?.groupId ?? null;
    const label = pod?.label ?? key;
    const crew = Object.fromEntries(CREW_ROLES.map((r) => [r, seatInfo(`${key}:${r === "researcher" ? "lane" : r}`, r)])) as Record<CrewRole, SeatInfo>;
    const fetch = fetchesAt(cmd, key, t, ctx);
    const freshFetch = new Set(fetch.cards.slice(0, 8).filter((f) => fresh(f.seq, ctx.clock.at(f.ts))).map((f) => f.seq));
    let fanLine: CmdLine | null = null;
    let ledgerLine: CmdLine | null = null;
    let claims: number | null = null;
    for (const l of cmd.lines) {
      if (l.lane !== key || !shownAt(l, t, ctx)) continue;
      if (l.ts < s5) {
        if (!isFetchEcho(l.text)) fanLine = l;
      } else ledgerLine = l;
      const m = /passed the gates \((\d+) claims\)/.exec(l.text);
      if (m?.[1]) claims = Number(m[1]);
    }
    const mine = beats.filter((b) => b.lane === key && b.start <= t);
    const stamps = mine.slice(-2).map((beat) => ({ beat, count: stampCountAt(beat, t), fresh: animOn && beat.fresh && beat.start > animFrom && t - beat.start < FRESH_MS }));
    const rowTags = groupId ? (tags[groupId] ?? []) : [];
    const memos = groupId ? (filed.rows[groupId] ?? []) : [];
    // a tag is new when the message that first cited it was just pinned
    const freshTags = new Set<string>();
    if (animOn && groupId) {
      const first = new Map<string, SwarmItem>();
      for (const m of [...memos].reverse()) for (const c of m.citations) if (!first.has(c.code)) first.set(c.code, m);
      for (const [code, m] of first) if (fresh(m.seq, sendAt(m))) freshTags.add(code);
    }
    const newest = memos[0];
    const boardRow = board?.rows.find((r) => boardSlotRow([{ key, groupId }], r) === 0);
    const codeIndex = boardRow ? codes.indexOf(boardRow.code) : -1;
    return {
      index: lay.index,
      key,
      label,
      groupId,
      team: pod?.team ?? 0,
      lay,
      crew,
      fetch: { cards: fetch.cards, counts: fetch.counts },
      freshFetch,
      fanLine,
      ledgerLine,
      counts: tally.lanes[key] ?? null,
      notable: notableAt(cmd, key, t, ctx, NOTABLE_STEP_MS),
      stamps,
      tags: rowTags,
      freshTags,
      memos,
      memoFresh: newest !== undefined && fresh(newest.seq, sendAt(newest)),
      slot: boardRow ? { code: boardRow.code, share: boardRow.share, notScored: boardRow.code === "", from: codeRects[codeIndex] ?? null, order: Math.max(0, codeIndex) } : null,
      slotFresh: board !== null && view.boardSeen !== null && fresh(view.boardSeen.seq, sched.scoresAt),
      incumbent: boardRow?.incumbent ?? false,
      claims,
    };
  });

  const states = stageStatesAt(cmd, t, ctx);
  let running: StageId | null = null;
  for (const s of STAGES) if (states[s.id]?.state === "running") running = s.id;
  const gates = gatesAt(cmd, approvals, R);
  const clockNow = runClock(cmd, approvals, R);
  const lastDone = [...STAGES].reverse().find((s) => states[s.id] && states[s.id]?.state !== "running");
  const stageText = running
    ? `${running} ${STAGE_NAME[running] ?? ""}`.toUpperCase()
    : gates.H2.state === "waiting"
      ? "H2 DECISION"
      : gates.H1.state === "waiting"
        ? "H1 PLAN APPROVAL"
        : lastDone
          ? `${lastDone.id} ${lastDone.name} ${CHIP_TITLE[states[lastDone.id]?.state ?? "done"]}`.toUpperCase()
          : "NOT STARTED";

  const threads = threadsAt(sched, view, t, sent);
  const rivalRounds = view.messages.filter((m) => sent.has(m.messageId) && m.contextId !== "board").map((m) => m.round);
  const round = rivalRounds.length ? Math.max(...rivalRounds) : 0;

  const seat = (id: string, role: Role) => seatInfo(id, role);
  const evaluators = [0, 1, 2].map((i) => seat(`board:${i}`, "evaluator"));
  const challenges = view.messages.filter((m) => sent.has(m.messageId) && m.from === plan.seats.red_team?.agentId && m.kind === "challenge");
  const interviews = view.messages.filter((m) => sent.has(m.messageId) && m.kind === "interview");
  const juryMemos = filed.jury;

  return {
    t,
    R,
    rows,
    frame,
    sent,
    sentCount: frame.sent,
    scores: frame.scores,
    board,
    boardFresh: board !== null && view.boardSeen !== null && fresh(view.boardSeen.seq, sched.scoresAt),
    codes,
    codeRects,
    ratings: ratingsOf(view, sent),
    tally,
    states,
    running,
    gates,
    clockText: { tPlus: clockNow.tPlus === null ? "--:--.-" : formatTPlus(clockNow.tPlus), wall: formatWall(R), stage: stageText },
    threads,
    round,
    evaluators,
    red: seat("red_team", "red_team"),
    analyst: seat("analyst", "analyst"),
    stamping: frame.stamp !== null,
    challenges,
    interviews,
    juryMemos,
    errors: cmd.errors.filter((e) => shownAt(e, t, ctx)),
    title: cmd.opportunity,
    pinned,
    final: !Number.isFinite(t),
    emphasis: running ? (AREA_OF[running] ?? null) : null,
    freshError: (e: CmdError) => fresh(e.seq, ctx.clock.at(e.ts)),
  };
}

function rowInFocus(focus: Focus, row: RowState, view: SwarmView): boolean {
  if (focus === "all") return true;
  if (focus === "board") return false;
  if (focus.startsWith("agent:")) return view.cards[focus.slice(6)]?.group === row.groupId;
  if (focus.startsWith("edge:")) return focus.slice(5).split("~").some((id) => view.cards[id]?.group === row.groupId);
  return focus === row.groupId;
}

function boardLabel(S: BoardState): string {
  const fetched = S.rows.reduce((n, r) => n + r.fetch.counts.total, 0);
  const stamped = S.tally.total.supported + S.tally.total.partly + S.tally.total.withheld;
  return `Case board: ${S.rows.length} rivals, ${fetched} intel cards, ${stamped} claims stamped, ${S.sentCount} memos. The message thread below holds every message.`;
}

/* ------------------------------------------------------------------------------------------------ layers */

function AreaLayer({ area, S, children }: { area: Area; S: BoardState; children: ReactNode }) {
  const lit = S.emphasis === null || S.emphasis.includes(area) || area === "dossier";
  return (
    <g data-area={area} style={{ opacity: lit ? 1 : 0.7 }} className="transition-opacity duration-[var(--duration-slow)]">
      {children}
    </g>
  );
}

function EmptyRows() {
  const r: Rect = { x: 360, y: 330, w: 460, h: 74 };
  return (
    <Pinned id="empty" r={r} pin="var(--color-office-board)">
      <text x={r.x + r.w / 2} y={r.y + 34} textAnchor="middle" className="fill-ink" fontSize={14} fontWeight={600}>
        Rivals are pinned when the approved plan&apos;s
      </text>
      <text x={r.x + r.w / 2} y={r.y + 54} textAnchor="middle" className="fill-ink" fontSize={14} fontWeight={600}>
        evidence lanes open (S4).
      </text>
      <title>Rival rows appear when the approved plan names their evidence lanes.</title>
    </Pinned>
  );
}

function Overflow({ L, labels }: { L: BoardLayout; labels: string[] }) {
  const o = L.overflow;
  if (!o || labels.length === 0) return null;
  return (
    <g>
      <Paper r={o.band} />
      <text x={o.band.x + 10} y={o.band.y + o.band.h / 2 + 4} className="fill-ink-2" fontSize={11}>
        <tspan fontWeight={600}>+{labels.length} rivals</tspan> {clip(labels.map(shortName).join(", "), 150)}
      </text>
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ the header */

const Header = memo(function Header({ S, L, holdMs, runId, parkedLive }: { S: BoardState; L: BoardLayout; holdMs: (g: GateView) => number | null; runId: string | null; parkedLive: boolean }) {
  const h = L.header;
  const title = wrapText(S.title ?? "Reading the run's record", 40, 2);
  return (
    <g>
      <Pinned id="case" r={h.caseCard} pin="var(--color-office-board)" angle={-0.6}>
        <text x={h.caseCard.x + 14} y={h.caseCard.y + 18} className="fill-muted" fontSize={9.5} fontWeight={600} letterSpacing={1.6}>
          CASE BOARD
        </text>
        <Lines x={h.caseCard.x + 14} y={h.caseCard.y + 39} lines={title} step={20} className="font-serif fill-ink" fontSize={18.5} fontWeight={600} />
      </Pinned>

      <Tape r={h.tPlus}>
        <text x={h.tPlus.x + 10} y={h.tPlus.y + 15} className="font-mono" fontSize={9} fontWeight={700} letterSpacing={1} fill="var(--cb-tape-text)" opacity={0.7}>
          T+ RUN TIME
        </text>
        <text x={h.tPlus.x + h.tPlus.w - 10} y={h.tPlus.y + 40} textAnchor="end" className="font-mono tabular" fontSize={27} fontWeight={700} fill="var(--cb-tape-text)">
          {S.clockText.tPlus}
        </text>
      </Tape>
      <Tape r={h.wall}>
        <text x={h.wall.x + h.wall.w / 2} y={h.wall.y + 14.5} textAnchor="middle" className="font-mono tabular" fontSize={12.5} fontWeight={600} fill="var(--cb-tape-text)">
          {S.clockText.wall || "--:--:--.-"}
        </text>
      </Tape>
      <Tape r={h.stage}>
        <text x={h.stage.x + h.stage.w / 2} y={h.stage.y + 14.5} textAnchor="middle" className="font-mono" fontSize={clipSize(S.clockText.stage, 10.5, 15)} fontWeight={600} fill="var(--cb-tape-text)">
          {clip(S.clockText.stage, 22)}
        </text>
      </Tape>
      <g aria-hidden>
        <rect x={440} y={62} width={320} height={14} rx={1.5} fill="var(--cb-paper)" opacity={0.92} />
        <text x={448} y={72.5} className="fill-muted" fontSize={8.5}>
          run time stops while the run waits at a gate; wall time in your time zone
        </text>
      </g>

      <StageChips S={S} L={L} />
      <GateCard gate="H1" r={h.h1} g={S.gates.H1} held={holdMs(S.gates.H1)} href={runId && parkedLive && S.gates.H1.state === "waiting" ? `/runs/${runId}/plan` : null} />
      <GateCard gate="H2" r={h.h2} g={S.gates.H2} held={holdMs(S.gates.H2)} href={runId && parkedLive && S.gates.H2.state === "waiting" ? `/runs/${runId}/decision` : null} />
    </g>
  );
});

function clipSize(text: string, base: number, fit: number): number {
  return text.length > fit ? Math.max(8.5, base * (fit / text.length)) : base;
}

const CHIP_TITLE: Record<StageState | "not_started", string> = {
  running: "running",
  done: "done",
  degraded: "done with gaps",
  not_built: "skipped on this run",
  failed: "failed",
  not_started: "not started",
};

function StageChips({ S, L }: { S: BoardState; L: BoardLayout }) {
  const ids = CHIP_ROWS.flat();
  return (
    <g>
      {ids.map((id) => {
        const r = L.header.chips[id];
        if (!r) return null;
        if (id === "H1" || id === "H2") {
          const g = S.gates[id as Gate];
          const on = g.state !== "none";
          return (
            <g key={id}>
              <title>{`${id} ${id === "H1" ? "plan approval" : "decision"}: ${g.state === "none" ? "not reached" : g.state}`}</title>
              <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={1.6} fill={on ? "var(--color-cream-deep)" : "var(--cb-paper)"} stroke={on ? "var(--color-cream-edge)" : "var(--cb-edge)"} strokeWidth={0.8} strokeDasharray={on ? undefined : "2 1.6"} />
              <text x={r.x + r.w / 2} y={r.y + 12.5} textAnchor="middle" className={cn("font-mono", on ? "fill-ink" : "fill-muted")} fontSize={10} fontWeight={700}>
                {id}
              </text>
            </g>
          );
        }
        const st = S.states[id as StageId];
        const state: StageState | "not_started" = st?.state ?? "not_started";
        const ink = state === "done" || state === "degraded";
        const fill = state === "running" ? "var(--color-signal)" : state === "failed" ? "var(--color-danger)" : ink ? "var(--cb-tape)" : "var(--cb-paper)";
        const text = state === "running" || state === "failed" || ink ? "var(--cb-tape-text)" : "var(--color-muted)";
        const span = st && st.end !== null ? `, ${formatTime(st.start)} to ${formatTime(st.end)} (${formatHeld(st.end - st.start)})` : st ? `, started ${formatTime(st.start)}` : "";
        return (
          <g key={id}>
            <title>{`${id} ${STAGE_NAME[id] ?? ""}: ${CHIP_TITLE[state]}${span}`}</title>
            <clipPath id={`cb-chip-${id}`}>
              <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={1.6} />
            </clipPath>
            <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={1.6} fill={fill} stroke={state === "not_started" ? "var(--cb-edge)" : "none"} strokeWidth={0.8} />
            {state === "not_built" && <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={1.6} fill="url(#cb-hatch)" />}
            {state === "running" && (
              <g clipPath={`url(#cb-chip-${id})`}>
                <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="var(--color-office-glint)" opacity={0.35} className="animate-sweep cb-sweep" />
              </g>
            )}
            {state === "degraded" && <path d={`M${r.x + r.w - 7} ${r.y} L${r.x + r.w} ${r.y} L${r.x + r.w} ${r.y + 7}Z`} fill="var(--cb-paper)" />}
            <text x={r.x + r.w / 2} y={r.y + 12.5} textAnchor="middle" className="font-mono" fontSize={10} fontWeight={700} fill={text}>
              {state === "failed" ? `${id}x` : id}
            </text>
          </g>
        );
      })}
      <defs>
        <pattern id="cb-hatch" width={4} height={4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width={4} height={4} fill="var(--cb-paper)" />
          <line x1={0} y1={0} x2={0} y2={4} stroke="var(--cb-edge)" strokeWidth={1.4} />
        </pattern>
      </defs>
    </g>
  );
}

function GateCard({ gate, r, g, held, href }: { gate: Gate; r: Rect; g: GateView; held: number | null; href: string | null }) {
  const name = gate === "H1" ? "H1 Plan approval" : "H2 Decision";
  const line =
    g.state === "none"
      ? "not reached"
      : g.state === "waiting"
        ? `waiting ${held !== null ? formatHeld(held) : ""}`
        : gate === "H1"
          ? `${g.inferred ? "resumed" : "approved"} ${g.actedTs !== null ? formatWall(g.actedTs) : ""}${g.heldMs !== null ? `, held ${formatHeld(g.heldMs)}` : ""}`
          : `recorded ${g.actedTs !== null ? formatWall(g.actedTs) : ""}`;
  const title = g.state === "approved" ? (gate === "H1" ? "H1 Plan approved" : "Decision recorded") : name;
  const body = (
    <g key={`${gate}:${g.state}`} className={g.state !== "none" ? "animate-pop" : undefined} style={{ transformBox: "fill-box", transformOrigin: "center" }}>
      <rect x={r.x + 1.2} y={r.y + 2} width={r.w} height={r.h} rx={1.6} fill={SHADOW} opacity={0.1} />
      <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={1.6} fill={g.state === "none" ? "var(--color-cream-soft)" : "var(--color-cream)"} stroke="var(--color-cream-edge)" strokeWidth={0.9} strokeDasharray={g.state === "none" ? "2.4 2" : undefined} />
      <text x={r.x + 9} y={r.y + 13.5} className={g.state === "none" ? "fill-muted" : "fill-ink"} fontSize={10.5} fontWeight={600}>
        {title}
      </text>
      <text x={r.x + 9} y={r.y + 26} className={cn("font-mono tabular", g.state === "waiting" ? "fill-accent" : "fill-ink-2")} fontSize={9} fontWeight={g.state === "waiting" ? 700 : 500}>
        {clip(line, 30)}
      </text>
      {g.state === "approved" && <path d={`M${r.x + r.w - 17} ${r.y + 11} l3.5 3.6 l7 -7.4`} fill="none" stroke="var(--color-ink)" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />}
      {g.state === "waiting" && <PinHead x={r.x + r.w - 10} y={r.y + 9} colour="var(--color-signal)" size={3.4} />}
    </g>
  );
  const label = `${title}: ${line}`;
  if (href) {
    return (
      <Link href={href} aria-label={`${label}. Open the ${gate === "H1" ? "plan review" : "Decision (H2) page"}.`}>
        {body}
      </Link>
    );
  }
  return (
    <g role="img" aria-label={label}>
      {body}
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ rows */

/** What the hover or focus card shows, built fresh from the frame on every render. */
type TipState = { kind: "agent"; at: Pt; card: AgentCard; rival: boolean } | { kind: "text"; at: Pt; title: string; lines: string[] } | { kind: "memo"; at: Pt; m: SwarmItem };

/** What is hovered or focused: only the target, never its words (they are read from the frame on show). */
type TipTarget =
  | { kind: "agent"; agentId: string; rival: boolean; at: Pt }
  | { kind: "memo"; msgId: string; at: Pt }
  | { kind: "dossier"; pod: string; at: Pt }
  | { kind: "crew"; pod: string; role: CrewRole; at: Pt }
  | { kind: "intel"; pod: string; seq: number; at: Pt }
  | { kind: "tag"; pod: string; code: string; at: Pt };

type OnTip = (t: TipTarget | null) => void;

/** The card for a target at this frame: from the board as drawn now; null when the frame does not know it. */
function tipAt(target: TipTarget | null, S: BoardState, view: SwarmView, scene: Scene, sent: ReadonlySet<string>): TipState | null {
  if (!target) return null;
  if (target.kind === "agent") {
    const card = scene.hasAgent(target.agentId) ? view.cards[target.agentId] : undefined;
    return card ? { kind: "agent", at: target.at, card, rival: target.rival } : null;
  }
  if (target.kind === "memo") {
    const m = sent.has(target.msgId) ? view.messages.find((x) => x.messageId === target.msgId) : undefined;
    return m ? { kind: "memo", at: target.at, m } : null;
  }
  const row = S.rows.find((r) => r.key === target.pod);
  if (!row) return null;
  if (target.kind === "dossier") {
    const words = dossierTipWords({ label: row.label, fetched: row.fetch.counts.total, incumbent: row.incumbent, counts: row.counts, memos: row.memos.length });
    return { kind: "text", at: target.at, ...words };
  }
  if (target.kind === "crew") {
    const s = row.crew[target.role];
    if (s.card) return { kind: "agent", at: target.at, card: s.card, rival: true };
    const lines = target.role === "researcher" ? [`S4 research lane: ${row.fetch.counts.total} sources fetched from public records.`] : ["This polaroid fills when the agent's card is recorded (S9)."];
    return { kind: "text", at: target.at, title: `${shortName(row.label)} ${CAPTION[CREW_SEAT_ROLE[target.role]]}`, lines };
  }
  if (target.kind === "intel") {
    const card = row.fetch.cards.find((c) => c.seq === target.seq);
    if (!card) return null;
    return {
      kind: "text",
      at: target.at,
      title: card.host,
      lines: [`${TIER_LABEL[card.tier]} (${card.sourceType}), matrix column ${card.column}`, `${card.status === "ok" ? "fetched" : card.status} at ${formatWall(card.ts)}`, `evidence ${card.evidenceId}`],
    };
  }
  const tag = row.tags.find((x) => x.code === target.code);
  if (!tag) return null;
  return {
    kind: "text",
    at: target.at,
    title: `${tag.code}: cited claim, ${shortName(row.label)}`,
    lines: [tag.text, tag.verdict ? `S7 verdict: ${VERDICT_LABEL[tag.verdict]}` : "No S7 verdict on this run's record (the claim was accepted earlier)."],
  };
}

function activate(fn: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

function toggle(cur: Focus, next: Focus): Focus {
  return cur === next ? "all" : next;
}

function teamInk(team: number): string {
  return `color-mix(in oklab, var(--color-team-${team}) 62%, var(--color-ink))`;
}

function Dossier({ row, S, focus, onFocus, onTip }: { row: RowState; S: BoardState; focus: Focus; onFocus: (f: Focus) => void; onTip: OnTip }) {
  const r = row.lay.dossier;
  const name = shortName(row.label);
  const tabW = Math.min(r.w - 12, name.length * 6.6 + 16);
  const on = row.groupId !== null && focus === row.groupId;
  const dim = focus !== "all" && !on && !(focus.startsWith("agent:") || focus.startsWith("edge:"));
  const mono = initials(row.label);
  const monoSize = row.lay.compact ? 30 : 40;
  const nameLines = wrapText(row.label, 21, 2);
  const withheld = row.counts?.withheld ?? 0;
  const label = `${row.label}: ${row.fetch.counts.total} fetched, ${row.claims ?? (row.counts ? row.counts.supported + row.counts.partly + row.counts.withheld : 0)} claims (${withheld} withheld), ${row.memos.length} memos.${row.groupId ? " Show this team's messages." : ""}`;
  const select = () => row.groupId && onFocus(toggle(focus, row.groupId));
  const tip = () => onTip({ kind: "dossier", pod: row.key, at: { x: r.x + r.w / 2, y: r.y + r.h + 4 } });
  return (
    <g
      role={row.groupId ? "button" : "img"}
      tabIndex={0}
      aria-label={label}
      onPointerEnter={tip}
      onPointerLeave={() => onTip(null)}
      onFocus={tip}
      onBlur={() => onTip(null)}
      {...(row.groupId ? { "aria-pressed": on, onClick: select, onKeyDown: activate(select) } : {})}
      className={cn("outline-none transition-opacity duration-[var(--duration-base)]", row.groupId && "cursor-pointer", dim && "opacity-35")}
      data-cb-dossier={row.key}
    >
      <g transform={`rotate(${row.index % 2 ? 0.7 : -0.6} ${r.x + r.w / 2} ${r.y})`}>
        <g className={S.pinned && row.fetch.counts.total === 0 && !S.final ? undefined : undefined}>
          {/* the folder tab, in the team's colour, with the rival's short name */}
          <path
            d={`M${r.x + 4} ${r.y + 1} L${r.x + 8} ${r.y - 11} L${r.x + 4 + tabW} ${r.y - 11} L${r.x + 8 + tabW} ${r.y + 1}Z`}
            fill={`color-mix(in oklab, var(--color-team-${row.team}) 78%, var(--cb-paper))`}
            stroke="var(--cb-edge)"
            strokeWidth={0.7}
          />
          <text x={r.x + 11} y={r.y - 2.6} className="fill-ink" fontSize={9.5} fontWeight={700} letterSpacing={0.4}>
            {clip(name.toUpperCase(), 17)}
          </text>
          <Paper r={r} stroke={on ? "var(--color-signal)" : "var(--cb-edge)"} />
          {on && <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={1.6} fill="none" stroke="var(--color-signal)" strokeWidth={2} />}
          <rect x={r.x} y={r.y} width={3} height={r.h} fill={`var(--color-team-${row.team})`} />
          <text x={r.x + 13} y={r.y + 13 + monoSize * 0.82} className="font-serif" fontSize={monoSize} fontWeight={600} fill={teamInk(row.team)}>
            {mono}
          </text>
          <Lines x={r.x + 13} y={r.y + 22 + monoSize} lines={nameLines} step={11} className="fill-ink-2" fontSize={9.5} fontWeight={500} />
          <text x={r.x + 13} y={r.y + r.h - 8} className="font-mono fill-muted" fontSize={8.5}>
            {row.fetch.counts.total} fetched{row.memos.length ? `, ${row.memos.length} memos` : ""}
          </text>
          {row.incumbent && (
            <g>
              <rect x={r.x + r.w - 62} y={r.y + 8} width={54} height={13} rx={1.5} fill="none" stroke="var(--color-ink)" strokeWidth={1} />
              <text x={r.x + r.w - 35} y={r.y + 17.6} textAnchor="middle" className="fill-ink" fontSize={7.5} fontWeight={700} letterSpacing={0.6}>
                INCUMBENT
              </text>
            </g>
          )}
          <PinHead x={r.x + r.w / 2} y={r.y + 5} colour={`var(--color-team-${row.team})`} />
        </g>
      </g>
      <title>{label}</title>
    </g>
  );
}

const CREW_SEAT_ROLE: Record<CrewRole, Role> = { researcher: "researcher", pricing: "pricing", technical: "technical", past_performance: "past_performance", capture_lead: "capture_lead" };

function Crew({ row, focus, onFocus, onTip, stats, dim }: { row: RowState; focus: Focus; onFocus: (f: Focus) => void; onTip: OnTip; stats: ReturnType<typeof nodeStats>; dim: boolean }) {
  return (
    <g className={cn("transition-opacity duration-[var(--duration-base)]", dim && "opacity-35")}>
      {CREW_ROLES.map((role) => {
        const s = row.crew[role];
        const r = row.lay.crew[role];
        const interactive = s.agentId !== null && s.card !== undefined;
        const on = s.agentId !== null && focus === `agent:${s.agentId}`;
        const st = s.agentId ? stats[s.agentId] : undefined;
        const name = s.card?.name ?? (role === "researcher" ? `${row.label} researcher` : `${ROLE_NAME[CREW_SEAT_ROLE[role]]} (no card yet)`);
        const doing = s.state.workingMs !== null ? ` On a model call, ${Math.floor(s.state.workingMs / 1000)} s of model time so far.` : s.state.field ? " In the field: reading sources." : "";
        const label = `${name}.${doing}${st ? ` ${st.sent} sent, ${st.received} received.` : ""}${interactive ? " Show this agent's messages." : ""}`;
        const caption = s.state.workingMs !== null ? `${Math.floor(s.state.workingMs / 1000)} s` : CAPTION[CREW_SEAT_ROLE[role]];
        return (
          <Polaroid
            key={role}
            r={r}
            role={CREW_SEAT_ROLE[role]}
            team={row.team}
            state={s.state}
            caption={caption}
            fresh={s.fresh}
            focused={on}
            interactive={interactive}
            label={label}
            pin={`var(--color-team-${row.team})`}
            onActivate={() => s.agentId && onFocus(toggle(focus, `agent:${s.agentId}`))}
            onHover={(hov) => {
              if (!hov) return onTip(null);
              const at = { x: r.x + r.w + 4, y: r.y + r.h / 2 };
              onTip({ kind: "crew", pod: row.key, role, at });
            }}
          />
        );
      })}
      {CREW_ROLES.map((role) => {
        const s = row.crew[role];
        if (s.state.workingMs === null || !s.calling) return null;
        const r = row.lay.crew[role];
        return (
          <g key={`dots-${role}`} className="office-agent" data-activity="typing" aria-hidden>
            <g className="office-dots" fill="var(--color-accent)">
              <circle cx={r.x + r.w / 2 - 4} cy={r.y - 4} r={1.5} />
              <circle cx={r.x + r.w / 2} cy={r.y - 4} r={1.5} />
              <circle cx={r.x + r.w / 2 + 4} cy={r.y - 4} r={1.5} />
            </g>
          </g>
        );
      })}
    </g>
  );
}

function Fan({ row, dim, onTip }: { row: RowState; dim: boolean; onTip: OnTip }) {
  const f = row.lay.fan;
  const inner = { x: f.x, y: f.y + 16, w: f.w, h: f.h - 32 };
  const cardH = Math.max(36, Math.min(60, inner.h));
  const cards = row.fetch.cards.slice(0, 8);
  const pos = fanRects(inner, row.fetch.cards.length, cardH);
  const c = row.fetch.counts;
  const parts = [`${c.total} fetched`];
  if (c.error) parts.push(`${c.error} error`);
  if (c.blocked) parts.push(`${c.blocked} blocked`);
  const line = row.fanLine ? laneText(row.fanLine.text, row.fanLine.label) : null;
  // one tab stop for the fan; arrows, Home and End move between every visible card
  const shown = cards.flatMap((card, i) => (pos.cards[i] ? [card.seq] : []));
  const [active, setActive] = useState<number | null>(null);
  const stop = active !== null && shown.includes(active) ? active : (shown[0] ?? null);
  const refs = useRef(new Map<number, SVGGElement>());
  const onCardKey = (seq: number) => (e: KeyboardEvent) => {
    const next = rovingIndex(shown.indexOf(seq), shown.length, e.key);
    if (next === null) return;
    e.preventDefault();
    const target = shown[next];
    if (target === undefined) return;
    setActive(target);
    refs.current.get(target)?.focus();
  };
  return (
    <g className={cn("transition-opacity duration-[var(--duration-base)]", dim && "opacity-35")} data-cb-fan={row.key}>
      {line && (
        <g key={`fl-${row.fanLine?.seq}`} className="animate-rise">
          <rect x={f.x + 30} y={f.y + 1} width={f.w - 30} height={12} rx={1.4} fill="var(--cb-paper)" opacity={0.94} />
          <text x={f.x + 36} y={f.y + 10} className="fill-ink-2" fontSize={8.6}>
            {clip(line, 46)}
          </text>
        </g>
      )}
      {cards
        .map((card, i) => ({ card, i, r: pos.cards[i] }))
        .reverse()
        .map(({ card, i, r }) =>
          r ? (
            <IntelCard
              key={card.seq}
              card={card}
              r={r}
              newest={i === 0}
              fresh={row.freshFetch.has(card.seq)}
              team={row.team}
              onTip={onTip}
              tabStop={card.seq === stop}
              onKey={onCardKey(card.seq)}
              onFocused={() => setActive(card.seq)}
              cardRef={(el) => {
                if (el) refs.current.set(card.seq, el);
                else refs.current.delete(card.seq);
              }}
            />
          ) : null,
        )}
      {pos.more && (
        <g>
          <Paper r={pos.more} />
          <text x={pos.more.x + pos.more.w / 2} y={pos.more.y + pos.more.h / 2 + 3.4} textAnchor="middle" className="font-mono fill-ink-2" fontSize={9} fontWeight={600}>
            +{pos.hidden}
          </text>
        </g>
      )}
      {c.total > 0 && (
        <g>
          <rect x={f.x + 30} y={f.y + f.h - 13} width={Math.min(f.w - 30, parts.join(", ").length * 5.6 + 12)} height={12} rx={1.4} fill="var(--cb-paper)" stroke="var(--cb-edge)" strokeWidth={0.6} />
          <text x={f.x + 36} y={f.y + f.h - 4.2} className="font-mono fill-ink-2 tabular" fontSize={8.6}>
            {parts.join(", ")}
          </text>
        </g>
      )}
    </g>
  );
}

function IntelCard({
  card,
  r,
  newest,
  fresh,
  team,
  onTip,
  tabStop,
  onKey,
  onFocused,
  cardRef,
}: {
  card: CmdFetch;
  r: Rect;
  newest: boolean;
  fresh: boolean;
  team: number;
  onTip: OnTip;
  tabStop: boolean;
  onKey: (e: KeyboardEvent) => void;
  onFocused: () => void;
  cardRef: (el: SVGGElement | null) => void;
}) {
  const Glyph = TIER_ICON[card.tier];
  const bad = card.status !== "ok";
  const label = `${card.host}, ${TIER_LABEL[card.tier]}, ${card.status}, fetched ${formatTime(card.ts)}`;
  const tip = () => onTip({ kind: "intel", pod: card.lane, seq: card.seq, at: { x: r.x + r.w / 2, y: r.y - 4 } });
  return (
    <g
      ref={cardRef}
      role="img"
      aria-label={label}
      tabIndex={tabStop ? 0 : -1}
      onKeyDown={onKey}
      onFocus={() => {
        onFocused();
        tip();
      }}
      onBlur={() => onTip(null)}
      onPointerEnter={tip}
      onPointerLeave={() => onTip(null)}
      className="outline-none"
    >
      <Pinned id={`intel:${card.seq}`} r={r} fresh={fresh} pin={newest ? `var(--color-team-${team})` : null}>
        <line x1={r.x + 4} y1={r.y + 15} x2={r.x + r.w - 4} y2={r.y + 15} stroke={`var(--color-team-${team})`} strokeWidth={0.9} />
        {Array.from({ length: Math.max(0, Math.floor((r.h - 22) / 9)) }, (_, k) => (
          <line key={k} x1={r.x + 4} y1={r.y + 24 + k * 9} x2={r.x + r.w - 4} y2={r.y + 24 + k * 9} stroke="var(--cb-rule)" strokeWidth={0.6} />
        ))}
        <Glyph x={r.x + 2.5} y={r.y + 3} size={10.5} weight="duotone" className="text-ink-2" aria-hidden />
        <text x={r.x + 17} y={r.y + 11.6} className="font-mono fill-ink" fontSize={9.6} fontWeight={600}>
          {clip(card.host, 15)}
        </text>
        <text x={r.x + 5} y={r.y + 26} className="font-mono fill-ink-2" fontSize={7.8}>
          {clip(card.sourceType, 22)}
        </text>
        <text x={r.x + 5} y={r.y + r.h - 5} className="font-mono fill-muted tabular" fontSize={8}>
          {formatTime(card.ts)}
        </text>
        {bad && (
          <g transform={`rotate(-14 ${r.x + r.w / 2} ${r.y + r.h / 2})`}>
            <rect x={r.x - 3} y={r.y + r.h / 2 - 6.5} width={r.w + 6} height={13} fill="var(--color-danger)" opacity={0.92} />
            <Warning x={r.x + r.w / 2 - 30} y={r.y + r.h / 2 - 5} size={10} weight="bold" className="text-canvas" aria-hidden />
            <text x={r.x + r.w / 2 + 4} y={r.y + r.h / 2 + 3.3} textAnchor="middle" className="font-mono fill-canvas" fontSize={8.6} fontWeight={700} letterSpacing={1}>
              {card.status === "blocked" ? "BLOCKED" : "ERROR"}
            </text>
          </g>
        )}
      </Pinned>
    </g>
  );
}

function Ledger({ row, dim, onTip, S }: { row: RowState; dim: boolean; onTip: OnTip; S: BoardState }) {
  const r = row.lay.ledger;
  const tags = tagRects(r, row.tags.length);
  const leftW = tags.tags.length ? r.w - (r.x + r.w - (tags.tags[0]?.x ?? r.x + r.w)) - 14 : r.w - 16;
  const chars = Math.floor(leftW / 6.2);
  const counts = row.counts;
  const total = counts ? counts.supported + counts.partly + counts.withheld : 0;
  const big = row.lay.compact ? 18 : 22;
  const label = counts ? `${row.label} claims: ${counts.supported} supported, ${counts.partly} partly, ${counts.withheld} withheld` : `${row.label} claims: ${row.ledgerLine ? laneText(row.ledgerLine.text, row.ledgerLine.label) : "none checked yet"}`;
  const line = row.ledgerLine ? laneText(row.ledgerLine.text, row.ledgerLine.label) : null;
  const showLine = counts === null && line !== null;
  const notable = row.notable;
  const rules = Math.floor((r.h - 22) / 12);
  return (
    <g className={cn("transition-opacity duration-[var(--duration-base)]", dim && "opacity-35")} data-cb-ledger={row.key}>
      <g role="img" tabIndex={0} aria-label={label} className="outline-none">
        <Pinned id={`ledger:${row.key}`} r={r} angle={row.index % 2 ? -0.5 : 0.4} pin={`var(--color-team-${row.team})`}>
          {Array.from({ length: rules }, (_, k) => (
            <line key={k} x1={r.x + 6} y1={r.y + 22 + k * 12} x2={r.x + leftW + 8} y2={r.y + 22 + k * 12} stroke="var(--cb-rule)" strokeWidth={0.7} />
          ))}
          <line x1={r.x + 26} y1={r.y + 3} x2={r.x + 26} y2={r.y + r.h - 3} stroke="var(--color-signal)" strokeWidth={0.5} opacity={0.35} />
          <text x={r.x + 32} y={r.y + 14} className="fill-muted" fontSize={8.6} fontWeight={700} letterSpacing={1.2}>
            CLAIMS
          </text>
          {total > 0 && (
            <text x={r.x + leftW + 6} y={r.y + 14} textAnchor="end" className="font-mono fill-muted tabular" fontSize={8.6}>
              {total} stamped
            </text>
          )}
          {!counts && !line && (
            <text x={r.x + 32} y={r.y + 36} className="fill-muted" fontSize={9.5}>
              {S.final ? "No claims recorded for this rival." : "Claims arrive with the dossier (S6)."}
            </text>
          )}
          {showLine && line && (
            <g key={`ll-${row.ledgerLine?.seq}`} className="animate-rise">
              <text x={r.x + 32} y={r.y + 32} className="fill-muted" fontSize={8.4} fontWeight={600} letterSpacing={0.6}>
                DOSSIER
              </text>
              <Lines x={r.x + 32} y={r.y + 46} lines={wrapText(line, Math.floor((leftW - 26) / 5.9), 3)} step={13} className="fill-ink" fontSize={10.8} fontWeight={500} />
            </g>
          )}
          {counts && (
            <g>
              <CountGlyph x={r.x + 32} y={r.y + 22} verdict="supported" n={counts.supported} size={big} />
              <CountGlyph x={r.x + 32 + (leftW - 26) / 3} y={r.y + 22} verdict="partly" n={counts.partly} size={big} />
              <CountGlyph x={r.x + 32 + (2 * (leftW - 26)) / 3} y={r.y + 22} verdict="withheld" n={counts.withheld} size={big} />
            </g>
          )}
          {counts && notable && (
            <g key={`nt-${notable.seq}`} className="animate-rise">
              <text x={r.x + 32} y={r.y + 32 + big + 6} className={notable.verdict === "withheld" ? "fill-danger" : "fill-ink-2"} fontSize={8} fontWeight={700} letterSpacing={0.6}>
                {notable.verdict === "withheld" ? "WITHHELD" : "PARTLY"}
              </text>
              <Lines x={r.x + 32} y={r.y + 32 + big + 17} lines={wrapText(notable.claim, Math.max(16, chars - 5), row.lay.tight ? 1 : 2)} step={10.5} className="font-mono fill-ink-2" fontSize={8.6} />
            </g>
          )}
          {counts && !notable && row.ledgerLine && (
            <text x={r.x + 32} y={r.y + 32 + big + 10} className="fill-muted" fontSize={8.6}>
              {clip(laneText(row.ledgerLine.text, row.ledgerLine.label), chars)}
            </text>
          )}
          {row.stamps.map((s, i) => (
            <StampMark key={s.beat.id} x={r.x + Math.max(34, leftW - 128) - (row.stamps.length - 1 - i) * 10} y={r.y + r.h - 28 - (row.stamps.length - 1 - i) * 6} verdict={s.beat.verdict} count={s.count} fresh={s.fresh} faded={i < row.stamps.length - 1} />
          ))}
        </Pinned>
      </g>
      {row.tags.slice(0, tags.tags.length).map((tag, i) => {
        const tr = tags.tags[i];
        return tr ? <EvidenceTagCard key={tag.code} tag={tag} r={tr} fresh={row.freshTags.has(tag.code)} onTip={onTip} rival={row.label} pod={row.key} /> : null;
      })}
      {tags.more && (
        <g>
          <rect x={tags.more.x} y={tags.more.y} width={tags.more.w} height={tags.more.h} rx={1.2} fill="var(--cb-paper-2)" stroke="var(--cb-edge)" strokeWidth={0.6} />
          <text x={tags.more.x + tags.more.w / 2} y={tags.more.y + tags.more.h - 2.4} textAnchor="middle" className="font-mono fill-ink-2" fontSize={7.6} fontWeight={600}>
            +{tags.hidden} codes
          </text>
        </g>
      )}
    </g>
  );
}

function CountGlyph({ x, y, verdict, n, size }: { x: number; y: number; verdict: "supported" | "partly" | "withheld"; n: number; size: number }) {
  return (
    <g>
      <VerdictGlyph verdict={verdict} x={x} y={y + 2} size={size * 0.72} />
      <text key={n} x={x + size * 0.8} y={y + size * 0.84} className={cn("font-mono tabular animate-rise", verdict === "withheld" && n > 0 ? "fill-danger" : "fill-ink")} fontSize={size} fontWeight={700}>
        {n}
      </text>
    </g>
  );
}

function EvidenceTagCard({ tag, r, fresh, onTip, rival, pod }: { tag: EvidenceTag; r: Rect; fresh: boolean; onTip: OnTip; rival: string; pod: string }) {
  const tip = () => onTip({ kind: "tag", pod, code: tag.code, at: { x: r.x + r.w / 2, y: r.y - 3 } });
  return (
    <g
      role="img"
      tabIndex={0}
      aria-label={`${tag.code}, cited claim for ${shortName(rival)}: ${tag.text}. ${tag.verdict ? `S7 verdict: ${VERDICT_LABEL[tag.verdict]}.` : "No S7 verdict on this run's record."}`}
      onPointerEnter={tip}
      onPointerLeave={() => onTip(null)}
      onFocus={tip}
      onBlur={() => onTip(null)}
      className="outline-none focus-visible:[&_rect]:stroke-[var(--color-signal)]"
      data-cb-tag={tag.code}
    >
      <g className={fresh ? "animate-pin" : undefined}>
        <rect x={r.x + 0.8} y={r.y + 1.2} width={r.w} height={r.h} rx={1.2} fill={SHADOW} opacity={0.1} />
        <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={1.2} fill="var(--cb-paper)" stroke={tag.verdict === "withheld" ? "var(--color-danger)" : "var(--cb-edge)"} strokeWidth={0.7} />
        <text x={r.x + 3} y={r.y + r.h - 2.6} className="font-mono fill-ink" fontSize={Math.min(8.4, r.h - 2)} fontWeight={700}>
          {tag.code}
        </text>
        {tag.verdict && <VerdictGlyph verdict={tag.verdict} x={r.x + r.w - Math.min(9, r.h) - 1} y={r.y + (r.h - Math.min(9, r.h)) / 2} size={Math.min(9, r.h)} />}
      </g>
    </g>
  );
}

function memoRoute(view: SwarmView, m: SwarmItem): string {
  const who = (id: string) => (id === "board" ? "Board" : id === "red_team" ? "Red team" : id === "analyst" ? "Analyst" : ROLE_SHORT[view.cards[id]?.role ?? ""] ?? id);
  return `${who(m.from)} -> ${m.to.map(who).join(", ")}`;
}

function memoFocus(view: SwarmView, m: SwarmItem): Focus {
  const rs = recipients(view, m);
  return rs.length === 1 && rs[0] ? `edge:${edgeKey(m.from, rs[0])}` : `agent:${m.from}`;
}

function Memos({ row, view, focus, onFocus, onTip, dim }: { row: RowState; view: SwarmView; focus: Focus; onFocus: (f: Focus) => void; onTip: OnTip; dim: boolean }) {
  const r = row.lay.memo;
  const m = row.memos[0];
  if (!m) {
    return (
      <g aria-hidden className={cn(dim && "opacity-35")}>
        <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={1.6} fill="none" stroke="var(--cb-edge)" strokeWidth={0.8} strokeDasharray="3 2.4" />
        <text x={r.x + r.w / 2} y={r.y + r.h / 2 + 3} textAnchor="middle" className="fill-muted" fontSize={9}>
          memos are pinned here at S9
        </text>
      </g>
    );
  }
  const failed = m.state !== "completed";
  const behind = Math.min(3, row.memos.length - 1);
  const target = memoFocus(view, m);
  const on = focus === target;
  const latency = m.usage.latencyMs > 0 ? `${(m.usage.latencyMs / 1000).toFixed(1)} s` : "";
  const cost = m.usage.model ? (m.usage.free ? "free" : formatUsd(m.usage.costUsd)) : "";
  const body = wrapText(firstWords(m.text, 20), 40, row.lay.tight ? 2 : 3);
  const codes = new Set(m.citations.map((c) => c.code)).size;
  const label = `${memoRoute(view, m).replace(" -> ", " to ")}, ${KIND_LABEL[m.kind].toLowerCase()}, round ${m.round}: ${firstWords(m.text, 12)}. Show this conversation.`;
  const select = () => onFocus(toggle(focus, target));
  const tip = () => onTip({ kind: "memo", msgId: m.messageId, at: { x: r.x + r.w / 2, y: r.y + r.h + 4 } });
  return (
    <g className={cn("transition-opacity duration-[var(--duration-base)]", dim && "opacity-35")} data-cb-memos={row.key}>
      {Array.from({ length: behind }, (_, k) => {
        const d = (behind - k) * 4;
        return <Pinned key={`edge-${k}`} id={`memo-edge:${row.key}:${k}`} r={{ x: r.x - d, y: r.y - d, w: r.w, h: r.h }} />;
      })}
      <g
        role="button"
        tabIndex={0}
        aria-pressed={on}
        aria-label={label}
        onClick={select}
        onKeyDown={activate(select)}
        onPointerEnter={tip}
        onPointerLeave={() => onTip(null)}
        onFocus={tip}
        onBlur={() => onTip(null)}
        className="cursor-pointer outline-none"
      >
        <Pinned key={m.messageId} id={`memo:${m.messageId}`} r={r} angle={failed ? 6 : undefined} fresh={row.memoFresh} pin={`var(--color-team-${row.team})`} stroke={on ? "var(--color-signal)" : undefined}>
          {on && <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={1.6} fill="none" stroke="var(--color-signal)" strokeWidth={2} />}
          <text x={r.x + 8} y={r.y + 13} className="font-mono fill-muted" fontSize={8.2} fontWeight={700} letterSpacing={0.6}>
            {`R${m.round} ${KIND_LABEL[m.kind].toUpperCase()}`}
          </text>
          <text x={r.x + r.w - 8} y={r.y + 13} textAnchor="end" className="font-mono fill-muted tabular" fontSize={8.2}>
            {[latency, cost].filter(Boolean).join(", ")}
          </text>
          <line x1={r.x + 6} y1={r.y + 17} x2={r.x + r.w - 6} y2={r.y + 17} stroke="var(--cb-rule)" strokeWidth={0.8} />
          <text x={r.x + 8} y={r.y + 29} className="fill-ink" fontSize={10.2} fontWeight={600}>
            {clip(memoRoute(view, m), 38)}
          </text>
          <Lines x={r.x + 8} y={r.y + 42} lines={body} step={12} className="fill-ink-2" fontSize={9.8} />
          {codes > EVIDENCE_PER_MEMO && (
            <text x={r.x + r.w - 8} y={r.y + r.h - 5} textAnchor="end" className="font-mono fill-accent" fontSize={7.6} fontWeight={700}>
              +{codes - EVIDENCE_PER_MEMO} cited
            </text>
          )}
          {failed && (
            <g transform={`rotate(-9 ${r.x + r.w / 2} ${r.y + r.h / 2})`}>
              <rect x={r.x + r.w / 2 - 62} y={r.y + r.h / 2 - 11} width={124} height={22} rx={2} fill="none" stroke="var(--color-danger)" strokeWidth={1.6} />
              <text x={r.x + r.w / 2} y={r.y + r.h / 2 + 4.5} textAnchor="middle" className="font-mono fill-danger" fontSize={11.5} fontWeight={700} letterSpacing={0.8}>
                {m.state === "rejected" ? "NOT RUN: BUDGET" : "NO VALID REPLY"}
              </text>
            </g>
          )}
        </Pinned>
      </g>
      {row.memos.length > 1 && (
        <g aria-hidden>
          <Tape r={{ x: r.x + r.w - 50, y: r.y + r.h - 4, w: 46, h: 11 }}>
            <text x={r.x + r.w - 27} y={r.y + r.h + 4} textAnchor="middle" className="font-mono" fontSize={7.6} fontWeight={700} fill="var(--cb-tape-text)">
              {row.memos.length} MEMOS
            </text>
          </Tape>
        </g>
      )}
    </g>
  );
}

function Slot({ row, dim, reduced, board }: { row: RowState; dim: boolean; reduced: boolean; board: BoardResult | null }) {
  const r = row.lay.slot;
  const s = row.slot;
  const ref = useRef<SVGGElement>(null);
  const fx = s?.from?.x;
  const fy = s?.from?.y;
  const order = s?.order ?? 0;
  const travel = useMemo(
    () => (row.slotFresh && !reduced && fx !== undefined && fy !== undefined ? { dx: fx - r.x, dy: fy - r.y, delay: order * 150 } : null),
    [row.slotFresh, reduced, fx, fy, r.x, r.y, order],
  );
  useEffect(() => {
    const el = ref.current;
    if (!el || !travel || typeof el.animate !== "function") return;
    const a = el.animate([{ transform: `translate(${travel.dx}px, ${travel.dy}px)`, opacity: 0.85 }, { transform: "translate(0px, 0px)", opacity: 1 }], {
      duration: 600,
      delay: travel.delay,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      fill: "backwards",
    });
    return () => a.cancel();
  }, [travel]);
  if (!s) {
    return (
      <g aria-hidden className={cn(dim && "opacity-35")}>
        <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={1.6} fill="none" stroke="var(--cb-edge)" strokeWidth={0.8} strokeDasharray="3 2.4" />
        <text x={r.x + r.w / 2} y={r.y + r.h / 2 + 3} textAnchor="middle" className="fill-muted" fontSize={8.6}>
          {board ? "not on the board" : "board slot"}
        </text>
      </g>
    );
  }
  const label = s.notScored ? `${row.label}: not scored by the board` : `${row.label} was offeror ${s.code}: simulated share ${Math.round(s.share * 100)}%`;
  return (
    <g ref={ref} role="img" tabIndex={0} aria-label={label} className={cn("outline-none", dim && "opacity-35")}>
      <Pinned id={`slot:${row.key}`} r={r} pin={`var(--color-team-${row.team})`}>
        <rect x={r.x} y={r.y} width={r.w} height={12} fill={`color-mix(in oklab, var(--color-team-${row.team}) 78%, var(--cb-paper))`} />
        <text x={r.x + r.w / 2} y={r.y + 9} textAnchor="middle" className="fill-ink" fontSize={7.4} fontWeight={700} letterSpacing={0.5}>
          {s.notScored ? "NOT SCORED" : `OFFEROR ${s.code}`}
        </text>
        {!s.notScored && (
          <>
            <text x={r.x + r.w / 2} y={r.y + r.h / 2 + 7} textAnchor="middle" className="font-mono fill-ink tabular" fontSize={row.lay.compact ? 19 : 22} fontWeight={700}>
              {Math.round(s.share * 100)}%
            </text>
            <text x={r.x + r.w / 2} y={r.y + r.h / 2 + 20} textAnchor="middle" className="fill-muted" fontSize={8.2}>
              sim. share
            </text>
          </>
        )}
      </Pinned>
      <title>{label}</title>
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ the jury */

const EVAL_SHORT: Record<string, string> = { technical: "TECH", management: "MGMT", past_performance: "PAST PERF" };

function Jury({ S, L, focus, onFocus, onTip, stats }: { S: BoardState; L: BoardLayout; focus: Focus; onFocus: (f: Focus) => void; onTip: OnTip; stats: ReturnType<typeof nodeStats> }) {
  const h = L.jury.header;
  const on = focus === "board";
  const dim = focus !== "all" && focus !== "board" && !focus.includes("board.");
  const select = () => onFocus(toggle(focus, "board"));
  const unmasked = S.board !== null;
  return (
    <g className={cn("transition-opacity duration-[var(--duration-base)]", dim && "opacity-35")}>
      <g role="button" tabIndex={0} aria-pressed={on} aria-label={`Evaluation board, de-identified.${unmasked ? " Simulated board, not a forecast." : ""} Show the board's messages.`} onClick={select} onKeyDown={activate(select)} className="cursor-pointer outline-none">
        <Pinned id="jury" r={h} pin="var(--color-office-board)" angle={0.4} stroke={on ? "var(--color-signal)" : undefined}>
          {on && <rect x={h.x} y={h.y} width={h.w} height={h.h} rx={1.6} fill="none" stroke="var(--color-signal)" strokeWidth={2} />}
          <text x={h.x + 10} y={h.y + 15} className="fill-ink" fontSize={11} fontWeight={700}>
            Evaluation board
          </text>
          <text x={h.x + 10} y={h.y + 26} className="fill-muted" fontSize={8.6}>
            de-identified: names masked, coded offerors
          </text>
          {unmasked && (
            <text key="caveat" x={h.x + 10} y={h.y + 36} className="fill-ink animate-rise" fontSize={8.4} fontWeight={700}>
              Simulated board, not a forecast.
            </text>
          )}
        </Pinned>
      </g>
      {S.evaluators.map((ev, i) => {
        const r = L.jury.evaluators[i];
        const sheet = L.jury.sheets[i];
        if (!r || !sheet) return null;
        const short = EVAL_SHORT[ev.card?.name.split(", ").at(-1)?.replace(/ /g, "_") ?? ""] ?? CAPTION.evaluator;
        const ratings = ev.agentId ? S.ratings[ev.agentId] : undefined;
        const evOn = ev.agentId !== null && focus === `agent:${ev.agentId}`;
        const st = ev.agentId ? stats[ev.agentId] : undefined;
        return (
          <g key={ev.seatId}>
            <Polaroid
              r={r}
              role="evaluator"
              team={-1}
              state={ev.state}
              caption={ev.state.workingMs !== null ? `${Math.floor(ev.state.workingMs / 1000)} s` : short}
              fresh={ev.fresh}
              focused={evOn}
              interactive={ev.card !== undefined}
              label={`${ev.card?.name ?? "Evaluator"}.${st ? ` ${st.sent} sent.` : ""}${ev.card ? " Show this evaluator's messages." : ""}`}
              pin="var(--color-office-board)"
              onActivate={() => ev.agentId && onFocus(toggle(focus, `agent:${ev.agentId}`))}
              onHover={(hov) => (hov && ev.card && ev.agentId ? onTip({ kind: "agent", agentId: ev.agentId, rival: false, at: { x: r.x - 4, y: r.y + r.h / 2 } }) : onTip(null))}
            />
            {ratings && (
              <Pinned key={`sheet-${ev.agentId}`} id={`sheet:${ev.agentId}`} r={sheet} fresh={S.juryMemos.some((m) => m.from === ev.agentId) && ev.fresh === false && S.t !== Infinity && isSheetFresh(S, ev.agentId)} pin="var(--color-office-board)">
                <text x={sheet.x + 6} y={sheet.y + 14} className="fill-muted" fontSize={7} fontWeight={700} letterSpacing={0.6}>
                  RATINGS
                </text>
                <Lines x={sheet.x + 8} y={sheet.y + 27} lines={Object.entries(ratings).sort(([a], [b]) => a.localeCompare(b)).map(([c, v]) => `${c}  ${v}`)} step={9.8} className="font-mono fill-ink tabular" fontSize={9.4} fontWeight={600} />
              </Pinned>
            )}
          </g>
        );
      })}
      {S.codes.map((code, i) => {
        const r = S.codeRects[i];
        if (!r) return null;
        const row = S.board ? S.rows.find((x) => x.slot?.code === code) : undefined;
        const raters = S.evaluators.map((ev) => (ev.agentId ? S.ratings[ev.agentId]?.[code] : undefined));
        const cOn = focus === "board";
        return (
          <g key={code} role="button" tabIndex={0} aria-pressed={cOn} aria-label={`Offeror ${code}: ratings ${raters.filter((v) => v !== undefined).join(", ") || "none yet"}.${row ? ` Unmasked: ${row.label}.` : ""} Show the board's messages.`} onClick={select} onKeyDown={activate(select)} className="cursor-pointer outline-none" opacity={row ? 0.5 : 1}>
            <Pinned id={`code:${code}`} r={r} pin="var(--color-office-board)">
              <text x={r.x + 10} y={r.y + r.h / 2 + 4.5} className="fill-ink" fontSize={12} fontWeight={700}>
                Offeror {code}
              </text>
              {raters.map((v, k) => (
                <g key={k}>
                  <circle cx={r.x + r.w - 46 + k * 15} cy={r.y + r.h / 2} r={5.6} fill={v !== undefined ? "var(--cb-tape)" : "none"} stroke="var(--cb-edge)" strokeWidth={0.8} />
                  {v !== undefined && (
                    <text x={r.x + r.w - 46 + k * 15} y={r.y + r.h / 2 + 3} textAnchor="middle" className="font-mono" fontSize={7.6} fontWeight={700} fill="var(--cb-tape-text)">
                      {v}
                    </text>
                  )}
                </g>
              ))}
              {row && (
                <text x={r.x + 10} y={r.y + r.h - 4} className="fill-ink-2" fontSize={7.4} fontWeight={600}>
                  {clip(shortName(row.label), 24)}
                </text>
              )}
            </Pinned>
          </g>
        );
      })}
    </g>
  );
}

function isSheetFresh(S: BoardState, agentId: string | null): boolean {
  void S;
  void agentId;
  return false;
}

/* ------------------------------------------------------------------------------------------------ the desks */

function Desks({ S, L, focus, onFocus, onTip }: { S: BoardState; L: BoardLayout; focus: Focus; onFocus: (f: Focus) => void; onTip: OnTip }) {
  const f = L.footer;
  const latestChallenge = S.challenges.at(-1);
  const latestInterview = S.interviews.at(-1);
  const qa = interviewOf(latestInterview)[0];
  const rivalOf = (m: SwarmItem | undefined) => (m ? (S.rows.find((r) => r.groupId === m.contextId)?.label ?? m.contextId) : "");
  const withheld = S.interviews.reduce((n, m) => n + interviewOf(m).reduce((k, q) => k + q.withheld, 0), 0);
  const redOn = S.red.agentId !== null && focus === `agent:${S.red.agentId}`;
  const anOn = S.analyst.agentId !== null && focus === `agent:${S.analyst.agentId}`;
  const desk = (who: "red" | "analyst") => {
    const s = who === "red" ? S.red : S.analyst;
    return () => s.agentId && onFocus(toggle(focus, `agent:${s.agentId}`));
  };
  const deskDim = (agentId: string | null) => focus !== "all" && !(agentId && (focus === `agent:${agentId}` || focus.includes(agentId)));
  const t = S.tally.total;
  return (
    <g>
      {/* red team */}
      <g
        role={S.red.card ? "button" : "img"}
        tabIndex={0}
        aria-label={`Red-team challenger: ${S.challenges.length} challenges sent.${latestChallenge ? ` Latest: ${firstWords(latestChallenge.text, 12)}` : ""}${S.red.card ? " Show its messages." : ""}`}
        {...(S.red.card ? { "aria-pressed": redOn, onClick: desk("red"), onKeyDown: activate(desk("red")) } : {})}
        onPointerEnter={() => S.red.card && S.red.agentId && onTip({ kind: "agent", agentId: S.red.agentId, rival: false, at: { x: f.red.x + f.red.w / 2, y: f.red.y - 6 } })}
        onPointerLeave={() => onTip(null)}
        className={cn("outline-none transition-opacity duration-[var(--duration-base)]", S.red.card && "cursor-pointer", deskDim(S.red.agentId) && "opacity-35")}
      >
        <Pinned id="desk:red" r={f.red} pin="var(--color-office-red)" angle={-0.5} stroke={redOn ? "var(--color-signal)" : undefined}>
          {redOn && <rect x={f.red.x} y={f.red.y} width={f.red.w} height={f.red.h} rx={1.6} fill="none" stroke="var(--color-signal)" strokeWidth={2} />}
          <DeskPhoto x={f.red.x + 10} y={f.red.y + 12} role="red_team" s={S.red} />
          <text x={f.red.x + 64} y={f.red.y + 22} className="fill-ink" fontSize={11.5} fontWeight={700}>
            Red-team challenger
          </text>
          <text x={f.red.x + 64} y={f.red.y + 35} className="font-mono fill-ink-2 tabular" fontSize={9.5}>
            {S.challenges.length} {S.challenges.length === 1 ? "challenge" : "challenges"} sent{latestChallenge ? `, latest to ${shortName(rivalOf(latestChallenge))}` : ""}
          </text>
          {latestChallenge ? (
            <Lines key={latestChallenge.messageId} x={f.red.x + 64} y={f.red.y + 50} lines={wrapText(firstWords(latestChallenge.text, 16), 44, 3)} step={11.5} className="fill-ink-2 animate-rise" fontSize={9.4} />
          ) : (
            <text x={f.red.x + 64} y={f.red.y + 52} className="fill-muted" fontSize={9}>
              Challenges every rival in S9 round 2.
            </text>
          )}
        </Pinned>
      </g>

      {/* verifier */}
      <g role="img" tabIndex={0} aria-label={`Verifier, S7 claim checks: ${t.supported} supported, ${t.partly} partly, ${t.withheld} withheld${S.tally.unattributed ? `, ${S.tally.unattributed} unattributed` : ""}.`} className={cn("outline-none", focus !== "all" && "opacity-35")}>
        <Pinned id="desk:verify" r={f.verifier} pin="var(--color-office-verify)" angle={0.3}>
          <DeskPhoto x={f.verifier.x + 10} y={f.verifier.y + 12} role="verifier" s={null} />
          <text x={f.verifier.x + 64} y={f.verifier.y + 22} className="fill-ink" fontSize={11.5} fontWeight={700}>
            Verifier
          </text>
          <text x={f.verifier.x + 64} y={f.verifier.y + 35} className="fill-muted" fontSize={9}>
            S7: every claim checked against its source
          </text>
          <CountGlyph x={f.verifier.x + 64} y={f.verifier.y + 44} verdict="supported" n={t.supported} size={17} />
          <CountGlyph x={f.verifier.x + 132} y={f.verifier.y + 44} verdict="partly" n={t.partly} size={17} />
          <CountGlyph x={f.verifier.x + 190} y={f.verifier.y + 44} verdict="withheld" n={t.withheld} size={17} />
          {S.tally.unattributed > 0 && (
            <text x={f.verifier.x + 64} y={f.verifier.y + f.verifier.h - 6} className="font-mono fill-muted" fontSize={8.4}>
              unattributed {S.tally.unattributed}
            </text>
          )}
          <g transform={`translate(${f.verifier.x + f.verifier.w - 34} ${f.verifier.y + f.verifier.h - 18})`} aria-hidden>
            <rect x={-16} y={4} width={32} height={6} rx={1.5} fill="var(--color-office-device)" opacity={0.25} />
            <g key={S.stamping ? `down-${S.t}` : "rest"} className={cn("office-stamp-arm", S.stamping && "is-down")}>
              <rect x={-4} y={-22} width={8} height={12} rx={2.5} fill="var(--color-office-device)" />
              <rect x={-9} y={-10} width={18} height={6} rx={1.5} fill="var(--cb-tape)" />
            </g>
          </g>
        </Pinned>
      </g>

      {/* home analyst */}
      <g
        role={S.analyst.card ? "button" : "img"}
        tabIndex={0}
        aria-label={`Home-team analyst: interviews ${S.interviews.length}.${qa ? ` Latest question: ${qa.question}` : ""}${S.analyst.card ? " Show its messages." : ""}`}
        {...(S.analyst.card ? { "aria-pressed": anOn, onClick: desk("analyst"), onKeyDown: activate(desk("analyst")) } : {})}
        onPointerEnter={() => S.analyst.card && S.analyst.agentId && onTip({ kind: "agent", agentId: S.analyst.agentId, rival: false, at: { x: f.analyst.x + f.analyst.w / 2, y: f.analyst.y - 6 } })}
        onPointerLeave={() => onTip(null)}
        className={cn("outline-none transition-opacity duration-[var(--duration-base)]", S.analyst.card && "cursor-pointer", deskDim(S.analyst.agentId) && "opacity-35")}
      >
        <Pinned id="desk:analyst" r={f.analyst} pin="var(--color-office-home)" angle={0.5} stroke={anOn ? "var(--color-signal)" : undefined}>
          {anOn && <rect x={f.analyst.x} y={f.analyst.y} width={f.analyst.w} height={f.analyst.h} rx={1.6} fill="none" stroke="var(--color-signal)" strokeWidth={2} />}
          <DeskPhoto x={f.analyst.x + 10} y={f.analyst.y + 12} role="analyst" s={S.analyst} />
          <text x={f.analyst.x + 64} y={f.analyst.y + 22} className="fill-ink" fontSize={11.5} fontWeight={700}>
            Home-team analyst
          </text>
          <text x={f.analyst.x + 64} y={f.analyst.y + 35} className="font-mono fill-ink-2 tabular" fontSize={9.5}>
            Interviews: {S.interviews.length}
            {withheld > 0 ? `, ${withheld} statements withheld` : ""}
          </text>
          {qa && latestInterview ? (
            <g key={latestInterview.messageId} className="animate-rise">
              <text x={f.analyst.x + 64} y={f.analyst.y + 50} className="fill-ink" fontSize={9.6} fontWeight={600}>
                {clip(`Q: ${qa.question}`, 64)}
              </text>
              <Lines
                x={f.analyst.x + 64}
                y={f.analyst.y + 63}
                lines={wrapText(`${shortName(rivalOf(latestInterview))}: ${qa.statements[0]?.text ?? "(no statement survived the citation check)"}`, 64, 2)}
                step={11.5}
                className="fill-ink-2"
                fontSize={9.4}
              />
            </g>
          ) : (
            <text x={f.analyst.x + 64} y={f.analyst.y + 52} className="fill-muted" fontSize={9}>
              Interviews each rival&apos;s capture lead in S9 round 3.
            </text>
          )}
        </Pinned>
      </g>

      {/* incidents */}
      <g role="img" tabIndex={0} aria-label={S.errors.length ? `Incidents: ${S.errors.map((e) => `${e.code} at ${formatTime(e.ts)}`).join("; ")}` : "Incidents: none recorded."} className="outline-none">
        <Pinned id="desk:incidents" r={f.incidents} pin="var(--color-office-board)" angle={-0.4}>
          <text x={f.incidents.x + 10} y={f.incidents.y + 18} className="fill-muted" fontSize={8.6} fontWeight={700} letterSpacing={1.2}>
            INCIDENTS
          </text>
          {S.errors.length === 0 ? (
            <text x={f.incidents.x + 10} y={f.incidents.y + 36} className="fill-muted" fontSize={9.5}>
              None recorded.
            </text>
          ) : (
            S.errors.slice(-2).map((e, i) => (
              <g key={e.seq} className={S.freshError(e) ? "animate-pin" : undefined}>
                <rect x={f.incidents.x + 8} y={f.incidents.y + 26 + i * 28} width={f.incidents.w - 16} height={24} rx={1.2} fill="var(--cb-paper-2)" stroke="var(--color-danger)" strokeWidth={0.8} />
                <rect x={f.incidents.x + 8} y={f.incidents.y + 26 + i * 28} width={5} height={24} fill="var(--color-danger)" />
                <text x={f.incidents.x + 18} y={f.incidents.y + 37 + i * 28} className="font-mono fill-danger" fontSize={8.6} fontWeight={700}>
                  {clip(e.code, 22)}
                </text>
                <text x={f.incidents.x + 18} y={f.incidents.y + 47 + i * 28} className="font-mono fill-ink-2 tabular" fontSize={8}>
                  {formatWall(e.ts)}
                </text>
              </g>
            ))
          )}
        </Pinned>
      </g>
    </g>
  );
}

function DeskPhoto({ x, y, role, s }: { x: number; y: number; role: Role; s: SeatInfo | null }) {
  const working = s?.state.workingMs !== null && s?.state.workingMs !== undefined;
  return (
    <g>
      {working && <rect x={x - 2.5} y={y - 2.5} width={49} height={61} rx={2.5} fill="var(--color-signal)" opacity={0.2} />}
      <rect x={x} y={y} width={44} height={56} rx={1.4} fill="var(--cb-paper)" stroke={working ? "var(--color-signal)" : "var(--cb-edge)"} strokeWidth={working ? 1.5 : 0.75} />
      <rect x={x + 3} y={y + 3} width={38} height={38} fill="var(--cb-paper-2)" />
      <g transform={`translate(${x + 22} ${y + 40.5})`}>
        <AvatarBadgeInline role={role} />
      </g>
      <text x={x + 22} y={y + 51.5} textAnchor="middle" className={cn("font-mono", working ? "fill-accent" : "fill-muted")} fontSize={6.6} fontWeight={working ? 700 : 500}>
        {working && s?.state.workingMs !== null && s?.state.workingMs !== undefined ? `${Math.floor(s.state.workingMs / 1000)} s` : CAPTION[role]}
      </text>
      {working && (
        <g className="office-agent" data-activity="typing" aria-hidden>
          <g className="office-dots" fill="var(--color-accent)">
            <circle cx={x + 18} cy={y - 5} r={1.5} />
            <circle cx={x + 22} cy={y - 5} r={1.5} />
            <circle cx={x + 26} cy={y - 5} r={1.5} />
          </g>
        </g>
      )}
    </g>
  );
}

/** A role's companion character, static, centred on its feet (the desks are not seats on a floor). */
function AvatarBadgeInline({ role }: { role: Role }) {
  return (
    <g transform="scale(1.0)">
      <foreignObject x={-18} y={-38} width={36} height={40} aria-hidden>
        <AvatarBadge role={role} team={-1} size={36} />
      </foreignObject>
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ threads */

function Threads({ S, L, view, focus, reduced }: { S: BoardState; L: BoardLayout; view: SwarmView; focus: Focus; reduced: boolean }) {
  const rowOf = new Map(S.rows.map((r) => [r.groupId, r]));
  const agentPin = (agentId: string): Pt | null => {
    if (agentId === S.red.agentId) return { x: L.footer.red.x + L.footer.red.w / 2, y: L.footer.red.y + 4.5 };
    if (agentId === S.analyst.agentId) return { x: L.footer.analyst.x + L.footer.analyst.w / 2, y: L.footer.analyst.y + 4.5 };
    const card = view.cards[agentId];
    const row = card ? rowOf.get(card.group) : undefined;
    const role = card ? (CREW_ROLES as readonly string[]).includes(card.role) : false;
    if (!row || !card || !role) return null;
    const r = row.lay.crew[card.role as CrewRole];
    return { x: r.x + r.w / 2, y: r.y + 2.2 };
  };
  const juryPin = pinOf(L.jury.header);
  // one string per (row, kind, target): the strongest emphasis wins, so repeated messages never pile up opacity
  const strongest = new Map<string, { th: Thread; emph: "active" | "current" | "past" }>();
  const rank = { active: 3, current: 2, past: 1 } as const;
  for (const th of S.threads) {
    const emph = roundEmphasis(th.active, th.round, S.round);
    const k = `${th.row}|${th.kind}|${JSON.stringify(th.to)}`;
    const cur = strongest.get(k);
    if (!cur || rank[emph] > rank[cur.emph]) strongest.set(k, { th, emph });
  }
  const paths: ReactNode[] = [];
  for (const [k, { th, emph }] of strongest) {
    const row = rowOf.get(th.row);
    if (!row) continue;
    const a = pinOf(row.lay.memo);
    let b: Pt | null = null;
    if (th.to.kind === "jury") b = juryPin;
    else if (th.to.kind === "agent") b = agentPin(th.to.agentId);
    else {
      const to = th.to;
      const tr = tagRects(row.lay.ledger, row.tags.length);
      const i = row.tags.findIndex((x) => x.code === to.code);
      const rr = i >= 0 && i < tr.tags.length ? tr.tags[i] : tr.more;
      b = rr ? { x: rr.x + rr.w, y: rr.y + rr.h / 2 } : null;
    }
    if (!b) continue;
    const msg = view.messages.find((m) => m.messageId === th.msgId);
    const inFocus = threadInFocus(focus, th, msg, view, row);
    const base = emph === "active" ? 1 : emph === "current" ? 0.42 : 0.14;
    const opacity = focus === "all" ? base : inFocus ? Math.max(base, 0.85) : 0.06;
    paths.push(
      <g key={k} opacity={opacity} className="transition-opacity duration-[var(--duration-base)]">
        <g key={emph === "active" ? `on-${th.msgId}` : "rest"} className={emph === "active" && !reduced ? "animate-pin" : undefined}>
          <path d={threadPath(a, b)} fill="none" stroke={th.kind === "route" ? "var(--cb-thread)" : "var(--cb-string)"} strokeWidth={emph === "active" ? 1.8 : 1.4} strokeLinecap="round" />
        </g>
      </g>,
    );
  }
  return (
    <g className="pointer-events-none" aria-hidden data-cb-threads={paths.length}>
      {paths}
    </g>
  );
}

function threadInFocus(focus: Focus, th: Thread, m: SwarmItem | undefined, view: SwarmView, row: RowState): boolean {
  if (focus === "all") return true;
  if (focus === "board") return th.to.kind === "jury";
  if (!m) return false;
  if (focus.startsWith("agent:")) {
    const id = focus.slice(6);
    return m.from === id || recipients(view, m).includes(id);
  }
  if (focus.startsWith("edge:")) {
    const key = focus.slice(5);
    return recipients(view, m).some((r) => edgeKey(m.from, r) === key);
  }
  return row.groupId === focus;
}

/* ------------------------------------------------------------------------------------------------ chrome */

function Caption({ S, live, replaying, done }: { S: BoardState; live: boolean; replaying: boolean; done: boolean }) {
  const lines: string[] = [];
  for (const row of S.rows) {
    const name = shortName(row.label);
    for (const role of CREW_ROLES) {
      const s = row.crew[role];
      if (s.state.workingMs !== null) lines.push(`${name} ${ROLE_NAME[CREW_SEAT_ROLE[role]].toLowerCase()}: model call, ${Math.floor(s.state.workingMs / 1000)} s`);
      else if (s.state.field) lines.push(`${name} researcher: GET ${row.fetch.cards[0]?.host ?? "sources"}`);
    }
    const st = row.stamps.at(-1);
    if (st && st.beat.start <= S.t && S.t < st.beat.last + 600) lines.push(`Verifier: ${st.count} ${VERDICT_LABEL[st.beat.verdict]} for ${name}`);
  }
  for (const m of S.threads.filter((x) => x.active && x.kind === "route")) {
    const row = S.rows.find((r) => r.groupId === m.row);
    lines.push(`Memo pinned for ${row ? shortName(row.label) : "the board"}`);
    break;
  }
  const quiet = live
    ? S.running
      ? `Stage ${S.running.slice(1).padStart(2, "0")} is running; nothing new to pin yet.`
      : "Waiting for the next event."
    : replaying && !done
      ? "Between events."
      : finalWords(S);
  return (
    <p className="line-clamp-2 min-h-10 min-w-0 flex-1 text-sm text-ink-2" aria-live="off">
      <span className="mr-2 font-semibold text-ink">{live ? "Live" : replaying && !done ? "Replay" : "Final state"}</span>
      {lines.length ? lines.slice(0, 3).join("; ") + (lines.length > 3 ? `; and ${lines.length - 3} more` : "") : quiet}
    </p>
  );
}

function finalWords(S: BoardState): string {
  const fetched = S.rows.reduce((n, r) => n + r.fetch.counts.total, 0);
  const ok = S.rows.reduce((n, r) => n + r.fetch.counts.ok, 0);
  const t = S.tally.total;
  const parts: string[] = [];
  if (fetched) parts.push(`${ok} of ${fetched} sources read`);
  if (t.supported + t.partly + t.withheld) parts.push(`${t.supported} claims held up, ${t.withheld} withheld`);
  if (S.sentCount) parts.push(`${S.sentCount} memos`);
  if (S.board) parts.push("the board scored");
  return parts.length ? `${parts.join(", ")}.` : "No recorded activity yet.";
}

/** Milestones for screen readers: a stage starting, a hold and its end, the board's result; at most one every 2 s. */
function Milestones({ S, active }: { S: BoardState; active: boolean }) {
  const message = !active
    ? ""
    : S.board
      ? "The board has scored; codenames unmasked."
      : S.gates.H2.state === "waiting"
        ? "The run is waiting at H2, the decision."
        : S.gates.H1.state === "waiting"
          ? "The run is waiting at H1, plan approval."
          : S.running
            ? `${S.running} ${STAGE_NAME[S.running] ?? ""} started.`
            : "";
  const [said, setSaid] = useState({ text: "", at: 0 });
  useEffect(() => {
    if (!message || message === said.text) return;
    const wait = Math.max(0, said.at + MILESTONE_GAP_MS - Date.now());
    const h = window.setTimeout(() => setSaid({ text: message, at: Date.now() }), wait);
    return () => window.clearTimeout(h);
  }, [message, said]);
  return (
    <p className="sr-only" aria-live="polite">
      {said.text}
    </p>
  );
}

function Legend({ S }: { S: BoardState }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-hairline px-4 py-2.5 text-xs text-ink-2">
      <span className="flex items-center gap-1.5">
        <svg width={26} height={10} aria-hidden>
          <path d="M1 3 Q13 9 25 3" fill="none" stroke="var(--color-ink-2)" strokeWidth={1.6} />
        </svg>
        <span>
          <span className="font-medium text-ink">Ink thread</span> a message&apos;s route
        </span>
      </span>
      <span className="flex items-center gap-1.5">
        <svg width={26} height={10} aria-hidden>
          <path d="M1 3 Q13 9 25 3" fill="none" stroke="var(--color-signal)" strokeWidth={1.6} />
        </svg>
        <span>
          <span className="font-medium text-ink">Orange thread</span> an evidence code it cites
        </span>
      </span>
      <span className="flex items-center gap-1.5">
        <SealCheck size={14} weight="fill" aria-hidden className="text-ink" /> Supported
      </span>
      <span className="flex items-center gap-1.5">
        <Warning size={14} weight="bold" aria-hidden className="text-ink-2" /> Partly
      </span>
      <span className="flex items-center gap-1.5">
        <EyeSlash size={14} weight="bold" aria-hidden className="text-danger" /> Withheld
      </span>
      <span className="text-muted">A plain tag: no S7 verdict on this run&apos;s record.</span>
      {S.rows.length > 0 && (
        <ul className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="Team colours">
          {S.rows.map((r) => (
            <li key={r.key} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full" style={{ background: teamColour(r.team) }} />
              {shortName(r.label)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TipCard({ tip, view, stats }: { tip: TipState; view: SwarmView; stats: ReturnType<typeof nodeStats> }) {
  const right = tip.at.x > VIEW_W * 0.62;
  const below = tip.at.y < VIEW_H * 0.3;
  const style = { left: `${(tip.at.x / VIEW_W) * 100}%`, top: `${(tip.at.y / VIEW_H) * 100}%` };
  return (
    <div role="tooltip" className={cn("pointer-events-none absolute z-[var(--z-tooltip)] w-72 animate-fade-in", right ? "-translate-x-full" : "", below ? "" : "-translate-y-full")} style={style}>
      {tip.kind === "agent" ? (
        <AgentCardTip card={tip.card} rival={tip.rival} stats={stats[tip.card.agentId]} />
      ) : tip.kind === "memo" ? (
        <MemoTip m={tip.m} view={view} />
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

function MemoTip({ m, view }: { m: SwarmItem; view: SwarmView }) {
  return (
    <div className="rounded-lg border border-hairline-strong bg-canvas px-3 py-2.5 text-xs shadow-md">
      <div className="text-sm font-semibold text-ink">{memoRoute(view, m).replace(" -> ", " to ")}</div>
      <div className="mt-0.5 font-mono text-micro text-muted">
        Round {m.round}, {KIND_LABEL[m.kind].toLowerCase()}
        {m.usage.latencyMs > 0 ? `, ${(m.usage.latencyMs / 1000).toFixed(1)} s model time` : ""}
        {m.usage.model ? `, ${m.usage.free ? "free tier" : formatUsd(m.usage.costUsd)}` : ""}
      </div>
      <p className="mt-1.5 text-ink-2">{firstWords(m.text, 60)}</p>
      {m.reasoning && (
        <p className="mt-1.5 text-muted">
          <span className="font-medium text-ink-2">The agent&apos;s own summary: </span>
          <span className="italic">{firstWords(m.reasoning, 40)}</span>
        </p>
      )}
      {m.citations.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 font-mono text-micro text-ink-2">
          {m.citations.slice(0, 6).map((c) => (
            <li key={c.claimId}>
              <span className="font-semibold text-ink">{c.code}</span>: {clip(c.text, 90)}
            </li>
          ))}
          {m.citations.length > 6 && <li className="text-muted">and {m.citations.length - 6} more in the thread</li>}
        </ul>
      )}
    </div>
  );
}
