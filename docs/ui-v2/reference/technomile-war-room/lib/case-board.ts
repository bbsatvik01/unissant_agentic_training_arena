/**
 * The case board office style: the run pinned up as an investigator's wall. One row per rival, read left to right in
 * pipeline order (dossier, crew, S4 intel cards, S5-S7 claims ledger, S9 memos, S10 board slot), the evaluation board
 * in the right column, the shared desks (red team, verifier, home analyst, incidents) along the bottom, and the run's
 * clock, stages and human gates across the top. Pure layout, filing and thread logic, so the view, its tests and a
 * replay see the same board.
 */
import type { AgentCitation, BoardRow } from "@/lib/contracts/run-events";
import type { Approvals } from "@/lib/pipeline/rail";

import type { CommandRecord } from "./command";
import { podKey, SEND_MS, type Schedule, type Verdict, type WarpKey } from "./office";
import { recipients } from "./swarm-graph";
import type { SwarmItem, SwarmView } from "./swarm";

/* ------------------------------------------------------------------------------------------------ geometry */

export const VIEW_W = 1280;
export const VIEW_H = 800;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Pt {
  x: number;
  y: number;
}

export type CrewRole = "researcher" | "pricing" | "technical" | "past_performance" | "capture_lead";

/** The crew polaroids of a row, in reading order: the S4 researcher first, the capture lead last. */
export const CREW_ROLES: readonly CrewRole[] = ["researcher", "pricing", "technical", "past_performance", "capture_lead"];

export function crewRoleOf(role: string): CrewRole | null {
  return (CREW_ROLES as readonly string[]).includes(role) ? (role as CrewRole) : null;
}

export interface RowLayout {
  key: string;
  index: number;
  /** The row's band (the jury column excluded). */
  band: Rect;
  dossier: Rect;
  crew: Record<CrewRole, Rect>;
  fan: Rect;
  ledger: Rect;
  memo: Rect;
  slot: Rect;
  /** Five or more rows: smaller monograms and counts. */
  compact: boolean;
  /** Six rows: two-line memo bodies. */
  tight: boolean;
}

export interface BoardLayout {
  rows: RowLayout[];
  /** Rivals past the sixth, listed on one strip. */
  overflow: { band: Rect; keys: string[] } | null;
  header: { caseCard: Rect; tPlus: Rect; wall: Rect; stage: Rect; chips: Record<string, Rect>; h1: Rect; h2: Rect };
  jury: { column: Rect; header: Rect; evaluators: Rect[]; sheets: Rect[]; codes: Rect };
  footer: { red: Rect; verifier: Rect; analyst: Rect; incidents: Rect };
}

const ROWS_TOP = 88;
const ROWS_BOTTOM = 692;
const MAX_ROWS = 6;
const OVERFLOW_H = 26;
/** Rows never grow past this: one to three rivals sit centred in the band. */
const ROW_MAX_H = 176;
const PAD = 7;

const COL = {
  dossier: [16, 146],
  crew: [154, 262],
  fan: [272, 512],
  ledger: [522, 752],
  memo: [762, 994],
  slot: [1004, 1088],
  jury: [1100, 1264],
} as const;

/** Stage chips: two rows of nine, the gates in pipeline order. */
export const CHIP_ROWS: readonly (readonly string[])[] = [
  ["S0", "S1", "S2", "S3", "H1", "S4", "S5", "S6", "S7"],
  ["S8", "S9", "S10", "S11", "S12", "S13", "S14", "S15", "H2"],
];

const POLAROID_W = 33;

function r1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** A rect from its corners, each corner rounded first so neighbours that share an edge still share it. */
function rect(x0: number, y0: number, x1: number, y1: number): Rect {
  const [a, b, c, d] = [r1(x0), r1(y0), r1(x1), r1(y1)];
  return { x: a, y: b, w: r1(c - a), h: r1(d - b) };
}

