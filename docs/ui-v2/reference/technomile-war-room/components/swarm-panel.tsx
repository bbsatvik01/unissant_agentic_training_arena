"use client";

import { ArrowRight, X } from "@phosphor-icons/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Pill } from "@/components/ui/pill";
import { Segmented } from "@/components/ui/segmented";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import type { AgentCitation, BoardResult, RunEventEnvelope } from "@/lib/contracts/run-events";
import { approvalsOf, type Approvals } from "@/lib/pipeline/rail";
import type { OfficeRecord } from "@/lib/war-room/office";
import { officeHasScene as hasOfficeScene } from "@/lib/war-room/scene";
import { ACTIVE_RUN_STATES } from "@/lib/war-room/state";
import { agentName, formatUsd, KIND_LABEL, ROUND_LABEL, shortName, type SwarmItem, type SwarmView } from "@/lib/war-room/swarm";
import { filterThread, replayOrder, ROUND_SHORT, roundAt, type Focus } from "@/lib/war-room/swarm-graph";

import type { OfficeDrive, OfficeLive, OfficeReplay } from "./agent-office";
import { CLASSIC_STYLE, OfficeStage, OfficeStyleSwitch, useOfficeStyle } from "./office-stage";
import { RoleIcon } from "./roles";
import { useRunFeed } from "./run-feed";
import { loadSwarmGraphView, SwarmGraphView } from "./swarm-graph";
import type { GraphReplay } from "./swarm-graph-view";
import type { ReplayView } from "./use-run-replay";
import { useOfficeFeed } from "./use-office-feed";
import { useSwarm } from "./use-swarm";

export { RoleIcon } from "./roles";
export { shortName } from "@/lib/war-room/swarm";

/**
 * The live "Agent swarm" panel of a live run: the agent office (default) or the agent graph. Inside a run page it
 * reads the page's shared run feed; on its own it reads the swarm and the run's events itself.
 */
export function SwarmPanel({ runId, title, lede }: { runId: string; title?: string; lede?: string }) {
  const shared = useRunFeed();
  const ownSwarm = useSwarm(runId, shared === null);
  const { view, status, error, loaded } = shared?.swarm ?? ownSwarm;
  const running = ACTIVE_RUN_STATES.has(status);
  // `?swarm=graph` opens the graph directly (demos, screenshots); read once, on the client
  const params = useSearchParams();
  const [mode, setMode] = useState<SwarmMode>(() => (params.get("swarm") === "graph" ? "graph" : "office"));
  const ownFeed = useOfficeFeed(runId, shared === null && mode === "office");
  const feed = shared?.office ?? ownFeed;
  // the swarm's first read is history too: nothing in it animates, whichever source delivered it first
  const [firstSeq, setFirstSeq] = useState<number | null>(null);
  if (loaded && firstSeq === null) setFirstSeq(Math.max(0, ...view.messages.map((m) => m.seq), ...Object.values(view.cardSeen).map((c) => c.seq)));
  const skew = feed.sync.skewMs;
  // nothing is fresh until the history boundary is known
  const settled = feed.sync.settledSeq === null ? Infinity : Math.max(feed.sync.settledSeq, firstSeq ?? 0);
  const replay = shared?.replay ?? null;
  const live = useMemo<OfficeLive | null>(() => (running && !replay ? { settledSeq: settled, skewMs: skew ?? 0 } : null), [running, replay, settled, skew]);
  const driven = useOfficeDrive(replay);
  const graphReplay = useGraphReplay(replay);
  const approvalRows = shared?.detail?.approvals;
  const approvals = useMemo(() => (shared ? approvalsOf(approvalRows) : null), [shared, approvalRows]);
  // the office styles read the run's frames: the whole record in a full-run replay (they draw it at its cursor)
  const envs = replay ? replay.timeline.envs : feed.envs;
  return (
    <SwarmBody
      view={view}
      running={running}
      error={error}
      loaded={loaded}
      mode={mode}
      onMode={setMode}
      office={{ record: feed.record, live, error: feed.error, loaded: feed.loaded, driven, onReplayRun: shared?.replayOffer.available ? shared.replayOffer.enter : undefined, envs, approvals }}
      runReplay={replay !== null}
      graphReplay={graphReplay}
      board={`/runs/${runId}/war-game`}
      {...(title ? { title } : {})}
      {...(lede ? { lede } : {})}
    />
  );
}

