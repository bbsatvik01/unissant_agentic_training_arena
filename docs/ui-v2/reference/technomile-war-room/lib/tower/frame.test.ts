import { describe, expect, it } from "vitest";

import type { OfficePlan } from "../office";
import type { SwarmView } from "../swarm";

import { agentCardAt, type TowerFrame } from "./frame";

const card = { agentId: "p1", name: "Acme pricing", role: "pricing", group: "g", groupLabel: "Acme", stage: "S9", skills: [], reads: "" };
const plan = { seats: { "ACME:pricing": { id: "ACME:pricing", role: "pricing", zone: "pod", pod: "ACME", team: 0, at: { x: 0, y: 0 }, agentId: "p1" } } } as unknown as OfficePlan;
const view = { cards: { p1: card } } as unknown as SwarmView;
const at = (present: boolean) => ({ agents: { "ACME:pricing": { seat: "ACME:pricing", present, placement: present ? "seat" : "absent" } } }) as unknown as TowerFrame;

describe("the hover card", () => {
  it("shows the hovered or focused agent's card only while the agent is present at the frame", () => {
    expect(agentCardAt(at(true), plan, view, "ACME:pricing")).toEqual({ card, rival: true });
    expect(agentCardAt(at(false), plan, view, "ACME:pricing")).toBeNull();
    expect(agentCardAt(at(true), plan, view, null)).toBeNull();
    expect(agentCardAt(at(true), plan, view, "nobody")).toBeNull();
  });
});
