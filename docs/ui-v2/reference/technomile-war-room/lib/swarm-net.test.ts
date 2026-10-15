import { describe, expect, it } from "vitest";

import { timedPods, timedSwarm } from "./__fixtures__/swarm-timed";
import { planOffice, rivalPods } from "./office";
import { foldSwarm } from "./swarm";
import {
  ANALYST,
  BENCH,
  edgeGeometry,
  edgeId,
  highlight,
  layoutNetwork,
  neighbours,
  netEdges,
  nodeOf,
  pairKey,
  RED,
  ribbonWidth,
  targets,
  WORLD,
  type Rect,
} from "./swarm-net";

const view = timedSwarm();
const layout = layoutNetwork(view, timedPods());

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const square = (d: { x: number; y: number; r: number }): Rect => ({ x: d.x - d.r, y: d.y - d.r, w: 2 * d.r, h: 2 * d.r });

describe("targets", () => {
  it("keeps agents, turns groups into anchors, drops the sender, unknown ids and duplicates", () => {
    expect(targets(view, { from: "cgi.capture_lead", to: ["board", "red_team", "board"] })).toEqual(["anchor:board", "red_team"]);
    expect(targets(view, { from: "red_team", to: ["red_team", "nobody", "cgi.capture_lead"] })).toEqual(["cgi.capture_lead"]);
    expect(targets(view, { from: "cgi.capture_lead", to: ["cgi"] })).toEqual(["anchor:cgi"]);
    expect(targets(foldSwarm([]), { from: "x", to: ["board", "analyst"] })).toEqual(["anchor:board", "anchor:analyst"]);
  });
});

describe("layoutNetwork", () => {
  it("is deterministic and keeps every pod and hub inside the world without overlaps, for 0 to 8 rivals", () => {
    for (let n = 0; n <= 8; n++) {
      const pods = Array.from({ length: n }, (_, i) => ({ key: `R${i}`, label: `Rival ${i}`, groupId: null, team: i % 6 }));
      const a = layoutNetwork(foldSwarm([]), pods);
      expect(layoutNetwork(foldSwarm([]), pods)).toEqual(a);
      const rects = [...a.pods.map((p) => p.rect), square(ANALYST), square(RED), BENCH];
      for (const r of rects) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(WORLD.w);
        expect(r.y + r.h).toBeLessThanOrEqual(WORLD.h);
      }
      rects.forEach((r, i) => rects.slice(i + 1).forEach((q) => expect(overlap(r, q)).toBe(false)));
      expect(a.pods.filter((p) => p.side === "left")).toHaveLength(Math.ceil(n / 2));
    }
  });

  it("places the lead as the pod's hub and the specialists in their reserved rows, the board on its bench", () => {
    const pod = layout.pods[0]!;
    expect(layout.byId["cgi.capture_lead"]).toMatchObject({ shape: "disc", x: pod.lead.x, y: pod.lead.y, team: 0 });
    expect(layout.byId["cgi.pricing"]?.rect).toEqual(pod.pills[0]);
    expect(layout.byId["cgi.past_performance"]?.rect).toEqual(pod.pills[2]);
    expect(layout.byId["cgi.pricing"]?.port?.x).toBe(pod.pills[0]!.x + pod.pills[0]!.w);
    expect(layout.byId["deloitte.pricing"]?.port?.x).toBe(layout.byId["deloitte.pricing"]?.rect?.x);
    expect(layout.byId["board.technical"]).toMatchObject({ kind: "board", label: "Technical", y: 590 });
    expect(layout.byId.red_team).toMatchObject({ x: RED.x, y: RED.y });
    expect(layout.anchorById["anchor:cgi"]).toMatchObject({ x: pod.lead.x });
  });

  it("keeps every slot when the board's cards arrive", () => {
    const early = layoutNetwork(timedSwarm({ until: 150 }), timedPods());
    expect(early.pods).toEqual(layout.pods);
    expect(early.bench).toEqual(layout.bench);
    for (const a of early.agents) expect(layout.byId[a.id]).toEqual(a);
  });

  it("gives a pod the team index the office gives it", () => {
    const record = { lanes: [], fetches: [], verifies: [], stages: [], parks: [], notes: [], lastSeq: 0 };
    const pods = rivalPods(view, record);
    const plan = planOffice(view, record);
    expect(pods.map((p) => p.team)).toEqual(plan.pods.map((p) => p.team));
    expect(layoutNetwork(view, pods).pods.map((p) => p.groupId)).toEqual(["cgi", "akumen", "zen", "deloitte"]);
  });

  it("appends rivals the list does not name, takes the first card as a hub, and stacks a large team", () => {
    const big = foldSwarm([]);
    const v = timedSwarm({ rivals: 1 });
    const extra = layoutNetwork(v, []);
    expect(extra.pods).toHaveLength(1);
    expect(extra.pods[0]?.key).toBe("group:cgi");
    // a team without a capture lead: its first card is the hub
    const noLead = { ...v, groups: v.groups.map((g) => (g.id === "cgi" ? { ...g, agents: g.agents.filter((a) => a.role !== "capture_lead") } : g)) };
    expect(layoutNetwork(noLead, []).byId["cgi.pricing"]?.shape).toBe("disc");
    // five members: two unknown roles take the free rows, then the column stacks
    const extraCards = ["a", "b", "c"].map((x) => ({ ...v.cards["cgi.pricing"]!, agentId: `cgi.${x}`, role: "scout" }));
    const crowd = { ...v, groups: v.groups.map((g) => (g.id === "cgi" ? { ...g, agents: [...g.agents, ...extraCards] } : g)) };
    const l = layoutNetwork(crowd, []);
    const pills = l.agents.filter((a) => a.groupId === "cgi" && a.shape === "pill");
    expect(pills).toHaveLength(6);
    const ys = pills.map((p) => p.rect!.y);
    expect(new Set(ys).size).toBe(6);
    expect(big.groups).toEqual([]);
  });

  it("folds each team into one disc in the compact layout", () => {
    const c = layoutNetwork(view, timedPods(), { compact: true });
    expect(c.compact).toBe(true);
    expect(nodeOf(c, "cgi.pricing")).toBe("team:cgi");
    expect(nodeOf(c, "anchor:cgi")).toBe("team:cgi");
    expect(nodeOf(c, "red_team")).toBe("red_team");
    expect(c.byId["team:cgi"]?.shape).toBe("disc");
    expect(c.agents.filter((a) => a.kind === "board")).toHaveLength(3);
    // a team's own briefs have no edge there
    expect(netEdges(view, c).some((e) => e.from === e.to)).toBe(false);
    expect(netEdges(view, c).map((e) => e.key)).toContain("team:cgi>red_team");
  });
});