/**
 * The office's clock in a full-run replay: a recorded time is drawn at its playback position at the replay's speed
 * (so walks and bubbles keep their length at any speed, and a model call keeps its share of the recorded time).
 */
function useOfficeDrive(replay: ReplayView | null): OfficeDrive | null {
  const engine = replay?.engine ?? null;
  const map = replay?.state.map ?? null;
  const speed = replay?.state.speed ?? 1;
  const timing = useMemo(() => {
    if (!engine || !map) return null;
    const at = (ts: number) => map.toPlay(ts) / speed;
    return {
      clock: { at, typingStart: (ts: number, latencyMs: number) => at(ts - Math.max(0, latencyMs)) },
      now: () => engine.playbackNow() / speed,
      recordedAt: (d: number) => (Number.isFinite(d) ? map.toRecorded(d * speed) : Infinity),
      seek: (r: number) => engine.seek(r),
    };
  }, [engine, map, speed]);
  if (!replay || !timing) return null;
  // the end of the record is the run's final state: every beat has played out (as the office draws a finished run)
  const t = replay.state.ended ? Infinity : replay.state.p / speed;
  return { ...timing, t, playing: replay.state.playing, view: replay.full.swarm, record: replay.full.record, calls: replay.full.calls };
}

/** The graph's view of the run-level replay: its clock, cursor and the whole record. */
function useGraphReplay(replay: ReplayView | null): GraphReplay | null {
  const engine = replay?.engine ?? null;
  const state = replay?.state ?? null;
  const full = replay?.full.swarm ?? null;
  return useMemo(
    () =>
      engine && state && full
        ? { recordedNow: () => engine.recordedNow(), seek: (r: number) => engine.seek(r), at: state.r, speed: state.speed, playing: state.playing, ended: state.ended, full }
        : null,
    [engine, state, full],
  );
}

export type SwarmMode = "office" | "graph";

const NO_ENVS: readonly RunEventEnvelope[] = [];

export interface OfficeInput {
  record: OfficeRecord;
  live: OfficeLive | null;
  error: string | null;
  loaded: boolean;
  /** A full-run replay draws the office at its cursor. */
  driven?: OfficeDrive | null;
  /** Start the run page's full-run replay (in place of the office's own replay). */
  onReplayRun?: (() => void) | undefined;
  /** The run's frames and its approvals, for the office styles beside Classic. */
  envs?: readonly RunEventEnvelope[];
  approvals?: Approvals | null;
}

