"use client";

/**
 * Drawing parts of the case board (office-styles/case-board.tsx): paper, push pins, label-maker tape, polaroids,
 * stamps and glyphs, all in the board's SVG units (viewBox 1280 x 800). Paper and ink come from the board's scoped
 * tokens (--cb-* in globals.css), so light and dark both hold.
 */
import { Bank, Buildings, EyeSlash, FileText, Globe, Newspaper, SealCheck, Warning, type Icon } from "@phosphor-icons/react";
import type { KeyboardEvent, ReactNode } from "react";

import { cn } from "@/lib/cn";
import type { SourceTier } from "@/lib/contracts/run-events";
import { restAngle, type Rect } from "@/lib/war-room/case-board";
import type { Activity, Role, Verdict } from "@/lib/war-room/office";

import { Avatar, tintOf } from "../office-avatars";

/** A shadow that stays dark in both themes (a device colour does not invert with the page). */
export const SHADOW = "var(--color-office-device-2)";

export function teamColour(team: number): string {
  return team >= 0 ? `var(--color-team-${team})` : "var(--color-office-board)";
}

/** Paper: a card face with a soft offset shadow (a second rect, no filter). */
export function Paper({ r, fill = "var(--cb-paper)", stroke = "var(--cb-edge)", dash, radius = 1.6, lift = 1 }: { r: Rect; fill?: string; stroke?: string; dash?: string; radius?: number; lift?: number }) {
  return (
    <>
      {lift > 0 && <rect x={r.x + 1.5 * lift} y={r.y + 2.5 * lift} width={r.w} height={r.h} rx={radius} fill={SHADOW} opacity={0.1} />}
      <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={radius} fill={fill} stroke={stroke} strokeWidth={0.75} strokeDasharray={dash} />
    </>
  );
}

/** A push pin seen from above. */
export function PinHead({ x, y, colour, size = 4 }: { x: number; y: number; colour: string; size?: number }) {
  return (
    <g aria-hidden className="pointer-events-none">
      <circle cx={x + 1.1} cy={y + 1.7} r={size} fill={SHADOW} opacity={0.22} />
      <circle cx={x} cy={y} r={size} fill={colour} stroke={`color-mix(in oklab, ${colour} 50%, var(--color-office-device-2))`} strokeWidth={0.8} />
      <circle cx={x - size * 0.3} cy={y - size * 0.33} r={size * 0.3} fill="var(--color-office-glint)" opacity={0.65} />
    </g>
  );
}

/** Where a card hangs from: the centre of its top edge, a little in. */
export function pinOf(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + 4.5 };
}

/**
 * A pinned card: its rest angle on the outer group (it hangs from its pin, so the pin never moves) and the filing
 * animation on the inner group, so the two transforms never fight.
 */
export function Pinned({
  id,
  r,
  angle,
  fresh = false,
  pin,
  children,
  fill,
  stroke,
  dash,
  lift,
}: {
  id: string;
  r: Rect;
  angle?: number | undefined;
  fresh?: boolean;
  pin?: string | null;
  children?: ReactNode;
  fill?: string;
  stroke?: string | undefined;
  dash?: string;
  lift?: number;
}) {
  const a = angle ?? restAngle(id);
  const p = pinOf(r);
  return (
    <g transform={a ? `rotate(${a} ${p.x} ${p.y})` : undefined}>
      <g className={fresh ? "animate-pin" : undefined}>
        <Paper r={r} {...(fill ? { fill } : {})} {...(stroke ? { stroke } : {})} {...(dash ? { dash } : {})} {...(lift !== undefined ? { lift } : {})} />
        {children}
        {pin && <PinHead x={p.x} y={p.y} colour={pin} />}
      </g>
    </g>
  );
}