/** The board for a run's rival pods (in the plan's lane order). */
export function planBoard(plan: { pods: readonly { key: string }[] }): BoardLayout {
  const keys = plan.pods.map((p) => p.key);
  const spill = keys.length > MAX_ROWS;
  const shown = spill ? keys.slice(0, MAX_ROWS) : keys;
  const band = ROWS_BOTTOM - ROWS_TOP - (spill ? OVERFLOW_H + 4 : 0);
  // a whole number of tenths, so every row is exactly as tall as the others
  const h = shown.length ? Math.floor(Math.min(ROW_MAX_H, band / shown.length) * 10) / 10 : ROW_MAX_H;
  const top = ROWS_TOP + (shown.length && !spill ? Math.round(Math.max(0, (band - h * shown.length) / 2) * 10) / 10 : 0);
  const compact = shown.length >= 5;
  const tight = shown.length >= 6;

  const rows: RowLayout[] = shown.map((key, i) => {
    const y0 = top + i * h;
    const y1 = y0 + h;
    const inner0 = y0 + PAD;
    const inner1 = y1 - PAD;
    // crew: three polaroids over two, centred in the row
    const ph = Math.min(42, (inner1 - inner0 - 4) / 2);
    const cy0 = y0 + (h - (2 * ph + 4)) / 2;
    const at = (x: number, y: number) => rect(x, y, x + POLAROID_W, y + ph);
    const crew: Record<CrewRole, Rect> = {
      researcher: at(155, cy0),
      pricing: at(191, cy0),
      technical: at(227, cy0),
      past_performance: at(173, cy0 + ph + 4),
      capture_lead: at(209, cy0 + ph + 4),
    };
    return {
      key,
      index: i,
      band: rect(COL.dossier[0], y0, COL.slot[1], y1),
      dossier: rect(COL.dossier[0], inner0 + 6, COL.dossier[1], inner1),
      crew,
      fan: rect(COL.fan[0], inner0, COL.fan[1], inner1),
      ledger: rect(COL.ledger[0], inner0, COL.ledger[1], inner1),
      memo: rect(COL.memo[0] + 12, inner0 + 10, COL.memo[1], Math.min(inner1, inner0 + 10 + (tight ? 70 : 84))),
      slot: rect(COL.slot[0] + 4, inner0 + 8, COL.slot[1] - 4, inner1 - 4),
      compact,
      tight,
    };
  });

  const chips: Record<string, Rect> = {};
  CHIP_ROWS.forEach((ids, r) => ids.forEach((id, c) => (chips[id] = rect(780 + c * 35.5, 20 + r * 24, 780 + c * 35.5 + 32, 20 + r * 24 + 18))));

  const jx0 = COL.jury[0];
  const jx1 = COL.jury[1];
  const evW = 48;
  const evaluators = [0, 1, 2].map((i) => rect(jx0 + 6 + i * 52, 140, jx0 + 6 + i * 52 + evW, 198));
  const sheets = [0, 1, 2].map((i) => rect(jx0 + 6 + i * 52, 204, jx0 + 6 + i * 52 + evW, 268));

  return {
    rows,
    overflow: spill ? { band: rect(COL.dossier[0], ROWS_BOTTOM - OVERFLOW_H, COL.slot[1], ROWS_BOTTOM), keys: keys.slice(MAX_ROWS) } : null,
    header: {
      caseCard: rect(16, 10, 420, 78),
      tPlus: rect(440, 12, 636, 58),
      wall: rect(644, 12, 760, 33),
      stage: rect(644, 37, 760, 58),
      chips,
      h1: rect(1110, 10, 1264, 43),
      h2: rect(1110, 47, 1264, 80),
    },
    jury: { column: rect(jx0, ROWS_TOP, jx1, ROWS_BOTTOM), header: rect(jx0, ROWS_TOP + 4, jx1, ROWS_TOP + 44), evaluators, sheets, codes: rect(jx0 + 7, 280, jx1 - 7, ROWS_BOTTOM - 4) },
    footer: { red: rect(16, 702, 330, 790), verifier: rect(342, 702, 660, 790), analyst: rect(672, 702, 1090, 790), incidents: rect(1100, 702, 1264, 790) },
  };
}

/** The jury's codename cards (Offeror A onward), stacked in the codes area. */
export function codenameRects(b: BoardLayout, n: number): Rect[] {
  if (n <= 0) return [];
  const area = b.jury.codes;
  const gap = 6;
  const h = Math.min(46, (area.h - gap * (n - 1)) / n);
  return Array.from({ length: n }, (_, i) => rect(area.x, area.y + i * (h + gap), area.x + area.w, area.y + i * (h + gap) + h));
}

export const FAN_MAX = 8;
const FAN_CARD_W = 112;
const FAN_STEP_X = 14;
const FAN_STEP_Y = 2;

/** Intel cards in a fan: the newest at the right, each older one 14 units left and 2 down, eight at most; the rest
 *  collapse into a count at the left. */
