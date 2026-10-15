"use client";

/**
 * The Bid Tower's heads-up display, above the scene: what is happening now in words, the replay controls (exact
 * time: one recorded second plays as one second at 1x) and the 18-step strip with each step's recorded status and
 * time. Below the scene: the event log and the legend.
 */
import { ArrowCounterClockwise, FastForward, Pause, Play } from "@phosphor-icons/react";
import { useState } from "react";

import { cn } from "@/lib/cn";
import { PHASES, STEP_META, isGate, type StepId } from "@/lib/pipeline/steps";
import type { RowStatus } from "@/lib/pipeline/rail";
import { shortName } from "@/lib/war-room/swarm";
import type { TowerFrame } from "@/lib/war-room/tower/frame";
import { clockLabel, seconds, type LogRow, type StripCell } from "@/lib/war-room/tower/world";

import { AvatarBadge, ROLE_NAME, ROLE_NOTE } from "../office-avatars";

export const SPEEDS = [1, 2, 4, 8, 16] as const;
export type Speed = (typeof SPEEDS)[number];

/* ------------------------------------------------------------------------------------------------ controls */

export interface ControlsProps {
  t: number;
  end: number;
  origin: number;
  playing: boolean;
  replaying: boolean;
  speed: Speed;
  sent: number;
  skip: { to: number; label: string } | null;
  onPlay: () => void;
  onPause: () => void;
  onScrub: (ms: number) => void;
  onSpeed: () => void;
  onFinal: () => void;
  /** Display time to the recorded time it shows: the clock reads recorded run time on a compressed replay. */
  back?: (display: number) => number;
}

