"use client";

import { Anchor, ArrowClockwise, ArrowSquareOut, CircleDashed, EyeSlash, Pause, Play, SealCheck, Warning, type Icon } from "@phosphor-icons/react";
import Link from "next/link";
import { Popover } from "radix-ui";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { StatusGlyph } from "@/components/pipeline/status-glyph";
import { Pill } from "@/components/ui/pill";
import { Segmented } from "@/components/ui/segmented";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { cellKey, type Cell, type CellState, type Lane, type WarRoomSnapshot } from "@/lib/contracts/run-events";
import { clock, duration, money, plural } from "@/lib/format";
import { approvalsOf, gateStatusOf, historyFeed, ROW_STATUS_LABEL, type RowStatus } from "@/lib/pipeline/rail";
import { isGate, PHASES, STEP_META, type GateId } from "@/lib/pipeline/steps";
import { connection } from "@/lib/run-lifecycle";
import { STAGES, type StageId } from "@/lib/stages";
import { tierLabel } from "@/lib/tiers";
import { phaseLine } from "@/lib/war-room/feed-text";
import { SPEEDS } from "@/lib/war-room/player";
import { dayOf, timeOfDay, zoneName } from "@/lib/war-room/replay-controls";
import { ACTIVITY_LIMIT, type FeedItem, type WarRoomStore } from "@/lib/war-room/state";

import { useRunFeed } from "./run-feed";
import { LIVE_ENDPOINTS, RECORDED_ENDPOINTS, useScrubTransport, useStreamTransport, type Mode, type Transport } from "./use-war-room";

const CELL: Record<CellState, { label: string; icon: Icon; cls: string; help: string }> = {
  pending: { label: "Pending", icon: CircleDashed, cls: "hatch text-faint", help: "No evidence row yet" },
  anchored: { label: "Anchored", icon: Anchor, cls: "border-dashed border-hairline-strong bg-canvas text-ink-2", help: "Rows with matched quotes; no claim checked yet" },
  verified: { label: "Verified", icon: SealCheck, cls: "bg-canvas text-ink", help: "Every claim checked here is fully supported" },
  contested: { label: "Contested", icon: Warning, cls: "bg-cream-deep text-ink", help: "A claim here is only partly supported by its source" },
  withheld: { label: "Withheld", icon: EyeSlash, cls: "bg-surface-2 text-muted", help: "A claim here was unsupported and is withheld from every export" },
};

export type WarRoomSource =
  | { kind: "recorded"; recordedAt: string; claimTotal: number }
  | { kind: "live"; opportunity: string; planHref: string; decisionHref: string };

/** A replay shows a past moment: a gate waited for a person then, nobody is asked to act now. */
const REPLAY_GATE_HEADLINE: Readonly<Record<string, string>> = {
  awaiting_plan_approval: "The plan is ready. The run waits at H1 for a person to approve who to research.",
  awaiting_decision: "Research is done. The run waits at H2 for the bid / no-bid decision.",
  awaiting_review: "Research is done. The run waits at H2 for review.",
  decided: "The run is decided: the decision (H2) is on the record.",
};

const GATE_HEADLINE: Readonly<Record<string, string>> = {
  awaiting_plan_approval: "The plan is ready. The run waits for your approval of who to research (H1).",
  awaiting_decision: "Research is done. The run waits for your bid / no-bid decision (H2).",
  awaiting_review: "Research is done. The run waits for your review (H2).",
  decided: "The run is decided: your decision (H2) is on the record.",
  cancelled: "The run was cancelled.",
  expired: "The run expired at its gate; it can only be re-run.",
  interrupted: "The run was interrupted. An owner or analyst can resume it.",
};

/**
 * Claims withheld from display. Live: every verdict that is not an acceptance (rejected, unverifiable, needs
 * human), the API's `withheld` counter. Recorded replay: its unsupported claims (its `withheld` counts cells).
 */
function withheldClaims(c: WarRoomSnapshot["counters"], live: boolean): number {
  return live ? c.withheld : c.unsupported;
}

