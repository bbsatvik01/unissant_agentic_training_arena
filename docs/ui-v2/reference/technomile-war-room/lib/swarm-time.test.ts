import { describe, expect, it } from "vitest";

import { T0, timedPods, timedSwarm } from "./__fixtures__/swarm-timed";
import { foldSwarm } from "./swarm";
import { layoutNetwork } from "./swarm-net";
import {
  ariaFor,
  buildModel,
  captionFor,
  easeInOutCubic,
  feedSettledAt,
  FEED_LEAD_MS,
  firstSentence,
  flightWallMs,
  formatSince,
  formatSpan,
  heatHoldMs,
  lod,
  messageCaption,
  replayFrame,
  roundSeek,
  scheduleFeed,
  speaker,
  stepTarget,
  swarmAt,
} from "./swarm-time";

const view = timedSwarm();
const layout = layoutNetwork(view, timedPods());
const model = buildModel(view, layout);
const s = (sec: number) => T0 + sec * 1000;
const SPECIALISTS = Object.keys(view.cards).filter((id) => /\.(pricing|technical|past_performance)$/.test(id));

describe("buildModel", () => {
  it("sets the S9 origin at the first card and the end after the last change", () => {
    expect(model.start).toBe(s(-10.6));
    expect(model.origin).toBe(model.start);
    expect(model.end).toBe(s(186) + 950);
    expect(model.roundStarts.map((r) => r.round)).toEqual([1, 2, 3, 4]);
    expect(model.byId["cgi-c"]).toMatchObject({ from: "red_team", targets: ["cgi.capture_lead"], threadTeam: 0, toBoard: false });
    expect(model.byId["cgi-r"]).toMatchObject({ targets: ["anchor:board", "red_team"], toBoard: true });
    expect(model.byId["v-technical"]?.toBoard).toBe(false);
  });

  it("starts a call at its card at the earliest, and handles a run with no swarm", () => {
    expect(model.byId["cgi-b0"]?.start).toBe(s(-9));
    const empty = buildModel(foldSwarm([]), layoutNetwork(foldSwarm([]), []));
    expect(empty.start).toBeNaN();
    expect(empty.end).toBeNaN();
  });
});