export function SwarmBody({
  view,
  running,
  error,
  loaded,
  mode = "graph",
  onMode,
  office,
  board,
  title = "Agent swarm",
  lede = "S9 Role-play and S10 Board. Each rival gets a capture team that reads only that rival's accepted claims; a red team challenges it; a de-identified board scores the result.",
  thread = true,
  runReplay = false,
  graphReplay = null,
}: {
  view: SwarmView;
  running: boolean;
  error: string | null;
  loaded: boolean;
  mode?: SwarmMode;
  onMode?: (m: SwarmMode) => void;
  office?: OfficeInput;
  /** Where the board's full table lives: the panel then shows one line linking there instead of the table. */
  board?: string;
  title?: string;
  lede?: string;
  /** Show the message thread under the picture. */
  thread?: boolean;
  /** The run page is replaying the whole run: its transport is the only one shown. */
  runReplay?: boolean;
  /** The run-level replay's clock for the graph. */
  graphReplay?: GraphReplay | null;
}) {
  const [details, setDetails] = useState(false);
  const [focus, setFocus] = useState<Focus>("all");
  const ordered = useMemo(() => replayOrder(view.messages), [view.messages]);
  // the graph's own replay of a finished run: the thread shows what it has reached
  const [cutoff, setCutoff] = useState<number | null>(null);
  const onCutoff = useCallback((t: number | null) => setCutoff(t === null || !Number.isFinite(t) ? null : t), []);
  // the run-level replay owns the cursor: the graph's own replay never truncates the thread while it is active
  const localCut = runReplay ? null : cutoff;

  // the office's own replay reports which messages it has reached; the thread follows it
  const [officeReplay, setOfficeReplay] = useState<OfficeReplay | null>(null);
  const [officeStyle, setOfficeStyle] = useOfficeStyle();
  const onOfficeReplay = useCallback((r: OfficeReplay | null) => setOfficeReplay(r), []);
  const officeSent = officeReplay?.sent ?? null;
  const showOffice = mode === "office" && office !== undefined;
  const drawn = useMemo(() => {
    if (showOffice) return officeSent ? ordered.filter((m) => officeSent.has(m.messageId)) : ordered;
    return localCut === null ? ordered : ordered.filter((m) => Date.parse(m.ts) <= localCut);
  }, [ordered, localCut, showOffice, officeSent]);
  const shown = filterThread(view, drawn, focus);
  const round = showOffice || localCut !== null ? roundAt(drawn, drawn.length) : (view.totals.rounds.at(-1) ?? 0);
  const t = view.totals;
  const rivals = view.groups.filter((g) => g.kind === "rival");
  const hasCards = Object.keys(view.cards).length > 0;
  const waiting = loaded && t.messages === 0 && !error;
  // Classic keeps its rule (lanes or cards); the other styles also draw the early stages and gates
  const officeHasScene = office !== undefined && hasOfficeScene(officeStyle === CLASSIC_STYLE, office.record, hasCards);

  return (
    <section id="swarm" aria-labelledby="swarm-h" className="scroll-mt-6">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div>
          <h2 id="swarm-h" className="flex items-center gap-2 text-lg font-semibold tracking-[-0.01em] text-ink">
            {title}
            {running && t.messages > 0 && <span className="size-2 rounded-full bg-signal animate-pulse-soft" aria-label="agents working" />}
          </h2>
          {lede && <p className="mt-0.5 max-w-[80ch] text-sm text-muted">{lede}</p>}
        </div>
        <div className="flex flex-col items-end gap-2">
        <div className="flex flex-wrap items-center justify-end gap-3">
        {showOffice && (
          <OfficeStyleSwitch
            value={officeStyle}
            onChange={(s) => {
              setOfficeReplay(null);
              setOfficeStyle(s);
            }}
          />
        )}
        {onMode && (
          <div onPointerEnter={() => void loadSwarmGraphView()} onFocus={() => void loadSwarmGraphView()}>
          <Segmented
            label="Swarm view"
            value={mode}
            onChange={(m) => {
              setCutoff(null);
              setOfficeReplay(null);
              onMode(m);
            }}
            options={[
              { value: "office", label: "Office" },
              { value: "graph", label: "Graph" },
            ]}
          />
          </div>
        )}
        </div>
        {t.messages > 0 && (
          <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted tabular">
            <Stat k="Agents" v={t.agents} />
            <Stat k="Messages" v={t.messages} />
            <Stat k="Round" v={round === 4 ? "Board" : round > 0 ? `${round} of 3` : "-"} />
          </dl>
        )}
        </div>
      </div>
      {error && <p className="mb-3 text-sm text-danger">Swarm events could not be read ({error}); retrying.</p>}
      {!loaded && !error && <p className="text-sm text-muted">Reading the swarm&apos;s record...</p>}
      {showOffice && office && officeHasScene && (
        <OfficeStage
          key={officeStyle}
          style={officeStyle}
          view={view}
          record={office.record}
          live={office.live}
          driven={office.driven ?? null}
          onReplayRun={office.onReplayRun}
          focus={focus}
          onFocus={setFocus}
          onReplay={onOfficeReplay}
          recordError={office.error}
          envs={office.envs ?? NO_ENVS}
          approvals={office.approvals ?? null}
        />
      )}
      {showOffice && office && !officeHasScene && loaded && (
        <div className="rounded-lg border border-dashed border-hairline-strong px-5 py-3 text-sm text-muted">
          {!office.loaded
            ? "Reading the run's research and verification events..."
            : running
              ? "The office fills as the run records its research lanes (S4 Evidence) and its agents (S9 Role-play)."
              : "This run recorded no research lanes or swarm activity."}
        </div>
      )}
      {!showOffice && waiting && !(running && hasCards) && (
        <div className="rounded-lg border border-dashed border-hairline-strong px-5 py-3 text-sm text-muted">
          {running ? "The swarm starts at S9 Role-play, after the dossiers. Its agents appear here as soon as their cards are recorded." : "This run recorded no swarm activity."}
        </div>
      )}
      {!showOffice && loaded && (hasCards || t.messages > 0) && (
        <SwarmGraphView view={view} record={office?.record ?? null} running={running} focus={focus} onFocus={setFocus} onCutoff={onCutoff} runReplay={runReplay} replay={graphReplay} />
      )}
      {t.messages > 0 && (
        <>
          {showOffice && (
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
              <Rounds current={round} />
            </div>
          )}
          {thread && (
          <div className={cn("min-w-0", showOffice ? "mt-3" : "mt-4")}>
            <div className="mb-2 flex flex-wrap items-center gap-1" role="group" aria-label="Thread filter">
              <FilterButton on={focus === "all"} onClick={() => setFocus("all")}>
                All
              </FilterButton>
              {rivals.map((g) => (
                <FilterButton key={g.id} on={focus === g.id} onClick={() => setFocus(g.id)}>
                  {shortName(g.label)}
                </FilterButton>
              ))}
              <FilterButton on={focus === "board"} onClick={() => setFocus("board")}>
                Board
              </FilterButton>
              {(focus.startsWith("agent:") || focus.startsWith("edge:")) && (
                <button
                  type="button"
                  onClick={() => setFocus("all")}
                  className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-ink bg-ink pl-3 pr-2 text-xs font-medium text-on-ink"
                >
                  {focusLabel(view, focus)}
                  <X size={12} aria-label="clear" />
                </button>
              )}
              <span className="ml-auto flex items-center gap-3">
                <label className="inline-flex items-center gap-1.5 text-xs text-ink-2">
                  <input type="checkbox" checked={details} onChange={(e) => setDetails(e.target.checked)} className="size-3.5 accent-[var(--color-accent)]" />
                  Show call details
                </label>
                {/* the graph's caption bar is the one announcement channel while the graph is shown */}
                <span className="font-mono text-micro text-faint tabular" aria-live={showOffice ? "polite" : "off"}>
                  {shown.length} of {t.messages} messages
                </span>
              </span>
            </div>
            <Thread view={view} items={shown} details={details} live={showOffice} />
          </div>
          )}
        </>
      )}
      {view.board && (showOffice ? officeReplay === null || officeReplay.scores : localCut === null || (view.boardSeen !== null && localCut >= Date.parse(view.boardSeen.ts))) &&
        (board ? <BoardLine board={view.board} href={board} /> : <BoardTable board={view.board} />)}
    </section>
  );
}

