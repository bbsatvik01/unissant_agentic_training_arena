import { describe, expect, it } from "vitest";

import type { SnapshotCard, SnapshotRelease, SnapshotTurn, TrialFrame, TrialSnapshot } from "../contracts/generated/types";
import { isWire } from "../contracts/validate";
import { COMMITMENT_HASH, LogBuilder, SESSION_ID, cardFor, finding, frame, snapshot, voiceSnapshot } from "../../test/trial-log";
import { applyFrame, initialTrialState, roomStatus, trialReducer, type TrialState } from "./trialReducer";

function boot(snap: TrialSnapshot = snapshot()): TrialState {
  return trialReducer(initialTrialState(), { type: "snapshot", snapshot: snap });
}

function fold(state: TrialState, frames: readonly TrialFrame[]): TrialState {
  return frames.reduce((s, f) => trialReducer(s, { type: "frame", frame: f }), state);
}

function view(state: TrialState) {
  if (state.view === null) throw new Error("no view");
  return state.view;
}

describe("test logs are valid wire frames", () => {
  it("every frame the builder makes passes the compiled validators", () => {
    const log = new LogBuilder("practice")
      .ask({ releaseBefore: "rec-01" })
      .ask({ releaseAfter: "rec-02" })
      .ask({ coach: "failed" })
      .ask({ coach: "stale" })
      .update(4, "deceptive")
      .notice("paused")
      .commit()
      .debriefReady();
    for (const f of log.frames) expect(isWire("events", f), `${f.type} ${String(f.seq)}`).toBe(true);
    expect(isWire("events", new LogBuilder().end("infra_failed").frames[0])).toBe(true);
    expect(isWire("snapshot", snapshot())).toBe(true);
  });
});