describe("swarmAt on the recorded run", () => {
  it("at -9.0 has all twelve specialists working and nothing sent", () => {
    const f = swarmAt(model, s(-9));
    expect(SPECIALISTS.filter((id) => f.agents[id]?.status === "working")).toHaveLength(12);
    expect(f.sent).toBe(0);
    expect(f.latest).toBeNull();
    expect(f.inFlight).toBe(12);
    expect(captionFor(f, model, view).line).toBe("Working: 12 calls in flight");
  });

  it("at +86 holds three red-team challenges, tinted by their rival", () => {
    const f = swarmAt(model, s(86));
    const tasks = f.agents.red_team!.tasks;
    expect(tasks.map((t) => [t.contextId, Math.round((t.start - T0) / 100) / 10, Math.round((t.end - T0) / 100) / 10])).toEqual([
      ["cgi", 64.7, 87],
      ["akumen", 76.3, 94.8],
      ["deloitte", 79.4, 98.2],
    ]);
    expect(tasks.map((t) => t.team)).toEqual([0, 1, 3]);
    expect(f.redInFlight).toBe(3);
    expect(ariaFor(view, "red_team", f)).toContain("working on a 22.3 s model call, 3 calls in flight");
  });

  it("at +87.0 flies the CGI challenge before Zenpoint's strategy", () => {
    const f = swarmAt(model, s(87.0));
    const c = f.flights.find((x) => x.messageId === "cgi-c")!;
    expect(c.u).toBeCloseTo(0, 2);
    expect(f.agents.red_team?.status).toBe("sending");
    expect(f.flights.some((x) => x.messageId === "zen-s")).toBe(false);
    expect(f.ripples.some((r) => r.key === "launch:cgi-c")).toBe(true);
    expect(f.edges["red_team>cgi.capture_lead"]?.heat).toBe(1);
    expect(captionFor(f, model, view).line).toMatch(/^Challenge · Red team -> CGI FEDERAL capture lead · S9\+01:37\.6 · 22\.3 s · 0 cited · gemini-flash$/);
  });

  it("at +160 holds four proposals with no seat, at +172 three seats working, at +186 the result", () => {
    const a = swarmAt(model, s(160));
    expect(a.board).toMatchObject({ proposals: 4, convened: false, status: "waiting" });
    expect(a.board.from).toEqual(["cgi", "akumen", "deloitte", "zen"]);
    expect(a.agents["board.technical"]?.present).toBe(false);
    expect(ariaFor(view, "board.technical", a)).toBe("Evaluator, technical: not in the swarm yet");
    const b = swarmAt(model, s(172));
    expect(["board.technical", "board.management", "board.past_performance"].map((id) => b.agents[id]?.status)).toEqual(["working", "working", "working"]);
    expect(b.board.status).toBe("scoring");
    const c = swarmAt(model, s(186));
    expect(c.board.status).toBe("scored");
    expect(c.pods.cgi?.result).toEqual({ code: "A", share: 0.86, incumbent: true });
    expect(c.pods.cgi).toMatchObject({ count: 6, round: 3 });
    expect(c.board.ratings).toBe(3);
    expect(captionFor(c, model, view).line).toBe("Board scored: CGI FEDERAL 86% of the simulated vote. Simulated, never an input to the bid decision.");
  });

  it("moves a comet to the midpoint at half its flight, at 1x and at 16x", () => {
    for (const speed of [1, 16]) {
      const half = (flightWallMs(speed) * speed) / 2;
      const f = swarmAt(model, s(87) + half, { speed });
      expect(f.flights.find((x) => x.messageId === "cgi-c")?.u).toBeCloseTo(0.5, 5);
    }
  });

  it("cools an edge after its hold, and lands with a ring", () => {
    const hold = heatHoldMs(1);
    expect(swarmAt(model, s(87) + hold + 600).edges["red_team>cgi.capture_lead"]?.heat).toBeCloseTo(0.5, 5);
    expect(swarmAt(model, s(87) + hold + 5000).edges["red_team>cgi.capture_lead"]?.heat).toBe(0);
    const land = swarmAt(model, s(87) + flightWallMs(1) + 100);
    expect(land.ripples.find((r) => r.key === "land:cgi-c:cgi.capture_lead")?.p).toBeCloseTo(0.2, 5);
    expect(land.agents["cgi.capture_lead"]?.status).toBe("receiving");
  });

  it("stops a failed comet at the midpoint and fades it; a rejected message has no flight", () => {
    const fm = buildModel(timedSwarm({ faults: true }), layout);
    const early = swarmAt(fm, s(94.8) + 100);
    expect(early.flights.find((x) => x.messageId === "akumen-c")?.failed).toBe(true);
    const stop = swarmAt(fm, s(94.8) + flightWallMs(1) * 0.5 + 600);
    expect(stop.flights.find((x) => x.messageId === "akumen-c")).toMatchObject({ u: 0.5, fade: 0.5 });
    expect(stop.edges["red_team>akumen.capture_lead"]?.failed).toBe(true);
    expect(stop.agents.red_team?.failed).toBe(true);
    const rej = swarmAt(fm, s(133) + 10);
    expect(rej.flights.some((x) => x.messageId === "cgi-i")).toBe(false);
    expect(rej.agents["cgi.capture_lead"]?.rejected).toBe(true);
    expect(messageCaption(fm.byId["cgi-i"]!, fm, view).line).toContain("not run: budget");
    expect(messageCaption(fm.byId["akumen-c"]!, fm, view).line).toContain("failed");
    expect(ariaFor(view, "cgi.capture_lead", rej)).toContain("a call was not run (budget)");
    expect(ariaFor(view, "red_team", rej)).toContain("a call failed");
  });

  it("drops comets, ripples and heat under reduced motion but keeps the sender filled", () => {
    const f = swarmAt(model, s(87) + 50, { reduced: true });
    expect(f.flights).toEqual([]);
    expect(f.ripples).toEqual([]);
    expect(f.edges["red_team>cgi.capture_lead"]?.heat).toBe(0);
    expect(f.agents.red_team?.status).toBe("sending");
  });

  it("shows a live call only from when its message became known", () => {
    const known = (id: string) => (id === "cgi-c" ? s(86) : undefined);
    const f = swarmAt(model, s(85), { live: true, knownAt: known });
    expect(f.agents.red_team?.tasks).toEqual([]);
    const g = swarmAt(model, s(86.5), { live: true, knownAt: known });
    expect(g.agents.red_team?.tasks.map((t) => t.messageId)).toEqual(["cgi-c"]);
    expect(g.agents.red_team?.tasks[0]?.start).toBe(s(86));
  });

  it("sets level of detail by speed", () => {
    expect(lod(1)).toEqual({ tail: 12, glyph: true, ripple: true });
    expect(lod(4)).toEqual({ tail: 8, glyph: true, ripple: true });
    expect(lod(8)).toEqual({ tail: 4, glyph: false, ripple: false });
    expect(lod(16)).toEqual({ tail: 0, glyph: false, ripple: false });
    expect(flightWallMs(1)).toBe(950);
    expect(flightWallMs(16)).toBeCloseTo(260);
    expect(heatHoldMs(0)).toBe(2500);
    expect(easeInOutCubic(0.25)).toBeCloseTo(0.0625);
    expect(easeInOutCubic(0.75)).toBeCloseTo(0.9375);
  });
});