function headline(store: WarRoomStore, claimTotal: number | null, live: boolean, replaying = false): string {
  const v = store.view;
  if (!v) return store.status === "error" ? "The run reported an error." : live ? "Connecting to the live run." : "Connecting to the recorded run.";
  const c = v.counters;
  const firms = v.laneOrder.length;
  if (store.status === "error") return `The run stopped: ${store.error ?? "no reason recorded"}.`;
  if (live && store.status === "finished") {
    const said = (replaying ? REPLAY_GATE_HEADLINE[store.finalState ?? ""] : undefined) ?? GATE_HEADLINE[store.finalState ?? ""];
    return said ?? `The phase finished (${store.finalState ?? "unknown state"}).`;
  }
  if (live && store.currentStage === null) return firms > 0 ? `${plural(firms, "firm")} approved at H1; waiting for the next stage to start.` : "Waiting for the run's next stage to start.";
  if (store.status === "finished") {
    return `Research complete: ${plural(c.fetches, "source")} fetched, ${c.supported} claims fully supported, ${c.partial} partly, ${withheldClaims(c, live)} withheld. The call is yours.`;
  }
  switch (store.currentStage) {
    case "S4":
      return `Researching ${plural(firms, "firm")}: ${plural(c.fetches, "source")} fetched so far.`;
    case "S5":
    case "S6":
      return `Quotes matched; drafting one dossier per firm from ${plural(c.rows, "evidence row")}.`;
    case "S7":
      return claimTotal === null
        ? `Verifying claims against their sources: ${c.claimsChecked} checked, ${withheldClaims(c, live)} withheld so far.`
        : `Verifying claims against their sources: ${c.claimsChecked} of ${claimTotal} checked, ${withheldClaims(c, live)} withheld so far.`;
    case null:
      return `${plural(firms, "firm")} approved at H1; waiting for the next stage.`;
    default: {
      const meta = STEP_META[store.currentStage];
      return `${meta.name}: ${meta.about}`;
    }
  }
}

/** `swarm`: the live run's agent swarm panel, drawn right under the stage strip (S9 and S10 link to it). */
export function WarRoom({ runId, source, swarm }: { runId: string; source: WarRoomSource; swarm?: ReactNode }) {
  const live = source.kind === "live";
  const claimTotal = source.kind === "recorded" ? source.claimTotal : null;
  const [mode, setMode] = useState<Mode>("stream");
  const router = useRouter();
  // a live run page shares one feed between its views; a recorded replay or a bare page reads its own stream
  const shared = useRunFeed();
  const own = useStreamTransport(runId, mode === "stream" && shared === null, live ? LIVE_ENDPOINTS : RECORDED_ENDPOINTS);
  const stream: Transport = shared?.stream ?? own;
  // a live phase ended: refresh the server-rendered header (run status) once the view has re-read the snapshot
  const phaseEnded = shared === null && live && (stream.store.status === "finished" || stream.store.status === "error") && !stream.store.needsResync;
  useEffect(() => {
    if (phaseEnded) router.refresh();
  }, [phaseEnded, router]);
  const scrub = useScrubTransport(runId, !live && mode === "scrub");
  const store = mode === "stream" ? stream.store : scrub.store;
  const view = store.view;
  const stageName = STAGES.find((s) => s.id === store.currentStage)?.name ?? null;
  const approvals = approvalsOf(shared?.detail?.approvals);
  const runStatus = shared?.detail?.run.status ?? null;
  const gates = shared ? { H1: gateStatusOf("H1", runStatus, approvals), H2: gateStatusOf("H2", runStatus, approvals) } : undefined;
  const replay = shared?.replay ?? null;
  // the end of a replay is the run as it stands now: the live words
  const said = headline(store, claimTotal, live, replay !== null && !replay.state.ended);

  return (
    <div className="space-y-5">
      <div className="min-w-0 max-w-[62rem]">
        {source.kind === "recorded" && (
          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
            <Pill tone="outline">RECORDED</Pill>
            <span className="text-muted">Replay of a recorded run, {source.recordedAt}</span>
          </div>
        )}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="font-serif text-2xl font-medium leading-tight tracking-[-0.012em] text-ink md:text-3xl">
            <span key={said} className="inline-block animate-rise">
              {said}
            </span>
          </h1>
          {!live && (
            <Segmented
              label="Replay mode"
              value={mode}
              onChange={setMode}
              options={[
                { value: "stream", label: "Stream" },
                { value: "scrub", label: "Scrub" },
              ]}
            />
          )}
        </div>
        {source.kind === "live" && !replay && store.status === "finished" && store.finalState === "awaiting_plan_approval" && (
          <Link href={source.planHref} className="mt-3 inline-flex h-9 items-center rounded-md bg-accent px-3 text-sm font-medium text-on-accent hover:bg-accent-strong">
            Review the plan (H1)
          </Link>
        )}
        {source.kind === "live" && store.status === "finished" && ["awaiting_decision", "awaiting_review", "decided"].includes(store.finalState ?? "") && (
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href={`/runs/${runId}/dossiers`} className="inline-flex h-9 items-center rounded-md border border-hairline-strong px-3 text-sm font-medium text-ink hover:bg-surface">
              Open the dossiers
            </Link>
            <Link href={`/runs/${runId}/brief`} className="inline-flex h-9 items-center rounded-md border border-hairline-strong px-3 text-sm font-medium text-ink hover:bg-surface">
              Open the gate brief
            </Link>
            <Link href={source.decisionHref} className="inline-flex h-9 items-center rounded-md bg-accent px-3 text-sm font-medium text-on-accent hover:bg-accent-strong">
              Open the decision (H2)
            </Link>
          </div>
        )}
        {source.kind === "recorded" && store.status === "finished" && (
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href={`/reviews/${runId}/dossiers`} className="inline-flex h-9 items-center rounded-md border border-hairline-strong px-3 text-sm font-medium text-ink hover:bg-surface">
              Open the dossiers
            </Link>
            <Link href={`/reviews/${runId}/brief`} className="inline-flex h-9 items-center rounded-md bg-accent px-3 text-sm font-medium text-on-accent hover:bg-accent-strong">
              Open the gate brief (H2)
            </Link>
          </div>
        )}
        <p className="sr-only" aria-live="polite">
          {stageName ? `Stage ${store.currentStage}, ${stageName}` : store.status === "finished" ? "Run complete" : ""}
        </p>
      </div>

      {replay ? (
        <ReplayLine at={replay.state.r} t0={replay.timeline.t0} />
      ) : mode === "stream" ? (
        <StreamBar transport={stream} resyncing={store.needsResync} live={live} finished={store.status === "finished"} />
      ) : (
        <ScrubBar scrub={scrub} />
      )}

      {/* inside a run page the page shows this for every view (RunViews); a bare War Room shows its own */}
      {shared === null && <SeedError transport={stream} />}
      <Counters view={view} claimTotal={claimTotal} live={live} spendUsd={shared?.spendUsd ?? null} capUsd={shared?.capUsd ?? null} />
      <StageStrip stages={view?.stages ?? {}} current={store.currentStage} jump={swarm ? SWARM_JUMP : undefined} gates={gates} />
      {live && mode === "stream" && <WorkingNow store={store} at={replay?.state.r} />}
      {swarm}

      <div className="grid gap-5 2xl:grid-cols-[minmax(0,1fr)_26rem]">
        <Matrix view={view} runId={runId} live={live} />
        <div className="grid gap-5 md:grid-cols-2 2xl:grid-cols-1">
          <Lanes view={view} />
          <Ticker feed={shared && mode === "stream" ? historyFeed(shared.history, ACTIVITY_LIMIT) : store.feed} />
        </div>
      </div>
      {live && <p className="text-xs text-muted">Every number here is from this run&apos;s record.</p>}
    </div>
  );
}

