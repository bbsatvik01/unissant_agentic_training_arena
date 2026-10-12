/**
 * Recordings and playback (D-021): the shipped F01 fixture passes every wire contract, a broken recording is
 * refused whole, and playback lands on the same reducer state whichever way the clock got there.
 */
import { describe, expect, it } from "vitest";

import raw from "../../fixtures/recordings/F01-truthful.json";
import { initialTrialState, trialReducer } from "../trial/trialReducer";
import { parseRecording } from "./parseRecording";
import { END_TAIL_MS, arrivalKey, noteArrival, seek, startCursor, SNAPSHOT_ARRIVAL, type Recording } from "./recording";

function load(): Recording {
  const result = parseRecording(structuredClone(raw));
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.recording;
}

function broken(change: (r: Record<string, unknown>) => void): readonly string[] {
  const copy = structuredClone(raw) as unknown as Record<string, unknown>;
  change(copy);
  const result = parseRecording(copy);
  return result.ok ? [] : result.errors;
}

describe("the F01 fixture recording", () => {
  it("validates against the wire contracts: snapshot, every frame, the debrief", () => {
    const rec = load();
    expect(rec.events.length).toBeGreaterThan(30);
    expect(rec.debrief?.schema_version).toBe("debrief.v1");
    expect(rec.durationMs).toBe((rec.events.at(-1)?.at_ms ?? 0) + END_TAIL_MS);
  });

  it("carries public case metadata only (no role, style or family id before the debrief)", () => {
    const text = JSON.stringify({ case: raw.case, snapshot: raw.snapshot, events: raw.events });
    expect(text).not.toMatch(/"(role|style|family_id|variant|canary)"/);
  });

  it("plays to a completed, sealed practice session with every turn answered and carded", () => {
    const rec = load();
    const end = seek(rec, startCursor(rec), rec.durationMs);
    const view = end.state.view;
    expect(view?.status).toBe("ended");
    expect(view?.commitmentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(view?.turns.every((t) => t.answer !== null)).toBe(true);
    expect(view?.cards.map((c) => c.turn_no)).toEqual(view?.turns.map((t) => t.turn_no));
    expect(view?.rejectedCards).toEqual([]);
    expect(view?.released.map((r) => r.record_id).sort()).toEqual(["rec-01", "rec-02", "rec-03", "rec-04", "rec-05"]);
    expect(end.state.violations).toEqual([]);
  });
});

describe("parseRecording refuses a broken recording whole", () => {
  it.each([
    ["a wrong format", (r: Record<string, unknown>) => (r["format"] = "other")],
    ["no trial id", (r: Record<string, unknown>) => (r["trial_id"] = "")],
    ["a role in the case block", (r: Record<string, unknown>) => ((r["case"] as Record<string, unknown>)["role"] = "truthful")],
    ["a case without a subject", (r: Record<string, unknown>) => ((r["case"] as Record<string, unknown>)["subject"] = null)],
    ["a case with a bad document", (r: Record<string, unknown>) => ((r["case"] as Record<string, unknown>)["initial_documents"] = [{ doc_id: "doc-01" }])],
    ["a case with no document list", (r: Record<string, unknown>) => ((r["case"] as Record<string, unknown>)["initial_documents"] = "none")],
    ["a case with a text difficulty", (r: Record<string, unknown>) => ((r["case"] as Record<string, unknown>)["difficulty_level"] = "2")],
    ["a case that is not an object", (r: Record<string, unknown>) => (r["case"] = [])],
    ["a snapshot with a role", (r: Record<string, unknown>) => ((r["snapshot"] as Record<string, unknown>)["role"] = "deceptive")],
    ["no events", (r: Record<string, unknown>) => (r["events"] = [])],
    ["an event that is not an object", (r: Record<string, unknown>) => ((r["events"] as unknown[])[0] = 7)],
    ["events out of time order", (r: Record<string, unknown>) => (((r["events"] as unknown[])[3] as Record<string, unknown>)["at_ms"] = -1)],
    ["a frame failing the schema", (r: Record<string, unknown>) => ((((r["events"] as unknown[])[0] as Record<string, unknown>)["frame"] as Record<string, unknown>)["type"] = "subject.mood")],
    ["a frame of another trial", (r: Record<string, unknown>) => ((((r["events"] as unknown[])[0] as Record<string, unknown>)["frame"] as Record<string, unknown>)["scope_id"] = "other-trial")],
    ["a document table with a short row", (r: Record<string, unknown>) => {
      const docs = (r["case"] as Record<string, unknown>)["initial_documents"] as Record<string, unknown>[];
      docs[0] = { ...docs[0], content: { body: "b", table: { columns: ["a", "b"], rows: [["only one"]] } } };
    }],
    ["a document table whose rows are text", (r: Record<string, unknown>) => {
      const docs = (r["case"] as Record<string, unknown>)["initial_documents"] as Record<string, unknown>[];
      docs[0] = { ...docs[0], content: { body: "b", table: { columns: ["a"], rows: "x" } } };
    }],
    ["a debrief of another session", (r: Record<string, unknown>) => ((r["debrief"] as Record<string, unknown>)["session_id"] = "00000000-0000-4000-8000-000000000000")],
    ["a debrief failing the schema", (r: Record<string, unknown>) => ((r["debrief"] as Record<string, unknown>)["scored"] = "yes")],
  ])("%s", (_name, change) => {
    expect(broken(change).length).toBeGreaterThan(0);
  });

  it("refuses a value that is not an object", () => {
    expect(parseRecording(null)).toEqual({ ok: false, errors: ["recording: not an object"] });
  });

  it("accepts a recording without a debrief", () => {
    const copy = structuredClone(raw) as unknown as Record<string, unknown>;
    delete copy["debrief"];
    const result = parseRecording(copy);
    expect(result.ok && result.recording.debrief).toBe(null);
  });
});

describe("playback cursor", () => {
  it("starts at the snapshot, with its arrival at time 0", () => {
    const rec = load();
    const start = startCursor(rec);
    expect(start.state.view?.status).toBe("awaiting_question");
    expect(start.arrivals.get(SNAPSHOT_ARRIVAL)).toBe(0);
    expect(start.next).toBe(0);
  });

  it("applies the events at or before t, in order, through the same reducer", () => {
    const rec = load();
    const first = rec.events[0];
    if (first === undefined) throw new Error("empty");
    const at = seek(rec, startCursor(rec), first.at_ms);
    expect(at.next).toBe(1);
    expect(at.state.view?.turns[0]?.question).toBe(rec.events[0]?.frame.type === "question.accepted" ? (first.frame.data as { text: string }).text : null);
    expect(seek(rec, startCursor(rec), first.at_ms - 1).next).toBe(0);
  });

  it("lands on the same state stepping forward in small ticks, in one jump, or scrubbing back", () => {
    const rec = load();
    const mid = rec.durationMs / 2;
    let stepped = startCursor(rec);
    for (let t = 0; t <= mid; t += 250) stepped = seek(rec, stepped, t);
    stepped = seek(rec, stepped, mid);
    const jumped = seek(rec, startCursor(rec), mid);
    const back = seek(rec, seek(rec, startCursor(rec), rec.durationMs), mid);
    expect(stepped.state.view).toEqual(jumped.state.view);
    expect(back.state.view).toEqual(jumped.state.view);
    expect([...back.arrivals]).toEqual([...jumped.arrivals]);
  });

  it("clamps the time to the recording", () => {
    const rec = load();
    expect(seek(rec, startCursor(rec), -50).t).toBe(0);
    expect(seek(rec, startCursor(rec), rec.durationMs + 9_000).t).toBe(rec.durationMs);
  });

  it("matches folding every frame by hand", () => {
    const rec = load();
    let state = trialReducer(initialTrialState(), { type: "snapshot", snapshot: rec.snapshot });
    for (const e of rec.events) state = trialReducer(state, { type: "frame", frame: e.frame });
    expect(seek(rec, startCursor(rec), rec.durationMs).state.view).toEqual(state.view);
  });
});

describe("arrivals", () => {
  it("keys frames by turn, by record, or by type, and keeps the first arrival", () => {
    const rec = load();
    const keys = new Set(rec.events.map((e) => arrivalKey(e.frame)));
    expect(keys).toContain("question.accepted:1");
    expect(keys).toContain("coach.card:5");
    expect(keys).toContain("evidence.released:rec-05");
    expect(keys).toContain("trial.finalized");
    const first = rec.events[0];
    if (first === undefined) throw new Error("empty");
    const once = noteArrival(new Map(), first.frame, 10);
    expect(noteArrival(once, first.frame, 99)).toBe(once);
    expect(once.get(arrivalKey(first.frame))).toBe(10);
  });

  it("keys the remaining coaching frames by turn", () => {
    const base = { v: 1, seq: 1, scope: "trial", scope_id: "x", ts: "2026-10-09T14:00:00.000Z", transcript_version: 1 } as const;
    expect(arrivalKey({ ...base, type: "coach.update", data: { turn_no: 3 } } as never)).toBe("coach.update:3");
    expect(arrivalKey({ ...base, type: "coach.failed", data: { turn_no: 2, reason: "timeout" } } as never)).toBe("coach.failed:2");
  });
});

describe("a harness (tournament) trial's recording (D-021, WP-17)", () => {
  function harness(change?: (r: Record<string, unknown>) => void): Record<string, unknown> {
    const copy = structuredClone(raw) as unknown as Record<string, unknown>;
    (copy["snapshot"] as Record<string, unknown>)["mode"] = "harness";
    copy["debrief"] = null;
    copy["events"] = (copy["events"] as { frame: { type: string } }[]).filter((e) => e.frame.type !== "debrief.ready");
    change?.(copy);
    return copy;
  }

  function sourceUnavailable(r: Record<string, unknown>): void {
    const first = (r["events"] as { frame: Record<string, unknown> }[])[0];
    const frame = {
      ...first?.frame,
      seq: 1,
      type: "trial.status",
      transcript_version: 0,
      data: { status: "source_unavailable", reason_code: "source_unavailable" },
    };
    r["events"] = [{ at_ms: 0, frame }];
  }

  it("plays with its recorded coaching visible: no investigator, no debrief to save it for", () => {
    const result = parseRecording(harness());
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const end = seek(result.recording, startCursor(result.recording), result.recording.durationMs);
    const view = end.state.view;
    expect(view?.status).toBe("ended");
    expect(view?.mode).toBe("practice");
    expect(view?.cards.map((c) => c.turn_no)).toEqual(view?.turns.map((t) => t.turn_no));
    expect(view?.runningFinding).not.toBeNull();
  });

  it("accepts a replay trial that ended source_unavailable and plays it to its end", () => {
    const result = parseRecording(harness(sourceUnavailable));
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const end = seek(result.recording, startCursor(result.recording), result.recording.durationMs);
    expect(end.state.view?.status).toBe("ended");
    expect(end.state.view?.serverStatus).toBe("source_unavailable");
  });

  it("refuses source_unavailable in a training recording (C-45: never a training state)", () => {
    const copy = structuredClone(raw) as unknown as Record<string, unknown>;
    copy["debrief"] = null;
    sourceUnavailable(copy);
    expect(parseRecording(copy).ok).toBe(false);
  });
});
