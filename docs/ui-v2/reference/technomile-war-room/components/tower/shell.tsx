"use client";

/**
 * The Bid Tower's building, drawn once per layout: the sky band and skyline, the outer walls and slabs, each room's
 * back wall and windows, the lift shaft and its landings, the brass tube network, the riser conduit and the fixed
 * furniture. Everything that changes with the run (people, lamps, screens, props, the cabin, capsules) is drawn by
 * the stage above it. Colours are product tokens and the scene's --tower-* environment colours.
 */
import { memo, type ReactNode } from "react";

import type { PhaseId } from "@/lib/pipeline/steps";
import { CABIN_H, CRT, PARTITION_X, TRAY_X, X, type Row, type TowerLayout } from "@/lib/war-room/tower/layout";

/** Sky colours per phase: morning, late morning, noon, late afternoon, dusk (light); evening into night (dark). */
export const SKY: Record<PhaseId, { light: [string, string]; dark: [string, string] }> = {
  intake: { light: ["#cfe4f2", "#eef5f9"], dark: ["#2a3a5c", "#41557a"] },
  research: { light: ["#bfdcf0", "#e9f3fa"], dark: ["#2f4a6e", "#4f6f96"] },
  verify: { light: ["#c6def0", "#f1f4f2"], dark: ["#3a4f73", "#6b7fa0"] },
  wargame: { light: ["#f2cf9f", "#fbe8cd"], dark: ["#4a3a5a", "#8a6a7a"] },
  decide: { light: ["#b9a7d1", "#efd1c2"], dark: ["#10182a", "#1f2a44"] },
};
export const PHASE_IDS: readonly PhaseId[] = ["intake", "research", "verify", "wargame", "decide"];

/** Windows on a room's back wall: [x0, width]. */
function windowsFor(row: Row, layout: TowerLayout): [number, number][] {
  if (row.kind === "rival") return [[214, 40], [526, 34], [816, 40], [1088, 40]];
  if (row.kind === "upper") return [[120, 40], [552, 34], [626, 36], [1100, 34]];
  if (row.kind === "ground") return [[442, 30], [930, 34], [1104, 34]];
  if (row.index === layout.roof) return [];
  return [];
}