export function fanRects(fan: Rect, n: number, cardH: number): { cards: Rect[]; more: Rect | null; hidden: number } {
  const shown = Math.min(n, FAN_MAX);
  const x0 = fan.x + fan.w - FAN_CARD_W;
  const y0 = fan.y + (fan.h - cardH) / 2 - ((shown - 1) * FAN_STEP_Y) / 2;
  const cards = Array.from({ length: shown }, (_, i) => rect(x0 - i * FAN_STEP_X, y0 + i * FAN_STEP_Y, x0 - i * FAN_STEP_X + FAN_CARD_W, y0 + i * FAN_STEP_Y + cardH));
  const hidden = n - shown;
  const last = cards.at(-1);
  const more = hidden > 0 && last ? rect(fan.x, last.y + cardH / 2 - 9, Math.min(fan.x + 28, last.x), last.y + cardH / 2 + 9) : null;
  return { cards, more, hidden };
}

export const TAG_MAX = 12;
const TAG_W = 27;

/** Evidence tags along a ledger's right edge: two columns of six, then a count. */
export function tagRects(ledger: Rect, n: number): { tags: Rect[]; more: Rect | null; hidden: number } {
  const step = Math.min(14, (ledger.h - 10) / 7);
  const th = step - 2.5;
  const x1 = ledger.x + ledger.w - 6;
  const xs = [x1 - 2 * TAG_W - 3, x1 - TAG_W];
  const y0 = ledger.y + 6;
  const shown = Math.min(n, TAG_MAX);
  const tags = Array.from({ length: shown }, (_, i) => {
    const x = xs[i % 2] ?? x1;
    const y = y0 + Math.floor(i / 2) * step;
    return rect(x, y, x + TAG_W, y + th);
  });
  const hidden = n - shown;
  const more = hidden > 0 ? rect(xs[0] ?? x1, y0 + 6 * step, x1, y0 + 6 * step + th) : null;
  return { tags, more, hidden };
}

/** A card's rest angle, from a hash of its id: between -2.5 and 2.5 degrees, the same on every render. */
export function restAngle(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return r1(((h >>> 0) % 1001) / 200 - 2.5);
}

/** A sagging thread from `a` to `b`: a quadratic curve whose control point hangs below both ends. */
export function threadPath(a: Pt, b: Pt): string {
  const sag = Math.min(60, 0.08 * Math.hypot(b.x - a.x, b.y - a.y));
  return `M${r1(a.x)} ${r1(a.y)} Q${r1((a.x + b.x) / 2)} ${r1(Math.max(a.y, b.y) + sag)} ${r1(b.x)} ${r1(b.y)}`;
}

/** Text wrapped to lines of at most `max` characters (by count: SVG text has no layout), `lines` at most; a cut is
 *  marked with "...". */
export function wrapText(text: string, max: number, lines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  let used = 0;
  const start = (w: string) => {
    used += 1;
    if (w.length > max) out.push(w.slice(0, max));
    else cur = w;
  };
  for (const w of words) {
    if (out.length === lines) break;
    if (!cur) {
      start(w);
      continue;
    }
    if (cur.length + 1 + w.length <= max) {
      cur = `${cur} ${w}`;
      used += 1;
      continue;
    }
    out.push(cur);
    cur = "";
    if (out.length === lines) break;
    start(w);
  }
  if (cur && out.length < lines) out.push(cur);
  if (used < words.length && out.length > 0) {
    const last = out[out.length - 1] ?? "";
    out[out.length - 1] = last.length + 3 <= max ? `${last}...` : `${last.slice(0, Math.max(0, max - 3))}...`;
  }
  return out;
}

const SUFFIX: ReadonlySet<string> = new Set(["INC", "LLC", "LLP", "LP", "CORP", "CORPORATION", "INCORPORATED", "CO", "COMPANY", "LTD", "PLC"]);

/** A rival's monogram: the initials of its first two name words, corporate suffixes left out. */
export function initials(label: string): string {
  const words = label.split(/[\s,.&]+/).filter((w) => /[\p{L}\p{N}]/u.test(w) && !SUFFIX.has(w.toUpperCase()));
  return words.slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join("") || "?";
}

/* ------------------------------------------------------------------------------------------------ the record */

/** A replay holds each lane line apart (lines recorded together still read one after another) and gives each gate
 *  park, approval and error a beat of its own. */
export const LINE_STEP_MS = 120;
export const GATE_STEP_MS = 1200;

const FETCH_ECHO = /^GET \S+ \([^)]*\)$/;

