import { describe, expect, it } from "vitest";
import { cardFor, LogBuilder, SESSION_ID, snapshot } from "../../test/trial-log";
import type { StoredFlag, TrialFrame } from "../contracts/generated/types";
import { initialTrialState, trialReducer, type TrialView } from "../trial/trialReducer";
import { noteArrival } from "../world/recording";
import { between, deriveAgentWork, officePoint, TRANSFER_MS, WORK_STYLES, type WorkInput } from "./model";

function projected(log: LogBuilder = new LogBuilder(), options: Partial<WorkInput> = {}): WorkInput {
  let state = trialReducer(initialTrialState(), { type: "snapshot", snapshot: snapshot() });
  let arrivals: ReadonlyMap<string, number> = new Map();
  log.frames.forEach((frame, i) => {
    state = trialReducer(state, { type: "frame", frame });
    arrivals = noteArrival(arrivals, frame, i * 1000);
  });
  return { view: state.view, arrivals, nowMs: 20_000, paused: false, reducedMotion: false, ...options };
}
function viewOf(input = projected()): TrialView {
  if (input.view === null) throw new Error("missing test view");
  return input.view;
}
function withView(patch: Partial<TrialView>, input = projected()): WorkInput {
  return { ...input, view: { ...viewOf(input), ...patch } };
}
const FLAG: StoredFlag = { kind: "gap", turn_id: "t01", quote: "Answer 1.", missing_fact: "When?", conflict_turn_id: null, conflict_quote: null, conflict_record_id: null, conflict_record_quote: null, flag_ref: "t01.f1" };
function flagged(flag: Partial<StoredFlag> = {}, validation = { citation_ok: true, demeanor_based: false, duplicate: false }): WorkInput {
  const input = projected(new LogBuilder().ask({ releaseAfter: "r:01" }));
  const card = cardFor(1, 3);
  return withView({ cards: [{ turn_no: 1, card: { ...card, flags: [{ ...FLAG, ...flag }], validation: { ...card.validation, flags: { "t01.f1": validation } } } }] }, input);
}

describe("agent-work public adapter", () => {
  it("has four fixed visual styles and no activity before a session exists", () => {
    expect(WORK_STYLES).toEqual(["office", "case-board", "playhouse", "tower"]);
    const result = deriveAgentWork(projected(undefined, { view: null }));
    expect(result.available).toBe(false);
    expect(result.caption).toContain("No session loaded");
    expect(result.items).toEqual([]);
    expect(result.agents.every((agent) => agent.status === "waiting")).toBe(true);
  });
  it("uses the reducer lifecycle for neutral subject thinking and explicit coach work", () => {
    const log = new LogBuilder().ask();
    log.frames.splice(2);
    const thinking = deriveAgentWork(projected(log));
    expect(thinking.agents[0]).toMatchObject({ status: "working", task: "Preparing an answer" });
    expect(thinking.caption).toContain("Subject: Preparing an answer");
    expect(thinking.agents[1]?.status).toBe("waiting");
    const coach = new LogBuilder().ask(); coach.frames.pop();
    const working = deriveAgentWork(projected(coach));
    expect(working.agents[1]).toMatchObject({ status: "working", task: "Reading turn 1" });
    expect(deriveAgentWork(withView({ status: "coach_working", coachReading: null })).agents[1]?.task).toBe("Reviewing the answer");
  });
  it("files accepted cards, updates and released records without inspecting findings", () => {
    const input = projected(new LogBuilder().ask({ releaseAfter: "r:01" }).update(1, "truthful"));
    const result = deriveAgentWork(input);
    expect(result.cards).toBe(1); expect(result.updates).toBe(1);
    expect(result.documents).toEqual([{ id: "r:01", title: "Record r:01", turn: 1 }]);
    expect(result.agents[1]?.task).toBe("Coaching filed");
    expect(result.agents[2]?.task).toBe("1 released records filed");
    expect(result.caption).toBe("Waiting for the next recorded activity.");
    expect(JSON.stringify(result)).not.toContain("truthful");
    expect(JSON.stringify(result)).not.toContain("Finding as of");
  });
  it("does not reintroduce cards rejected by the existing reducer", () => {
    const input = projected(new LogBuilder().ask({ coach: "stale" }));
    expect(viewOf(input).rejectedCards).toEqual([1]);
    expect(deriveAgentWork(input).cards).toBe(0);
    const failed = deriveAgentWork(projected(new LogBuilder().ask({ coach: "failed" })));
    expect(failed.agents[1]).toMatchObject({ status: "failed", task: "Coaching unavailable for this turn" });
    const later = projected(new LogBuilder().ask({ coach: "failed" }).ask());
    expect(deriveAgentWork(later).agents[1]?.status).toBe("ready");
  });
  it("suppresses coaching in assessment, including terminal snapshots and unexpected payloads", () => {
    const original = flagged();
    for (const status of ["awaiting_question", "ended"] as const) {
      const result = deriveAgentWork(withView({ mode: "assessment", status }, original));
      expect(result.assessment).toBe(true); expect(result.cards).toBe(0); expect(result.updates).toBe(0); expect(result.flags).toEqual([]);
      expect(result.agents[1]?.status).toBe("withheld");
      expect(result.items.every((item) => item.kind !== "flag" && item.kind !== "card")).toBe(true);
    }
  });
  it("suppresses text coaching in voice sessions", () => {
    const result = deriveAgentWork(withView({ channel: "voice" }, flagged()));
    expect(result.cards).toBe(0); expect(result.flags).toEqual([]);
    expect(result.agents[1]?.task).toBe("Text coaching unavailable in voice");
  });
  it("keeps subject state independent of coach flags, labels and findings", () => {
    const input = flagged();
    const before = deriveAgentWork(input).agents[0];
    const without = deriveAgentWork(withView({ cards: [], updates: [], runningFinding: null, committedFinding: null }, input)).agents[0];
    expect(before).toEqual(without);
  });
  it("is deterministic, leaves inputs unchanged, and has no independent pause clock", () => {
    const input = flagged();
    const serialized = JSON.stringify(input.view);
    const first = deriveAgentWork(input);
    expect(deriveAgentWork(input)).toEqual(first);
    const paused = deriveAgentWork({ ...input, paused: true });
    expect(paused).toEqual({ ...first, paused: true });
    expect(JSON.stringify(input.view)).toBe(serialized);
    expect(deriveAgentWork({ ...input, nowMs: Number.NaN }).phase).toBe(0);
    expect(deriveAgentWork({ ...input, nowMs: -1 }).phase).toBe(0);
  });
});