export function SkyGradients({ theme }: { theme: "light" | "dark" }) {
  return (
    <defs>
      {PHASE_IDS.map((p) => {
        const [top, bottom] = SKY[p][theme];
        return (
          <linearGradient key={p} id={`tw-sky-${p}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={top} />
            <stop offset="1" stopColor={bottom} />
          </linearGradient>
        );
      })}
      <linearGradient id="tw-cone" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="var(--tower-lamp)" stopOpacity="1" />
        <stop offset="1" stopColor="var(--tower-lamp)" stopOpacity="0" />
      </linearGradient>
      <linearGradient id="tw-glass" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="var(--tower-glass-edge)" stopOpacity="0.5" />
        <stop offset="0.5" stopColor="var(--tower-glass-edge)" stopOpacity="0.08" />
        <stop offset="1" stopColor="var(--tower-glass-edge)" stopOpacity="0.3" />
      </linearGradient>
      <linearGradient id="tw-riser" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stopColor="var(--color-signal)" stopOpacity="0.95" />
        <stop offset="1" stopColor="var(--color-signal)" stopOpacity="0.55" />
      </linearGradient>
    </defs>
  );
}

function roomTint(row: Row, x0: number, x1: number, tint: string | null, key: string): ReactNode {
  return <rect key={key} x={x0} y={row.top} width={x1 - x0} height={row.floor - row.top} style={{ fill: tint ? `color-mix(in oklab, ${tint}, var(--tower-wall))` : "var(--tower-wall)" }} />;
}

/** One back-wall window showing the sky of the current phase. */
function Window({ x, y, w, h, phase }: { x: number; y: number; w: number; h: number; phase: PhaseId }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={2} fill={`url(#tw-sky-${phase})`} />
      <rect x={x} y={y} width={w} height={h} rx={2} fill="none" stroke="var(--tower-window-frame)" strokeWidth={2} />
      <line x1={x + w / 2} y1={y} x2={x + w / 2} y2={y + h} stroke="var(--tower-window-frame)" strokeWidth={1.2} />
      <line x1={x + 3} y1={y + h - 3} x2={x + w * 0.4} y2={y + 3} stroke="var(--color-canvas)" strokeOpacity={0.45} strokeWidth={1.2} />
    </g>
  );
}

/** A side-view desk: top, front panel and a 3/4 monitor at the agent's right. */
export function DeskFront({ x, floor, wide = false }: { x: number; floor: number; wide?: boolean }) {
  const w0 = wide ? 26 : 20;
  const w1 = wide ? 36 : 30;
  return (
    <g>
      <rect x={x - w0} y={floor - 14} width={w0 + w1} height={4} rx={1.5} className="fill-canvas stroke-hairline-strong" strokeWidth={1} />
      <rect x={x - w0 + 2} y={floor - 10} width={w0 + w1 - 4} height={10} className="fill-surface-2 stroke-hairline-strong" strokeWidth={1} />
      <line x1={x - w0 + 6} y1={floor - 6} x2={x + w1 - 6} y2={floor - 6} className="stroke-hairline" strokeWidth={1} />
    </g>
  );
}

export function Chair({ x, floor }: { x: number; floor: number }) {
  return <rect x={x - 10} y={floor - 34} width={20} height={22} rx={7} className="fill-surface-2 stroke-hairline-strong" strokeWidth={1} />;
}

const Pipe = ({ x1, y1, x2, y2, w = 3.2 }: { x1: number; y1: number; x2: number; y2: number; w?: number }) => (
  <g>
    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--tower-brass-dark)" strokeWidth={w + 1.4} strokeLinecap="round" />
    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--tower-brass)" strokeWidth={w} strokeLinecap="round" />
    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--tower-brass-hi)" strokeWidth={0.9} strokeLinecap="round" strokeOpacity={0.8} transform={x1 === x2 ? "translate(-0.8 0)" : "translate(0 -0.8)"} />
  </g>
);

/** A tiny skyline: deterministic boxes, two depths. */
function Skyline({ w, base }: { w: number; base: number }) {
  const far: ReactNode[] = [];
  const near: ReactNode[] = [];
  let x = 0;
  let i = 0;
  while (x < w) {
    const bw = 34 + ((i * 37) % 46);
    const bh = 28 + ((i * 53) % 52);
    far.push(<rect key={`f${i}`} x={x} y={base - bh} width={bw} height={bh} />);
    x += bw + 6;
    i += 1;
  }
  x = 18;
  i = 0;
  while (x < w) {
    const bw = 26 + ((i * 29) % 34);
    const bh = 14 + ((i * 41) % 30);
    near.push(<rect key={`n${i}`} x={x} y={base - bh} width={bw} height={bh} />);
    x += bw + 22 + ((i * 17) % 30);
    i += 1;
  }
  return (
    <g aria-hidden>
      <g style={{ fill: "var(--tower-skyline-2)" }}>{far}</g>
      <g style={{ fill: "var(--tower-skyline)" }}>{near}</g>
    </g>
  );
}

export const Shell = memo(function Shell({ layout, phase, theme, known }: { layout: TowerLayout; phase: PhaseId; theme: "light" | "dark"; known: string }) {
  // a rival floor is furnished and tinted only once its rival is named (`known`: the named pod keys, "|"-joined)
  const named = new Set(known ? known.split("|") : []);
  const rows = layout.rows.map((r) => (r.kind === "rival" && r.pod !== null && !named.has(r.pod) ? { ...r, pod: null } : r));
  const roof = rows[layout.roof] as Row;
  const ground = rows[layout.ground] as Row;
  const basement = rows[layout.basement] as Row;
  const top = (rows[layout.upper] as Row).top;
  const bottom = basement.bottom;
  const trunkTop = roof.pipe;
  const trunkBottom = (rows[layout.rivalRows.at(-1) ?? layout.upper] as Row).pipe;
  const teamOf = (pod: string | null) => {
    if (!pod) return null;
    const i = layout.rivalRows.findIndex((r) => layout.rows[r]?.pod === pod);
    return i >= 0 ? i % 6 : null;
  };

  return (
    <svg viewBox={`0 0 ${layout.w} ${layout.h}`} aria-hidden className="block" shapeRendering="geometricPrecision">
      <SkyGradients theme={theme} />
      {/* the sky band behind the roof, one layer per phase (cross-faded by the stage) */}
      {PHASE_IDS.map((p) => (
        <rect key={p} className="tw-sky" x={0} y={0} width={layout.w} height={roof.bottom} fill={`url(#tw-sky-${p})`} opacity={p === phase ? 1 : 0} />
      ))}
      <Skyline w={layout.w} base={roof.floor + 2} />
      {/* ground outside the building, below the street */}
      <rect x={0} y={ground.floor} width={layout.w} height={layout.h - ground.floor} style={{ fill: "var(--tower-ground)" }} />

      {/* outer shell */}
      <rect x={X.wallL} y={top - 4} width={X.wallR + 8 - X.wallL} height={bottom - top + 8} style={{ fill: "var(--tower-shell)" }} />

      {/* rooms: back walls */}
      {rows.map((row) => {
        if (row.kind === "roof") return null;
        const parts: ReactNode[] = [];
        if (row.kind === "rival") {
          const team = teamOf(row.pod);
          const tint = team !== null ? `var(--color-team-${team}) 16%` : null;
          parts.push(roomTint(row, X.in0, X.in1, tint, "open"));
          if (team !== null) parts.push(<rect key="office" x={PARTITION_X} y={row.top} width={810 - PARTITION_X} height={row.floor - row.top} style={{ fill: `color-mix(in oklab, var(--color-team-${team}) 26%, var(--tower-wall))` }} />);
        } else if (row.kind === "upper") {
          parts.push(roomTint(row, X.in0, 600, "var(--color-danger) 8%", "red"), roomTint(row, 600, X.in1, "var(--color-cream-deep) 70%", "home"));
        } else if (row.kind === "ground") {
          parts.push(
            roomTint(row, X.in0, 424, "var(--color-cream) 60%", "lobby"),
            roomTint(row, 424, 604, null, "dossier"),
            roomTint(row, 604, 904, "var(--color-office-verify) 22%", "notary"),
            roomTint(row, 904, X.in1, "var(--color-cream-deep) 40%", "ledger"),
          );
        } else {
          parts.push(roomTint(row, X.in0, 644, "var(--color-cream-edge) 22%", "archive"), roomTint(row, 644, X.in1, "var(--color-ink) 7%", "machine"));
        }
        return (
          <g key={row.index}>
            {parts}
            {windowsFor(row, layout).map(([x, w]) => (
              <Window key={x} x={x} y={row.top + 18} w={w} h={20} phase={phase} />
            ))}
            {/* the floor: carpet or tile strip, then the slab */}
            <rect x={X.in0} y={row.floor - 3} width={X.in1 - X.in0} height={3} style={{ fill: "color-mix(in oklab, var(--color-ink) 10%, var(--tower-wall))" }} />
            <rect x={X.wallL} y={row.floor} width={X.wallR + 8 - X.wallL} height={row.bottom - row.floor} style={{ fill: "var(--tower-slab)" }} />
          </g>
        );
      })}

      {/* room partitions */}
      {rows.map((row) => {
        const walls: number[] = row.kind === "upper" ? [600] : row.kind === "ground" ? [424, 604, 904] : row.kind === "basement" ? [644] : [];
        return walls.map((x) => <rect key={`${row.index}:${x}`} x={x - 2} y={row.top} width={4} height={row.floor - row.top} style={{ fill: "var(--tower-shell)" }} />);
      })}
      {/* the capture lead's glass office on each rival floor */}
      {layout.rivalRows.map((r) => {
        const row = rows[r] as Row;
        if (!row.pod) return null;
        return (
          <g key={`glass${r}`}>
            <rect x={PARTITION_X - 1.5} y={row.top + 6} width={3} height={row.floor - row.top - 6} style={{ fill: "var(--tower-glass-edge)" }} />
            <rect x={PARTITION_X + 1.5} y={row.top + 6} width={8} height={row.floor - row.top - 6} fill="url(#tw-glass)" />
            <rect x={808} y={row.top + 6} width={3} height={row.floor - row.top - 6} style={{ fill: "var(--tower-glass-edge)" }} />
          </g>
        );
      })}

      {/* the lift shaft: a dark well with rails, and a landing door on every floor */}
      <rect x={X.shaft0} y={top - 4} width={X.shaft1 - X.shaft0} height={bottom - top + 4} style={{ fill: "var(--tower-shaft)" }} />
      <line x1={X.shaft0 + 5} y1={top} x2={X.shaft0 + 5} y2={bottom} className="stroke-hairline-strong" strokeWidth={1.2} />
      <line x1={X.shaft1 - 5} y1={top} x2={X.shaft1 - 5} y2={bottom} className="stroke-hairline-strong" strokeWidth={1.2} />
      {rows.map((row) => {
        if (row.kind === "roof") return null;
        return (
          <g key={`landing${row.index}`}>
            <rect x={X.shaft1} y={row.floor - CABIN_H - 2} width={6} height={CABIN_H + 2} style={{ fill: "var(--tower-shell)" }} />
            <rect x={X.shaft1 + 1} y={row.floor - CABIN_H + 2} width={4} height={CABIN_H - 2} className="fill-surface-2" />
            <circle cx={X.shaft1 + 3} cy={row.floor - CABIN_H - 6} r={2} className="fill-hairline-strong" />
          </g>
        );
      })}

      {/* the roof: the slab, the shaft's headhouse, the penthouse glass and table, the deck's railing */}
      <rect x={X.wallL} y={roof.floor} width={X.wallR + 8 - X.wallL} height={roof.bottom - roof.floor} style={{ fill: "var(--tower-slab)" }} />
      <rect x={X.shaft0 - 4} y={roof.floor - 46} width={X.shaft1 - X.shaft0 + 12} height={46} rx={2} style={{ fill: "var(--tower-shell)" }} />
      <circle cx={X.cabin} cy={roof.floor - 26} r={9} fill="none" style={{ stroke: "var(--tower-brass)" }} strokeWidth={2.4} />
      <circle cx={X.cabin} cy={roof.floor - 26} r={2} style={{ fill: "var(--tower-brass)" }} />
      <Penthouse roof={roof} />
      <Deck roof={roof} />

      {/* the brass tube trunk and each floor's ceiling pipe */}
      <Pipe x1={X.trunk} y1={trunkTop} x2={X.trunk} y2={trunkBottom} w={4.2} />
      <Pipe x1={X.trunk} y1={roof.pipe} x2={600} y2={roof.pipe} />
      <Pipe x1={layout.table.x} y1={roof.pipe} x2={layout.table.x} y2={layout.table.y - 6} w={2.4} />
      {rows
        .filter((r) => r.kind === "upper" || (r.kind === "rival" && r.pod))
        .map((row) => (
          <Pipe key={`pipe${row.index}`} x1={X.trunk} y1={row.pipe} x2={X.in1 - 10} y2={row.pipe} />
        ))}
      {Object.values(layout.seats)
        .filter((s) => {
          const row = rows[s.row];
          return row && (row.kind === "upper" || (row.kind === "rival" && row.pod));
        })
        .map((s) => {
          const row = rows[s.row] as Row;
          return (
            <g key={`drop${s.id}`}>
              <Pipe x1={s.station.x} y1={row.pipe} x2={s.station.x} y2={s.station.y - 3} w={2.2} />
              <rect x={s.station.x - 4} y={s.station.y - 4} width={8} height={7} rx={2} style={{ fill: "var(--tower-brass)", stroke: "var(--tower-brass-dark)" }} strokeWidth={0.8} />
            </g>
          );
        })}

      {/* the riser conduit up the right wall */}
      <rect x={X.riser - 3} y={roof.floor - 4} width={6} height={basement.floor - roof.floor + 4} rx={2} className="fill-surface-2 stroke-hairline-strong" strokeWidth={1} />

      {/* fixed furniture */}
      <Ground row={ground} />
      <Basement row={basement} layout={layout} />
      {layout.rivalRows.map((r) => {
        const row = rows[r] as Row;
        return row.pod ? <RivalFixtures key={`fx${r}`} row={row} /> : <Vacant key={`fx${r}`} row={row} />;
      })}
      <UpperFixtures row={rows[layout.upper] as Row} />
    </svg>
  );
});

function Penthouse({ roof }: { roof: Row }) {
  const y0 = roof.top + 44;
  const f = roof.floor;
  return (
    <g>
      <rect x={X.in0} y={y0} width={640 - X.in0} height={f - y0} style={{ fill: "color-mix(in oklab, var(--color-office-board) 18%, var(--tower-wall))" }} opacity={0.9} />
      <rect x={X.in0} y={y0} width={640 - X.in0} height={f - y0} fill="url(#tw-glass)" />
      <rect x={X.in0 - 4} y={y0 - 5} width={640 - X.in0 + 8} height={6} rx={2} style={{ fill: "var(--tower-shell)" }} />
      {[X.in0, 230, 368, 506, 640].map((x) => (
        <rect key={x} x={x - 1.5} y={y0} width={3} height={f - y0} style={{ fill: "var(--tower-glass-edge)" }} />
      ))}
    </g>
  );
}

function Deck({ roof }: { roof: Row }) {
  const f = roof.floor;
  return (
    <g>
      {/* railing */}
      <line x1={652} y1={f - 18} x2={X.in1 + 8} y2={f - 18} className="stroke-hairline-strong" strokeWidth={2} />
      {Array.from({ length: 21 }, (_, i) => 656 + i * 24.8).map((x) => (
        <line key={x} x1={x} y1={f - 18} x2={x} y2={f} className="stroke-hairline-strong" strokeWidth={1.2} />
      ))}
      {/* the H2 podium and the bell post */}
      <path d={`M688,${f} L692,${f - 30} L716,${f - 30} L720,${f} Z`} style={{ fill: "var(--tower-wood)" }} className="stroke-hairline-strong" strokeWidth={1} />
      <rect x={686} y={f - 34} width={36} height={5} rx={1.5} style={{ fill: "var(--tower-wood-dark)" }} />
      <line x1={736} y1={f} x2={736} y2={f - 62} className="stroke-ink-2" strokeWidth={2} />
      <line x1={736} y1={f - 62} x2={752} y2={f - 62} className="stroke-ink-2" strokeWidth={2} />
      {/* S11 counters board, S12 scale, S13 press, S14 lens, S15 chute: their bases */}
      <path d={`M780,${f} L792,${f - 40} L804,${f}`} fill="none" className="stroke-ink-2" strokeWidth={1.6} />
      <line x1={870} y1={f} x2={870} y2={f - 40} className="stroke-ink-2" strokeWidth={2} />
      <rect x={858} y={f - 4} width={24} height={4} rx={1} className="fill-ink-2" />
      <rect x={932} y={f - 24} width={40} height={24} rx={2} className="fill-surface-2 stroke-hairline-strong" strokeWidth={1} />
      <line x1={1030} y1={f} x2={1030} y2={f - 28} className="stroke-ink-2" strokeWidth={2} />
      <path d={`M1092,${f - 44} L1122,${f - 44} L1116,${f} L1098,${f} Z`} className="fill-surface-2 stroke-hairline-strong" strokeWidth={1} />
    </g>
  );
}

function RivalFixtures({ row }: { row: Row }) {
  const f = row.floor;
  return (
    <g>
      {/* the in-tray table beside the capture lead's office */}
      <rect x={TRAY_X - 16} y={f - 18} width={32} height={3} rx={1} style={{ fill: "var(--tower-wood)" }} />
      <line x1={TRAY_X - 12} y1={f - 15} x2={TRAY_X - 12} y2={f} className="stroke-hairline-strong" strokeWidth={1.4} />
      <line x1={TRAY_X + 12} y1={f - 15} x2={TRAY_X + 12} y2={f} className="stroke-hairline-strong" strokeWidth={1.4} />
      {/* a plant by the far wall */}
      <rect x={1120} y={f - 12} width={14} height={12} rx={2} style={{ fill: "var(--tower-wood-dark)" }} />
      <ellipse cx={1127} cy={f - 20} rx={10} ry={9} style={{ fill: "color-mix(in oklab, #4f8a5b 70%, var(--tower-wall))" }} />
    </g>
  );
}

function Vacant({ row }: { row: Row }) {
  return (
    <g>
      <rect x={X.in0} y={row.top} width={X.in1 - X.in0} height={row.floor - row.top} className="fill-surface-2" opacity={0.7} />
      <line x1={X.in0 + 20} y1={row.floor - 2} x2={X.in1 - 20} y2={row.top + 12} className="stroke-hairline" strokeWidth={1} strokeDasharray="4 6" />
    </g>
  );
}

function UpperFixtures({ row }: { row: Row }) {
  const f = row.floor;
  return (
    <g>
      {/* the red team's war board */}
      <rect x={436} y={row.top + 12} width={136} height={34} rx={2} className="fill-canvas" style={{ stroke: "color-mix(in oklab, var(--color-danger) 45%, transparent)" }} strokeWidth={1.5} />
      {/* the interview board (cork) */}
      <rect x={850} y={row.top + 10} width={236} height={38} rx={2} style={{ fill: "color-mix(in oklab, #c49a6c 55%, var(--tower-wall))", stroke: "var(--tower-wood-dark)" }} strokeWidth={1.5} />
      <rect x={1104} y={f - 12} width={14} height={12} rx={2} style={{ fill: "var(--tower-wood-dark)" }} />
      <ellipse cx={1111} cy={f - 20} rx={10} ry={9} style={{ fill: "color-mix(in oklab, #4f8a5b 70%, var(--tower-wall))" }} />
    </g>
  );
}

function Ground({ row }: { row: Row }) {
  const f = row.floor;
  const t = row.top;
  return (
    <g>
      {/* the street doors */}
      <rect x={X.in0 + 2} y={f - 50} width={32} height={50} rx={2} style={{ fill: "var(--tower-glass-edge)" }} opacity={0.5} />
      <rect x={X.in0 + 4} y={f - 48} width={13} height={48} fill="url(#tw-glass)" />
      <rect x={X.in0 + 19} y={f - 48} width={13} height={48} fill="url(#tw-glass)" />
      {/* lobby props: the dial's face, the mail slot, the lineage frame, the registry cabinet, the planning table */}
      <circle cx={152} cy={t + 30} r={14} className="fill-canvas stroke-hairline-strong" strokeWidth={1.5} />
      <rect x={184} y={t + 22} width={26} height={6} rx={2} className="fill-ink-2" />
      <rect x={180} y={f - 22} width={34} height={22} rx={2} className="fill-surface-2 stroke-hairline-strong" strokeWidth={1} />
      <rect x={230} y={t + 14} width={44} height={32} rx={2} className="fill-canvas" style={{ stroke: "var(--tower-wood-dark)" }} strokeWidth={2} />
      <path d={`M240,${t + 38} L252,${t + 24} L264,${t + 38} M252,${t + 24} L252,${t + 20}`} fill="none" className="stroke-hairline-strong" strokeWidth={1.2} />
      <rect x={292} y={f - 44} width={36} height={44} rx={2} style={{ fill: "var(--tower-wood)", stroke: "var(--tower-wood-dark)" }} strokeWidth={1} />
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={295} y={f - 41 + i * 10} width={30} height={8} rx={1} style={{ fill: "var(--tower-wood-dark)" }} opacity={0.5} />
      ))}
      <rect x={346} y={f - 20} width={60} height={4} rx={1.5} style={{ fill: "var(--tower-wood)" }} />
      <line x1={352} y1={f - 16} x2={352} y2={f} className="stroke-hairline-strong" strokeWidth={1.6} />
      <line x1={400} y1={f - 16} x2={400} y2={f} className="stroke-hairline-strong" strokeWidth={1.6} />
      {/* the notary booth: counter and window frame; the conveyor and its trays */}
      <rect x={662} y={t + 12} width={110} height={4} className="fill-hairline-strong" />
      <rect x={662} y={t + 12} width={4} height={f - t - 30} className="fill-hairline-strong" />
      <rect x={768} y={t + 12} width={4} height={f - t - 30} className="fill-hairline-strong" />
      <rect x={786} y={f - 16} width={104} height={5} rx={2.5} className="fill-ink-2" opacity={0.75} />
      {[796, 824, 852, 880].map((x) => (
        <circle key={x} cx={x} cy={f - 13.5} r={1.4} className="fill-surface-2" />
      ))}
      <line x1={792} y1={f - 11} x2={792} y2={f} className="stroke-hairline-strong" strokeWidth={1.6} />
      <line x1={884} y1={f - 11} x2={884} y2={f} className="stroke-hairline-strong" strokeWidth={1.6} />
      {/* the dossier presses' frames */}
      {[470, 552].map((x) => (
        <g key={x}>
          <rect x={x - 22} y={f - 40} width={44} height={40} rx={3} className="fill-surface-2 stroke-hairline-strong" strokeWidth={1.2} />
          <rect x={x - 16} y={f - 12} width={32} height={6} rx={1} className="fill-canvas stroke-hairline" strokeWidth={1} />
        </g>
      ))}
      {/* the price-to-win ledger desk */}
      <rect x={968} y={f - 18} width={84} height={4} rx={1.5} style={{ fill: "var(--tower-wood)" }} />
      <rect x={972} y={f - 14} width={76} height={14} style={{ fill: "var(--tower-wood-dark)" }} opacity={0.8} />
    </g>
  );
}

