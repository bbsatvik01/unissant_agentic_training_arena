/**
 * The office's companion characters: one original, code-drawn character per role, tinted by its team. Each is drawn
 * around its feet at (0, 0), facing the viewer, about 36 units tall, and themes through CSS variables (`--tint` is
 * the team colour). Animation is CSS only and keyed on the `data-activity` attribute of the wrapping group (see
 * `.office-agent` in globals.css): eyes blink when idle, hands type, legs step, the body hops when a message lands.
 */
import type { CSSProperties } from "react";

import type { Activity, Role } from "@/lib/war-room/office";

export const ROLE_NAME: Record<Role, string> = {
  researcher: "Researcher",
  capture_lead: "Capture lead",
  pricing: "Pricing",
  technical: "Technical",
  past_performance: "Past performance",
  red_team: "Red team",
  analyst: "Home analyst",
  evaluator: "Evaluator",
  verifier: "Verifier",
};

/** What each character stands for, in the legend. */
export const ROLE_NOTE: Record<Role, string> = {
  researcher: "S4 research lane",
  capture_lead: "the rival's strategy",
  pricing: "price posture",
  technical: "solution and staffing",
  past_performance: "contract record",
  red_team: "challenges every rival",
  analyst: "interviews the rivals",
  evaluator: "de-identified board",
  verifier: "S7 claim checks",
};

const OUTLINE = "color-mix(in oklab, var(--tint) 45%, var(--color-ink))";
const LIGHT = "color-mix(in oklab, var(--tint) 45%, var(--color-canvas))";

export function tintOf(role: Role, team: number): string {
  if (team >= 0) return `var(--color-team-${team})`;
  if (role === "red_team") return "var(--color-office-red)";
  if (role === "analyst" || role === "researcher") return "var(--color-office-home)";
  if (role === "evaluator") return "var(--color-office-board)";
  return "var(--color-office-verify)";
}

/** The body outline of each role: the silhouette is what makes a character readable at small size. */
const BODY: Record<Role, string> = {
  // a tall bean
  capture_lead: "M-10,-2 C-11.5,-14 -9,-27 0,-28 C9,-27 11.5,-14 10,-2 C7,0.6 -7,0.6 -10,-2Z",
  // a round little thing
  pricing: "M-11,-3 C-12.5,-15 -7,-23 0,-23 C7,-23 12.5,-15 11,-3 C8,0.6 -8,0.6 -11,-3Z",
  // a rounded box
  technical: "M-10,-5 L-10,-21 Q-10,-27 -4,-27 L4,-27 Q10,-27 10,-21 L10,-5 Q10,0 4,0 L-4,0 Q-10,0 -10,-5Z",
  // an owl with ear tufts
  past_performance: "M-10,-2 C-12,-12 -11.5,-21 -8.5,-24.5 L-9.5,-31 L-4,-26.2 C-1.5,-27 1.5,-27 4,-26.2 L9.5,-31 L8.5,-24.5 C11.5,-21 12,-12 10,-2 C7,0.6 -7,0.6 -10,-2Z",
  // a bean with tall pointed ears
  researcher: "M-9.5,-2 C-11,-13 -10,-21 -8,-23.5 L-10.5,-34 L-3.5,-25.6 C-1.2,-26.2 1.2,-26.2 3.5,-25.6 L10.5,-34 L8,-23.5 C10,-21 11,-13 9.5,-2 C7,0.6 -7,0.6 -9.5,-2Z",
  // a bean (the horns and tail are accessories)
  red_team: "M-10,-2 C-11.5,-13 -9,-25 0,-25.5 C9,-25 11.5,-13 10,-2 C7,0.6 -7,0.6 -10,-2Z",
  // round, wearing a headset
  analyst: "M-10.5,-2.5 C-12,-14 -8,-24.5 0,-24.5 C8,-24.5 12,-14 10.5,-2.5 C8,0.6 -8,0.6 -10.5,-2.5Z",
  // tall and narrow, with a flat cap
  evaluator: "M-9,-2 C-10,-14 -8.5,-27 0,-27.5 C8.5,-27 10,-14 9,-2 C6.5,0.6 -6.5,0.6 -9,-2Z",
  // a dome
  verifier: "M-11,-2 C-11.5,-12 -9,-23.5 0,-23.5 C9,-23.5 11.5,-12 11,-2 C8,0.6 -8,0.6 -11,-2Z",
};