describe("replayFrame (the run-level replay's clock)", () => {
  it("draws a paused seek at the cursor's recorded time, whatever the wall clock", () => {
    const at86 = replayFrame(model, s(86), { speed: 1, ended: false });
    expect(at86.latest?.id).not.toBe("cgi-c");
    expect(at86.agents.red_team?.tasks).toHaveLength(3);
    const at88 = replayFrame(model, s(88), { speed: 1, ended: false });
    expect(at88.latest?.id).toBe("cgi-c");
    expect(at88.edges["red_team>cgi.capture_lead"]?.count).toBe(1);
    // seeking back undoes it: no schedule is kept between frames
    expect(replayFrame(model, s(86), { speed: 1, ended: false }).edges["red_team>cgi.capture_lead"]).toBeUndefined();
  });

  it("settles every transient at the end of the record", () => {
    const end = replayFrame(model, s(181), { speed: 16, ended: true });
    expect(end.flights).toEqual([]);
    expect(end.ripples).toEqual([]);
    expect(Object.values(end.edges).every((e) => e.heat === 0)).toBe(true);
    expect(end.board.status).toBe("scored");
  });
});

describe("stepping", () => {
  it("steps by message and by round, and stops at the ends", () => {
    expect(stepTarget(model, s(87), 1, "message")).toBe(s(90.5));
    expect(stepTarget(model, s(87), -1, "message")).toBe(s(58.6));
    expect(stepTarget(model, s(500), 1, "message")).toBeNull();
    expect(stepTarget(model, s(-20), -1, "message")).toBeNull();
    expect(stepTarget(model, s(0), 1, "round")).toBe(s(2));
    expect(stepTarget(model, s(5), 1, "round")).toBe(s(85));
    expect(stepTarget(model, s(87) - 1000, -1, "round")).toBe(s(4) - 2000);
    expect(roundSeek(model, 3)).toBe(s(132) - 2000);
    expect(roundSeek(model, 9)).toBeNull();
  });
});

describe("words", () => {
  it("formats time since S9", () => {
    expect(formatSince(87_049)).toBe("S9+01:27.0");
    expect(formatSince(87_012, true)).toBe("S9+01:27.012");
    expect(formatSince(-1500)).toBe("S9-00:01.5");
    expect(formatSpan(196_400)).toBe("3:16");
    expect(formatSpan(-5)).toBe("0:00");
  });

  it("names speakers and trims first sentences", () => {
    expect(speaker(view, "anchor:board")).toBe("the board");
    expect(speaker(view, "anchor:cgi")).toBe("CGI FEDERAL team");
    expect(speaker(view, "team:zen")).toBe("Zenpoint Solutions team");
    expect(speaker(view, "team:nope")).toBe("nope");
    expect(speaker(view, "analyst")).toBe("Home analyst");
    expect(speaker(view, "board.management")).toBe("Management evaluator");
    expect(speaker(view, "red_team")).toBe("Red team");
    expect(speaker(view, "nobody")).toBe("nobody");
    expect(firstSentence("One. Two.")).toBe("One.");
    expect(firstSentence("x".repeat(200), 10)).toBe("xxxxxxx...");
    expect(ariaFor(view, "team:cgi", swarmAt(model, s(0)))).toBe("CGI FEDERAL INC. capture team: not in the swarm yet");
  });

  it("captions the latest message between calls, and nothing before the first", () => {
    expect(captionFor(swarmAt(model, s(-20)), model, view)).toMatchObject({ kind: "none", line: "" });
    const late = swarmAt(model, s(181) + 20_000);
    expect(captionFor({ ...late, board: { ...late.board, result: null } }, model, view).kind).toBe("message");
    expect(captionFor({ ...late, board: { ...late.board, result: { ...late.board.result!, rows: [] } } }, model, view).line).toBe("Board scored. Simulated, never an input to the bid decision.");
  });
});