/** A lane line that only repeats a fetch the intel cards already show ("GET host (source)"). */
export function isFetchEcho(text: string): boolean {
  return FETCH_ECHO.test(text);
}

/** The recorded times the case board adds to the office's replay keys: lane lines, parks, errors and approvals. */
export function boardKeys(cmd: CommandRecord, approvals: Approvals | null): WarpKey[] {
  const keys: WarpKey[] = cmd.lines.map((l) => (isFetchEcho(l.text) ? { t: l.ts } : { t: l.ts, minStep: LINE_STEP_MS }));
  for (const p of cmd.parks) keys.push({ t: p.ts, minStep: GATE_STEP_MS });
  for (const e of cmd.errors) keys.push({ t: e.ts, minStep: GATE_STEP_MS });
  for (const at of [approvals?.h1?.at, approvals?.h2?.at]) {
    const ms = at ? Date.parse(at) : NaN;
    if (Number.isFinite(ms)) keys.push({ t: ms, minStep: GATE_STEP_MS });
  }
  return keys;
}

/** A lane line as its own row shows it: without the rival's name it ends with ("... for CGI FEDERAL INC."). */
export function laneText(text: string, label: string): string {
  const tail = ` for ${label}`;
  return text.toUpperCase().endsWith(tail.toUpperCase()) ? text.slice(0, text.length - tail.length) : text;
}

/* ------------------------------------------------------------------------------------------------ filing */

/** Sent messages filed where they are pinned: each in the row of its context (a rival), newest first; the board's
 *  ratings in the jury. */
export function memosByRow(view: SwarmView, sent: ReadonlySet<string>): { rows: Record<string, SwarmItem[]>; jury: SwarmItem[] } {
  const rows: Record<string, SwarmItem[]> = {};
  const jury: SwarmItem[] = [];
  for (const m of view.messages) {
    if (!sent.has(m.messageId)) continue;
    if (m.contextId === "board") jury.unshift(m);
    else (rows[m.contextId] ??= []).unshift(m);
  }
  return { rows, jury };
}

export interface EvidenceTag {
  code: string;
  claimId: string;
  text: string;
  /** The claim's S7 verdict on this run's record; null when the run recorded none (accepted earlier, in the plan). */
  verdict: Verdict | null;
}

/** Each row's cited evidence codes, once each, in first-cited order (codes are numbered per rival), with the S7 verdict
 *  of the claim when the run recorded one (the latest wins). Failed messages cite nothing. */
export function tagsByRow(view: SwarmView, sent: ReadonlySet<string>, cmd: CommandRecord): Record<string, EvidenceTag[]> {
  const verdicts = new Map<string, Verdict>();
  for (const v of cmd.verdicts) verdicts.set(v.claimId, v.verdict);
  const out: Record<string, EvidenceTag[]> = {};
  for (const m of view.messages) {
    if (!sent.has(m.messageId) || m.state !== "completed" || m.contextId === "board") continue;
    for (const c of m.citations) {
      const list = (out[m.contextId] ??= []);
      if (list.some((t) => t.code === c.code)) continue;
      list.push({ code: c.code, claimId: c.claimId, text: c.text, verdict: verdicts.get(c.claimId) ?? null });
    }
  }
  return out;
}

function ratingMap(m: SwarmItem): Record<string, number> {
  const raw = m.data.ratings;
  const out: Record<string, number> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [code, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v)) out[code] = v;
  return out;
}

/** The de-identified offeror codes the board has rated so far, in order. */
export function codesOf(view: SwarmView, sent: ReadonlySet<string>): string[] {
  const codes = new Set<string>();
  for (const m of view.messages) if (sent.has(m.messageId) && m.kind === "rating") for (const c of Object.keys(ratingMap(m))) codes.add(c);
  return [...codes].sort();
}

/** Each evaluator's ratings by offeror code (its latest rating message). */
export function ratingsOf(view: SwarmView, sent: ReadonlySet<string>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const m of view.messages) if (sent.has(m.messageId) && m.kind === "rating") out[m.from] = ratingMap(m);
  return out;
}

/** The row a board result row lands in: the row whose group is the board row's group, else whose key is its name. */
export function boardSlotRow(rows: readonly { key: string; groupId: string | null }[], row: Pick<BoardRow, "group" | "label">): number {
  const byGroup = rows.findIndex((r) => r.groupId === row.group);
  return byGroup >= 0 ? byGroup : rows.findIndex((r) => r.key === podKey(row.label));
}