function Basement({ row, layout }: { row: Row; layout: TowerLayout }) {
  const f = row.floor;
  return (
    <g>
      {/* carrels: a desk against the back wall, a CRT and a dot-matrix printer */}
      {layout.carrels.map((c) => (
        <g key={c.slot}>
          <rect x={c.x - 30} y={f - 22} width={60} height={4} rx={1.5} style={{ fill: "var(--tower-wood)" }} />
          <rect x={c.x - 28} y={f - 18} width={56} height={18} style={{ fill: "var(--tower-wood-dark)" }} opacity={0.6} />
          <rect x={c.x - 3} y={f - CRT.bottom} width={6} height={CRT.bottom - 22} className="fill-hairline-strong" />
          <rect x={c.x - CRT.half} y={f - CRT.top} width={CRT.half * 2} height={CRT.top - CRT.bottom} rx={4} className="fill-surface-2 stroke-hairline-strong" strokeWidth={1.2} />
          <rect x={c.x - CRT.screenHalf} y={f - CRT.screenTop} width={CRT.screenHalf * 2} height={CRT.screenTop - CRT.screenBottom} rx={3} style={{ fill: "var(--tower-crt)" }} />
          <rect x={c.x + 16} y={f - 29} width={14} height={7} rx={1.5} className="fill-surface-2 stroke-hairline-strong" strokeWidth={1} />
          <line x1={c.x + 18} y1={f - 26} x2={c.x + 28} y2={f - 26} className="stroke-hairline-strong" strokeWidth={0.8} />
        </g>
      ))}
      {/* filing cabinets (S5 rows) */}
      {[598, 624].map((x) => (
        <g key={x}>
          <rect x={x - 11} y={f - 46} width={22} height={46} rx={2} className="fill-surface-2 stroke-hairline-strong" strokeWidth={1} />
          {[0, 1, 2].map((i) => (
            <line key={i} x1={x - 4} y1={f - 38 + i * 15} x2={x + 4} y2={f - 38 + i * 15} className="stroke-hairline-strong" strokeWidth={1.6} />
          ))}
        </g>
      ))}
      {/* server racks */}
      {layout.racks.map((r) => (
        <g key={r.slot}>
          <rect x={r.x - 24} y={f - 60} width={48} height={60} rx={3} className="fill-ink-2" opacity={0.92} />
          <rect x={r.x - 20} y={f - 56} width={40} height={50} rx={2} style={{ fill: "var(--tower-shaft)" }} />
        </g>
      ))}
    </g>
  );
}