describe("citation-only flag mapping", () => {
  it("requires both validator approval and an exact public transcript citation", () => {
    expect(deriveAgentWork(flagged()).flags).toEqual([{ id: "t01.f1", label: "Information gap", turn: 1, quote: "Answer 1.", conflictTurn: null, recordId: null }]);
    expect(deriveAgentWork(flagged({ quote: "Made-up quote" })).flags).toEqual([]);
    expect(deriveAgentWork(flagged({}, { citation_ok: false, demeanor_based: false, duplicate: false })).flags).toEqual([]);
    expect(deriveAgentWork(flagged({}, { citation_ok: true, demeanor_based: true, duplicate: false })).flags).toEqual([]);
    expect(deriveAgentWork(flagged({}, { citation_ok: true, demeanor_based: false, duplicate: true })).flags).toEqual([]);
    expect(deriveAgentWork(flagged({ flag_ref: "missing-validation" })).flags).toEqual([]);
  });
  it.each(["invalid", "t00", "t9007199254740992"])("refuses invalid public turn ID %s", (turn_id) => {
    expect(deriveAgentWork(flagged({ turn_id })).flags).toEqual([]);
  });
  it("requires the other transcript citation for a conflict", () => {
    expect(deriveAgentWork(flagged({ kind: "contradiction", conflict_turn_id: "t01", conflict_quote: "Answer 1." })).flags[0]?.conflictTurn).toBe(1);
    for (const patch of [
      { conflict_turn_id: "t02", conflict_quote: "Answer 1." },
      { conflict_turn_id: "invalid", conflict_quote: "Answer 1." },
      { conflict_turn_id: "t01", conflict_quote: null },
      { conflict_turn_id: null, conflict_quote: "Answer 1." },
    ]) expect(deriveAgentWork(flagged(patch)).flags).toEqual([]);
  });
  it("does not depict a conflict without the required second citation", () => {
    expect(deriveAgentWork(flagged({ kind: "contradiction" })).flags).toEqual([]);
    expect(deriveAgentWork(flagged({ kind: "evidence_conflict" })).flags).toEqual([]);
  });
  it("accepts only a released record and matching record quote", () => {
    const patch = { kind: "evidence_conflict" as const, conflict_record_id: "r:01", conflict_record_quote: "Body of r:01." };
    expect(deriveAgentWork(flagged(patch)).flags[0]?.recordId).toBe("r:01");
    expect(deriveAgentWork(flagged({ ...patch, conflict_record_id: "hidden" })).flags).toEqual([]);
    expect(deriveAgentWork(flagged({ ...patch, conflict_record_quote: null })).flags).toEqual([]);
    expect(deriveAgentWork(flagged({ ...patch, conflict_record_quote: "Not the record" })).flags).toEqual([]);
    expect(deriveAgentWork(flagged({ ...patch, conflict_record_id: null })).flags).toEqual([]);
  });
  it("deduplicates repeated accepted flags and preserves neutral labels", () => {
    const input = flagged({ kind: "possible_evasion" });
    const view = viewOf(input);
    const output = deriveAgentWork(withView({ cards: [...view.cards, ...view.cards] }, input));
    expect(output.flags).toHaveLength(1);
    expect(output.flags[0]?.label).toBe("Possible evasion flag");
  });
});