describe("trialReducer: lifecycle (S6 6.1)", () => {
  it("is connecting until the snapshot, and ignores frames before it", () => {
    const s0 = initialTrialState();
    expect(roomStatus(s0)).toBe("connecting");
    const f = new LogBuilder().ask().frames[0] as TrialFrame;
    const r = applyFrame(s0, f);
    expect(r.outcome).toBe("ignored");
    expect(r.state).toBe(s0);
  });

  it("starts from the snapshot: awaiting a question when running with no open turn", () => {
    const s = boot();
    expect(roomStatus(s)).toBe("awaiting_question");
    expect(view(s)).toMatchObject({ mode: "practice", channel: "text", exchangesUsed: 0, exchangesCap: 12, lastSeq: 0 });
  });

  it("walks a practice turn: answering, coach working, then awaiting the next question", () => {
    const frames = new LogBuilder("practice").ask().frames;
    const types = frames.map((f) => f.type);
    expect(types).toEqual(["question.accepted", "subject.thinking", "subject.answer", "coach.working", "coach.card"]);
    const statuses: string[] = [];
    let s = boot();
    for (const f of frames) {
      s = trialReducer(s, { type: "frame", frame: f });
      statuses.push(roomStatus(s));
    }
    // Send stays disabled from the question until the card (FE-ROOM-6).
    expect(statuses).toEqual(["subject_answering", "subject_answering", "coach_working", "coach_working", "awaiting_question"]);
    expect(view(s).exchangesUsed).toBe(1);
    expect(view(s).cards.map((c) => c.turn_no)).toEqual([1]);
  });

  it("shows 'Coach is reading' only between coach.working and the card", () => {
    const frames = new LogBuilder("practice").ask().frames;
    let s = fold(boot(), frames.slice(0, 3));
    expect(view(s).coachReading).toBeNull();
    s = fold(s, frames.slice(3, 4));
    expect(view(s).coachReading).toBe(1);
    s = fold(s, frames.slice(4));
    expect(view(s).coachReading).toBeNull();
  });

  it("closes a practice turn on coach.failed", () => {
    const s = fold(boot(), new LogBuilder().ask({ coach: "failed" }).frames);
    expect(roomStatus(s)).toBe("awaiting_question");
    expect(view(s).coachFailures).toEqual([{ turn_no: 1, reason: "timeout" }]);
  });

  it("in assessment, re-enables on subject.answer", () => {
    const frames = new LogBuilder("assessment").ask().frames;
    const s = fold(boot(snapshot({ mode: "assessment" })), frames);
    expect(roomStatus(s)).toBe("awaiting_question");
    expect(view(s).turns.map((t) => t.answer)).toEqual(["Answer 1."]);
  });

  it("treats a subject.thinking hint for a turn not yet seen as an open turn", () => {
    const s = fold(boot(), [frame("subject.thinking", null, 1, { turn_no: 1 })]);
    expect(roomStatus(s)).toBe("subject_answering");
  });

  it("reaches cap_reached after the twelfth exchange closes", () => {
    const b = new LogBuilder();
    for (let i = 0; i < 12; i += 1) b.ask();
    const frames = b.frames;
    const beforeCard = fold(boot(), frames.slice(0, -1));
    expect(roomStatus(beforeCard)).toBe("coach_working");
    const s = fold(beforeCard, frames.slice(-1));
    expect(roomStatus(s)).toBe("cap_reached");
    expect(view(s).exchangesUsed).toBe(12);
  });

  it("is finalizing from the client's own submit until the terminal status, and recovers on a failed submit", () => {
    const s = trialReducer(boot(), { type: "finding_submitted" });
    expect(roomStatus(s)).toBe("finalizing");
    expect(roomStatus(trialReducer(s, { type: "finding_failed" }))).toBe("awaiting_question");
    const pair = new LogBuilder().commit().frames;
    const committed = fold(s, pair.slice(0, 1));
    expect(roomStatus(trialReducer(committed, { type: "finding_failed" }))).toBe("finalizing");
    const ended = fold(committed, pair.slice(1));
    expect(roomStatus(ended)).toBe("ended");
    expect(view(ended).committedFinding?.by).toBe("investigator");
  });

  it.each(["subject_quarantined", "infra_failed", "budget_truncated"] as const)("ends on a terminal %s status row", (status) => {
    const s = fold(boot(), new LogBuilder().ask().end(status).frames);
    expect(roomStatus(s)).toBe("ended");
    expect(view(s).serverStatus).toBe(status);
    expect(view(s).commitmentHash).toBeNull();
  });

  it("is ended from a snapshot with a status other than running, with its commitment hash", () => {
    const s = boot(snapshot({ status: "completed", commitment_hash: COMMITMENT_HASH, finding: finding() }));
    expect(roomStatus(s)).toBe("ended");
    expect(view(s).commitmentHash).toBe(COMMITMENT_HASH);
    expect(view(s).committedFinding).toEqual({ by: null, finding: finding(), committed_at: null });
  });

  it("ignores a running trial.status hint: it never ends or reopens anything", () => {
    const s = fold(boot(), [frame("trial.status", null, 0, { status: "running", reason_code: null })]);
    expect(roomStatus(s)).toBe("awaiting_question");
  });

  it("a persisted running status row changes neither the status nor the reason", () => {
    const s = fold(boot(), [frame("trial.status", 1, 0, { status: "running", reason_code: "warmup" })]);
    expect(roomStatus(s)).toBe("awaiting_question");
    expect(view(s).reasonCode).toBeNull();
    const ended = fold(s, [frame("trial.status", 2, 1, { status: "infra_failed", reason_code: "fault" })]);
    expect(view(ended)).toMatchObject({ serverStatus: "infra_failed", reasonCode: "fault" });
  });

  it("records debrief.ready and notices by kind", () => {
    const s = fold(boot(), new LogBuilder().notice("paused").notice("quota").notice("paused").commit().debriefReady().frames);
    expect(view(s).debriefReady).toBe(SESSION_ID);
    expect(view(s).notices).toEqual([
      { kind: "paused", text: "Notice paused." },
      { kind: "quota", text: "Notice quota." },
    ]);
  });

  it("tracks the transcript version (expected_version for the next question) and the highest applied seq", () => {
    const b = new LogBuilder().ask({ releaseBefore: "rec-01" }).ask();
    const s = fold(boot(), b.frames);
    expect(view(s).transcriptVersion).toBe(b.version);
    expect(view(s).lastSeq).toBe(b.seq);
  });

  it("starts the transcript version from the snapshot's answers and releases", () => {
    const s = boot(
      snapshot({
        last_seq: 4,
        exchanges_used: 1,
        turns: [turn(1, 3)],
        released: [release("rec-01", 0, 4, 3)],
      }),
    );
    expect(view(s).transcriptVersion).toBe(4);
  });

  it("adds released evidence once and keeps the requestable list", () => {
    const b = new LogBuilder().ask({ releaseBefore: "rec-01" });
    const s = fold(boot(snapshot({ requestable: [] })), [...b.frames, ...b.frames]);
    expect(view(s).released.map((r) => r.record_id)).toEqual(["rec-01"]);
  });

  it("shows the deep update's finding over the card's for the running finding", () => {
    const s = fold(boot(), new LogBuilder().ask().update(1, "deceptive").frames);
    expect(view(s).runningFinding?.label).toBe("deceptive");
    const cardOnly = fold(boot(), new LogBuilder().ask().frames);
    expect(view(cardOnly).runningFinding?.rationale).toBe("Finding as of turn 1.");
  });

  it("a later snapshot replaces the state and keeps only frames after its last_seq", () => {
    const b = new LogBuilder().ask().ask();
    const s = fold(boot(), b.frames);
    const ended = snapshot({ status: "completed", last_seq: b.seq + 2, commitment_hash: COMMITMENT_HASH });
    const next = trialReducer(s, { type: "snapshot", snapshot: ended });
    expect(view(next).turns).toEqual([]);
    expect(roomStatus(next)).toBe("ended");
    expect(applyFrame(next, b.frames[0] as TrialFrame).outcome).toBe("duplicate");
  });

  it("a running snapshot's finding alone does not make the room finalizing", () => {
    const s = boot(snapshot({ finding: finding() }));
    expect(roomStatus(s)).toBe("awaiting_question");
    expect(view(s).committedFinding?.by).toBeNull();
  });

  it("a finding.committed frame keeps the room finalizing until the terminal status", () => {
    const s = fold(boot(), new LogBuilder().commit().frames.slice(0, 1));
    expect(roomStatus(s)).toBe("finalizing");
  });
});