/** The run's first read failed: say so with the reason, that it is being retried, and offer Retry now. */
export function SeedError({ transport }: { transport: Transport }) {
  if (!transport.seedError) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md border border-danger bg-danger-soft px-3 py-2 text-sm text-danger">
      <span>The run could not be read ({transport.seedError}). Trying again on its own; the view starts once it can be read.</span>
      <button type="button" onClick={transport.reconnect} className="ml-auto h-8 rounded-md bg-ink px-3 text-sm text-on-ink">
        Retry now
      </button>
    </div>
  );
}

/** In a replay: the moment every number on the page stands at (the transport is docked below). */
function ReplayLine({ at, t0 }: { at: number; t0: number }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-hairline bg-surface px-4 py-2.5 text-sm" data-connection="Replay">
      <span className="inline-flex items-center gap-2 font-medium text-ink">
        <span aria-hidden className="size-2 rounded-full bg-ink-2" />
        Replay
      </span>
      <span className="text-ink-2">
        The run as recorded at <span className="font-mono tabular text-ink">{timeOfDay(at)}</span> <span className="text-muted">{zoneName(at)}</span> on {dayOf(at)},{" "}
        <span className="font-mono tabular">{clock(at - t0)}</span> after it was created. Every number below is as of this moment.
      </span>
    </div>
  );
}

/**
 * One connection dot and word (Live, Reconnecting, Offline...) with a Retry when the stream gave up. A recorded
 * replay can be watched again; a live run is replayed from the run page's transport once it is no longer live.
 */
function StreamBar({ transport, resyncing, live, finished }: { transport: Transport; resyncing: boolean; live: boolean; finished: boolean }) {
  const c = connection(transport.lifecycle, { retrying: transport.retry !== null && !transport.gaveUp, gaveUp: transport.gaveUp });
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-hairline bg-surface px-4 py-2.5 text-sm" data-connection={c.label}>
      <span className="inline-flex items-center gap-2 font-medium text-ink">
        <span aria-hidden className={cn("size-2 rounded-full", c.tone === "live" ? "animate-pulse-soft bg-signal" : c.tone === "trouble" ? "bg-danger" : "bg-ink-2")} />
        {c.label}
      </span>
      {transport.lifecycle === "stalled" && <span className="text-muted">{transport.silence}</span>}
      {resyncing && <span className="text-ink-2">Catching up with the run</span>}
      <span className="ml-auto flex items-center gap-2">
        {transport.gaveUp && (
          <button type="button" onClick={transport.reconnect} className="h-8 rounded-md bg-ink px-3 text-sm text-on-ink">
            Retry
          </button>
        )}
        {!live && (
          <button type="button" onClick={transport.restart} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline-strong bg-canvas px-3 text-sm text-ink hover:bg-surface-2">
            <ArrowClockwise size={14} aria-hidden /> {finished ? "Watch again" : "Watch from the start"}
          </button>
        )}
      </span>
    </div>
  );
}