/** Eye height per role (the face sits a little higher on the tall characters). */
const EYE_Y: Record<Role, number> = {
  capture_lead: -18,
  pricing: -15,
  technical: -18,
  past_performance: -17,
  researcher: -16.5,
  red_team: -16.5,
  analyst: -16,
  evaluator: -18,
  verifier: -15,
};

function Behind({ role }: { role: Role }) {
  switch (role) {
    case "pricing":
      return (
        <g fill="var(--tint)" stroke={OUTLINE} strokeWidth={1.1}>
          <circle cx={-7.2} cy={-21.5} r={3.6} />
          <circle cx={7.2} cy={-21.5} r={3.6} />
          <circle cx={-7.2} cy={-21.5} r={1.6} fill={LIGHT} stroke="none" />
          <circle cx={7.2} cy={-21.5} r={1.6} fill={LIGHT} stroke="none" />
        </g>
      );
    case "red_team":
      return <path d="M9,-5 C15,-6 15.5,-12 13.5,-15 L16.5,-14.6 L14.6,-17.6 L12.6,-14.8" fill="none" stroke={OUTLINE} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />;
    default:
      return null;
  }
}

function Accessory({ role }: { role: Role }) {
  switch (role) {
    case "capture_lead":
      return (
        <g>
          <line x1={0} y1={-28} x2={1.4} y2={-36} stroke={OUTLINE} strokeWidth={1.2} strokeLinecap="round" />
          <path d="M1.4,-36 L9,-33.6 L1.9,-31.2Z" fill="var(--color-signal)" />
          <path d="M-1.6,-9.5 L1.6,-9.5 L0.9,-4.4 L0,-3.4 L-0.9,-4.4Z" fill={OUTLINE} />
        </g>
      );
    case "pricing":
      return (
        <g>
          <circle cx={0} cy={-7.6} r={4.1} fill="var(--color-cream-deep)" stroke="var(--color-cream-edge)" strokeWidth={1} />
          <text x={0} y={-5.5} textAnchor="middle" className="fill-ink font-mono" fontSize={6} fontWeight={700}>
            $
          </text>
        </g>
      );
    case "technical":
      return (
        <g>
          <line x1={0} y1={-27} x2={0} y2={-32.5} stroke={OUTLINE} strokeWidth={1.2} />
          <circle cx={0} cy={-34} r={2.2} fill="var(--color-signal)" />
          <rect x={-7.5} y={-21.2} width={15} height={6.6} rx={3.3} fill="var(--color-office-device)" />
          <circle cx={-3} cy={-7} r={1} fill={OUTLINE} />
          <circle cx={0} cy={-7} r={1} fill={OUTLINE} />
          <circle cx={3} cy={-7} r={1} fill={OUTLINE} />
        </g>
      );
    case "past_performance":
      return (
        <g>
          <path d="M-1.2,-14.4 L1.2,-14.4 L0,-12.4Z" fill="var(--color-cream-edge)" />
          <path d="M-4,-8 L-2,-6.4 L0,-8 L2,-6.4 L4,-8" fill="none" stroke={OUTLINE} strokeWidth={0.9} strokeLinecap="round" />
        </g>
      );
    case "researcher":
      return (
        <g>
          <path d="M-3.5,-25.6 L-8.6,-31.4 L-6.6,-24.4Z M3.5,-25.6 L8.6,-31.4 L6.6,-24.4Z" fill={LIGHT} />
          <path d="M-7,-14 L7,-4" stroke={OUTLINE} strokeWidth={1.2} />
          <rect x={4.4} y={-7} width={5.4} height={4.4} rx={1.2} fill="var(--color-cream-edge)" stroke={OUTLINE} strokeWidth={0.8} />
        </g>
      );
    case "red_team":
      return (
        <g fill="var(--color-danger)">
          <path d="M-6.4,-23.6 C-8.4,-26 -8.6,-29 -7.6,-31.2 C-6,-28.8 -4.2,-26.6 -3.2,-25Z" />
          <path d="M6.4,-23.6 C8.4,-26 8.6,-29 7.6,-31.2 C6,-28.8 4.2,-26.6 3.2,-25Z" />
        </g>
      );
    case "analyst":
      return (
        <g fill="none" stroke="var(--color-ink-2)" strokeWidth={1.6} strokeLinecap="round">
          <path d="M-9.6,-15 C-10,-25 10,-25 9.6,-15" />
          <rect x={-11.6} y={-17.6} width={3.4} height={6} rx={1.4} fill="var(--color-ink-2)" stroke="none" />
          <rect x={8.2} y={-17.6} width={3.4} height={6} rx={1.4} fill="var(--color-ink-2)" stroke="none" />
          <path d="M9.6,-12 C8,-9 5,-9.4 3.4,-10.6" strokeWidth={1.1} />
        </g>
      );
    case "evaluator":
      return (
        <g>
          <path d="M-9.6,-28.6 L0,-32.4 L9.6,-28.6 L0,-24.8Z" fill="var(--color-office-device)" />
          <rect x={-5} y={-27.6} width={10} height={2.6} fill="var(--color-office-device)" />
          <path d="M0,-28.6 L6.8,-27.4 L6.8,-22.8" fill="none" stroke="var(--color-signal)" strokeWidth={1} strokeLinecap="round" />
        </g>
      );
    case "verifier":
      return (
        <g>
          <path d="M-9.4,-17.4 C-9.4,-25.4 9.4,-25.4 9.4,-17.4Z" fill="var(--color-office-device)" />
          <path d="M5,-17.6 L14,-16.4 L13.6,-15.2 L5,-15.8Z" fill="var(--color-office-device)" />
        </g>
      );
  }
}