describe("trialReducer: duplicates, reordering and the snapshot boundary (FE-SSE-2, FE-ROOM-1)", () => {
  it("treats a frame at or below the snapshot's last_seq, or a seq already seen, as a duplicate", () => {
    const b = new LogBuilder().ask();
    const first = b.frames[0] as TrialFrame;
    const s = boot(snapshot({ last_seq: 1, turns: [{ ...turn(1, 1), answer: null, answer_version: null, committed_at: null }] }));
    expect(applyFrame(s, first).outcome).toBe("duplicate");
    const s2 = fold(boot(), [first]);
    const again = applyFrame(s2, first);
    expect(again.outcome).toBe("duplicate");
    expect(again.state).toBe(s2);
    expect(applyFrame(s2, b.frames[1] as TrialFrame).outcome).toBe("applied");
  });

  it("renders turns in seq order regardless of arrival order", () => {
    const frames = new LogBuilder().ask().ask().ask().frames;
    const s = fold(boot(), [...frames].reverse());
    expect(view(s).turns.map((t) => t.turn_no)).toEqual([1, 2, 3]);
    expect(view(s)).toEqual(view(fold(boot(), frames)));
  });

  it("property: every permutation with duplicates of a session log folds to the same state", () => {
    const b = new LogBuilder("practice")
      .notice("quota")
      .ask({ releaseBefore: "rec-01" })
      .ask({ releaseAfter: "rec-02" })
      .ask({ coach: "failed" })
      .ask({ coach: "stale" })
      .update(4, "truthful")
      .ask()
      .commit()
      .debriefReady();
    const expected = view(fold(boot(), b.frames));
    expect(expected.cards.map((c) => c.turn_no)).toEqual([1, 2, 5]);
    expect(expected.rejectedCards).toEqual([4]);
    const rand = mulberry32(0x5eed);
    for (let run = 0; run < 300; run += 1) {
      const shuffled = shuffle(withDuplicates(b.frames, rand), rand);
      const got = fold(boot(), shuffled);
      expect(view(got), `run ${String(run)}`).toEqual(expected);
    }
  });

  it("property: interleaving a non-terminal reconnect's replay stays out of ended (FE-SSE-8)", () => {
    const b = new LogBuilder().ask().ask();
    const rand = mulberry32(42);
    for (let run = 0; run < 100; run += 1) {
      const s = fold(boot(), shuffle(withDuplicates(b.frames, rand), rand));
      expect(roomStatus(s)).toBe("awaiting_question");
    }
  });
});