function focusLabel(view: SwarmView, focus: Focus): string {
  if (focus.startsWith("agent:")) return agentName(view, focus.slice(6));
  const [a = "", b = ""] = focus.slice(5).split("~");
  return `${agentName(view, a)} and ${agentName(view, b)}`;
}

function Rounds({ current }: { current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="Swarm rounds">
      {[1, 2, 3, 4].map((r) => (
        <li
          key={r}
          aria-current={r === current ? "step" : undefined}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 transition-colors duration-[var(--duration-base)]",
            r === current ? "border-ink bg-ink text-on-ink" : r < current ? "border-hairline-strong text-ink-2" : "border-hairline text-faint",
          )}
        >
          <span className="font-mono tabular">{r === 4 ? "B" : r}</span>
          <span key={`${r}-${r === current}`} className={cn(r === current && "animate-rise")}>
            {ROUND_SHORT[r]}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Stat({ k, v }: { k: string; v: string | number }) {
  return (
    <div className="flex gap-1.5">
      <dt>{k}</dt>
      <dd className="font-semibold text-ink">{v}</dd>
    </div>
  );
}

function FilterButton({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "h-7 shrink-0 rounded-full border px-3 text-xs font-medium transition-colors",
        on ? "border-ink bg-ink text-on-ink" : "border-hairline text-ink-2 hover:bg-surface-2",
      )}
    >
      {children}
    </button>
  );
}


export function Thread({ view, items, details = false, live = true }: { view: SwarmView; items: SwarmItem[]; details?: boolean; live?: boolean }) {
  const box = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [items.length]);
  return (
    <ol
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      id="swarm-thread"
      tabIndex={-1}
      aria-label="Agent messages"
      aria-live={live ? "polite" : "off"}
      className="flex max-h-[680px] flex-col gap-2 overflow-y-auto rounded-lg border border-hairline bg-surface p-2"
    >
      {items.length === 0 && <li className="px-2 py-6 text-center text-sm text-muted">No messages yet.</li>}
      {items.map((m, i) => {
        const divider = i === 0 || items[i - 1]?.round !== m.round ? (ROUND_LABEL[m.round] ?? `Round ${m.round}`) : null;
        return (
          <li key={m.messageId} className="contents">
            {divider && <div className="px-1 pt-2 text-micro font-semibold uppercase tracking-[0.06em] text-faint">{divider}</div>}
            <MessageCard view={view} m={m} details={details} />
          </li>
        );
      })}
    </ol>
  );
}

