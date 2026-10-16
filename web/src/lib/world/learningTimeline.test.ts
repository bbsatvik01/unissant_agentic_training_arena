import { describe, expect, it } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import coached from "../../fixtures/recordings/F01-coached.json";
import type { Debrief } from "../contracts/generated/types";
import { isWire } from "../contracts/validate";
import { parseRecording } from "./parseRecording";
import { seek, startCursor, type Recording } from "./recording";
import { recordedLearningTimeline } from "./learningTimeline";

function load(value: unknown): Recording { const result = parseRecording(value); if (!result.ok) throw new Error("fixture"); return result.recording; }
const recording = load(raw);
function end(rec: Recording) { return seek(rec, startCursor(rec), rec.durationMs).state.view; }

describe("published recorded learning timeline", () => {
  it.each([recording, load(coached)])("joins actual checks, coach review and suggestions to exact existing question arrivals", (rec) => {
    const timeline = recordedLearningTimeline(rec, rec.debrief, end(rec)); if (timeline === null || rec.debrief?.scored !== true) throw new Error("fixture");
    expect(timeline.trialId).toBe(rec.trial_id); expect(timeline.sessionId).toBe(rec.debrief.session_id);
    expect(timeline.evidenceCoverage).toEqual(rec.debrief.scorecards.learning.evidence_coverage);
    expect(timeline.unsupported).toEqual(rec.debrief.scorecards.detection.unsupported);
    for (const turn of timeline.turns) {
      const actual = rec.events.find((event) => event.frame.type === "question.accepted" && event.frame.data.turn_no === turn.turn);
      expect(turn.atMs).toBe(actual?.at_ms ?? null);
      expect(turn.checks).toEqual(rec.debrief.rubric.dimensions.flatMap((dimension) => dimension.checks.filter((check) => check.turns.includes(turn.turn)).map((check) => ({ ...check, dimension: dimension.dim_id }))));
      expect(turn.learning).toEqual(rec.debrief.scorecards.learning.key_questions.filter((item) => item.addressed_turns.includes(turn.turn)));
    }
    expect(JSON.stringify(timeline)).not.toContain('"correct_finding"'); expect(JSON.stringify(timeline)).not.toContain('"role"');
    expect(JSON.stringify(timeline)).not.toContain('"total"'); expect(timeline.turns.at(-1)?.askedNext).toBeNull();
    const card = end(rec)?.cards[0]; if (card === undefined) throw new Error("fixture card");
    expect(timeline.turns[0]?.suggested).toEqual(card.card.follow_up); expect(timeline.turns[0]?.suggested).not.toBe(card.card.follow_up);
  });
  it("does not expose an unpublished, unrelated, active or rewound debrief, including assessment", () => {
    const view = end(recording); if (view === null || recording.debrief === null) throw new Error("fixture");
    expect(recordedLearningTimeline(null, recording.debrief, view)).toBeNull();
    expect(recordedLearningTimeline(recording, null, view)).toBeNull();
    expect(recordedLearningTimeline(recording, structuredClone(recording.debrief), view)).toBeNull();
    expect(recordedLearningTimeline(recording, recording.debrief, null)).toBeNull();
    expect(recordedLearningTimeline(recording, recording.debrief, { ...view, debriefReady: "other" })).toBeNull();
    expect(recordedLearningTimeline(recording, recording.debrief, seek(recording, startCursor(recording), 0).state.view)).toBeNull();
    const assessment = { ...recording, snapshot: { ...recording.snapshot, mode: "assessment" as const } };
    expect(recordedLearningTimeline(assessment, assessment.debrief, seek(assessment, startCursor(assessment), 0).state.view)).toBeNull();
    const noReady = { ...recording, events: recording.events.filter((event) => event.frame.type !== "debrief.ready") };
    expect(recordedLearningTimeline(noReady, noReady.debrief, view)).toBeNull();
    const noEnd = { ...recording, events: recording.events.filter((event) => event.frame.type !== "trial.status" && event.frame.type !== "trial.finalized"), final_snapshot: null };
    expect(recordedLearningTimeline(noEnd, noEnd.debrief, view)).toBeNull();
  });
  it("keeps failures and unaddressed intents exactly as published without inventing a turn timestamp", () => {
    const original = recording.debrief; if (original?.scored !== true) throw new Error("fixture");
    const published: Debrief = { ...original, rubric: { ...original.rubric, dimensions: [{ dim_id: "D1", score: 0, checks: [
      { id: "1a", result: "fail", turns: [1] }, { id: "1b", result: "na", turns: [] }, { id: "1c", result: "fail", turns: [999] },
    ] }] }, scorecards: { ...original.scorecards, learning: { ...original.scorecards.learning, key_questions: [
      { intent: "Published unaddressed intent", addressed_turns: [] }, { intent: "Missing referenced turn", addressed_turns: [999] },
    ] } } };
    const rec = { ...recording, debrief: published }; const timeline = recordedLearningTimeline(rec, published, end(rec)); if (timeline === null) throw new Error("timeline");
    expect(timeline.turns[0]?.checks).toEqual([{ dimension: "D1", id: "1a", result: "fail", turns: [1] }]);
    expect(timeline.unlocatedChecks.map((check) => check.id)).toEqual(["1b", "1c"]);
    expect(timeline.unlocatedLearning).toEqual(published.scorecards.learning.key_questions);
    expect(timeline.turns.every((turn) => turn.learning.length === 0)).toBe(true);
  });
  it("leaves snapshot-only turn time absent, and does not infer missing coach cards or validations", () => {
    const view = end(recording); if (view === null) throw new Error("fixture");
    const final = { ...recording.snapshot, status: "completed" as const, turns: view.turns.map((turn) => ({ turn_no: turn.turn_no, question: turn.question ?? "", source: "investigator" as const, answer: turn.answer, partial: false, committed_at: null, answer_version: null, question_seq: turn.turn_no })), cards: [], updates: [] };
    const rec = { ...recording, snapshot: final, final_snapshot: null, events: recording.events.filter((event) => event.frame.type === "debrief.ready") };
    const timeline = recordedLearningTimeline(rec, rec.debrief, end(rec)); if (timeline === null) throw new Error("timeline");
    expect(timeline.turns.length).toBeGreaterThan(0); expect(timeline.turns.every((turn) => turn.atMs === null && turn.suggested === null && turn.flags.length === 0)).toBe(true);
    const missingChecks = { ...recording, events: recording.events.map((event) => event.frame.type === "coach.card" ? { ...event, frame: { ...event.frame, data: { ...event.frame.data, card: { ...event.frame.data.card, validation: { ...event.frame.data.card.validation, flags: {} } } } } } : event) };
    const without = recordedLearningTimeline(missingChecks, missingChecks.debrief, end(missingChecks));
    expect(without?.turns.flatMap((turn) => turn.flags).every((flag) => flag.validation === null)).toBe(true);
  });
  it("leaves an unscored voice/practice record without invented rubric or learning failures", () => {
    if (recording.debrief === null) throw new Error("fixture");
    const debrief: Debrief = { schema_version: "debrief.v1", session_id: recording.debrief.session_id, scored: false, outcome: recording.debrief.outcome };
    const rec = { ...recording, debrief }; const timeline = recordedLearningTimeline(rec, debrief, end(rec));
    expect(timeline).toMatchObject({ scored: false, evidenceCoverage: null, unsupported: null, unlocatedChecks: [], unlocatedLearning: [] });
    expect(timeline?.turns.every((turn) => turn.checks.length + turn.learning.length === 0)).toBe(true);
  });
  it("audits the real session-create contract: fresh creation is valid; fork/retry fields are not", () => {
    const body = { case_id: recording.case.case_id, mode: "practice", voice: false, idem_key: "00000000-0000-0000-0000-000000000000" };
    expect(isWire("session-create", body)).toBe(true);
    for (const extra of [{ source_trial_id: recording.trial_id }, { from_turn: 1 }, { fork_at_ms: 100 }, { retry: true }, { transcript_prefix: [] }, { inherited_score: 100 }]) {
      expect(isWire("session-create", { ...body, ...extra })).toBe(false);
    }
  });
});