describe("trialReducer: the completion pair (SG4-02, FE-SSE-8)", () => {
  it("a disconnect between trial.status and trial.finalized replays both, and the hash shows once", () => {
    const b = new LogBuilder().ask();
    const before = fold(boot(), b.frames);
    b.commit();
    const pair = b.frames.slice(-2);
    const [status, finalized] = pair as [TrialFrame, TrialFrame];
    expect(status.seq).toBeNull();
    expect(finalized.seq).toBe(b.seq);
    const committed = fold(before, b.frames.slice(-3, -2));
    const half = fold(committed, [status]);
    expect(roomStatus(half)).toBe("ended");
    expect(view(half).commitmentHash).toBeNull();
    // the connection drops; the cursor stayed below the row, so the server sends both frames again
    const resumed = fold(half, [status, finalized]);
    expect(view(resumed).commitmentHash).toBe(COMMITMENT_HASH);
    expect(view(fold(resumed, [status, finalized]))).toEqual(view(resumed));
  });
});

describe("trialReducer: complete-card reveal (S6 4.5, FE-COACH-7, SG4-23)", () => {
  // answer at version 7, a scheduled release after it at 8, then the card
  function session() {
    const b = new LogBuilder("practice", { seq: 10, version: 5, turn: 0 });
    b.ask({ releaseAfter: "rec-03", coach: "none" });
    expect(b.version).toBe(8);
    return b;
  }

  it("on deltas: keeps the card read after the scheduled release and drops the one read before it", () => {
    for (const [v, kept] of [
      [8, true],
      [7, false],
    ] as const) {
      const b = session();
      const card = frame("coach.card", b.seq + 1, v, { turn_no: 1, card: cardFor(1, v) });
      expect(isWire("events", card)).toBe(true);
      const s = fold(boot(snapshot({ last_seq: 10 })), [...b.frames, card]);
      expect(view(s).cards.length, `card at ${String(v)}`).toBe(kept ? 1 : 0);
      expect(view(s).rejectedCards).toEqual(kept ? [] : [1]);
      // either way the turn is closed: the server closed it on the card row
      expect(roomStatus(s)).toBe("awaiting_question");
    }
  });

  it("on deltas: a release after the card does not reach back and drop it", () => {
    const b = new LogBuilder().ask();
    b.release("rec-02", "requested");
    const s = fold(boot(), b.frames);
    expect(view(s).cards).toHaveLength(1);
  });

  it("refuses a card for a turn with no answer once everything below it is known", () => {
    const b = new LogBuilder().ask({ coach: "none" });
    const card = frame("coach.card", b.seq + 1, b.version, { turn_no: 2, card: cardFor(2, b.version) });
    const s = fold(boot(), [...b.frames, card]);
    expect(view(s).rejectedCards).toEqual([2]);
    expect(view(s).pendingCards).toEqual([]);
  });

  it("a card that arrives before its answer is pending, and shown once the answer is folded", () => {
    const frames = new LogBuilder().ask().frames;
    const card = frames.at(-1) as TrialFrame;
    const early = fold(boot(), [frames[0] as TrialFrame, card]);
    expect(view(early).pendingCards).toEqual([1]);
    expect(view(early).cards).toEqual([]);
    expect(view(fold(early, frames)).cards.map((c) => c.turn_no)).toEqual([1]);
  });

  it("a card read at a release not folded yet is pending until that release arrives", () => {
    const b = new LogBuilder().ask({ releaseAfter: "rec-02" });
    const release = b.frames.find((f) => f.type === "evidence.released") as TrialFrame;
    const without = fold(boot(), b.frames.filter((f) => f !== release));
    expect(view(without).pendingCards).toEqual([1]);
    expect(view(fold(without, [release])).cards.map((c) => c.turn_no)).toEqual([1]);
  });

  it("a card after a later turn's question is stale, even at its answer's version", () => {
    const b = new LogBuilder().ask({ coach: "none" });
    const answerVersion = b.version;
    b.ask({ coach: "none" });
    const late = frame("coach.card", b.seq + 1, answerVersion, { turn_no: 1, card: cardFor(1, answerVersion) });
    const s = fold(boot(), [...b.frames, late]);
    expect(view(s).rejectedCards).toEqual([1]);
    expect(view(s).cards).toEqual([]);
  });

  it("a card claiming a version beyond everything below it is stale, as on the snapshot, and moves no version", () => {
    // question seq 1 (v1), answer seq 2 (v2), card seq 3 claiming v3
    const b = new LogBuilder().ask({ coach: "none" });
    const ahead = frame("coach.card", b.seq + 1, b.version + 1, { turn_no: 1, card: cardFor(1, b.version + 1) });
    const s = fold(boot(), [...b.frames, ahead]);
    expect(view(s).rejectedCards).toEqual([1]);
    expect(view(s).pendingCards).toEqual([]);
    expect(view(s).transcriptVersion).toBe(b.version);
    const snap = boot(snapshot({ last_seq: 3, exchanges_used: 1, turns: [turn(1, 2, 1)], cards: [snapCard(1, 3, 3)] }));
    expect(view(snap).rejectedCards).toEqual([1]);
  });


  it("a card refused by the schema closes its turn without keeping anything of it", () => {
    const frames = new LogBuilder().ask().frames;
    const open = fold(boot(), frames.slice(0, -1));
    expect(roomStatus(open)).toBe("coach_working");
    const refused = trialReducer(open, { type: "card_refused", turn_no: 1 });
    expect(roomStatus(refused)).toBe("awaiting_question");
    expect(view(refused).rejectedCards).toEqual([1]);
    expect(trialReducer(refused, { type: "card_refused", turn_no: 1 })).toBe(refused);
    expect(trialReducer(initialTrialState(), { type: "card_refused", turn_no: 1 }).view).toBeNull();
    // it was acknowledged invalid: a valid-looking copy, on the stream or in a snapshot, never shows
    const copy = fold(refused, frames.slice(-1));
    expect(view(copy).cards).toEqual([]);
    expect(view(copy).rejectedCards).toEqual([1]);
    const snap = trialReducer(refused, {
      type: "snapshot",
      snapshot: snapshot({ last_seq: 3, exchanges_used: 1, turns: [turn(1, 2)], cards: [snapCard(1, 2, 3)] }),
    });
    expect(view(snap).cards).toEqual([]);
  });

  it("on the snapshot: the same rule as on deltas, by the seqs it carries (FE-COACH-7, SG4-23)", () => {
    // question seq 1, answer seq 2 at version 7, scheduled release seq 3 at version 8, card seq 4
    const base = { last_seq: 4, exchanges_used: 1, turns: [turn(1, 7, 1)], released: [release("rec-03", 1, 8, 3)] };
    for (const [v, kept] of [
      [8, true],
      [7, false],
      [6, false],
      [9, false],
    ] as const) {
      const s = boot(snapshot({ ...base, cards: [snapCard(1, v, 4)] }));
      expect(view(s).cards.length, `card at ${String(v)}`).toBe(kept ? 1 : 0);
      expect(view(s).rejectedCards).toEqual(kept ? [] : [1]);
    }
    // the same release after the card (seq 4, card at seq 3) leaves the card read at its answer current
    const before = boot(snapshot({ ...base, released: [release("rec-03", 1, 8, 4)], cards: [snapCard(1, 7, 3)] }));
    expect(view(before).cards.map((c) => c.turn_no)).toEqual([1]);
  });

  it("on the snapshot: the same fixture through deltas gives the same verdicts", () => {
    for (const [v, kept] of [
      [8, true],
      [7, false],
    ] as const) {
      const b = new LogBuilder("practice", { seq: 0, version: 5 }).ask({ releaseAfter: "rec-03", coach: "none" });
      const card = frame("coach.card", b.seq + 1, v, { turn_no: 1, card: cardFor(1, v) });
      expect(view(fold(boot(), [...b.frames, card])).cards.length, `delta card at ${String(v)}`).toBe(kept ? 1 : 0);
    }
  });

  it("on the snapshot: a release made inside the next turn does not make an earlier card stale", () => {
    // turn 1: q 1, answer 2 (v2), card 3; turn 2's POST: question 4 (v3), scheduled release 5 (v4), answer 6 (v5), card 7
    const s = boot(
      snapshot({
        last_seq: 7,
        exchanges_used: 2,
        turns: [turn(1, 2, 1), turn(2, 5, 4)],
        released: [release("rec-01", 1, 4, 5)],
        cards: [snapCard(1, 2, 3), snapCard(2, 5, 7)],
      }),
    );
    expect(view(s).cards.map((c) => c.turn_no)).toEqual([1, 2]);
  });

  it("on the snapshot: a card after a later turn's question is stale", () => {
    const s = boot(snapshot({ last_seq: 5, exchanges_used: 1, turns: [turn(1, 2, 1), { ...turn(2, 0, 3), answer: null, answer_version: null, committed_at: null }], cards: [snapCard(1, 2, 5)] }));
    expect(view(s).rejectedCards).toEqual([1]);
  });

  it("on the snapshot: a card for a turn with no answer is dropped", () => {
    const s = boot(
      snapshot({
        last_seq: 3,
        turns: [{ ...turn(1, 2), answer: null, answer_version: null, committed_at: null }],
        cards: [snapCard(1, 2, 3)],
      }),
    );
    expect(view(s).rejectedCards).toEqual([1]);
  });
});