function ScrubBar({ scrub }: { scrub: ReturnType<typeof useScrubTransport> }) {
  if (scrub.error) return <div className="rounded-lg border border-danger px-4 py-3 text-sm text-danger">Recording unavailable: {scrub.error}</div>;
  if (!scrub.ready) return <div className="h-[3.25rem] animate-pulse-soft rounded-lg border border-hairline bg-surface" aria-label="Loading recording" />;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-hairline bg-surface px-4 py-2.5">
      <button
        type="button"
        onClick={scrub.playing ? scrub.pause : scrub.play}
        aria-label={scrub.playing ? "Pause replay" : "Play replay"}
        className="inline-flex size-9 items-center justify-center rounded-md bg-ink text-on-ink"
      >
        {scrub.playing ? <Pause size={16} weight="fill" aria-hidden /> : <Play size={16} weight="fill" aria-hidden />}
      </button>
      <input
        type="range"
        min={0}
        max={scrub.total}
        value={scrub.cursor}
        onChange={(e) => scrub.seek(Number(e.target.value))}
        aria-label="Replay position"
        aria-valuetext={`event ${scrub.cursor} of ${scrub.total}`}
        className="h-2 min-w-40 flex-1 cursor-pointer accent-[var(--color-accent)]"
      />
      <span className="font-mono text-sm text-ink-2 tabular">
        {clock(scrub.positionMs)} / {clock(scrub.durationMs)}
      </span>
      <Segmented
        label="Replay speed"
        value={String(scrub.speed)}
        onChange={(v) => scrub.setSpeed(Number(v))}
        className="bg-canvas"
        itemClassName="h-7 px-2 font-mono text-xs"
        options={SPEEDS.map((s) => ({ value: String(s), label: `${s}x` }))}
      />
    </div>
  );
}

/**
 * Sources fetched (every gateway call, blocked ones included) beside the rows kept, the claims checked, and the run's
 * spend. Live spend is the run inspector's total (model calls, the single cost source) when it has been read, so
 * every view of the run shows the same figure.
 */
function Counters({ view, claimTotal, live, spendUsd, capUsd }: { view: WarRoomSnapshot | null; claimTotal: number | null; live: boolean; spendUsd: number | null; capUsd: number | null }) {
  if (!view) {
    // no snapshot yet (or it failed): no number is shown until the run's own state has been read
    return (
      <div className="grid gap-px overflow-hidden rounded-lg border border-hairline bg-hairline sm:grid-cols-3" aria-busy="true">
        {["Sources fetched", "Claims checked", "Spend against cap"].map((label) => (
          <div key={label} className="bg-canvas px-5 py-4">
            <div className="text-sm text-muted">{label}</div>
            <div className="mt-1 font-mono text-3xl font-medium text-muted">&ndash;</div>
            <div className="mt-1 text-xs text-muted">not read yet</div>
          </div>
        ))}
      </div>
    );
  }
  const c = view.counters;
  const usd = spendUsd ?? view.cost.usd;
  const cap = capUsd ?? view.cost.capUsd;
  const pct = cap > 0 ? Math.min(100, (usd / cap) * 100) : 0;
  return (
    <div className="grid gap-px overflow-hidden rounded-lg border border-hairline bg-hairline sm:grid-cols-3">
      <div className="bg-canvas px-5 py-4">
        <div className="text-sm text-muted">Sources fetched</div>
        <div className="mt-1 font-mono text-3xl font-medium text-ink tabular">
          <Flip value={c.fetches} />
        </div>
        <div className="mt-1 text-xs text-ink-2">
          <span className="font-mono tabular text-ink">{c.rows}</span> evidence rows kept
        </div>
      </div>
      <div className="bg-canvas px-5 py-4">
        <div className="text-sm text-muted">Claims checked</div>
        <div className="mt-1 font-mono text-3xl font-medium text-ink tabular">
          <Flip value={c.claimsChecked} />
          {claimTotal !== null && <span className="text-lg text-muted"> / {claimTotal}</span>}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 text-xs">
          <span className="inline-flex items-center gap-1 text-ink">
            <SealCheck size={12} weight="fill" aria-hidden /> {c.supported} supported
          </span>
          <span className="inline-flex items-center gap-1 text-ink-2">
            <Warning size={12} aria-hidden /> {c.partial} partly
          </span>
          <span className="inline-flex items-center gap-1 text-muted">
            <EyeSlash size={12} aria-hidden /> {withheldClaims(c, live)} withheld
          </span>
        </div>
      </div>
      <div className="bg-canvas px-5 py-4">
        <div className="flex items-baseline justify-between text-sm text-muted">
          <span>Spend against cap</span>
          {!live && (
            <Tip label="A replay draws spend down from the stage budgets of the Standard preset; live runs show what their model calls cost.">
              <button type="button" className="text-xs underline decoration-dotted underline-offset-2">
                simulated
              </button>
            </Tip>
          )}
        </div>
        <div className="mt-1 font-mono text-3xl font-medium text-ink tabular">
          <Flip value={money(usd)} />
          <span className="text-lg text-muted"> / {money(cap)}</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-hairline" role="meter" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={usd} aria-label="Spend against cap">
          <div className="h-full origin-left rounded-full bg-ink transition-transform duration-[var(--duration-data)] ease-out-expo" style={{ transform: `scaleX(${pct / 100})` }} />
        </div>
      </div>
    </div>
  );
}