function Face({ role }: { role: Role }) {
  const y = EYE_Y[role];
  const owl = role === "past_performance";
  const visor = role === "technical";
  const eye = visor ? "var(--color-office-glint)" : "var(--color-ink)";
  return (
    <g className="office-face">
      {owl && (
        <g fill={LIGHT} stroke="var(--color-ink)" strokeWidth={1}>
          <circle cx={-3.9} cy={y} r={3.5} />
          <circle cx={3.9} cy={y} r={3.5} />
          <line x1={-0.5} y1={y} x2={0.5} y2={y} />
        </g>
      )}
      <g className="office-eyes">
        <ellipse cx={-3.7} cy={y} rx={visor ? 1.5 : 1.35} ry={visor ? 1.1 : 1.85} fill={eye} />
        <ellipse cx={3.7} cy={y} rx={visor ? 1.5 : 1.35} ry={visor ? 1.1 : 1.85} fill={eye} />
      </g>
      {role === "red_team" && (
        <path d={`M-6,${y - 3.4} L-2,${y - 2.2} M6,${y - 3.4} L2,${y - 2.2}`} stroke="var(--color-ink)" strokeWidth={1} strokeLinecap="round" />
      )}
      {!visor && (
        <>
          <circle cx={-6.6} cy={y + 3.6} r={1.6} fill="var(--color-signal)" opacity={0.28} />
          <circle cx={6.6} cy={y + 3.6} r={1.6} fill="var(--color-signal)" opacity={0.28} />
        </>
      )}
      {role !== "past_performance" && (
        <path className="office-mouth" d={`M-1.7,${y + 4} Q0,${y + 5.6} 1.7,${y + 4}`} fill="none" stroke="var(--color-ink)" strokeWidth={1} strokeLinecap="round" />
      )}
    </g>
  );
}

/**
 * One character. `facing="back"` hides the face (the agent is turned to the web terminal). `seated` hides the legs
 * (the desk covers them). `carrying` puts a document in its hands; `holding` a magnifier (at the terminal) or a
 * stamp (the verifier at work). `paper` (the Playhouse style) cuts it out as a paper puppet: one paper keyline
 * stroke under the body and a stick under the feet.
 */