describe("trialReducer: the gap-free prefix (S5 6.1)", () => {
  it("counts held and skipped seqs toward the prefix, and ignores a skip at or below the snapshot", () => {
    const b = new LogBuilder().ask();
    const [q, , answer, , card] = b.frames;
    let s = fold(boot(), [q as TrialFrame, card as TrialFrame]);
    expect(view(s).contiguousSeq).toBe(1);
    expect(view(s).pendingCards).toEqual([1]);
    s = trialReducer(s, { type: "seq_skipped", seq: 2 });
    expect(view(s).contiguousSeq).toBe(3);
    expect(trialReducer(s, { type: "seq_skipped", seq: 2 })).toBe(s);
    expect(trialReducer(boot(snapshot({ last_seq: 5 })), { type: "seq_skipped", seq: 5 }).skippedSeqs.size).toBe(0);
    expect(trialReducer(initialTrialState(), { type: "seq_skipped", seq: 1 }).view).toBeNull();
    // the answer arriving after all is folded as usual
    s = fold(s, [answer as TrialFrame]);
    expect(view(s).cards.map((c) => c.turn_no)).toEqual([1]);
    // a snapshot covers every seq up to its last_seq, the order included: markers at or below it go
    const next = trialReducer(s, { type: "snapshot", snapshot: snapshot({ last_seq: 2 }) });
    expect([...next.skippedSeqs]).toEqual([]);
  });
});