const SWARM_JUMP: Partial<Record<StageId, string>> = { S9: "#swarm", S10: "#swarm" };

/**
 * The stages in their five phases, with the two human gates as diamonds where the run waits for a person.
 * `jump`: stages whose label links to a section of the page (S9 and S10 to the agent swarm). `gates`: the gates'
 * statuses; without them (the admin inspector) the strip shows stages only.
 */
export function StageStrip({
  stages,
  current,
  jump,
  gates,
}: {
  stages: Partial<Record<StageId, string>>;
  current: StageId | null;
  jump?: Partial<Record<StageId, string>> | undefined;
  gates?: Record<GateId, RowStatus> | undefined;
}) {
  return (
    <ol className="flex flex-wrap gap-x-4 gap-y-3" aria-label="Run stages by phase">
      {PHASES.map((phase) => {
        const steps = phase.steps.filter((id) => !isGate(id) || gates);
        return (
          <li key={phase.id} className="min-w-[9rem] flex-1" style={{ flexGrow: steps.filter((s) => !isGate(s)).length }}>
            <div className="mb-1 text-micro font-medium text-muted">{phase.label}</div>
            <ol className="flex items-start gap-1" aria-label={phase.label}>
              {steps.map((id) => {
                if (isGate(id)) {
                  const st = gates?.[id] ?? "not_started";
                  return (
                    <li key={id} className="flex shrink-0 flex-col items-center" title={`${id} ${STEP_META[id].name}: ${ROW_STATUS_LABEL[st]}`} data-stage-state={st}>
                      <StatusGlyph status={st} gate size={12} className="-mt-[3px]" />
                      <span className={cn("mt-0.5 font-mono text-micro", st === "waiting" ? "font-semibold text-ink" : "text-muted")}>{id}</span>
                      <span className="sr-only">{ROW_STATUS_LABEL[st]}</span>
                    </li>
                  );
                }
                const st = stages[id] ?? "not_started";
                const running = current === id;
                const filled = running || st === "done" || st === "degraded" || st === "not_built";
                return (
                  <li key={id} title={`${id} ${STEP_META[id].name}: ${running ? "running" : st.replace("_", " ")}`} className="min-w-0 flex-1" data-stage-state={running ? "running" : st}>
                    {/* Track + fill: the fill grows from the left when a stage starts or ends (transform only). */}
                    <div className="relative h-1.5 overflow-hidden rounded-full bg-hairline">
                      <div
                        aria-hidden
                        className={cn(
                          "absolute inset-0 origin-left rounded-full transition-transform duration-[var(--duration-slow)] ease-out-expo",
                          running ? "bg-signal" : st === "degraded" ? "hatch bg-ink-2" : st === "not_built" ? "hatch bg-hairline-strong" : "bg-ink",
                        )}
                        style={{ transform: `scaleX(${filled ? 1 : 0})` }}
                      />
                      {running && <div aria-hidden className="absolute inset-0 animate-sweep bg-gradient-to-r from-transparent via-canvas/70 to-transparent" />}
                    </div>
                    <div className={cn("mt-1 text-micro leading-tight [overflow-wrap:anywhere]", running ? "font-semibold text-ink" : st === "done" ? "text-ink-2" : "text-muted")}>
                      {jump?.[id as StageId] ? (
                        <a href={jump[id as StageId]} className="underline decoration-hairline-strong underline-offset-2 hover:decoration-ink" aria-label={`${id} ${STEP_META[id].name}: jump to the agent swarm`}>
                          <span className="font-mono">{id}</span> {STEP_META[id].name}
                        </a>
                      ) : (
                        <>
                          <span className="font-mono">{id}</span> {STEP_META[id].name}
                        </>
                      )}
                      {st === "not_built" && <span className="sr-only"> (skipped on this run)</span>}
                    </div>
                  </li>
                );
              })}
            </ol>
          </li>
        );
      })}
    </ol>
  );
}

/** A value that rises into place when it changes (transform only; tabular digits, so no shift). */
export function Flip({ value }: { value: string | number }) {
  return (
    <span key={String(value)} className="inline-block animate-rise">
      {value}
    </span>
  );
}