describe("public referee progress", () => {
  it("does not fabricate scoring from a finalization alone", () => {
    const input = projected(new LogBuilder().ask().commit());
    expect(deriveAgentWork(input).refereeState).toBe("waiting");
    expect(deriveAgentWork({ ...input, referee: null }).refereeState).toBe("waiting");
    expect(deriveAgentWork(input).agents[0]?.task).toBe("Interview finished");
    expect(deriveAgentWork(input).caption).toContain("Session finished");
  });
  it("shows scoring only after finding commitment, and a published result only for this session", () => {
    expect(deriveAgentWork(projected(undefined, { referee: { status: "scoring" } })).refereeState).toBe("waiting");
    expect(deriveAgentWork({ ...withView({ status: "finalizing", committedFinding: null }), referee: { status: "scoring" } }).refereeState).toBe("waiting");
    const input = projected(new LogBuilder().ask().commit().debriefReady());
    expect(deriveAgentWork({ ...input, referee: { status: "scoring" } }).refereeState).toBe("working");
    expect(deriveAgentWork({ ...input, referee: { session_id: "wrong", scored: true } }).refereeState).toBe("waiting");
    expect(deriveAgentWork({ ...input, referee: { session_id: SESSION_ID, scored: true } }).refereeState).toBe("ready");
    expect(deriveAgentWork({ ...input, referee: { session_id: SESSION_ID, scored: false } }).refereeState).toBe("failed");
    const finalizing = withView({ status: "finalizing", serverStatus: "running" }, input);
    expect(deriveAgentWork({ ...finalizing, referee: { status: "scoring" } }).refereeState).toBe("working");
    expect(deriveAgentWork({ ...finalizing, referee: { session_id: SESSION_ID, scored: true } }).refereeState).toBe("waiting");
  });
});

describe("exact event-clock geometry", () => {
  it("moves only recorded deliveries in their bounded window, never on a snapshot", () => {
    const input = projected(new LogBuilder().ask({ releaseAfter: "r:01" }).update(1, "truthful"));
    const atMs = input.arrivals.get("coach.card:1");
    if (atMs === undefined) throw new Error("missing arrival");
    const during = deriveAgentWork({ ...input, nowMs: atMs + TRANSFER_MS / 2 });
    expect(during.transfers.find((transfer) => transfer.id === "card:1")?.progress).toBe(.5);
    expect(deriveAgentWork({ ...input, nowMs: atMs + TRANSFER_MS }).transfers.some((transfer) => transfer.id === "card:1")).toBe(false);
    expect(deriveAgentWork({ ...input, arrivals: new Map() }).transfers).toEqual([]);
    expect(deriveAgentWork({ ...input, reducedMotion: true }).transfers).toEqual([]);
    expect(deriveAgentWork({ ...input, reducedMotion: true }).phase).toBe(0);
    for (const value of [Number.NaN, -1, Number.POSITIVE_INFINITY, input.nowMs + 1]) {
      expect(deriveAgentWork({ ...input, arrivals: new Map([["coach.card:1", value]]) }).items.find((item) => item.kind === "card")?.atMs).toBeNull();
    }
  });
  it("maps evidence, update and published referee deliveries to deterministic stage routes", () => {
    const input = projected(new LogBuilder().ask({ releaseAfter: "r:01" }).update(1, "truthful").commit().debriefReady());
    for (const [key, id, from] of [["evidence.released:r:01", "evidence:r:01", "evidence"], ["coach.update:1", "update:1", "coach"], ["debrief.ready", "referee:published", "referee"]] as const) {
      const at = input.arrivals.get(key) ?? 0;
      const frame = deriveAgentWork({ ...input, nowMs: at + 100, referee: { session_id: SESSION_ID, scored: true } });
      expect(frame.transfers.find((transfer) => transfer.id === id)?.from).toBe(from);
    }
    const flaggedInput = flagged();
    expect(deriveAgentWork({ ...flaggedInput, nowMs: 6000 }).transfers.some((transfer) => transfer.id.startsWith("flag:"))).toBe(false);
  });
  it("rewinds and repeats exactly using the existing reducer output", () => {
    const frames = new LogBuilder().ask({ releaseAfter: "r:01" }).ask().frames;
    const at = (count: number) => {
      const log = new LogBuilder(); log.frames.push(...frames.slice(0, count));
      return deriveAgentWork(projected(log, { nowMs: count * 1000 }));
    };
    const first = at(4); at(frames.length);
    expect(at(4)).toEqual(first);
    const shuffled = new LogBuilder();
    const persistent: TrialFrame[] = frames.filter((frame) => frame.seq !== null).reverse();
    shuffled.frames.push(...persistent);
    const ordered = new LogBuilder(); ordered.frames.push(...persistent.toReversed());
    const stable = (log: LogBuilder) => deriveAgentWork(projected(log, { arrivals: new Map() }));
    expect(stable(shuffled)).toEqual(stable(ordered));
  });
  it("uses 2:1 isometry and clamps interpolation without mutation", () => {
    expect(officePoint(1, 0)).toEqual({ x: 508, y: 184 });
    expect(officePoint(1, 0, 10)).toEqual({ x: 508, y: 174 });
    const a = { x: 0, y: 10 }, b = { x: 100, y: 30 };
    expect(between(a, b, .5)).toEqual({ x: 50, y: 20 });
    expect(between(a, b, -1)).toEqual(a); expect(between(a, b, 2)).toEqual(b); expect(between(a, b, Number.NaN)).toEqual(a);
  });
});