describe("trialReducer: the visibility re-check (S6 5.4, FE-SSE-3, FE-SSE-9)", () => {
  const coaching = (b: LogBuilder) => b.frames.filter((f) => f.type.startsWith("coach."));

  it("in a running assessment, every coaching frame is dropped as a violation and nothing renders", () => {
    const practice = new LogBuilder("practice").ask().update(1, "deceptive").ask({ coach: "failed" });
    let s = boot(snapshot({ mode: "assessment" }));
    for (const f of practice.frames) {
      const r = applyFrame(s, f);
      if (f.type.startsWith("coach.")) expect(r.outcome, f.type).toBe("violation");
      s = r.state;
    }
    expect(view(s).cards).toEqual([]);
    expect(view(s).updates).toEqual([]);
    expect(view(s).coachFailures).toEqual([]);
    expect(view(s).runningFinding).toBeNull();
    expect(view(s).coachReading).toBeNull();
    expect(s.violations.map((v) => `${v.frame_type}:${String(v.seq)}`)).toEqual(
      coaching(practice).map((f) => `${f.type}:${String(f.seq)}`),
    );
    expect(s.violations.every((v) => v.reason === "assessment_coaching")).toBe(true);
    // a duplicate of a violating frame is not reported twice
    expect(fold(s, coaching(practice)).violations).toHaveLength(s.violations.length);
  });

  it("in an assessment, a finding.committed by the assistant is a violation; the investigator's own is shown", () => {
    const s = boot(snapshot({ mode: "assessment" }));
    const assistant = frame("finding.committed", 3, 2, { by: "assistant", finding: finding(), committed_at: "2026-10-20T15:04:05.123Z" });
    expect(applyFrame(s, assistant).outcome).toBe("violation");
    const own = frame("finding.committed", 3, 2, { by: "investigator", finding: finding(), committed_at: "2026-10-20T15:04:05.123Z" });
    expect(view(applyFrame(s, own).state).committedFinding?.by).toBe("investigator");
  });

  it("a running assessment snapshot carrying coaching is reported and its coaching withheld", () => {
    const s = boot(
      snapshot({
        mode: "assessment",
        last_seq: 3,
        exchanges_used: 1,
        turns: [turn(1, 2)],
        cards: [snapCard(1, 2, 3)],
      }),
    );
    expect(view(s).cards).toEqual([]);
    expect(s.violations).toEqual([{ key: "snapshot:assessment_coaching", frame_type: "snapshot", seq: null, reason: "assessment_coaching" }]);
  });

  it("an ended assessment snapshot shows the coaching (the annotated transcript)", () => {
    const s = boot(
      snapshot({
        mode: "assessment",
        status: "completed",
        last_seq: 3,
        exchanges_used: 1,
        turns: [turn(1, 2)],
        cards: [snapCard(1, 2, 3)],
      }),
    );
    expect(view(s).cards).toHaveLength(1);
    expect(s.violations).toEqual([]);
  });

  it("in a practice session, every coaching frame is shown", () => {
    const s = fold(boot(), new LogBuilder("practice").ask().update(1, "truthful").frames);
    expect(s.violations).toEqual([]);
    expect(view(s).cards).toHaveLength(1);
    expect(view(s).updates).toHaveLength(1);
  });

  it("a voice trial takes no text turns and no coaching from the stream", () => {
    const s = boot(voiceSnapshot());
    expect(view(s).voiceExchanges.map((e) => e.exchange_no)).toEqual([1, 2]);
    expect(view(s).exchangesUsed).toBe(2);
    expect(roomStatus(s)).toBe("awaiting_question");
    for (const f of new LogBuilder("practice", { seq: 3 }).ask().frames) {
      const r = applyFrame(s, f);
      expect(r.outcome, f.type).toBe("violation");
      expect(r.state.violations.at(-1)?.reason).toBe("voice_text_frame");
    }
    const release = new LogBuilder("practice", { seq: 3 }).release("rec-02");
    expect(applyFrame(s, release).outcome).toBe("applied");
  });

  it("a voice trial reaches cap_reached on the snapshot's stored exchanges", () => {
    const snap = voiceSnapshot();
    const s = boot({ ...snap, exchanges_cap: 2 });
    expect(roomStatus(s)).toBe("cap_reached");
  });
});