export function CellView({ cell, runId, live, subjectLabel, columnLabel }: { cell: Cell; runId: string; live: boolean; subjectLabel: string; columnLabel: string }) {
  const meta = CELL[cell.state];
  const I = meta.icon;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`${subjectLabel}, ${columnLabel}: ${meta.label}, ${cell.rows} rows`}
          className={cn("relative flex h-12 w-full items-center justify-between gap-1 rounded-md border px-2.5 text-left hover:border-ink", cell.state === "anchored" ? "" : "border-hairline", meta.cls)}
        >
          {/* Keyed on state: a change remounts the glyph (pop) and plays one settle ring. */}
          <span key={`g-${cell.state}`} className="inline-flex animate-pop" data-cell-state={cell.state}>
            <I size={16} weight={cell.state === "verified" ? "fill" : "regular"} aria-hidden />
          </span>
          <span key={`n-${cell.rows}`} className={cn("inline-block animate-rise font-mono text-sm tabular", cell.state === "withheld" && "line-through")}>
            {cell.rows || ""}
          </span>
          {cell.state !== "pending" && <span key={`r-${cell.state}`} aria-hidden className="pointer-events-none absolute -inset-px animate-settle rounded-md border-2 border-ink" />}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={6} collisionPadding={16} style={{ zIndex: "var(--z-popover)" }} className="w-72 rounded-lg border border-hairline bg-canvas p-4 text-sm shadow-4 animate-fade-in">
          <div className="font-semibold text-ink">
            {subjectLabel} / {columnLabel}
          </div>
          <div className="mt-1 inline-flex items-center gap-1.5 text-ink-2">
            <I size={14} aria-hidden /> {meta.label}: {meta.help}
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-y-1 text-xs">
            <dt className="text-muted">Evidence rows</dt>
            <dd className="font-mono tabular">{cell.rows}</dd>
            <dt className="text-muted">Claims supported</dt>
            <dd className="font-mono tabular">{cell.supported}</dd>
            <dt className="text-muted">Partly supported</dt>
            <dd className="font-mono tabular">{cell.partial}</dd>
            <dt className="text-muted">Unsupported</dt>
            <dd className="font-mono tabular">{cell.unsupported}</dd>
          </dl>
          {/* a live run's dossiers exist once S13 stored the brief: link its list, never the recorded review's route */}
          <Link href={live ? `/runs/${runId}/dossiers` : `/reviews/${runId}/dossiers/${cell.subject}`} className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
            {live ? "Open the dossiers" : "Open dossier"} <ArrowSquareOut size={12} aria-hidden />
          </Link>
          <Popover.Arrow className="fill-canvas" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The evidence matrix: one row per firm, one column per topic, each cell its evidence rows and state. */