/* ------------------------------------------------------------------------------------------------ threads */

export type ThreadEnd = { kind: "agent"; agentId: string } | { kind: "jury" } | { kind: "tag"; row: string; code: string };

export interface Thread {
  id: string;
  kind: "route" | "evidence";
  msgId: string;
  /** The row (context) the memo is filed in. */
  row: string;
  round: number;
  to: ThreadEnd;
  /** The message's send beat is on (just pinned). */
  active: boolean;
  /** Evidence threads: cited codes past the first six (shown as "+n" on the memo). */
  more: number;
}

/** Evidence threads drawn per memo; the rest are counted on the memo. */
export const EVIDENCE_PER_MEMO = 6;

/** Where a memo's ink threads go: each recipient once; any evaluator (or the board itself) is the jury. */
export function memoTargets(view: SwarmView, m: Pick<SwarmItem, "from" | "to">): ThreadEnd[] {
  const out: ThreadEnd[] = [];
  const add = (end: ThreadEnd) => {
    if (!out.some((e) => JSON.stringify(e) === JSON.stringify(end))) out.push(end);
  };
  for (const t of m.to) {
    if (t === "board") {
      add({ kind: "jury" });
      continue;
    }
    for (const r of recipients(view, { from: m.from, to: [t] })) add(view.cards[r]?.group === "board" ? { kind: "jury" } : { kind: "agent", agentId: r });
  }
  return out;
}

/**
 * The board's threads at display time `t`: for every sent, completed rival message, one ink route thread per
 * recipient and one red evidence thread per cited code (the first six). A message whose send beat is on is active;
 * the rest are history. Ratings (filed at the jury, addressed to the board itself) and failed messages get none.
 */
export function threadsAt(sched: Pick<Schedule, "beats">, view: SwarmView, t: number, sent: ReadonlySet<string>): Thread[] {
  const active = new Set<string>();
  for (const b of sched.beats) if (b.kind === "send" && b.start <= t && t < b.start + SEND_MS) active.add(b.msgId);
  const out: Thread[] = [];
  for (const m of view.messages) {
    if (!sent.has(m.messageId) || m.state !== "completed" || m.contextId === "board") continue;
    const on = active.has(m.messageId);
    for (const to of memoTargets(view, m)) out.push({ id: `r:${m.messageId}:${JSON.stringify(to)}`, kind: "route", msgId: m.messageId, row: m.contextId, round: m.round, to, active: on, more: 0 });
    const codes = uniqueCodes(m.citations);
    const more = Math.max(0, codes.length - EVIDENCE_PER_MEMO);
    for (const code of codes.slice(0, EVIDENCE_PER_MEMO)) out.push({ id: `e:${m.messageId}:${code}`, kind: "evidence", msgId: m.messageId, row: m.contextId, round: m.round, to: { kind: "tag", row: m.contextId, code }, active: on, more });
  }
  return out;
}

function uniqueCodes(cites: readonly AgentCitation[]): string[] {
  return [...new Set(cites.map((c) => c.code))];
}

/** How strongly a thread is drawn: the message just pinned, the current round's history, or older rounds. */
export function roundEmphasis(active: boolean, round: number, current: number): "active" | "current" | "past" {
  if (active) return "active";
  return round >= current ? "current" : "past";
}

/** Roving focus over a row of cards: the index an arrow, Home or End key moves to (clamped), or null for any other
 *  key or an empty row. */
export function rovingIndex(cur: number, count: number, key: string): number | null {
  if (count <= 0) return null;
  const clamp = (i: number) => Math.min(count - 1, Math.max(0, i));
  if (key === "ArrowRight" || key === "ArrowDown") return clamp(cur + 1);
  if (key === "ArrowLeft" || key === "ArrowUp") return clamp(cur - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/** A dossier's hover card at the frame (built on show from the row as of the cursor, never stored). */
export function dossierTipWords(row: {
  label: string;
  fetched: number;
  incumbent: boolean;
  counts: { supported: number; partly: number; withheld: number } | null;
  memos: number;
}): { title: string; lines: string[] } {
  return {
    title: row.label,
    lines: [
      `${row.fetched} sources fetched${row.incumbent ? ", incumbent" : ""}`,
      row.counts ? `S7 verdicts: ${row.counts.supported} supported, ${row.counts.partly} partly, ${row.counts.withheld} withheld` : "No S7 verdicts recorded for this rival yet",
      row.memos ? `${row.memos} memos in the war game` : "No memos yet",
    ],
  };
}