function snapCard(n: number, version: number, seq: number): SnapshotCard {
  return { turn_no: n, card: cardFor(n, version), event_seq: seq };
}

function turn(n: number, answerVersion: number, questionSeq = 3 * n - 2): SnapshotTurn {
  return {
    turn_no: n,
    question: `Question ${String(n)}?`,
    source: "investigator",
    answer: `Answer ${String(n)}.`,
    partial: false,
    committed_at: "2026-10-20T15:04:05.123Z",
    answer_version: answerVersion,
    question_seq: questionSeq,
  };
}

function release(recordId: string, afterExchanges: number, version: number, seq: number): SnapshotRelease {
  return {
    record_id: recordId,
    title: `Record ${recordId}`,
    kind: "record",
    doc_kind: "alarm_log",
    date: null,
    content: { body: "x" },
    released_at_turn: afterExchanges,
    trigger: "scheduled",
    transcript_version: version,
    event_seq: seq,
  };
}

/** Seeded PRNG (mulberry32), so a failing permutation is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function withDuplicates<T>(items: readonly T[], rand: () => number): T[] {
  return items.flatMap((item) => (rand() < 0.3 ? [item, item] : [item]));
}

function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

describe("trialReducer: snapshots never go back", () => {
  it("ignores a snapshot older than the one installed", () => {
    const ended = boot(snapshot({ status: "completed", commitment_hash: COMMITMENT_HASH, last_seq: 6 }));
    const older = trialReducer(ended, { type: "snapshot", snapshot: snapshot({ last_seq: 3 }) });
    expect(older).toBe(ended);
    expect(view(older).commitmentHash).toBe(COMMITMENT_HASH);
    const same = trialReducer(ended, { type: "snapshot", snapshot: snapshot({ status: "completed", commitment_hash: COMMITMENT_HASH, last_seq: 6 }) });
    expect(roomStatus(same)).toBe("ended");
  });
});

describe("trialReducer: a finding in a running assessment snapshot (S6 5.4)", () => {
  it("is withheld and reported: the snapshot cannot say who wrote it", () => {
    const s = boot(snapshot({ mode: "assessment", finding: finding() }));
    expect(view(s).committedFinding).toBeNull();
    expect(s.violations).toEqual([
      { key: "snapshot:assessment_unattributed_finding", frame_type: "snapshot", seq: null, reason: "assessment_unattributed_finding" },
    ]);
    // a recovery snapshot is held to the same rule
    const again = trialReducer(boot(snapshot({ mode: "assessment" })), { type: "snapshot", snapshot: snapshot({ mode: "assessment", finding: finding(), last_seq: 1 }) });
    expect(view(again).committedFinding).toBeNull();
    expect(again.violations).toHaveLength(1);
  });

  it("is shown once the assessment ended, and in practice", () => {
    const ended = boot(snapshot({ mode: "assessment", status: "completed", finding: finding() }));
    expect(view(ended).committedFinding?.finding).toEqual(finding());
    expect(ended.violations).toEqual([]);
    const practice = boot(snapshot({ finding: finding() }));
    expect(view(practice).committedFinding?.finding).toEqual(finding());
    expect(practice.violations).toEqual([]);
  });

  it("the investigator's own finding on the stream is shown in a running assessment", () => {
    const s = boot(snapshot({ mode: "assessment" }));
    const own = frame("finding.committed", 1, 1, { by: "investigator", finding: finding(), committed_at: "2026-10-20T15:04:05.123Z" });
    expect(view(applyFrame(s, own).state).committedFinding?.by).toBe("investigator");
  });
});

describe("trialReducer: notices in any order", () => {
  it("keeps the newest notice of each kind whatever the arrival order", () => {
    const at = (ts: string, text: string) => ({ ...frame("notice", null, 0, { kind: "paused", text }), ts });
    const notes = [at("2026-10-20T15:04:05.123Z", "Paused at five."), at("2026-10-20T15:04:09.000Z", "Paused at nine."), at("2026-10-20T15:04:09.000Z", "Also nine.")];
    const forward = view(fold(boot(), notes)).notices;
    const backward = view(fold(boot(), [...notes].reverse())).notices;
    expect(forward).toEqual([{ kind: "paused", text: "Paused at nine." }]);
    expect(backward).toEqual(forward);
  });
});