export function Avatar({
  role,
  team,
  activity = "idle",
  facing = "front",
  seated = true,
  carrying = false,
  blinkDelay = 0,
  paper = false,
}: {
  role: Role;
  team: number;
  activity?: Activity;
  facing?: "front" | "back";
  seated?: boolean;
  carrying?: boolean;
  blinkDelay?: number;
  paper?: boolean;
}) {
  const style = { "--tint": tintOf(role, team), "--blink-delay": `${blinkDelay}ms` } as CSSProperties;
  return (
    <g className="office-agent" data-activity={activity} data-facing={facing} style={style}>
      {paper && <rect x={-1.1} y={-2} width={2.2} height={10} rx={1} className="fill-ink" opacity={0.55} />}
      <ellipse cx={0} cy={0.5} rx={10} ry={3.4} className="fill-ink" opacity={0.12} />
      {!seated && (
        <g fill={OUTLINE}>
          <rect className="office-leg-l" x={-5.2} y={-4.2} width={3.4} height={5} rx={1.6} />
          <rect className="office-leg-r" x={1.8} y={-4.2} width={3.4} height={5} rx={1.6} />
        </g>
      )}
      <g className="office-body">
        {paper && <path d={BODY[role]} fill="none" stroke="var(--color-stage-paper)" strokeWidth={5} strokeLinejoin="round" />}
        <Behind role={role} />
        <path d={BODY[role]} fill="var(--tint)" stroke={OUTLINE} strokeWidth={1.2} strokeLinejoin="round" />
        {facing === "front" && role !== "technical" && <ellipse cx={0} cy={-7.5} rx={5.6} ry={4.6} fill={LIGHT} opacity={0.75} />}
        <Accessory role={role} />
        {facing === "front" && <Face role={role} />}
        <g className="office-hands" fill="var(--tint)" stroke={OUTLINE} strokeWidth={1}>
          <circle className="office-hand-l" cx={-8.4} cy={-10.5} r={2.4} />
          <circle className="office-hand-r" cx={8.4} cy={-10.5} r={2.4} />
        </g>
        {carrying && (
          <g className="office-doc">
            <path d="M-4.6,-15.5 L2.6,-15.5 L4.6,-13.5 L4.6,-5.5 L-4.6,-5.5Z" fill="var(--color-canvas)" stroke="var(--color-ink-2)" strokeWidth={0.9} />
            <path d="M-2.6,-12.4 L2.4,-12.4 M-2.6,-10.2 L2.4,-10.2 M-2.6,-8 L0.8,-8" stroke="var(--color-faint)" strokeWidth={0.8} />
          </g>
        )}
        {activity === "browsing" && (
          <g className="office-lens" fill="none" stroke="var(--color-ink-2)" strokeWidth={1.3} strokeLinecap="round">
            <circle cx={11.5} cy={-21} r={3.4} fill="color-mix(in oklab, var(--color-canvas) 60%, transparent)" />
            <line x1={9.2} y1={-18.6} x2={7.6} y2={-14.6} strokeWidth={1.8} />
          </g>
        )}
      </g>
      {activity === "typing" && (
        <g className="office-dots" fill="var(--color-ink-2)">
          <circle cx={-4} cy={-41} r={1.4} />
          <circle cx={0} cy={-41} r={1.4} />
          <circle cx={4} cy={-41} r={1.4} />
        </g>
      )}
    </g>
  );
}

/** An empty place for a role whose agent has no card yet: its silhouette as a dashed outline (no animation). */
export function AvatarOutline({ role }: { role: Role }) {
  return <path d={BODY[role]} fill="none" stroke="var(--color-hairline-strong)" strokeWidth={1.1} strokeDasharray="2.6 2.2" strokeLinejoin="round" />;
}

/** A small, static badge of a role for legends and the hover card (no animation, no shadow). */
export function AvatarBadge({ role, team, size = 28 }: { role: Role; team: number; size?: number }) {
  const style = { "--tint": tintOf(role, team) } as CSSProperties;
  return (
    <svg width={size} height={size} viewBox="-15 -38 30 40" aria-hidden className="shrink-0 overflow-visible">
      <g style={style} className="office-agent" data-activity="still">
        <Behind role={role} />
        <path d={BODY[role]} fill="var(--tint)" stroke={OUTLINE} strokeWidth={1.2} strokeLinejoin="round" />
        {role !== "technical" && <ellipse cx={0} cy={-7.5} rx={5.6} ry={4.6} fill={LIGHT} opacity={0.75} />}
        <Accessory role={role} />
        <Face role={role} />
      </g>
    </svg>
  );
}