export function Controls(p: ControlsProps) {
  const shown = Math.min(Number.isFinite(p.t) ? p.t : p.end, p.end);
  const step = 100;
  const back = p.back ?? ((d: number) => d);
  const label = (ms: number) => clockLabel(back(ms), back(p.origin));
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button
        type="button"
        onClick={p.playing ? p.onPause : p.onPlay}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline-strong px-3 font-medium text-ink hover:bg-surface"
      >
        {p.playing ? <Pause size={14} weight="fill" aria-hidden /> : <Play size={14} weight="fill" aria-hidden />}
        {p.playing ? "Pause" : p.replaying && shown < p.end ? "Resume" : "Replay the run"}
      </button>
      <input
        type="range"
        min={0}
        max={Math.ceil(p.end / step)}
        value={Math.round(shown / step)}
        onChange={(e) => p.onScrub(Number(e.currentTarget.value) * step)}
        aria-label="Tower replay position"
        aria-valuetext={`${label(shown)} run time, ${p.sent} messages sent`}
        className="w-36 accent-[var(--color-signal)] sm:w-56"
      />
      <span className="font-mono tabular text-muted">
        <span className="text-ink">{label(shown)}</span> / {label(p.end)}
      </span>
      <button type="button" onClick={p.onSpeed} aria-label={`Replay speed ${p.speed}x`} className="h-8 rounded-md border border-hairline px-2 font-mono tabular text-ink-2 hover:bg-surface">
        {p.speed}x
      </button>
      {p.skip && (
        <button type="button" onClick={() => p.onScrub(p.skip?.to ?? p.end)} className="inline-flex h-8 items-center gap-1 rounded-md border border-signal/50 bg-cream px-2 font-medium text-ink hover:bg-cream-deep">
          <FastForward size={14} aria-hidden />
          {p.skip.label}
        </button>
      )}
      {p.replaying && (
        <button type="button" onClick={p.onFinal} className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-ink-2 hover:bg-surface">
          <ArrowCounterClockwise size={14} aria-hidden />
          Final state
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ the strip */

const CELL_TONE: Partial<Record<RowStatus, string>> = {
  running: "border-signal bg-signal/10 text-ink",
  waiting: "border-signal bg-cream text-ink",
  done: "border-hairline-strong text-ink-2",
  approved: "border-hairline-strong text-ink-2",
  degraded: "border-cream-edge bg-cream-soft text-ink-2",
  failed: "border-danger/60 bg-danger-soft text-danger",
  not_built: "border-dashed border-hairline-strong text-faint",
  stopped: "border-danger/40 text-danger",
  not_started: "border-hairline text-faint",
};

export function StepStrip({ strip, current }: { strip: readonly StripCell[]; current: StepId | null }) {
  const byId = new Map(strip.map((c) => [c.id, c]));
  return (
    <ol className="flex min-w-0 flex-wrap items-stretch gap-x-2 gap-y-1.5" aria-label="Pipeline steps at this moment">
      {PHASES.map((phase) => (
        <li key={phase.id} className="flex min-w-0 flex-col gap-0.5">
          <span className="text-micro font-semibold uppercase tracking-[0.06em] text-faint">{phase.label}</span>
          <ol className="flex gap-0.5">
            {phase.steps.map((id) => {
              const c = byId.get(id);
              if (!c) return null;
              const now = id === current;
              return (
                <li
                  key={id}
                  aria-current={now ? "step" : undefined}
                  title={`${id} ${STEP_META[id].name}: ${c.label}${c.ms !== null ? `, ${seconds(c.ms)}` : ""}`}
                  className={cn("flex h-9 min-w-[2.6rem] flex-col justify-center rounded-sm border px-1 leading-none", CELL_TONE[c.status], now && "ring-1 ring-signal", "max-lg:[&:not([aria-current])]:hidden")}
                >
                  <span className={cn("font-mono text-[0.6875rem] font-semibold tabular", isGate(id) && "text-accent")}>{id}</span>
                  <span className="mt-0.5 truncate text-[0.625rem]">{c.status === "not_started" ? STEP_META[id].name : c.ms !== null ? seconds(c.ms) : c.label}</span>
                </li>
              );
            })}
          </ol>
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------------------------------------------ caption */

export function Caption({ mode, frame, lines }: { mode: "Live" | "Replay" | "Final state"; frame: TowerFrame; lines: string[] }) {
  const quiet =
    mode === "Final state"
      ? "Every recorded event of the run, settled."
      : frame.step
        ? `${frame.step} ${STEP_META[frame.step].name} is ${frame.strip.find((c) => c.id === frame.step)?.status === "waiting" ? "waiting for your call" : "running"}.`
        : mode === "Live"
          ? "Waiting for the next event."
          : "Between events.";
  return (
    <p className="line-clamp-2 min-h-10 min-w-0 flex-1 text-sm text-ink-2" aria-live="off">
      <span className="mr-2 font-semibold text-ink">{mode}</span>
      {lines.length ? lines.slice(0, 3).join("; ") + (lines.length > 3 ? `; and ${lines.length - 3} more` : "") : quiet}
    </p>
  );
}

/* ------------------------------------------------------------------------------------------------ the log */

export function EventLog({ rows, origin, onSeek, back = (d) => d }: { rows: readonly LogRow[]; origin: number; onSeek: ((ms: number) => void) | null; back?: (display: number) => number }) {
  const label = (r: LogRow) => (r.ts !== null && Number.isFinite(r.ts) ? clockLabel(r.ts, back(origin)) : clockLabel(back(r.at), back(origin)));
  const [all, setAll] = useState(false);
  const shown = all ? rows.slice(0, 400) : rows.slice(0, 6);
  return (
    <div className="border-t border-hairline px-4 py-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold text-ink">Event log</h3>
        <span className="font-mono text-micro text-faint tabular">{rows.length} recorded so far</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted">Nothing recorded yet at this moment.</p>
      ) : (
        <ol className={cn("flex flex-col text-xs", all && "max-h-72 overflow-y-auto")} aria-label="Recorded events, newest first">
          {shown.map((r) => {
            const body = (
              <>
                <span className="w-14 shrink-0 font-mono tabular text-faint">{label(r)}</span>
                <span className="w-12 shrink-0 font-mono font-semibold text-ink-2">{r.step}</span>
                <span className={cn("min-w-0 truncate", r.tone === "danger" ? "text-danger" : r.tone === "signal" ? "font-medium text-ink" : "text-ink-2")}>{r.text}</span>
              </>
            );
            return (
              <li key={r.id} className="border-b border-hairline-soft last:border-b-0">
                {onSeek && Number.isFinite(r.at) ? (
                  <button type="button" onClick={() => onSeek(Math.max(0, r.at - 300))} className="flex w-full items-baseline gap-2 py-0.5 text-left hover:bg-surface" aria-label={`Replay from ${label(r)}: ${r.step} ${r.text}`}>
                    {body}
                  </button>
                ) : (
                  <div className="flex items-baseline gap-2 py-0.5">{body}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {rows.length > 6 && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-1 text-xs font-medium text-accent hover:underline" aria-expanded={all}>
          {all ? "Show the latest six" : `Show all ${Math.min(rows.length, 400)}`}
        </button>
      )}
    </div>
  );
}

export function Legend({ pods }: { pods: { key: string; label: string; team: number }[] }) {
  const roles = ["researcher", "capture_lead", "pricing", "technical", "past_performance", "red_team", "analyst", "evaluator", "verifier"] as const;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hairline px-4 py-2.5">
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5" aria-label="Who is who">
        {roles.map((r) => (
          <li key={r} className="flex items-center gap-1.5 text-xs">
            <AvatarBadge role={r} team={r === "red_team" || r === "analyst" || r === "evaluator" || r === "verifier" ? -1 : 0} size={22} />
            <span>
              <span className="font-medium text-ink">{ROLE_NAME[r]}</span> <span className="text-muted">{ROLE_NOTE[r]}</span>
            </span>
          </li>
        ))}
      </ul>
      {pods.length > 0 && (
        <ul className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" aria-label="Team colours">
          {pods.map((p) => (
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
