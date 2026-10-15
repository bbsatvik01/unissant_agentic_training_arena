"use client";

/**
 * The Bid Tower's moving layer, over the static shell: every desk with its agent, the rooms' working parts (lamps,
 * CRTs, the notary's stamp and trays, the presses, the racks, the riser, the gates, the roof's props), the lift
 * cabin with its riders, and the capsules in the brass tubes.
 *
 * React draws it at the frame rate of the run's data (the parent re-renders about every 100 ms). Between those
 * renders one requestAnimationFrame loop moves the walkers, the cabin and the capsules by writing transforms through
 * refs, from the same display clock; it runs only while something moves and stops when the scene is hidden or
 * unmounted.
 */
import { memo, useCallback, useEffect, useRef, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { pointAlong, type Activity, type Pt, type Role, type Verdict } from "@/lib/war-room/office";
import type { TowerFrame } from "@/lib/war-room/tower/frame";
import { CABIN_H, CABIN_W, CRT, TRAY_X, X, type Row, type TowerLayout } from "@/lib/war-room/tower/layout";
import { cabinAt, easeInOut, type LiftPlan } from "@/lib/war-room/tower/route";
import type { RackPlan } from "@/lib/war-room/tower/world";

import { Avatar } from "../office-avatars";

import { Chair, DeskFront } from "./shell";

/* ------------------------------------------------------------------------------------------------ motion */

type Place = (t: number) => Pt | null;

export interface Motion {
  register: (id: string, el: SVGGElement | null, place: Place) => void;
}

/** One animation-frame loop for every moving thing: each registers its element and how to place it at a time. */
export function useMotion(now: () => number, active: boolean): Motion {
  const movers = useRef(new Map<string, { el: SVGGElement; place: Place }>());
  const write = useCallback((t: number) => {
    for (const m of movers.current.values()) {
      const p = m.place(t);
      if (p) m.el.setAttribute("transform", `translate(${round(p.x)} ${round(p.y)})`);
    }
  }, []);
  const register = useCallback(
    (id: string, el: SVGGElement | null, place: Place) => {
      if (el) {
        movers.current.set(id, { el, place });
        const p = place(now());
        if (p) el.setAttribute("transform", `translate(${round(p.x)} ${round(p.y)})`);
      } else movers.current.delete(id);
    },
    [now],
  );
  useEffect(() => {
    write(now());
    if (!active) return;
    let raf = 0;
    const step = () => {
      write(now());
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [active, now, write]);
  return { register };
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}

function useMover(motion: Motion, id: string, place: Place) {
  const placeRef = useRef(place);
  useEffect(() => {
    placeRef.current = place;
  });
  return useCallback((el: SVGGElement | null) => motion.register(id, el, (t) => placeRef.current(t)), [motion, id]);
}

/* ------------------------------------------------------------------------------------------------ the stage */

export interface SeatInfo {
  id: string;
  role: Role;
  team: number;
  /** Dimmed: outside the thread filter's focus. */
  dim: boolean;
  /** Selected as the thread filter. */
  on: boolean;
}

export interface StageProps {
  layout: TowerLayout;
  frame: TowerFrame;
  lift: LiftPlan;
  racks: RackPlan;
  seats: SeatInfo[];
  reduced: boolean;
  motion: Motion;
  /** The seat being hovered or focused (its desk lamp brightens). */
  hover: string | null;
  /** H2: the brief is on the podium once S13 has finished. */
  briefReady: boolean;
  /** Challenges sent so far (the red team's war board marks). */
  challenges: number;
  /** The S6 presses run while S6 model calls are in flight (or while S6 runs, when no calls are known). */
  pressesRunning: boolean;
}

export function Stage(props: StageProps) {
  const { layout, frame, seats, reduced, motion } = props;
  const rows = layout.rows;
  const roof = rows[layout.roof] as Row;
  const ground = rows[layout.ground] as Row;
  const basement = rows[layout.basement] as Row;
  return (
    <svg viewBox={`0 0 ${layout.w} ${layout.h}`} aria-hidden className="block">
      <Lamps layout={layout} lamps={frame.lamps} alarm={frame.alarm} />
      <Riser layout={layout} rows={frame.riser} />
      <Racks layout={layout} frame={frame} racks={props.racks} basement={basement} />
      <Gate x={X.door - 2} row={basement} state={frame.gates.h1.state} />
      <Carrels layout={layout} frame={frame} basement={basement} reduced={reduced} />
      <LobbyProps layout={layout} frame={frame} ground={ground} />
      <Presses ground={ground} running={props.pressesRunning} />
      <Ledger ground={ground} on={frame.running.includes("S8")} done={frame.finished.S8 !== undefined} />
      <DeckProps roof={roof} frame={frame} briefReady={props.briefReady} />
      <WarBoard row={rows[layout.upper] as Row} challenges={props.challenges} />
      <InTrays layout={layout} frame={frame} />
      {seats.map((s) => {
        const spot = layout.seats[s.id];
        const a = frame.agents[s.id];
        if (!spot || !a) return null;
        const row = rows[spot.row] as Row;
        return (
          <SeatView
            key={s.id}
            id={s.id}
            x={spot.x}
            floor={row.floor}
            furniture={spot.furniture}
            role={s.role}
            team={s.team}
            seated={a.placement === "seat"}
            present={a.present}
            activity={a.activity}
            dim={s.dim}
            on={s.on}
            joinedAt={a.placement === "seat" && a.joinedAt !== null && frame.t - a.joinedAt < 600 && !reduced ? a.joinedAt : null}
            stamping={s.role === "verifier" && frame.stamping}
          />
        );
      })}
      <Booth ground={ground} frame={frame} />
      <BoardTable roof={roof} lit={frame.scores} />
      {/* people away from their desks: walking, waiting at a landing, reading at a carrel */}
      {seats.map((s) => {
        const a = frame.agents[s.id];
        if (!a || a.placement !== "move" || !a.leg || a.leg.kind === "cabin") return null;
        return <Walker key={`w-${s.id}`} id={s.id} role={s.role} team={s.team} leg={a.leg} activity={a.activity} facing={a.facing} carrying={a.carrying} motion={motion} dim={s.dim} />;
      })}
      <Cabin layout={layout} lift={props.lift} frame={frame} seats={seats} motion={motion} reduced={reduced} />
      {frame.tubes.map((path, i) => (
        <polyline key={`tube${i}`} points={path.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="var(--color-signal)" strokeWidth={3.4} strokeLinejoin="round" opacity={0.75} />
      ))}
      {frame.capsules.map((c) => (
        <Capsule key={c.id} id={c.id} path={c.path} start={c.start} end={c.end} kind={c.kind} failed={c.failed} motion={motion} />
      ))}
      {frame.moreCapsules > 0 && (
        <g transform={`translate(${X.trunk} ${(rows[layout.upper] as Row).pipe + 12})`}>
          <rect x={-10} y={-5} width={20} height={10} rx={5} className="fill-ink" />
          <text x={0} y={3} textAnchor="middle" className="fill-on-ink font-mono" fontSize={7} fontWeight={700}>
            +{frame.moreCapsules}
          </text>
        </g>
      )}
    </svg>
  );
}

/* ------------------------------------------------------------------------------------------------ lamps and the riser */

const ROOM_LAMPS: { room: string; xs: number[] }[] = [
  { room: "penthouse", xs: [250, 382, 514] },
  { room: "deck", xs: [] },
  { room: "red", xs: [240, 400] },
  { room: "home", xs: [700, 900] },
  { room: "lobby", xs: [200, 330] },
  { room: "dossier", xs: [512] },
  { room: "notary", xs: [716] },
  { room: "ledger", xs: [1010] },
  { room: "archive", xs: [190, 350, 500] },
  { room: "machine", xs: [800, 1000] },
];

function rowOfRoom(layout: TowerLayout, room: string): Row | null {
  const r = layout.rooms.find((x) => x.id === room);
  return r ? (layout.rows[r.row] ?? null) : null;
}

const Lamps = memo(function Lamps({ layout, lamps, alarm }: { layout: TowerLayout; lamps: TowerFrame["lamps"]; alarm: TowerFrame["alarm"] }) {
  const items: ReactNode[] = [];
  const cone = (key: string, x: number, row: Row, level: number, roofTop = false) => {
    const y0 = roofTop ? row.top + 50 : row.top + 3;
    const y1 = row.floor;
    const spread = (y1 - y0) * 0.75;
    items.push(
      <g key={key}>
        <rect className="tw-fixture" x={x - 7} y={y0 - 1} width={14} height={3} rx={1.5} style={{ fill: level > 0 ? "var(--tower-lamp)" : "var(--color-hairline-strong)" }} />
        <path
          className="tw-cone"
          d={`M${x - 6},${y0 + 2} L${x + 6},${y0 + 2} L${x + spread / 2},${y1} L${x - spread / 2},${y1} Z`}
          fill="url(#tw-cone)"
          style={{ opacity: level === 2 ? "var(--tower-lamp-on)" : level === 1 ? "var(--tower-lamp-dim)" : 0 }}
        />
      </g>,
    );
  };
  for (const { room, xs } of ROOM_LAMPS) {
    const row = rowOfRoom(layout, room);
    if (!row) continue;
    const level = lamps[room as keyof typeof lamps] ?? 0;
    xs.forEach((x, i) => cone(`${room}${i}`, x, row, level, room === "penthouse"));
  }
  for (const r of layout.rivalRows) {
    const row = layout.rows[r] as Row;
    if (!row.pod) continue;
    const level = lamps[`floor:${row.pod}`] ?? 0;
    [234, 420, 690, 950].forEach((x, i) => cone(`f${r}:${i}`, x, row, level));
  }
  const alarmRow = alarm ? rowOfRoom(layout, alarm.room) : null;
  const alarmRoom = alarm ? layout.rooms.find((x) => x.id === alarm.room) : null;
  return (
    <g>
      {items}
      {alarm && alarmRow && alarmRoom && (
        <g key={alarm.at}>
          <rect className="tw-alarm" x={alarmRoom.x0} y={alarmRow.top} width={alarmRoom.x1 - alarmRoom.x0} height={alarmRow.floor - alarmRow.top} fill="var(--color-danger)" opacity={0.18} />
          <circle className="tw-alarm" cx={alarmRoom.x0 + 14} cy={alarmRow.top + 10} r={5} fill="var(--color-danger)" />
        </g>
      )}
    </g>
  );
});

function Riser({ layout, rows }: { layout: TowerLayout; rows: number[] }) {
  const roof = layout.rows[layout.roof] as Row;
  const basement = layout.rows[layout.basement] as Row;
  const topRow = rows[0];
  if (topRow === undefined) return null;
  const top = Math.max(roof.floor - 4, (layout.rows[topRow] as Row).top + 8);
  return (
    <g>
      <rect x={X.riser - 2} y={top} width={4} height={basement.floor - top} rx={2} fill="url(#tw-riser)" className="tw-screen" />
      {rows.map((r) => {
        const row = layout.rows[r] as Row;
        return <circle key={r} cx={X.riser} cy={Math.max(row.top + 14, roof.floor - 10)} r={4} fill="var(--color-signal)" stroke="var(--color-canvas)" strokeWidth={1.4} />;
      })}
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ B1 */

const LED_COLS = 4;

function Racks({ layout, frame, racks, basement }: { layout: TowerLayout; frame: TowerFrame; racks: RackPlan; basement: Row }) {
  const f = basement.floor;
  const lit = new Map<string, { free: boolean; failed: boolean }>();
  for (const c of frame.calls.inFlight) {
    const slot = racks.slotOf.get(c.id) ?? -1;
    if (slot >= 0) lit.set(`${racks.rackOf(c.endpoint)}:${slot}`, { free: c.free, failed: false });
  }
  for (const c of frame.calls.failing) {
    const slot = racks.slotOf.get(c.id) ?? -1;
    if (slot >= 0) lit.set(`${racks.rackOf(c.endpoint)}:${slot}`, { free: c.free, failed: true });
  }
  return (
    <g>
      {layout.racks.map((r) => {
        // a rack is in use once its endpoint's first call has started
        const used = frame.scene.endpoints.some((e) => racks.rackOf(e) === r.slot);
        return (
          <g key={r.slot} opacity={used ? 1 : 0.35}>
            {Array.from({ length: 24 }, (_, i) => {
              const cx = r.x - 13 + (i % LED_COLS) * 8.7;
              const cy = f - 50 + Math.floor(i / LED_COLS) * 7.6;
              const on = lit.get(`${r.slot}:${i}`);
              if (!on) return <circle key={i} cx={cx} cy={cy} r={2.3} style={{ fill: "var(--tower-led-off)" }} />;
              if (on.failed) return <circle key={i} cx={cx} cy={cy} r={2.6} fill="var(--color-danger)" />;
              return on.free ? (
                <circle key={i} className="tw-led-busy" cx={cx} cy={cy} r={2.2} fill="none" stroke="var(--color-ink)" strokeWidth={1.3} />
              ) : (
                <circle key={i} className="tw-led-busy" cx={cx} cy={cy} r={2.6} fill="var(--color-signal)" />
              );
            })}
          </g>
        );
      })}
    </g>
  );
}

function Gate({ x, row, state }: { x: number; row: Row; state: TowerFrame["gates"]["h1"]["state"] }) {
  const f = row.floor;
  const open = state === "approved" || state === "open";
  return (
    <g>
      <rect x={x} y={f - 30} width={5} height={30} rx={1} className="fill-ink-2" />
      <g className={cn("tw-arm", open && "is-up")}>
        <rect x={x + 2} y={f - 28} width={40} height={4} rx={2} fill={open ? "var(--color-hairline-strong)" : "var(--color-danger)"} />
        {!open && [10, 22, 34].map((dx) => <rect key={dx} x={x + 2 + dx} y={f - 28} width={5} height={4} className="fill-canvas" />)}
      </g>
      <circle cx={x + 2.5} cy={f - 36} r={3.4} fill={open ? "#3fa66b" : "var(--color-danger)"} stroke="var(--color-canvas)" strokeWidth={1} />
    </g>
  );
}

function Carrels({ layout, frame, basement, reduced }: { layout: TowerLayout; frame: TowerFrame; basement: Row; reduced: boolean }) {
  const f = basement.floor;
  return (
    <g>
      {frame.carrels.map((c) => {
        const x = layout.carrels[c.slot]?.x ?? 0;
        const last = c.last;
        const live = last !== null && frame.t - last.at < 2500;
        const status = last?.status ?? null;
        const sx = x - CRT.screenHalf;
        const sy = f - CRT.screenTop;
        const sw = CRT.screenHalf * 2;
        const sh = CRT.screenTop - CRT.screenBottom;
        return (
          <g key={c.slot}>
            {/* the CRT: green text while its lane reads, a padlock for blocked, static for an error */}
            <rect className="tw-screen" x={sx} y={sy} width={sw} height={sh} rx={3} fill="var(--tower-crt-glow)" opacity={c.lane && (live || frame.running.includes("S4")) ? 0.26 : 0} />
            {live && status === "ok" && (
              <g opacity={0.9}>
                {[0, 1, 2].map((i) => (
                  <rect key={i} x={sx + 3} y={sy + 3 + i * 4} width={(i === 2 ? 10 : 17) - ((Math.floor(Math.abs(last.at) / 97) + i) % 5)} height={1.7} fill="var(--tower-crt-glow)" />
                ))}
              </g>
            )}
            {live && status === "blocked" && (
              <g>
                <rect x={x - 4.5} y={sy + 6} width={9} height={7} rx={1} fill="var(--color-danger)" />
                <path d={`M${x - 3},${sy + 6} v-2.6 a3,3 0 0 1 6,0 v2.6`} fill="none" stroke="var(--color-danger)" strokeWidth={1.4} />
              </g>
            )}
            {live && status === "error" && (
              <g opacity={0.85}>
                {[0, 1, 2, 3].map((i) => (
                  <line key={i} x1={sx + 2} y1={sy + 3 + i * 3.4} x2={sx + sw - 2} y2={sy + 4 + i * 3.4} stroke="var(--color-danger)" strokeWidth={1} strokeDasharray={`${2 + i} 2`} />
                ))}
              </g>
            )}
            {last && Number.isFinite(last.at) && !reduced && frame.t - last.at < 260 && <rect key={last.at} className="tw-flash" x={sx} y={sy} width={sw} height={sh} rx={3} fill="var(--tower-paper)" />}
            {/* the printer's page stack: one more sheet at 1, 3, 6, 10 and 15 sources that answered */}
            {[1, 3, 6, 10, 15]
              .filter((k) => c.printed >= k)
              .map((k, i) => (
                <rect key={k} x={x + 17} y={f - 31 - i * 1.7} width={12} height={1.5} fill="var(--tower-paper)" stroke="var(--color-hairline-strong)" strokeWidth={0.4} />
              ))}
          </g>
        );
      })}
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ ground floor */

const STEP_ANGLE: Record<string, number> = { S0: -120, S1: -105, S2: -90, S3: -75, H1: -60, S4: -45, S5: -30, S6: -15, S7: 0, S8: 15, S9: 30, S10: 45, S11: 60, S12: 75, S13: 90, S14: 105, S15: 120, H2: 135 };

function LobbyProps({ layout, frame, ground }: { layout: TowerLayout; frame: TowerFrame; ground: Row }) {
  const f = ground.floor;
  const t = ground.top;
  const angle = frame.step ? (STEP_ANGLE[frame.step] ?? -135) : -135;
  const s0 = frame.running.includes("S0");
  const s1 = frame.running.includes("S1");
  const s2 = frame.running.includes("S2") || frame.calling.includes("S2");
  const s3done = frame.finished.S3 !== undefined;
  return (
    <g>
      {/* the stage dial: the needle points at the step running now */}
      <g transform={`translate(152 ${t + 30})`}>
        {Object.values(STEP_ANGLE).map((a) => (
          <line key={a} x1={0} y1={-11} x2={0} y2={-9} className="stroke-hairline-strong" strokeWidth={1} transform={`rotate(${a})`} />
        ))}
        <g className="tw-needle" style={{ transform: `rotate(${angle}deg)` }}>
          <line x1={0} y1={0} x2={0} y2={-10} stroke="var(--color-signal)" strokeWidth={1.8} strokeLinecap="round" />
        </g>
        <circle r={2} className="fill-ink" />
      </g>
      {/* S0 mail slot: open, a notice dropping in, while S0 runs */}
      <rect x={186} y={t + 23} width={22} height={4} rx={1} fill={s0 ? "var(--color-signal)" : "var(--color-ink-2)"} className="tw-screen" />
      {(s0 || frame.finished.S0 !== undefined) && <rect x={186} y={f - 20} width={22} height={3} rx={0.5} fill="var(--tower-paper)" stroke="var(--color-hairline-strong)" strokeWidth={0.5} />}
      {/* S1 lineage frame lamp */}
      <circle cx={252} cy={t + 10} r={3} fill={s1 ? "var(--color-signal)" : "var(--color-hairline-strong)"} />
      {frame.finished.S1 !== undefined && <path d={`M240,${t + 38} L252,${t + 24} L264,${t + 38}`} fill="none" stroke="var(--color-accent)" strokeWidth={1.4} />}
      {/* S2 registry drawer */}
      <rect className={cn("tw-drawer", s2 && "is-open")} x={295} y={f - 31} width={30} height={8} rx={1} style={{ fill: s2 ? "var(--tower-wood)" : "var(--tower-wood-dark)" }} />
      {/* S3 planning table: the plan pinned when S3 finishes */}
      {s3done && (
        <g>
          <rect x={354} y={f - 24} width={44} height={4} rx={1} fill="var(--tower-paper)" stroke="var(--color-hairline-strong)" strokeWidth={0.5} />
          {[360, 372, 384, 392].map((x, i) => (
            <circle key={x} cx={x} cy={f - 25} r={1.6} fill={`var(--color-team-${i % 6})`} stroke="var(--color-ink-2)" strokeWidth={0.4} />
          ))}
        </g>
      )}
      {frame.running.includes("S3") && <circle cx={376} cy={f - 28} r={2.4} fill="var(--color-signal)" />}
      <rect x={layout.doors.x - 16} y={f - 52} width={32} height={2} className="fill-hairline-strong" />
    </g>
  );
}

function Presses({ ground, running }: { ground: Row; running: boolean }) {
  const f = ground.floor;
  return (
    <g>
      {[470, 552].map((x) => (
        <g key={x}>
          <g className={cn("tw-press", running && "is-running")}>
            <rect x={x - 18} y={f - 36} width={36} height={8} rx={2} className="fill-ink-2" />
          </g>
          <rect x={x - 3} y={f - 46} width={6} height={10} className="fill-ink-2" />
          <circle cx={x + 14} cy={f - 34} r={2.2} fill={running ? "var(--color-signal)" : "var(--color-hairline-strong)"} />
          {running && <rect x={x - 14} y={f - 14} width={28} height={3} fill="var(--tower-paper)" stroke="var(--color-hairline-strong)" strokeWidth={0.4} />}
        </g>
      ))}
    </g>
  );
}

function Ledger({ ground, on, done }: { ground: Row; on: boolean; done: boolean }) {
  const f = ground.floor;
  return (
    <g>
      <path d={`M986,${f - 18} L1008,${f - 21} L1030,${f - 18} L1030,${f - 15} L986,${f - 15} Z`} fill={done || on ? "var(--tower-paper)" : "var(--color-surface-2)"} stroke="var(--color-hairline-strong)" strokeWidth={0.8} />
      <line x1={1008} y1={f - 21} x2={1008} y2={f - 15} className="stroke-hairline-strong" strokeWidth={0.6} />
      <line x1={1040} y1={f - 18} x2={1040} y2={f - 36} className="stroke-ink-2" strokeWidth={1.4} />
      <path d={`M1032,${f - 36} L1048,${f - 36} L1044,${f - 42} L1036,${f - 42} Z`} className="fill-ink-2" />
      <circle cx={1040} cy={f - 34} r={2.4} fill={on ? "var(--color-signal)" : "var(--color-hairline-strong)"} />
    </g>
  );
}

const VERDICT_FILL: Record<Verdict, string> = { supported: "var(--color-canvas)", partly: "var(--color-cream-deep)", withheld: "var(--color-danger-soft)" };
const VERDICT_EDGE: Record<Verdict, string> = { supported: "var(--color-ink-2)", partly: "var(--color-cream-edge)", withheld: "var(--color-danger)" };
const TRAYS: { v: Verdict; x: number }[] = [
  { v: "supported", x: 808 },
  { v: "partly", x: 838 },
  { v: "withheld", x: 868 },
];

/** The notary booth's working parts: the shutter, the stamp, the slips on the conveyor and the trays. */
function Booth({ ground, frame }: { ground: Row; frame: TowerFrame }) {
  const f = ground.floor;
  const t = ground.top;
  const open = frame.running.includes("S7");
  const beat = frame.beat;
  const fill = (v: Verdict) => Math.min(12, frame.tally[v] === 0 ? 0 : Math.ceil(Math.log2(frame.tally[v] + 1) * 1.6));
  return (
    <g>
      {/* the counter in front of the verifier */}
      <rect x={656} y={f - 22} width={122} height={22} rx={2} style={{ fill: "color-mix(in oklab, var(--color-office-verify) 55%, var(--tower-wood-dark))" }} />
      <rect x={652} y={f - 25} width={130} height={4} rx={1.5} style={{ fill: "var(--tower-wood)" }} />
      {/* the roll-up shutter over the window: up while S7 runs */}
      <g className={cn("tw-shutter", open && "is-up")}>
        <rect x={666} y={t + 16} width={102} height={f - t - 41} style={{ fill: "color-mix(in oklab, var(--color-ink) 30%, var(--color-surface-2))" }} />
        {Array.from({ length: 6 }, (_, i) => (
          <line key={i} x1={666} y1={t + 22 + i * 5} x2={768} y2={t + 22 + i * 5} className="stroke-hairline-strong" strokeWidth={0.8} />
        ))}
      </g>
      {/* the stamp: drops on every beat */}
      <g transform={`translate(752 ${f - 25})`}>
        <g key={beat?.id ?? "rest"} className={cn("tw-stamp", frame.stamping && "is-down")}>
          <rect x={-3} y={-17} width={6} height={10} rx={2} fill="var(--color-office-device)" />
          <rect x={-7} y={-7} width={14} height={5} rx={1} className="fill-ink" />
        </g>
      </g>
      {/* trays at the end of the conveyor: each fills with its verdicts */}
      {TRAYS.map(({ v, x }) => (
        <g key={v}>
          <rect x={x - 12} y={f - 12 - fill(v)} width={24} height={fill(v)} fill={VERDICT_FILL[v]} stroke={VERDICT_EDGE[v]} strokeWidth={0.6} />
          <path d={`M${x - 13},${f - 24} L${x - 13},${f - 10} L${x + 13},${f - 10} L${x + 13},${f - 24}`} fill="none" stroke={VERDICT_EDGE[v]} strokeWidth={1.4} />
        </g>
      ))}
      {/* this beat's slips riding the conveyor (one per verdict kind; a grey corner when a source was unreachable) */}
      {beat && frame.stamping && (
        <g key={beat.id}>
          {(["supported", "partly", "withheld"] as const)
            .filter((v) => beat.counts[v] > 0)
            .map((v, i) => {
              const dx = (TRAYS.find((tr) => tr.v === v)?.x ?? 808) - 790;
              return (
                <g key={v} className="tw-slip" style={{ ["--tw-slip-dx" as string]: `${dx}px` }} transform={`translate(${786 + i * 3} ${f - 23})`}>
                  <rect x={0} y={0} width={13} height={7} rx={1} fill={VERDICT_FILL[v]} stroke={VERDICT_EDGE[v]} strokeWidth={0.8} />
                  {beat.unreachable > 0 && <path d="M9,0 L13,0 L13,4 Z" className="fill-faint" />}
                </g>
              );
            })}
        </g>
      )}
    </g>
  );
}

/** The penthouse's long table, in front of the evaluators' chairs. */
function BoardTable({ roof, lit }: { roof: Row; lit: boolean }) {
  const f = roof.floor;
  return (
    <g>
      <rect x={168} y={f - 22} width={428} height={5} rx={2} style={{ fill: "var(--tower-wood)" }} />
      <rect x={176} y={f - 17} width={412} height={17} style={{ fill: "var(--tower-wood-dark)" }} />
      {lit && <rect x={176} y={f - 17} width={412} height={2} fill="var(--color-signal)" opacity={0.7} />}
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ the floors */

function InTrays({ layout, frame }: { layout: TowerLayout; frame: TowerFrame }) {
  return (
    <g>
      {layout.rivalRows.map((r) => {
        const row = layout.rows[r] as Row;
        if (!row.pod || frame.vacant.includes(row.pod)) return null;
        const ok = frame.sources[row.pod]?.ok ?? 0;
        const sheets = [1, 3, 6, 10, 15].filter((k) => ok >= k).length;
        return (
          <g key={r}>
            {Array.from({ length: sheets }, (_, i) => (
              <rect key={i} x={TRAY_X - 10 + (i % 2)} y={row.floor - 21 - i * 2} width={20} height={2} fill="var(--tower-paper)" stroke="var(--color-hairline-strong)" strokeWidth={0.5} />
            ))}
          </g>
        );
      })}
    </g>
  );
}

function WarBoard({ row, challenges }: { row: Row; challenges: number }) {
  return (
    <g>
      {Array.from({ length: Math.min(challenges, 12) }, (_, i) => (
        <line key={i} x1={444 + i * 10} y1={row.top + 20} x2={448 + i * 10} y2={row.top + 34} stroke="var(--color-danger)" strokeWidth={2} strokeLinecap="round" />
      ))}
    </g>
  );
}

function DeckProps({ roof, frame, briefReady }: { roof: Row; frame: TowerFrame; briefReady: boolean }) {
  const f = roof.floor;
  const on = (s: string) => frame.running.includes(s);
  const h2 = frame.gates.h2.state;
  const recorded = h2 === "approved" || h2 === "open";
  return (
    <g>
      {/* S11 counters board */}
      <rect x={781} y={f - 46} width={22} height={18} rx={1.5} fill={on("S11") || frame.finished.S11 !== undefined ? "var(--color-canvas)" : "var(--color-surface-2)"} stroke="var(--color-ink-2)" strokeWidth={1} />
      {frame.finished.S11 !== undefined && <path d={`M785,${f - 40} h8 M785,${f - 36} h14 M785,${f - 32} h10`} stroke="var(--color-danger)" strokeWidth={1.2} />}
      {/* S12 the scale */}
      <g transform={`translate(870 ${f - 40}) rotate(${frame.finished.S12 !== undefined ? -8 : on("S12") ? 4 : 0})`} className="tw-needle">
        <line x1={-18} y1={0} x2={18} y2={0} className="stroke-ink-2" strokeWidth={1.8} />
        <path d="M-22,2 L-14,2 L-18,9 Z M14,2 L22,2 L18,9 Z" className="fill-ink-2" />
      </g>
      {/* S13 the brief press */}
      <g className={cn("tw-press", frame.calling.includes("S13") && "is-running")}>
        <rect x={938} y={f - 30} width={28} height={6} rx={1.5} className="fill-ink-2" />
      </g>
      <circle cx={966} cy={f - 18} r={2.2} fill={on("S13") ? "var(--color-signal)" : "var(--color-hairline-strong)"} />
      {/* S14 the lens */}
      <circle cx={1030} cy={f - 36} r={9} fill={on("S14") ? "color-mix(in oklab, var(--color-signal) 25%, transparent)" : "color-mix(in oklab, var(--color-canvas) 40%, transparent)"} stroke="var(--color-ink-2)" strokeWidth={2} />
      {/* S15 the parcel chute: a parcel once the export finished */}
      {frame.finished.S15 !== undefined && <rect x={1100} y={f - 12} width={14} height={11} rx={1.5} style={{ fill: "var(--tower-wood)" }} stroke="var(--tower-wood-dark)" strokeWidth={1} />}
      {on("S15") && <circle cx={1107} cy={f - 50} r={2.4} fill="var(--color-signal)" />}
      {/* the brief on the podium, and the decision's stamp */}
      {briefReady && <rect x={694} y={f - 40} width={20} height={6} rx={1} fill="var(--tower-paper)" stroke="var(--color-ink-2)" strokeWidth={0.8} />}
      {briefReady && recorded && <rect x={697} y={f - 39.5} width={14} height={5} rx={1} fill="none" stroke="var(--color-accent)" strokeWidth={1.4} />}
      {/* the bell swings once at the recorded decision */}
      <g transform={`translate(752 ${f - 62})`}>
        <g key={recorded ? "rung" : "still"} className={cn("tw-bell", h2 === "approved" && "is-ringing")}>
          <path d="M-7,10 C-7,2 -4,0 0,0 C4,0 7,2 7,10 Z" style={{ fill: "var(--tower-brass)" }} stroke="var(--tower-brass-dark)" strokeWidth={1} />
          <circle cx={0} cy={11.5} r={1.8} style={{ fill: "var(--tower-brass-dark)" }} />
        </g>
      </g>
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ seats */

interface SeatViewProps {
  id: string;
  x: number;
  floor: number;
  furniture: "desk" | "office" | "chair" | "booth";
  role: Role;
  team: number;
  seated: boolean;
  present: boolean;
  activity: Activity;
  dim: boolean;
  on: boolean;
  joinedAt: number | null;
  stamping: boolean;
}

function hashDelay(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 5200;
  return h;
}

const SeatView = memo(function SeatView(p: SeatViewProps) {
  const { x, floor } = p;
  const working = p.seated && p.present && (p.activity === "typing" || p.activity === "sending");
  const desk = p.furniture === "desk" || p.furniture === "office";
  const scale = 0.92;
  return (
    <g data-seat={p.id} className={p.dim ? "tw-dim" : "tw-undim"}>
      {desk && <Chair x={x} floor={floor} />}
      {p.furniture === "chair" && <rect x={x - 12} y={floor - 46} width={24} height={30} rx={6} className="fill-surface-2 stroke-hairline-strong" strokeWidth={1} />}
      {p.seated && p.present && (
        <g transform={`translate(${x} ${floor - 6}) scale(${scale})`}>
          <ellipse cx={0} cy={-17} rx={13} ry={11} className={cn("fill-signal transition-opacity duration-[var(--duration-base)]", working ? "opacity-25" : "opacity-0")} />
          <ellipse data-ring cx={0} cy={-15} rx={17} ry={23} fill="none" className={cn("stroke-signal", p.on ? "opacity-100" : "opacity-0")} strokeWidth={2.2} />
          <Avatar role={p.role} team={p.team} activity={p.activity} blinkDelay={hashDelay(p.id)} />
        </g>
      )}
      {p.joinedAt !== null && <circle key={p.joinedAt} className="tw-puff" cx={x} cy={floor - 22} r={14} fill="var(--color-canvas)" />}
      {desk && (
        <>
          <DeskFront x={x} floor={floor} wide={p.furniture === "office"} />
          {/* the monitor, turned three-quarters to the agent: lit in signal while a model call runs */}
          <path d={`M${x + 9},${floor - 33} L${x + 25},${floor - 31} L${x + 25},${floor - 18} L${x + 9},${floor - 19} Z`} fill="var(--color-office-device)" />
          <path className="tw-screen" d={`M${x + 10.5},${floor - 31.5} L${x + 23.5},${floor - 29.8} L${x + 23.5},${floor - 19.6} L${x + 10.5},${floor - 20.4} Z`} fill="var(--color-signal)" opacity={working ? 0.95 : 0} />
          <rect x={x + 15} y={floor - 18.5} width={4} height={4.5} fill="var(--color-office-device-2)" />
          {/* a dim nameplate until the agent's card is recorded */}
          {!p.present && <rect x={x - 8} y={floor - 9} width={16} height={4} rx={1} className="fill-hairline-strong" opacity={0.6} />}
        </>
      )}
      {p.furniture === "chair" && !p.present && <rect x={x - 8} y={floor - 30} width={16} height={4} rx={1} className="fill-hairline-strong" opacity={0.4} />}
    </g>
  );
});

/* ------------------------------------------------------------------------------------------------ movers */

const Walker = memo(function Walker({
  id,
  role,
  team,
  leg,
  activity,
  facing,
  carrying,
  motion,
  dim,
}: {
  id: string;
  role: Role;
  team: number;
  leg: NonNullable<TowerFrame["agents"][string]["leg"]>;
  activity: Activity;
  facing: "front" | "back";
  carrying: boolean;
  motion: Motion;
  dim: boolean;
}) {
  const place = useCallback(
    (t: number): Pt => {
      if (leg.kind !== "walk") return leg.from;
      const f = (t - leg.start) / Math.max(1, leg.end - leg.start);
      return pointAlong([leg.from, leg.to], Math.min(1, Math.max(0, f)));
    },
    [leg],
  );
  const ref = useMover(motion, `walker:${id}`, place);
  const start = place(leg.start);
  const sitting = leg.kind === "stay";
  const flip = leg.kind === "walk" && leg.to.x < leg.from.x;
  return (
    <g ref={ref} transform={`translate(${start.x} ${start.y})`} className={dim ? "tw-dim" : "tw-undim"}>
      <g transform={`translate(0 ${sitting ? -5 : 0}) scale(${flip ? -0.9 : 0.9} 0.9)`}>
        <Avatar role={role} team={team} activity={activity} facing={facing} seated={sitting} carrying={carrying} blinkDelay={hashDelay(id)} />
      </g>
    </g>
  );
});

function Cabin({ layout, lift, frame, seats, motion, reduced }: { layout: TowerLayout; lift: LiftPlan; frame: TowerFrame; seats: SeatInfo[]; motion: Motion; reduced: boolean }) {
  const place = useCallback((t: number): Pt => ({ x: X.cabin, y: reduced ? frame.cabin.y : cabinAt(lift, layout.rows, t).y }), [lift, layout.rows, reduced, frame.cabin.y]);
  const ref = useMover(motion, "cabin", place);
  const riders = frame.cabin.riders;
  const info = new Map(seats.map((s) => [s.id, s]));
  const spread = riders.length > 1 ? 24 / (riders.length - 1) : 0;
  return (
    <g ref={ref} transform={`translate(${X.cabin} ${frame.cabin.y})`}>
      {/* the cabin's back wall and lamp */}
      <rect x={-CABIN_W / 2} y={-CABIN_H} width={CABIN_W} height={CABIN_H} rx={2} style={{ fill: "color-mix(in oklab, var(--tower-brass) 22%, var(--color-surface))" }} />
      <rect x={-6} y={-CABIN_H + 2} width={12} height={2.4} rx={1} style={{ fill: frame.cabin.ride ? "var(--tower-lamp)" : "var(--color-hairline-strong)" }} />
      {riders.map((r, i) => {
        const s = info.get(r.seat);
        if (!s) return null;
        return (
          <g key={r.seat} transform={`translate(${riders.length > 1 ? -12 + i * spread : 0} 0) scale(0.82)`}>
            <Avatar role={s.role} team={s.team} activity="idle" seated={false} carrying={r.carrying} blinkDelay={hashDelay(r.seat)} />
          </g>
        );
      })}
      {/* the cabin's frame and doors (open at a stop) */}
      <rect x={-CABIN_W / 2} y={-CABIN_H} width={CABIN_W} height={CABIN_H} rx={2} fill="none" style={{ stroke: "var(--tower-brass-dark)" }} strokeWidth={2.2} />
      {!frame.cabin.doorsOpen && (
        <g opacity={riders.length > 0 ? 0.32 : 0.85}>
          <rect x={-CABIN_W / 2 + 2} y={-CABIN_H + 6} width={CABIN_W / 2 - 2.5} height={CABIN_H - 7} style={{ fill: "var(--tower-brass)" }} />
          <rect x={0.5} y={-CABIN_H + 6} width={CABIN_W / 2 - 2.5} height={CABIN_H - 7} style={{ fill: "var(--tower-brass)" }} />
        </g>
      )}
      <rect x={-CABIN_W / 2 - 2} y={-1} width={CABIN_W + 4} height={3} rx={1} style={{ fill: "var(--tower-brass-dark)" }} />
    </g>
  );
}

const CAPSULE_BAND: Record<string, string> = {
  brief: "transparent",
  strategy: "var(--color-ink)",
  challenge: "var(--color-danger)",
  response: "var(--color-signal)",
  interview: "var(--color-cream-edge)",
  rating: "transparent",
};

const Capsule = memo(function Capsule({ id, path, start, end, kind, failed, motion }: { id: string; path: Pt[]; start: number; end: number; kind: string; failed: boolean; motion: Motion }) {
  const place = useCallback((t: number): Pt => pointAlong(path, easeInOut((t - start) / Math.max(1, end - start))), [path, start, end]);
  const ref = useMover(motion, `capsule:${id}`, place);
  const p0 = place(start);
  return (
    <g ref={ref} transform={`translate(${p0.x} ${p0.y})`}>
      <rect x={-5.5} y={-3.4} width={11} height={6.8} rx={3.4} style={{ fill: "var(--tower-paper)", stroke: "var(--tower-brass-dark)" }} strokeWidth={1.1} />
      <rect x={-1.6} y={-3.4} width={3.2} height={6.8} style={{ fill: CAPSULE_BAND[kind] ?? "transparent" }} />
      {failed && <circle cx={6.5} cy={-4.5} r={2.6} fill="var(--color-danger)" />}
    </g>
  );
});