describe("netEdges", () => {
  it("folds messages into directed edges in first-message order, a group as its anchor", () => {
    const edges = netEdges(view, layout);
    const lead = edges.find((e) => e.key === edgeId("cgi.capture_lead", "red_team"))!;
    expect(lead.messageIds).toEqual(["cgi-s", "cgi-r"]);
    expect(edges.find((e) => e.key === edgeId("red_team", "cgi.capture_lead"))?.messageIds).toEqual(["cgi-c"]);
    expect(edges.find((e) => e.key === "cgi.capture_lead>anchor:board")?.messageIds).toEqual(["cgi-r"]);
    expect(edges.find((e) => e.key === "board.technical>anchor:board")).toBeDefined();
    expect(edges.some((e) => e.to.startsWith("board."))).toBe(false);
    const ghost = { ...view, messages: [{ ...view.messages[0]!, from: "ghost" }] };
    expect(netEdges(ghost)).toEqual([]);
    expect(pairKey("b", "a")).toBe("a~b");
    expect(neighbours(edges).red_team).toContain("cgi.capture_lead");
  });
});

describe("edgeGeometry", () => {
  const dist = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y);

  it("starts and ends just outside both rims", () => {
    const g = edgeGeometry(layout, "cgi.capture_lead", "red_team")!;
    const lead = layout.byId["cgi.capture_lead"]!;
    expect(g.shape).toBe("lens");
    expect(dist(g.pointAt(0), lead)).toBeCloseTo(lead.r + 3, 0);
    expect(dist(g.pointAt(1), RED)).toBeCloseTo(RED.r + 3, 0);
    expect(g.start).toEqual(g.pointAt(0));
    expect(g.midpoint).toEqual(g.pointAt(0.5));
    expect(g.d.startsWith("M")).toBe(true);
    expect(edgeGeometry(layout, "nobody", "red_team")).toBeNull();
  });

  it("draws a lead's edge to the red team and the edge back as a lens on opposite sides", () => {
    const out = edgeGeometry(layout, "cgi.capture_lead", "red_team")!;
    const back = edgeGeometry(layout, "red_team", "cgi.capture_lead")!;
    const chordY = (layout.byId["cgi.capture_lead"]!.y + RED.y) / 2;
    const chordX = (layout.byId["cgi.capture_lead"]!.x + RED.x) / 2;
    const side = (p: { x: number; y: number }) => Math.sign((p.x - chordX) * (RED.y - chordY) - (p.y - chordY) * (RED.x - chordX));
    expect(side(out.midpoint)).toBe(-side(back.midpoint));
  });

  it("bows other hub edges away from the red team, flows briefs from the port and arcs ratings into the inbox", () => {
    const hub = edgeGeometry(layout, "cgi.capture_lead", "anchor:board")!;
    expect(hub.shape).toBe("hub");
    const chord = { x: (layout.byId["cgi.capture_lead"]!.x + layout.bench.inbox.x + 52) / 2, y: (layout.byId["cgi.capture_lead"]!.y + layout.bench.inbox.y + 14) / 2 };
    expect(dist(hub.midpoint, RED)).toBeGreaterThan(dist(chord, RED));
    const brief = edgeGeometry(layout, "cgi.pricing", "cgi.capture_lead")!;
    expect(brief.shape).toBe("brief");
    const port = layout.byId["cgi.pricing"]!.port!;
    expect(brief.pointAt(0).y).toBeCloseTo(port.y, 0);
    expect(brief.pointAt(0).x).toBeGreaterThan(port.x);
    expect(brief.ribbon(6).split("L")).toHaveLength(48);
    expect(edgeGeometry(layout, "deloitte.pricing", "deloitte.capture_lead")?.pointAt(0).x).toBeLessThan(layout.byId["deloitte.pricing"]!.port!.x);
    for (const seat of ["board.technical", "board.management", "board.past_performance"]) expect(edgeGeometry(layout, seat, "anchor:board")?.shape).toBe("rating");
    expect(edgeGeometry(layout, "analyst", "anchor:red_team")?.shape).toBe("lens");
  });

  it("tapers the ribbon to 45% of its width at the target", () => {
    const g = edgeGeometry(layout, "cgi.capture_lead", "anchor:board")!;
    const nums = g.ribbon(10).replace(/[MLZ]/g, " ").trim().split(/\s+/).map(Number);
    const pts = Array.from({ length: nums.length / 2 }, (_, i) => ({ x: nums[2 * i]!, y: nums[2 * i + 1]! }));
    expect(pts).toHaveLength(48);
    expect(dist(pts[0]!, pts[47]!)).toBeCloseTo(10, 0);
    expect(dist(pts[23]!, pts[24]!)).toBeCloseTo(4.5, 0);
    expect(ribbonWidth(0)).toBe(1.4);
    expect(ribbonWidth(4)).toBeCloseTo(4.6);
    expect(g.length).toBeGreaterThan(0);
  });
});