export function Matrix({ view, runId, live, title = "Evidence matrix", compact = false }: { view: WarRoomSnapshot | null; runId: string; live: boolean; title?: string; compact?: boolean }) {
  if (!view) {
    // Same chrome and row rhythm as the loaded matrix, so the first snapshot does not shift the page.
    return (
      <section aria-labelledby="matrix-h" aria-busy="true" className="min-w-0 rounded-lg border border-hairline bg-canvas p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="matrix-h" className="text-lg font-semibold text-ink">
            {title}
          </h2>
        </div>
        <div className="h-6" />
        <div className="space-y-2">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="hatch h-12 rounded-md" />
          ))}
        </div>
        <p className="mt-3 text-xs text-muted">Waiting for the run&apos;s first snapshot.</p>
      </section>
    );
  }
  if (live && view.columns.length === 0) {
    const started = view.stages.S4 !== undefined;
    return (
      <section aria-labelledby="matrix-h" className="min-w-0 rounded-lg border border-dashed border-hairline-strong bg-canvas p-4">
        <h2 id="matrix-h" className="text-lg font-semibold text-ink">
          {title}
        </h2>
        <p className="mt-2 text-sm text-ink-2">
          {started ? "This run recorded no matrix topics, so there is no matrix to fill." : "The matrix fills once research starts (S4): one row per approved firm, one column per topic."}
        </p>
      </section>
    );
  }
  const rivals = view.laneOrder.filter((s) => !view.lanes[s]?.home);
  const home = view.laneOrder.filter((s) => view.lanes[s]?.home);
  const row = (subject: string) => {
    const lane = view.lanes[subject];
    return (
      <tr key={subject}>
        <th scope="row" className="whitespace-nowrap pr-3 text-left text-sm font-semibold text-ink">
          {lane?.home ? <>Us ({lane.label})</> : lane?.label}
        </th>
        {view.columns.map((c) => {
          const cell = view.cells[cellKey(subject, c.key)];
          return (
            <td key={c.key} className="p-1">
              {cell && <CellView cell={cell} runId={runId} live={live} subjectLabel={lane?.label ?? subject} columnLabel={c.label} />}
            </td>
          );
        })}
      </tr>
    );
  };
  return (
    <section aria-labelledby="matrix-h" className={cn("min-w-0 rounded-lg border border-hairline bg-canvas", compact ? "p-3" : "p-4")}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="matrix-h" className={cn("font-semibold text-ink", compact ? "text-base" : "text-lg")}>
          {title}
        </h2>
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-2" aria-label="Cell states: numbers are evidence rows per cell">
          {(Object.keys(CELL) as CellState[]).map((s) => {
            const I = CELL[s].icon;
            return (
              <li key={s} className="inline-flex items-center gap-1" title={CELL[s].help}>
                <I size={12} weight={s === "verified" ? "fill" : "regular"} aria-hidden /> {CELL[s].label}
              </li>
            );
          })}
        </ul>
      </div>
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[46rem] border-separate border-spacing-0">
          <thead>
            <tr>
              <th scope="col" className="sr-only">
                Firm
              </th>
              {view.columns.map((c) => (
                <th key={c.key} scope="col" className="px-1 pb-2 text-left text-xs font-medium text-muted">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rivals.map(row)}
            {home.length > 0 && (
              <tr aria-hidden>
                <td colSpan={view.columns.length + 1} className="py-1">
                  <div className="border-t border-dashed border-hairline-strong" />
                </td>
              </tr>
            )}
            {home.map(row)}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const FETCH_STATUS: Record<"ok" | "blocked" | "error", string> = { ok: "ok", blocked: "blocked by the source", error: "failed" };

/** Re-renders every `ms` while `on` (a wall clock for elapsed times; nothing runs when off). */
export function useNow(ms: number, on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms, on]);
  return now;
}

/** After this much silence inside a stage, say plainly that the stage records events as its calls finish. */
export const QUIET_NOTE_MS = 20_000;

/**
 * The stage working now and for how long, from the run's own recorded times: the War Room never looks frozen
 * while a long stage (one model call per dossier, say) has nothing new to record.
 */
export function WorkingNow({ store, at }: { store: WarRoomStore; at?: number | undefined }) {
  const working = store.status === "running" && store.currentStage !== null;
  // a replay passes its own clock (the recorded time at the cursor); live, the wall clock ticks
  const wall = useNow(1_000, working && at === undefined);
  const now = at ?? wall;
  if (!working || store.currentStage === null) return null;
  const st = STAGES.find((s) => s.id === store.currentStage);
  const started = store.stageStartedTs ? Date.parse(store.stageStartedTs) : NaN;
  const last = store.lastTs ? Date.parse(store.lastTs) : NaN;
  const quietMs = Number.isFinite(last) ? now - last : NaN;
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-hairline bg-surface px-4 py-2.5 text-sm" data-working-stage={store.currentStage}>
      <span className="inline-flex items-center gap-2 font-medium text-ink">
        <span aria-hidden className="size-2 animate-pulse-soft rounded-full bg-signal" />
        <span className="font-mono">{store.currentStage}</span> {st?.name ?? ""} working
      </span>
      {Number.isFinite(started) && <span className="font-mono text-ink-2 tabular">for {duration(now - started)}</span>}
      {Number.isFinite(quietMs) && quietMs >= 1_000 && <span className="text-muted">last event {duration(quietMs)} ago</span>}
      {Number.isFinite(quietMs) && quietMs >= QUIET_NOTE_MS && (
        <span className="basis-full text-xs text-muted sm:basis-auto">This stage records its events as each step completes; quiet stretches are model calls in flight.</span>
      )}
    </div>
  );
}

const LANE_STATUS: Record<Lane["status"], string> = {
  queued: "Waiting its turn",
  running: "Researching",
  done: "Done",
  degraded: "Done with gaps",
  ended: "Ended, no outcome recorded",
};

/** Evidence rows kept per firm: the sum of its matrix cells. */
export function laneRows(view: WarRoomSnapshot, subject: string): number {
  return view.columns.reduce((sum, c) => sum + (view.cells[cellKey(subject, c.key)]?.rows ?? 0), 0);
}