/** One agent message. `details`: the model call behind it (model, tokens, cost, latency), hidden by default. */
export function MessageCard({ view, m, details = false }: { view: SwarmView; m: SwarmItem; details?: boolean }) {
  const sender = view.cards[m.from];
  const ok = m.state === "completed";
  return (
    <article className={cn("rounded-md border bg-canvas px-3 py-2.5 animate-enter", ok ? "border-hairline" : "border-danger/30")}>
      <header className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
        <RoleIcon role={sender?.role ?? "analyst"} />
        <span className="font-semibold text-ink">{agentName(view, m.from)}</span>
        <ArrowRight size={12} aria-label="to" className="text-faint" />
        <span className="text-ink-2">{m.to.map((t) => agentName(view, t)).join(", ")}</span>
        <Pill tone="outline" className="ml-1 h-5 px-2 text-micro">
          {KIND_LABEL[m.kind]}
        </Pill>
        {!ok && (
          <Pill tone="danger" className="h-5 px-2 text-micro">
            {m.state === "rejected" ? "not run: budget" : "failed"}
          </Pill>
        )}
      </header>
      <p className="mt-1.5 text-sm text-ink-2">{m.text}</p>
      {m.reasoning && (
        <p className="mt-1.5 text-xs text-muted">
          <span className="font-medium text-ink-2">Reasoning summary: </span>
          <span className="italic">{m.reasoning}</span>
        </p>
      )}
      {m.citations.length > 0 && <CiteChips cites={m.citations} />}
      {(details || m.dropped > 0) && (
        <footer className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-micro text-faint tabular">
          {details && m.usage.model && <span>{m.usage.model}</span>}
          {details && (m.usage.inputTokens > 0 || m.usage.outputTokens > 0) && (
            <span>
              {m.usage.inputTokens} in / {m.usage.outputTokens} out tokens
            </span>
          )}
          {details && m.usage.model && <span>{m.usage.free ? "free tier" : formatUsd(m.usage.costUsd)}</span>}
          {details && m.usage.latencyMs > 0 && <span>{(m.usage.latencyMs / 1000).toFixed(1)} s</span>}
          {m.dropped > 0 && (
            <span className="text-danger">
              {m.dropped} {m.dropped === 1 ? "point" : "points"} dropped: no accepted citation
            </span>
          )}
        </footer>
      )}
    </article>
  );
}