describe("highlight", () => {
  const full = layoutNetwork(view, timedPods());
  const compact = layoutNetwork(view, timedPods(), { compact: true });
  const nb = (l: typeof full) => neighbours(netEdges(view, l));

  it("lights an agent's ego network and dims the rest", () => {
    const h = highlight("agent:cgi.capture_lead", full, nb(full));
    expect(h.dimming).toBe(true);
    expect(h.lit("cgi.capture_lead")).toBe(true);
    expect(h.lit("red_team")).toBe(true);
    expect(h.lit("akumen.capture_lead")).toBe(false);
    expect(h.litEdge("cgi.capture_lead", "red_team")).toBe(true);
    expect(h.litEdge("akumen.capture_lead", "red_team")).toBe(false);
    expect(highlight(null, full, nb(full)).lit("anything")).toBe(true);
  });

  it("follows the compact layout's aliases for a pinned agent and a pinned conversation", () => {
    const h = highlight("agent:cgi.pricing", compact, nb(compact));
    expect(h.lit("team:cgi")).toBe(true);
    expect(h.lit("red_team")).toBe(true);
    expect(h.litEdge("team:cgi", "red_team")).toBe(true);
    const e = highlight(`edge:${pairKey("cgi.capture_lead", "red_team")}`, compact, nb(compact));
    expect(e.lit("team:cgi")).toBe(true);
    expect(e.litEdge("red_team", "team:cgi")).toBe(true);
    expect(e.litEdge("team:zen", "red_team")).toBe(false);
  });

  it("lights a whole team or the board for a group focus", () => {
    const g = highlight("cgi", full, nb(full));
    expect(g.lit("cgi.pricing")).toBe(true);
    expect(g.lit("anchor:cgi")).toBe(true);
    expect(g.lit("zen.pricing")).toBe(false);
    expect(g.litEdge("red_team", "cgi.capture_lead")).toBe(true);
    expect(highlight("team:cgi", compact, nb(compact)).lit("team:cgi")).toBe(true);
  });
});

describe("highlight across layouts", () => {
  const full = layoutNetwork(view, timedPods());
  const nb = neighbours(netEdges(view, full));

  it("resolves a compact team in the full layout (selected narrow, then widened)", () => {
    const team = highlight("team:cgi", full, nb);
    expect(team.lit("cgi.pricing")).toBe(true);
    expect(team.lit("red_team")).toBe(true);
    expect(team.lit("zen.pricing")).toBe(false);
    expect(team.litEdge("cgi.capture_lead", "red_team")).toBe(true);
    expect(team.litEdge("zen.capture_lead", "red_team")).toBe(false);
    const edge = highlight(`edge:${pairKey("team:cgi", "red_team")}`, full, nb);
    expect(edge.lit("cgi.capture_lead")).toBe(true);
    expect(edge.litEdge("red_team", "cgi.capture_lead")).toBe(true);
    expect(edge.litEdge("cgi.pricing", "cgi.capture_lead")).toBe(false);
    expect(edge.litEdge("zen.capture_lead", "red_team")).toBe(false);
  });
});
