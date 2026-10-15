import { describe, expect, it } from "vitest";

import { dayOf, parseReplayParams, replayHref, replayKey, SEEK_STEP_MS, timeOfDay, zoneName } from "./replay-controls";

describe("replayKey (the keyboard map)", () => {
  it("maps Space, the arrows, Shift with the arrows, Home and End", () => {
    expect(replayKey({ key: " " })).toEqual({ type: "toggle" });
    expect(replayKey({ key: "Spacebar" })).toEqual({ type: "toggle" });
    expect(replayKey({ key: "ArrowRight" })).toEqual({ type: "seek", deltaMs: SEEK_STEP_MS });
    expect(replayKey({ key: "ArrowLeft" })).toEqual({ type: "seek", deltaMs: -5_000 });
    expect(replayKey({ key: "ArrowRight", shift: true })).toEqual({ type: "jump", dir: 1 });
    expect(replayKey({ key: "ArrowLeft", shift: true })).toEqual({ type: "jump", dir: -1 });
    expect(replayKey({ key: "Home" })).toEqual({ type: "start" });
    expect(replayKey({ key: "End" })).toEqual({ type: "end" });
    expect(replayKey({ key: "k" })).toBeNull();
    expect(replayKey({ key: "Enter" })).toBeNull();
  });

  it("leaves a key alone with a modifier, while typing, or when the focused control owns it", () => {
    expect(replayKey({ key: " ", ctrl: true })).toBeNull();
    expect(replayKey({ key: "ArrowRight", meta: true })).toBeNull();
    expect(replayKey({ key: "Home", alt: true })).toBeNull();
    expect(replayKey({ key: " ", tag: "INPUT" })).toBeNull();
    expect(replayKey({ key: "ArrowLeft", tag: "textarea" })).toBeNull();
    expect(replayKey({ key: "End", editable: true })).toBeNull();
    // Space belongs to a focused button or link; the arrows still step the replay from there
    expect(replayKey({ key: " ", tag: "BUTTON" })).toBeNull();
    expect(replayKey({ key: " ", tag: "DIV", role: "switch" })).toBeNull();
    expect(replayKey({ key: "ArrowRight", tag: "BUTTON" })).toEqual({ type: "seek", deltaMs: 5_000 });
    // the arrows, Home and End belong to tabs, radio groups and sliders
    expect(replayKey({ key: "ArrowLeft", tag: "BUTTON", role: "tab" })).toBeNull();
    expect(replayKey({ key: "ArrowRight", tag: "BUTTON", role: "radio" })).toBeNull();
    expect(replayKey({ key: "Home", role: "slider" })).toBeNull();
    expect(replayKey({ key: "End", role: "option" })).toBeNull();
    expect(replayKey({ key: " ", tag: "DIV", role: "tablist" })).toEqual({ type: "toggle" });
  });

  it("gives the replay's own scrubber every replay key", () => {
    expect(replayKey({ key: "ArrowRight", role: "slider", scrubber: true })).toEqual({ type: "seek", deltaMs: 5_000 });
    expect(replayKey({ key: " ", role: "slider", scrubber: true })).toEqual({ type: "toggle" });
    expect(replayKey({ key: "Home", role: "slider", scrubber: true })).toEqual({ type: "start" });
    expect(replayKey({ key: "End", tag: "INPUT", scrubber: true })).toEqual({ type: "end" });
    expect(replayKey({ key: " ", role: "slider", scrubber: true, ctrl: true })).toBeNull();
  });
});

describe("the deep link", () => {
  it("reads ?replay=1&t=<seconds>", () => {
    const get = (q: string) => (k: string) => new URLSearchParams(q).get(k);
    expect(parseReplayParams(get("replay=1&t=192"))).toEqual({ replay: true, t: 192 });
    expect(parseReplayParams(get("replay=true&t=12.5"))).toEqual({ replay: true, t: 12.5 });
    expect(parseReplayParams(get("view=office"))).toEqual({ replay: false, t: null });
    expect(parseReplayParams(get("replay=0&t=-4"))).toEqual({ replay: false, t: null });
    expect(parseReplayParams(get("replay=1&t=abc"))).toEqual({ replay: true, t: null });
    expect(parseReplayParams(get("replay=1&t=1e9"))).toEqual({ replay: true, t: null });
  });

  it("writes the flag and the moment and keeps the rest of the link", () => {
    const base = "https://x.test/runs/r/war-room?view=office&step=S4";
    const on = replayHref(base, { replay: true, t: 192.46 });
    expect(on).toBe("https://x.test/runs/r/war-room?view=office&step=S4&replay=1&t=192.46");
    expect(parseReplayParams((k) => new URL(on).searchParams.get(k))).toEqual({ replay: true, t: 192.46 });
    // millisecond precision: a copied link opens at the selected event, not before it
    const exact = replayHref(base, { replay: true, t: 2.847 });
    expect(exact).toContain("t=2.847");
    expect(parseReplayParams((k) => new URL(exact).searchParams.get(k)).t).toBe(2.847);
    expect(replayHref(base, { replay: true, t: 1.23456 })).toContain("t=1.235");
    expect(replayHref(on, { replay: true, t: null })).toBe("https://x.test/runs/r/war-room?view=office&step=S4&replay=1");
    expect(replayHref(on, { replay: true, t: -3 })).toContain("t=0");
    expect(replayHref(on, { replay: true, t: Number.NaN })).not.toContain("t=");
    expect(replayHref(on, { replay: false, t: null })).toBe(base);
  });
});

describe("the clock", () => {
  const ms = Date.parse("2026-10-05T04:42:31.649Z");

  it("shows the recorded time of day with seconds in a time zone", () => {
    expect(timeOfDay(ms, "UTC")).toBe("04:42:31");
    expect(timeOfDay(ms, "America/New_York")).toBe("00:42:31");
    expect(timeOfDay(Date.parse("2026-10-05T23:59:59Z"), "UTC")).toBe("23:59:59");
    expect(timeOfDay(Number.NaN)).toBe("--:--:--");
    expect(timeOfDay(ms)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("names the recorded day", () => {
    expect(dayOf(ms, "UTC")).toBe("Oct 5");
    expect(dayOf(Date.parse("2026-10-05T02:00:00Z"), "America/Los_Angeles")).toBe("Oct 4");
    expect(dayOf(ms)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    expect(dayOf(Number.NaN)).toBe("");
  });

  it("names the time zone", () => {
    expect(zoneName(ms, "UTC")).toBe("UTC");
    expect(zoneName(ms, "America/New_York")).toBe("EDT");
    expect(zoneName(Number.NaN)).toBe("");
  });
});