export function CiteChips({ cites }: { cites: AgentCitation[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-1" aria-label="Cited accepted claims">
      {cites.map((c) => (
        <li key={c.claimId}>
          <Tip label={c.text}>
            <span tabIndex={0} className="inline-flex h-5 items-center rounded-sm border border-cream-edge bg-cream px-1.5 font-mono text-micro text-ink">
              {c.code}
            </span>
          </Tip>
        </li>
      ))}
    </ul>
  );
}

/** The board's result in one line, linking to the War game page that holds the full table. */
export function BoardLine({ board, href }: { board: BoardResult; href: string }) {
  const top = [...board.rows].sort((a, b) => b.share - a.share)[0];
  return (
    <p className="mt-4 flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg border border-hairline bg-canvas px-4 py-2.5 text-sm text-ink-2">
      <span className="font-semibold text-ink">Board:</span>
      {top ? (
        <span>
          {shortName(top.label)} {Math.round(top.share * 100)}% of the simulated vote
        </span>
      ) : (
        <span>no rows recorded</span>
      )}
      <span className="text-xs font-semibold text-danger">Simulated, never an input to the bid decision.</span>
      <Link href={href} className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
        Full board in the War game <ArrowRight size={12} aria-hidden />
      </Link>
    </p>
  );
}

const MEMBER_LABEL: Record<string, string> ={ technical: "Tech", management: "Mgmt", past_performance: "Past perf." };

export function BoardTable({ board }: { board: BoardResult }) {
  const rows = [...board.rows].sort((a, b) => b.share - a.share);
  const members = Object.keys(MEMBER_LABEL);
  return (
    <div className="mt-5 rounded-lg border border-hairline bg-canvas">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hairline px-4 py-2.5">
        <h3 className="text-sm font-semibold text-ink">Board result</h3>
        <span className="text-xs font-semibold text-danger">{capitalize(board.label)}. Never an input to the bid decision.</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="px-4 py-2 font-medium">Offeror (code the board saw)</th>
              {members.map((m) => (
                <th key={m} className="px-2 py-2 text-center font-medium">
                  {MEMBER_LABEL[m]}
                </th>
              ))}
              <th className="px-4 py-2 font-medium">Simulated vote share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.group} className="border-t border-hairline-soft">
                <td className="px-4 py-2">
                  <span className="mr-2 inline-flex size-5 items-center justify-center rounded-sm bg-surface-2 font-mono text-micro text-ink">{r.code || "-"}</span>
                  <span className="text-ink">{r.label}</span>
                  {r.incumbent && (
                    <Pill tone="cream" className="ml-2 h-5 px-2 text-micro">
                      incumbent
                    </Pill>
                  )}
                </td>
                {members.map((m) => (
                  <td key={m} className="px-2 py-2 text-center font-mono text-xs tabular text-ink-2">
                    {r.ratings[m] ?? "-"}
                  </td>
                ))}
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-32 overflow-hidden rounded-full bg-surface-2">
                      <div className="h-full rounded-full bg-chart-mid animate-grow origin-left" style={{ width: `${Math.round(r.share * 100)}%` }} />
                    </div>
                    <span className="font-mono text-xs tabular text-ink">{Math.round(r.share * 100)}%</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-hairline px-4 py-2 text-xs text-muted">
        {board.members} evaluators scored de-identified proposals (names masked, codes in a seeded order) with an evidence profile built from accepted
        claims. {board.runs} runs (evaluator x price draw);{" "}
        {board.method
          ? "each run splits its vote by rating and price, so a one-point rating lead is a preference, not a sweep."
          : "the top offeror took each run; offerors within one price-index point tie."}{" "}
        Jeffreys-smoothed shares.
        {board.notes.length > 0 && ` ${board.notes.join("; ")}.`}
      </p>
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