describe("scheduleFeed", () => {
  const early = timedSwarm({ until: 86 });
  const later = timedSwarm({ until: 88 });

  it("names the latest message by recorded order, not by when it is drawn", () => {
    const first = scheduleFeed(null, timedSwarm({ until: 86 }), 0);
    const live = scheduleFeed(first, timedSwarm({ until: 88 }), 10_000);
    const jump = scheduleFeed(live, view, 10_500);
    const m = buildModel(view, layout, jump);
    expect(swarmAt(m, 10_700 + 100).latest?.id).toBe("v-past_performance");
  });

  it("follows a replay that seeks back and plays forward again", () => {
    const first = scheduleFeed(null, timedSwarm({ until: 100 }), 0);
    const back = scheduleFeed(first, timedSwarm({ until: 86 }), 5000);
    expect(back.messages["cgi-c"]).toBeUndefined();
    expect(back.board).toBeNull();
    const fwd = scheduleFeed(back, timedSwarm({ until: 88 }), 6000);
    expect(fwd.messages["cgi-c"]).toBe(6000 + FEED_LEAD_MS);
    const pending = scheduleFeed(fwd, timedSwarm({ until: 86 }), 6100);
    expect(pending.last).toBe(0);
    expect(scheduleFeed(pending, timedSwarm({ until: 88 }), 6200).messages["cgi-c"]).toBe(6200 + FEED_LEAD_MS);
  });

  it("treats the first read as settled history", () => {
    const first = scheduleFeed(null, early, 1000);
    expect(Object.values(first.messages).every((v) => v === 0)).toBe(true);
    expect(Object.values(first.cards).every((v) => v === 0)).toBe(true);
    expect(first.board).toBeNull();
    expect(first.last).toBe(0);
  });

  it("launches a new message a lead after it arrives, in recorded order, and draws it then", () => {
    const first = scheduleFeed(null, early, 1000);
    const next = scheduleFeed(first, later, 50_000);
    expect(next.messages["cgi-c"]).toBe(50_000 + FEED_LEAD_MS);
    expect(next.known["cgi-c"]).toBe(50_000);
    expect(next.messages["cgi-s"]).toBe(0);
    expect(feedSettledAt(next)).toBeGreaterThan(next.last);
    const m = buildModel(later, layout, next);
    expect(m.byId["cgi-c"]).toMatchObject({ ts: 50_700, recorded: s(87) });
    const frame = swarmAt(m, 50_200, { live: true, knownAt: (id) => next.known[id] });
    expect(frame.agents.red_team?.tasks.map((t) => t.messageId)).toEqual(["cgi-c"]);
    expect(frame.agents.red_team?.tasks[0]?.progress).toBeGreaterThan(0.95);
    expect(swarmAt(m, 50_700 + 100, { live: true }).flying).toEqual(["cgi-c"]);
    expect(messageCaption(m.byId["cgi-c"]!, m, later).line).toContain("S9+01:37.6");
  });

  it("spreads a batch over at most 2.5 s and settles a jump", () => {
    const first = scheduleFeed(null, timedSwarm({ until: 80 }), 0);
    const batch = scheduleFeed(first, timedSwarm({ until: 91 }), 10_000);
    const launches = ["cgi-c", "zen-s"].map((id) => batch.messages[id]!);
    expect(launches[1]! - launches[0]!).toBeCloseTo(2500, 0);
    const jump = scheduleFeed(first, view, 10_000);
    expect(jump.messages["zen-r"]).toBe(0);
    expect(jump.board).toBe(0);
    const cards = scheduleFeed(scheduleFeed(null, timedSwarm({ until: 160 }), 0), timedSwarm({ until: 170 }), 5000);
    expect(cards.cards["board.technical"]).toBe(5000);
    expect(cards.cards.red_team).toBe(0);
    const board = scheduleFeed(scheduleFeed(null, timedSwarm({ until: 185 }), 0), view, 7000);
    expect(board.board).toBe(7000 + FEED_LEAD_MS);
    // a board-only arrival keeps the loop running until it is drawn
    expect(feedSettledAt(board)).toBeGreaterThan(board.board!);
    expect(scheduleFeed(board, view, 9000).board).toBe(board.board);
  });
});
