/**
 * The companion pet's pose (S6 6.3, FE-PET-1..3 and 6; UI direction 1.1; C-38d). Lifted from gokbase
 * `kin/__tests__/fsm.test.ts` and re-targeted to the arena's states, inputs and PRB-4 rules.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import { NEUTRALITY_ISSUES, QUESTION_TYPES, type CardQuestion, type QuestionType } from "../contracts/card";
import {
  activeOneShot,
  cardSignals,
  encourages,
  ONE_SHOT_MS,
  oneShotEndsAt,
  petStateFor,
  SLEEP_AFTER_MS,
  startOneShots,
  trackOneShots,
  type CompanionInput,
  type CompanionMode,
  type CompanionSignals,
  type CompanionStatus,
  type OneShot,
  type OneShotTracker,
  type PetMotion,
  type PetPose,
  type PetState,
} from "./fsm";

const STATUSES: readonly CompanionStatus[] = [
  "connecting",
  "awaiting_question",
  "subject_answering",
  "coach_working",
  "cap_reached",
  "finalizing",
  "ended",
];
const ONE_SHOTS: readonly (OneShot | null)[] = [null, "noticing", "encouraging", "celebrating"];

const base = (over: Partial<CompanionInput> = {}): CompanionInput => ({
  mode: "practice",
  status: "awaiting_question",
  coachWorking: false,
  investigatorActive: false,
  oneShot: null,
  reducedMotion: false,
  isMobile: false,
  paused: false,
  idleMs: 0,
  ...over,
});

const pose = (state: PetState, motion: PetMotion): PetPose => ({ state, motion });

describe("petStateFor: FE-PET-1, the S6 6.3 table and precedence", () => {
  const rows: [string, Partial<CompanionInput>, PetPose][] = [
    ["nothing pending: idle, breathing", {}, pose("idle", "loop")],
    ["investigator typing while the composer is open: listening", { investigatorActive: true }, pose("listening", "loop")],
    ["typing or capture while the subject answers: idle (S6 6.1)", { status: "subject_answering", investigatorActive: true }, pose("idle", "loop")],
    ["activity at the exchange cap: idle (S6 6.1)", { status: "cap_reached", investigatorActive: true }, pose("idle", "loop")],
    ["activity while finalizing: idle (S6 6.1)", { status: "finalizing", investigatorActive: true }, pose("idle", "loop")],
    ["activity while connecting: idle (S6 6.1)", { status: "connecting", investigatorActive: true }, pose("idle", "loop")],
    ["coach working: thinking", { status: "coach_working", coachWorking: true }, pose("thinking", "loop")],
    ["thinking outranks listening", { coachWorking: true, investigatorActive: true }, pose("thinking", "loop")],
    ["a flag arrived: noticing, one shot", { oneShot: "noticing" }, pose("noticing", "burst")],
    ["a good question: encouraging, one shot", { oneShot: "encouraging" }, pose("encouraging", "burst")],
    ["session ready: celebrating, one shot", { oneShot: "celebrating" }, pose("celebrating", "burst")],
    ["a one-shot outranks thinking", { oneShot: "noticing", coachWorking: true }, pose("noticing", "burst")],
    ["a one-shot outranks listening", { oneShot: "encouraging", investigatorActive: true }, pose("encouraging", "burst")],
    ["a one-shot plays in any open status", { oneShot: "noticing", status: "subject_answering" }, pose("noticing", "burst")],
    ["idle past 45 s: sleeping", { idleMs: SLEEP_AFTER_MS + 1 }, pose("sleeping", "still")],
    ["exactly 45 s is still idle", { idleMs: SLEEP_AFTER_MS }, pose("idle", "loop")],
    ["only idle falls asleep: listening stays", { idleMs: SLEEP_AFTER_MS + 1, investigatorActive: true }, pose("listening", "loop")],
    ["only idle falls asleep: thinking stays", { idleMs: SLEEP_AFTER_MS + 1, coachWorking: true }, pose("thinking", "loop")],
    ["session ended: sleeping, whatever else is set", { status: "ended", oneShot: "celebrating", coachWorking: true, investigatorActive: true }, pose("sleeping", "still")],
    ["assessment: sleeping for the whole session", { mode: "assessment", oneShot: "noticing", coachWorking: true, investigatorActive: true }, pose("sleeping", "still")],
    ["reduced motion: the noticing still pose", { oneShot: "noticing", reducedMotion: true }, pose("noticing", "still")],
    ["mobile: the thinking still pose", { coachWorking: true, isMobile: true }, pose("thinking", "still")],
    ["pause control: the idle still pose", { paused: true }, pose("idle", "still")],
    ["pause control: the celebrating still pose", { oneShot: "celebrating", paused: true }, pose("celebrating", "still")],
  ];
  it.each(rows)("%s", (_label, over, expected) => {
    expect(petStateFor(base(over))).toEqual(expected);
  });

  const MODES: readonly CompanionMode[] = ["practice", "assessment"];
  const every: CompanionInput[] = MODES.flatMap((mode) =>
    STATUSES.flatMap((status) =>
      ONE_SHOTS.flatMap((oneShot) =>
        [false, true].flatMap((coachWorking) =>
          [false, true].flatMap((investigatorActive) =>
            [0, SLEEP_AFTER_MS + 1].flatMap((idleMs) =>
              [false, true].flatMap((reducedMotion) =>
                [false, true].flatMap((isMobile) =>
                  [false, true].map((paused): CompanionInput => ({
                    mode,
                    status,
                    oneShot,
                    coachWorking,
                    investigatorActive,
                    idleMs,
                    reducedMotion,
                    isMobile,
                    paused,
                  })),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  it("covers every status, mode, signal and motion combination", () => {
    expect(every).toHaveLength(2 * 7 * 4 * 2 * 2 * 2 * 8);
  });

  it("animates nothing under reduced motion, mobile or the pause control, and keeps the same pose", () => {
    for (const input of every) {
      const shown = petStateFor(input);
      if (input.reducedMotion || input.isMobile || input.paused) {
        expect(shown.motion).toBe("still");
        expect(shown.state).toBe(petStateFor({ ...input, reducedMotion: false, isMobile: false, paused: false }).state);
      }
    }
  });

  it("loops idle, listening and thinking, bursts the one-shots, and never animates sleeping", () => {
    const motionOf: Record<PetState, PetMotion> = {
      idle: "loop",
      listening: "loop",
      thinking: "loop",
      noticing: "burst",
      encouraging: "burst",
      celebrating: "burst",
      sleeping: "still",
    };
    for (const input of every.filter((i) => !i.reducedMotion && !i.isMobile && !i.paused)) {
      const shown = petStateFor(input);
      expect(shown.motion).toBe(motionOf[shown.state]);
    }
  });

  it("sleeps through every assessment and every ended session", () => {
    for (const input of every.filter((i) => i.mode === "assessment" || i.status === "ended")) {
      expect(petStateFor(input)).toEqual(pose("sleeping", "still"));
    }
  });

  it("shows a one-shot pose only while that one-shot is active, and the active one always wins in an open practice session", () => {
    for (const input of every) {
      const { state } = petStateFor(input);
      if (state === "noticing" || state === "encouraging" || state === "celebrating") expect(input.oneShot).toBe(state);
      if (input.mode === "practice" && input.status !== "ended" && input.oneShot !== null) expect(state).toBe(input.oneShot);
    }
  });
});

describe("encourages: FE-PET-6, the question block only", () => {
  const question = (question_type: QuestionType, issues: CardQuestion["neutrality_issues"] = []): CardQuestion => ({
    question_type,
    neutrality_issues: issues,
    assessment: "One sentence.",
  });

  it.each(QUESTION_TYPES.map((t) => [t, t === "open" || t === "probing"] as const))(
    "a neutral %s question encourages: %s",
    (type, expected) => {
      expect(encourages(question(type))).toBe(expected);
    },
  );

  it.each(NEUTRALITY_ISSUES.map((issue) => [issue] as const))("any issue (%s) withholds encouragement", (issue) => {
    expect(encourages(question("open", [issue]))).toBe(false);
    expect(encourages(question("probing", [issue]))).toBe(false);
  });

  it("gives the same answer for two cards with the same question but different findings, flags and answer categories", () => {
    const shared = question("probing");
    const cardA = { question: shared, answer_category: "contradiction", flags: [{ kind: "contradiction" }], finding: { label: "deceptive" } };
    const cardB = { question: shared, answer_category: "responsive", flags: [], finding: { label: "truthful" } };
    expect(encourages(cardA.question)).toBe(encourages(cardB.question));
    expect(cardSignals(cardA).encourage).toBe(cardSignals(cardB).encourage);
  });
});

describe("cardSignals: what an accepted practice card tells the companion", () => {
  const neutral: CardQuestion = { question_type: "open", neutrality_issues: [], assessment: "Open and neutral." };
  const leading: CardQuestion = { question_type: "leading", neutrality_issues: ["presupposes_fact"], assessment: "Leading." };

  it("notices any card with at least one flag and reads nothing about the flags beyond that", () => {
    expect(cardSignals({ question: leading, flags: [] })).toEqual({ notice: false, encourage: false });
    expect(cardSignals({ question: leading, flags: [{ kind: "gap" }] })).toEqual({ notice: true, encourage: false });
    expect(cardSignals({ question: neutral, flags: [{ kind: "contradiction" }, { kind: "gap" }] })).toEqual({
      notice: true,
      encourage: true,
    });
    expect(cardSignals({ question: neutral, flags: [{ kind: "evidence_conflict" }] })).toEqual(
      cardSignals({ question: neutral, flags: ["anything at all"] }),
    );
  });
});

describe("FE-PET-2: the companion's inputs carry nothing from findings, flags, categories, role, style or scores", () => {
  it("has exactly these input fields, each a plain flag, count, mode, status or one-shot kind", () => {
    expectTypeOf<keyof CompanionInput>().toEqualTypeOf<
      "mode" | "status" | "coachWorking" | "investigatorActive" | "oneShot" | "reducedMotion" | "isMobile" | "paused" | "idleMs"
    >();
    expectTypeOf<CompanionInput["mode"]>().toEqualTypeOf<"practice" | "assessment">();
    expectTypeOf<CompanionInput["status"]>().toEqualTypeOf<CompanionStatus>();
    expectTypeOf<CompanionInput["oneShot"]>().toEqualTypeOf<"noticing" | "encouraging" | "celebrating" | null>();
    expectTypeOf<CompanionInput["coachWorking"]>().toEqualTypeOf<boolean>();
    expectTypeOf<CompanionInput["investigatorActive"]>().toEqualTypeOf<boolean>();
    expectTypeOf<CompanionInput["idleMs"]>().toEqualTypeOf<number>();
    expectTypeOf<keyof CompanionSignals>().toEqualTypeOf<"mode" | "flagSignal" | "encourageSignal" | "sessionReady">();
    expectTypeOf<CompanionSignals["flagSignal"]>().toEqualTypeOf<number>();
    expectTypeOf<CompanionSignals["encourageSignal"]>().toEqualTypeOf<number>();
    expectTypeOf<CompanionSignals["sessionReady"]>().toEqualTypeOf<boolean>();
  });

  it("has no reconnecting status: during a stream retry the pose stays as it was (S6 6.1)", () => {
    expectTypeOf<CompanionStatus>().toEqualTypeOf<
      "connecting" | "awaiting_question" | "subject_answering" | "coach_working" | "cap_reached" | "finalizing" | "ended"
    >();
  });

  it("lets encourages() read the card.v1 question block and nothing else", () => {
    expectTypeOf(encourages).parameters.toEqualTypeOf<[CardQuestion]>();
    expectTypeOf<keyof CardQuestion>().toEqualTypeOf<"question_type" | "neutrality_issues" | "assessment">();
    expectTypeOf(cardSignals).parameter(0).toEqualTypeOf<{ readonly question: CardQuestion; readonly flags: readonly unknown[] }>();
  });
});

describe("one-shot windows: newest wins, noticing over encouraging over celebrating", () => {
  const signals = (over: Partial<CompanionSignals> = {}): CompanionSignals => ({
    mode: "practice",
    flagSignal: 0,
    encourageSignal: 0,
    sessionReady: false,
    ...over,
  });

  it("does not replay card history: a tracker started mid-session holds no card one-shot", () => {
    const tracker = startOneShots(signals({ flagSignal: 4, encourageSignal: 2 }));
    expect(activeOneShot(tracker, 0)).toBeNull();
    expect(activeOneShot(trackOneShots(tracker, signals({ flagSignal: 4, encourageSignal: 2 }), 10), 10)).toBeNull();
  });

  it("celebrates once when the tracker mounts after the first snapshot already set sessionReady (S6 6.3)", () => {
    const ready = signals({ sessionReady: true });
    const tracker = startOneShots(ready);
    const t = trackOneShots(tracker, ready, 5);
    expect(activeOneShot(t, 5)).toBe("celebrating");
    expect(activeOneShot(trackOneShots(t, ready, 5000), 5000)).toBeNull();
  });

  it("never celebrates twice in one session: a tracker recreated after the celebration is seeded as celebrated", () => {
    const ready = signals({ sessionReady: true });
    const first = trackOneShots(startOneShots(ready), ready, 0);
    const remounted = startOneShots(ready, first.celebrated);
    expect(activeOneShot(trackOneShots(remounted, ready, 10), 10)).toBeNull();
  });

  it("does not replay history: a tracker started mid-session with celebration consumed holds no one-shot", () => {
    const tracker = startOneShots(signals({ flagSignal: 4, encourageSignal: 2, sessionReady: true }), true);
    expect(activeOneShot(tracker, 0)).toBeNull();
    expect(activeOneShot(trackOneShots(tracker, signals({ flagSignal: 4, encourageSignal: 2, sessionReady: true }), 10), 10)).toBeNull();
  });

  it("holds a one-shot for exactly ONE_SHOT_MS", () => {
    const t = trackOneShots(startOneShots(signals()), signals({ flagSignal: 1 }), 1000);
    expect(ONE_SHOT_MS).toBe(1600);
    expect(activeOneShot(t, 1000)).toBe("noticing");
    expect(activeOneShot(t, 1000 + ONE_SHOT_MS - 1)).toBe("noticing");
    expect(activeOneShot(t, 1000 + ONE_SHOT_MS)).toBeNull();
    expect(oneShotEndsAt(t)).toBe(1000 + ONE_SHOT_MS);
    expect(oneShotEndsAt(startOneShots(signals()))).toBeNull();
  });

  it("prefers noticing over encouraging when one card bumps both", () => {
    const t = trackOneShots(startOneShots(signals()), signals({ flagSignal: 1, encourageSignal: 1 }), 0);
    expect(activeOneShot(t, 0)).toBe("noticing");
  });

  it("lets a newer one-shot replace an older one, whatever their kinds", () => {
    let t = trackOneShots(startOneShots(signals()), signals({ encourageSignal: 1 }), 0);
    t = trackOneShots(t, signals({ encourageSignal: 1, flagSignal: 1 }), 500);
    expect(activeOneShot(t, 600)).toBe("noticing");
    t = trackOneShots(t, signals({ encourageSignal: 2, flagSignal: 1 }), 900);
    expect(activeOneShot(t, 1000)).toBe("encouraging");
    expect(activeOneShot(t, 900 + ONE_SHOT_MS)).toBeNull();
  });

  it("keeps an active one-shot when nothing new arrives", () => {
    const t = trackOneShots(startOneShots(signals()), signals({ flagSignal: 1 }), 0);
    const again = trackOneShots(t, signals({ flagSignal: 1 }), 800);
    expect(again).toBe(t);
  });

  it("celebrates a ready session once, and never again in that session", () => {
    let t = trackOneShots(startOneShots(signals()), signals({ sessionReady: true }), 0);
    expect(activeOneShot(t, 0)).toBe("celebrating");
    t = trackOneShots(t, signals({ sessionReady: false }), 2000);
    t = trackOneShots(t, signals({ sessionReady: true }), 3000);
    expect(activeOneShot(t, 3000)).toBeNull();
  });

  it("spends the celebration even when a flag outranks it at the same moment", () => {
    let t = trackOneShots(startOneShots(signals()), signals({ sessionReady: true, flagSignal: 1 }), 0);
    expect(activeOneShot(t, 0)).toBe("noticing");
    t = trackOneShots(t, signals({ sessionReady: true, flagSignal: 1 }), 5000);
    expect(activeOneShot(t, 5000)).toBeNull();
  });

  it("takes no coaching signal in assessment mode and never celebrates there", () => {
    const start: OneShotTracker = startOneShots(signals({ mode: "assessment" }));
    const t = trackOneShots(start, signals({ mode: "assessment", flagSignal: 3, encourageSignal: 2, sessionReady: true }), 0);
    expect(activeOneShot(t, 0)).toBeNull();
    // The counts were consumed, so a later practice view does not replay them.
    expect(activeOneShot(trackOneShots(t, signals({ flagSignal: 3, encourageSignal: 2 }), 10), 10)).toBeNull();
  });

  it("treats a counter that went down as a reset, then counts up from it", () => {
    let t = trackOneShots(startOneShots(signals({ flagSignal: 5 })), signals({ flagSignal: 0 }), 0);
    expect(activeOneShot(t, 0)).toBeNull();
    t = trackOneShots(t, signals({ flagSignal: 1 }), 100);
    expect(activeOneShot(t, 100)).toBe("noticing");
  });
});

describe("FE-PET-3: a session's pose sequence", () => {
  interface Step {
    readonly t: number;
    readonly status: CompanionStatus;
    readonly coachWorking?: boolean;
    readonly investigatorActive?: boolean;
    readonly flagSignal?: number;
    readonly encourageSignal?: number;
    readonly sessionReady?: boolean;
  }

  // One practice exchange: ready, a question typed, the answer, the coach reading, a flagged card.
  const steps: readonly Step[] = [
    { t: 0, status: "connecting" },
    { t: 200, status: "awaiting_question", sessionReady: true },
    { t: 2500, status: "awaiting_question", sessionReady: true, investigatorActive: true },
    { t: 4000, status: "subject_answering", sessionReady: true },
    { t: 6000, status: "coach_working", sessionReady: true, coachWorking: true },
    { t: 7000, status: "awaiting_question", sessionReady: true, flagSignal: 1, encourageSignal: 1 },
    { t: 7500, status: "awaiting_question", sessionReady: true, flagSignal: 1, encourageSignal: 1 },
    { t: 9000, status: "awaiting_question", sessionReady: true, flagSignal: 1, encourageSignal: 1 },
    { t: 60_000, status: "ended", sessionReady: true, flagSignal: 1, encourageSignal: 1 },
  ];

  function poses(mode: CompanionMode, sequence: readonly Step[]): PetState[] {
    let tracker = startOneShots({ mode, flagSignal: 0, encourageSignal: 0, sessionReady: false });
    let lastActivity = 0;
    return sequence.map((step) => {
      tracker = trackOneShots(
        tracker,
        { mode, flagSignal: step.flagSignal ?? 0, encourageSignal: step.encourageSignal ?? 0, sessionReady: step.sessionReady ?? false },
        step.t,
      );
      if (step.investigatorActive === true || step.coachWorking === true) lastActivity = step.t;
      return petStateFor({
        mode,
        status: step.status,
        coachWorking: step.coachWorking ?? false,
        investigatorActive: step.investigatorActive ?? false,
        oneShot: activeOneShot(tracker, step.t),
        reducedMotion: false,
        isMobile: false,
        paused: false,
        idleMs: step.t - lastActivity,
      }).state;
    });
  }

  it("walks the practice table: ready, listening, answering, thinking, noticing, idle, asleep", () => {
    expect(poses("practice", steps)).toEqual([
      "idle",
      "celebrating",
      "listening",
      "idle",
      "thinking",
      "noticing",
      "noticing",
      "idle",
      "sleeping",
    ]);
  });

  it("sleeps through an assessment, identically with or without the coaching events", () => {
    const withCoaching = poses("assessment", steps);
    // Remove every coach.* event: no coach_working status, no working flag, no card signals.
    const withoutCoaching = poses(
      "assessment",
      steps.map((s) => ({
        ...s,
        status: s.status === "coach_working" ? "subject_answering" : s.status,
        coachWorking: false,
        flagSignal: 0,
        encourageSignal: 0,
      })),
    );
    expect(withCoaching).toEqual(Array<PetState>(steps.length).fill("sleeping"));
    expect(withCoaching).toEqual(withoutCoaching);
  });
});
