/**
 * The replay transport's keyboard map, deep link and clock: pure, so the dock and the tests read the same rules.
 *
 * Keys: Space plays or pauses; Left / Right step five seconds of the run's time; Shift with them jumps to the
 * previous or next stage or gate; Home / End go to the start or the end of the record. A key is left alone while
 * the focus types, when the focused control owns it (Space on a button, the arrows in a tab list or a radio group),
 * and with Ctrl, Alt or Cmd held. The replay's own scrubber takes every replay key.
 *
 * Deep link: `?replay=1&t=<seconds>` opens the replay at that moment, counted from the run's creation.
 */
export type ReplayAction = { type: "toggle" } | { type: "seek"; deltaMs: number } | { type: "jump"; dir: 1 | -1 } | { type: "start" } | { type: "end" };

export const SEEK_STEP_MS = 5_000;

export interface ReplayKeyInput {
  key: string;
  shift?: boolean;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  /** The focused element's tag name and ARIA role, and whether it is editable. */
  tag?: string | null;
  role?: string | null;
  editable?: boolean;
  /** The focus is on the replay's own scrubber. */
  scrubber?: boolean;
}

const TYPING_TAGS: ReadonlySet<string> = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const ACTIVATING_TAGS: ReadonlySet<string> = new Set(["BUTTON", "A", "SUMMARY"]);
const ACTIVATING_ROLES: ReadonlySet<string> = new Set(["button", "link", "checkbox", "switch", "tab", "radio", "menuitem", "menuitemradio", "menuitemcheckbox", "option"]);
/** Roles whose own keyboard model uses the arrows, Home and End. */
const ARROW_ROLES: ReadonlySet<string> = new Set([
  "tab",
  "tablist",
  "radio",
  "radiogroup",
  "slider",
  "spinbutton",
  "menu",
  "menubar",
  "menuitem",
  "menuitemradio",
  "menuitemcheckbox",
  "option",
  "listbox",
  "combobox",
  "tree",
  "treeitem",
  "grid",
  "gridcell",
]);

export function replayKey(i: ReplayKeyInput): ReplayAction | null {
  if (i.meta || i.ctrl || i.alt) return null;
  const own = i.scrubber === true;
  const tag = (i.tag ?? "").toUpperCase();
  const role = (i.role ?? "").toLowerCase();
  if (!own && (i.editable || TYPING_TAGS.has(tag))) return null;
  const ownsArrows = !own && ARROW_ROLES.has(role);
  const activates = !own && (ACTIVATING_TAGS.has(tag) || ACTIVATING_ROLES.has(role));
  switch (i.key) {
    case " ":
    case "Spacebar":
      return activates ? null : { type: "toggle" };
    case "ArrowLeft":
    case "ArrowRight": {
      if (ownsArrows) return null;
      const dir = i.key === "ArrowRight" ? 1 : -1;
      return i.shift ? { type: "jump", dir } : { type: "seek", deltaMs: dir * SEEK_STEP_MS };
    }
    case "Home":
      return ownsArrows ? null : { type: "start" };
    case "End":
      return ownsArrows ? null : { type: "end" };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------------------------------------ deep link */

export interface ReplayParams {
  replay: boolean;
  /** Seconds from the run's creation, or null. */
  t: number | null;
}

/** `?replay=1&t=<seconds>`: the replay flag and the moment (a non-negative number of seconds, else null). */
export function parseReplayParams(get: (name: string) => string | null): ReplayParams {
  const flag = get("replay")?.trim().toLowerCase();
  const raw = get("t")?.trim() ?? "";
  const t = /^\d{1,7}(\.\d{1,3})?$/.test(raw) ? Number(raw) : null;
  return { replay: flag === "1" || flag === "true", t };
}

/** `href` with the replay flag and moment set (seconds to the millisecond, so a copied link opens at the selected
 *  event and not before it), or both removed; other parameters are kept. */
export function replayHref(href: string, next: ReplayParams): string {
  const url = new URL(href);
  if (!next.replay) {
    url.searchParams.delete("replay");
    url.searchParams.delete("t");
    return url.toString();
  }
  url.searchParams.set("replay", "1");
  if (next.t === null || !Number.isFinite(next.t)) url.searchParams.delete("t");
  else url.searchParams.set("t", String(Math.round(Math.max(0, next.t) * 1000) / 1000));
  return url.toString();
}

/* ------------------------------------------------------------------------------------------------ clock */

const formats = new Map<string, Intl.DateTimeFormat>();

function format(timeZone: string | undefined, zone: boolean): Intl.DateTimeFormat {
  const key = `${timeZone ?? ""}|${zone ? 1 : 0}`;
  let f = formats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      ...(timeZone ? { timeZone } : {}),
      ...(zone ? { timeZoneName: "short" } : {}),
    });
    formats.set(key, f);
  }
  return f;
}

/** "14:32:07": a recorded time of day with seconds, in the viewer's time zone (or `timeZone`). */
export function timeOfDay(ms: number, timeZone?: string): string {
  if (!Number.isFinite(ms)) return "--:--:--";
  const parts = format(timeZone, false).formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${part("hour")}:${part("minute")}:${part("second")}`;
}

const days = new Map<string, Intl.DateTimeFormat>();

/** "Oct 5": the recorded day, in the viewer's time zone (or `timeZone`). */
export function dayOf(ms: number, timeZone?: string): string {
  if (!Number.isFinite(ms)) return "";
  const key = timeZone ?? "";
  let f = days.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", ...(timeZone ? { timeZone } : {}) });
    days.set(key, f);
  }
  return f.format(ms);
}

/** The time zone's short name at that moment ("EDT", "UTC", "GMT+5:30"), or "". */
export function zoneName(ms: number, timeZone?: string): string {
  if (!Number.isFinite(ms)) return "";
  return format(timeZone, true).formatToParts(ms).find((p) => p.type === "timeZoneName")?.value ?? "";
}