/** Label-maker tape: an ink strip with light lettering (the clock and stage chips). */
export function Tape({ r, children, fill = "var(--cb-tape)" }: { r: Rect; children?: ReactNode; fill?: string }) {
  return (
    <g>
      <rect x={r.x + 1} y={r.y + 1.6} width={r.w} height={r.h} rx={1.6} fill={SHADOW} opacity={0.14} />
      <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={1.6} fill={fill} />
      <rect x={r.x + 2} y={r.y + 1.2} width={r.w - 4} height={0.8} rx={0.4} fill="var(--cb-tape-text)" opacity={0.12} />
      {children}
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ glyphs */

export const TIER_ICON: Record<SourceTier, Icon> = { federal_primary: Bank, sec_filing: FileText, company_owned: Buildings, news: Newspaper, other: Globe };
export const TIER_LABEL: Record<SourceTier, string> = { federal_primary: "federal record", sec_filing: "SEC filing", company_owned: "company site", news: "news", other: "other source" };

export const VERDICT_WORD: Record<Verdict, string> = { supported: "SUPPORTED", partly: "PARTLY", withheld: "WITHHELD" };
export const VERDICT_LABEL: Record<Verdict, string> = { supported: "supported", partly: "partly supported", withheld: "withheld" };

/** The War Room's verdict glyphs: a filled seal for supported, a warning for partly, a slashed eye (danger) for
 *  withheld. Every verdict also carries its word. */
export function VerdictGlyph({ verdict, x, y, size }: { verdict: Verdict; x: number; y: number; size: number }) {
  if (verdict === "supported") return <SealCheck x={x} y={y} size={size} weight="fill" className="text-ink" aria-hidden />;
  if (verdict === "partly") return <Warning x={x} y={y} size={size} weight="bold" className="text-ink-2" aria-hidden />;
  return <EyeSlash x={x} y={y} size={size} weight="bold" className="text-danger" aria-hidden />;
}

/** A rubber-stamp impression: the verdict word (and its count) in a double rule, tilted, in ink or danger. */
export function StampMark({ x, y, verdict, count, fresh, faded = false }: { x: number; y: number; verdict: Verdict; count: number; fresh: boolean; faded?: boolean }) {
  const word = VERDICT_WORD[verdict];
  const label = count > 1 ? `${word} x${count}` : word;
  const w = label.length * 7.9 + 16;
  const h = 20;
  const tone = verdict === "withheld" ? "var(--color-danger)" : "var(--color-ink-2)";
  return (
    <g transform={`rotate(-8 ${x + w / 2} ${y + h / 2})`} opacity={faded ? 0.42 : 0.9}>
      <g className={fresh ? "animate-slam" : undefined}>
        <rect x={x} y={y} width={w} height={h} rx={2} fill="none" stroke={tone} strokeWidth={1.6} />
        <rect x={x + 2.4} y={y + 2.4} width={w - 4.8} height={h - 4.8} rx={1} fill="none" stroke={tone} strokeWidth={0.7} />
        <text x={x + w / 2} y={y + 14} textAnchor="middle" className="font-mono" fontSize={12} fontWeight={700} letterSpacing={0.6} fill={tone}>
          {label}
        </text>
      </g>
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ polaroids */

export interface PolaroidState {
  present: boolean;
  activity: Activity;
  /** Model time so far on the call in flight (ms), shown on the caption. */
  workingMs: number | null;
  /** The S4 researcher is out reading sources (a burst of fetches). */
  field: boolean;
  /** A message just landed. */
  received: boolean;
}

const POLAROID_ACTIVITY: Partial<Record<Activity, Activity>> = { typing: "typing", sending: "sending", receiving: "receiving" };

/**
 * A crew polaroid: the agent's companion character in team tint, dashed and empty until its card is recorded. While a
 * model call is in flight its edge lights and the caption counts the call's model time.
 */
export function Polaroid({
  r,
  role,
  team,
  state,
  caption,
  fresh,
  focused,
  interactive,
  label,
  onActivate,
  onHover,
  pin,
}: {
  r: Rect;
  role: Role;
  team: number;
  state: PolaroidState;
  caption: string;
  fresh: boolean;
  focused: boolean;
  interactive: boolean;
  label: string;
  onActivate: () => void;
  onHover: (on: boolean) => void;
  pin: string;
}) {
  const photo = { x: r.x + 3, y: r.y + 3, w: r.w - 6, h: Math.min(r.w - 6, r.h - 13) };
  const working = state.activity === "typing" || state.workingMs !== null;
  const scale = photo.h / 37;
  if (!state.present) {
    return (
      <g aria-hidden>
        <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={1.6} fill="none" stroke="var(--cb-edge)" strokeWidth={0.9} strokeDasharray="2.4 2" />
      </g>
    );
  }
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onActivate();
    }
  };
  return (
    <g
      role={interactive ? "button" : "img"}
      tabIndex={0}
      aria-label={label}
      {...(interactive ? { "aria-pressed": focused } : {})}
      onClick={interactive ? onActivate : undefined}
      onKeyDown={interactive ? keys : undefined}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
      className={cn("outline-none", interactive && "cursor-pointer")}
      data-cb-polaroid={role}
    >
      <g transform={`rotate(${restAngle(`polaroid:${r.x}:${r.y}`) * 0.6} ${r.x + r.w / 2} ${r.y + 4})`}>
        <g className={fresh ? "animate-pin" : undefined}>
          {working && <rect x={r.x - 2.6} y={r.y - 2.6} width={r.w + 5.2} height={r.h + 5.2} rx={3} fill="var(--color-signal)" opacity={0.2} />}
          <Paper r={r} stroke={working || focused ? "var(--color-signal)" : "var(--cb-edge)"} />
          {(working || focused) && <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={1.6} fill="none" stroke="var(--color-signal)" strokeWidth={focused ? 2 : 1.5} />}
          <rect x={photo.x} y={photo.y} width={photo.w} height={photo.h} fill={`color-mix(in oklab, ${tintOf(role, team)} 20%, var(--cb-paper-2))`} />
          <g transform={`translate(${photo.x + photo.w / 2} ${photo.y + photo.h - 0.5}) scale(${scale})`}>
            <Avatar role={role} team={team} activity={POLAROID_ACTIVITY[state.activity] ?? "idle"} blinkDelay={hashDelay(`${r.x}:${r.y}`)} />
          </g>
          <text x={r.x + r.w / 2} y={r.y + r.h - 3.4} textAnchor="middle" className={cn("font-mono", working ? "fill-accent" : "fill-muted")} fontSize={6.6} fontWeight={working ? 700 : 500} letterSpacing={0.3}>
            {caption}
          </text>
          <PinHead x={r.x + r.w / 2} y={r.y + 2.2} colour={pin} size={2.8} />
        </g>
      </g>
      {state.field && (
        <g aria-hidden>
          <Tape r={{ x: r.x - 7, y: r.y + r.h - 12, w: r.w + 14, h: 10 }}>
            <text x={r.x + r.w / 2} y={r.y + r.h - 4.6} textAnchor="middle" fontSize={6.6} fontWeight={700} letterSpacing={0.4} fill="var(--cb-tape-text)">
              IN THE FIELD
            </text>
          </Tape>
        </g>
      )}
      {state.received && <circle cx={r.x + r.w - 1} cy={r.y + 1} r={3.2} className="fill-signal animate-pop" aria-hidden />}
    </g>
  );
}

function hashDelay(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 5200;
  return h;
}

/** A role's word on a polaroid caption. */
export const CAPTION: Record<Role, string> = {
  researcher: "RESEARCH",
  pricing: "PRICING",
  technical: "TECHNICAL",
  past_performance: "PAST PERF",
  capture_lead: "CAPTURE",
  red_team: "RED TEAM",
  analyst: "ANALYST",
  evaluator: "EVALUATOR",
  verifier: "VERIFIER",
};

/* ------------------------------------------------------------------------------------------------ text */

/** SVG lines from a wrapped list (one tspan per line). */
export function Lines({ x, y, lines, step, className, fontSize, fontWeight, anchor = "start" }: { x: number; y: number; lines: readonly string[]; step: number; className?: string; fontSize: number; fontWeight?: number; anchor?: "start" | "middle" | "end" }) {
  return (
    <text x={x} y={y} className={className} fontSize={fontSize} fontWeight={fontWeight} textAnchor={anchor}>
      {lines.map((l, i) => (
        <tspan key={i} x={x} dy={i === 0 ? 0 : step}>
          {l}
        </tspan>
      ))}
    </text>
  );
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}