/** One research lane per firm: what it is doing, how many sources it fetched and how many rows it kept. */
export function Lanes({ view, title = "Research lanes" }: { view: WarRoomSnapshot | null; title?: string }) {
  return (
    <section aria-labelledby="lanes-h" className="rounded-lg border border-hairline bg-canvas p-4">
      <h2 id="lanes-h" className="mb-3 text-lg font-semibold text-ink">
        {title}
      </h2>
      {!view && (
        <ul className="space-y-2.5" aria-busy="true" aria-label="Loading lanes">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="hatch h-[2.475rem] rounded-md" />
          ))}
        </ul>
      )}
      {view && view.laneOrder.length === 0 && <p className="text-sm text-muted">Lanes open once the plan is approved (H1): one per firm.</p>}
      <ul className="space-y-2.5">
        {(view?.laneOrder ?? []).map((s) => {
          const lane = view?.lanes[s];
          if (!lane || !view) return null;
          const status = (
            <span key={lane.status} className={cn("inline-block animate-pop", lane.status === "degraded" ? "text-ink-2 underline decoration-dotted underline-offset-2" : "text-muted")}>
              {LANE_STATUS[lane.status]}
            </span>
          );
          return (
            <li key={s} className="min-w-0" data-lane-status={lane.status}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                <span
                  aria-hidden
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    lane.status === "running" && "animate-pulse-soft bg-signal",
                    lane.status === "done" && "bg-ink",
                    lane.status === "degraded" && "bg-ink-2",
                    (lane.status === "queued" || lane.status === "ended") && "border border-control",
                  )}
                />
                <span className="font-semibold text-ink">{lane.home ? `Us (${lane.label})` : lane.label}</span>
                {lane.status === "degraded" && lane.activity ? (
                  <Tip label={`Why: ${lane.activity}`}>
                    <button type="button" className="text-left">
                      {status}
                    </button>
                  </Tip>
                ) : (
                  status
                )}
                <span className="ml-auto font-mono text-xs text-ink-2 tabular">
                  <Flip value={lane.fetches} /> fetched, <Flip value={laneRows(view, s)} /> rows
                </span>
              </div>
              {lane.activity && (
                <div key={lane.activity} className="mt-0.5 animate-rise truncate pl-4 text-xs text-muted" title={lane.activity}>
                  {lane.activity}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** "14:02:11" in the viewer's time zone, for a recorded event time (empty when the time does not parse). */
function eventTime(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? timeOfDay(ms) : "";
}

/**
 * Newest first, scrolling inside its box through everything the store keeps (ACTIVITY_LIMIT). A reader who has
 * scrolled down stays on the item they were reading when new items arrive above it.
 */
export function Ticker({ feed, title = "Sources and verdicts" }: { feed: FeedItem[]; title?: string }) {
  const box = useRef<HTMLOListElement>(null);
  const anchor = useRef<{ seq: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const a = anchor.current;
    if (a && el.scrollTop > 0) {
      const kept = el.querySelector<HTMLElement>(`[data-seq="${a.seq}"]`);
      if (kept) el.scrollTop += kept.offsetTop - a.top;
    }
    const first = el.firstElementChild as HTMLElement | null;
    anchor.current = first ? { seq: Number(first.dataset.seq), top: first.offsetTop } : null;
  }, [feed]);
  // a recorded event without a display contract (CUSTOM: its type and stage only) is not listed for the analyst
  const shown = feed.filter((f) => f.kind !== "event");
  return (
    <section aria-labelledby="ticker-h" className="min-w-0 rounded-lg border border-hairline bg-canvas p-4">
      <h2 id="ticker-h" className="mb-3 text-lg font-semibold text-ink">
        {title}
      </h2>
      {shown.length === 0 ? (
        <p className="text-sm text-muted">Each source fetched and each claim checked appears here as it happens, newest first.</p>
      ) : (
        <ol ref={box} tabIndex={0} aria-label={`${shown.length} most recent items, newest first`} className="relative max-h-[22rem] space-y-1.5 overflow-y-auto overscroll-contain pr-1 [overflow-anchor:none]">
          {shown.map((f) => (
            <li key={f.seq} data-seq={f.seq} className="animate-rise text-xs">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 font-mono text-micro text-faint tabular">{eventTime(f.ts)}</span>
                {f.kind === "fetch" && f.fetch && (
                  <>
                    <span className="shrink-0 font-medium text-ink">{f.fetch.subject}</span>
                    <span className={cn("truncate font-mono", f.fetch.status === "ok" ? "text-ink-2" : "text-muted line-through decoration-hairline-strong")}>{f.fetch.host}</span>
                    {f.fetch.status !== "ok" && <span className={cn("shrink-0", f.fetch.status === "error" ? "text-danger" : "text-muted")}>{FETCH_STATUS[f.fetch.status]}</span>}
                    {tierLabel(f.fetch.tier) && <span className="ml-auto shrink-0 text-muted">{tierLabel(f.fetch.tier)}</span>}
                  </>
                )}
                {f.kind === "phase" && f.phase && <span className={cn("font-semibold text-ink", f.phase.edge === "failed" && "text-danger")}>{phaseLine(f.phase)}</span>}
                {f.kind === "verify" && f.verify && (
                  <>
                    <span className={cn("shrink-0 font-semibold", f.verify.verdict === "unsupported" ? "text-danger" : f.verify.verdict === "partially_supported" ? "text-ink-2" : "text-ink")}>
                      {f.verify.verdict === "supported" ? "Supported" : f.verify.verdict === "partially_supported" ? "Partly" : "Withheld"}
                    </span>
                    <span className="truncate text-ink-2">{f.verify.claim}</span>
                    {f.verify.laterCorrections && f.verify.laterCorrections.length > 0 && (
                      <span className="shrink-0 text-muted" title={`Corrected later: ${f.verify.laterCorrections.join(", ")}`}>
                        corrected later ({f.verify.laterCorrections.join(", ")})
                      </span>
                    )}
                  </>
                )}
                {f.kind === "stage" && f.stage && (
                  <span className="font-semibold text-ink">
                    {f.stage.id} {STEP_META[f.stage.id].name}{" "}
                    {f.stage.status === "not_built" ? "skipped on this run" : f.stage.status === "degraded" ? "done with gaps" : f.stage.status === "failed" ? "failed" : f.stage.edge}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
