/**
 * The judge demo (stage 4): a guided path of about four minutes through the precinct, one interview, the debrief
 * wall and the arena. The interview defaults to a recorded run, so the demo never depends on a live model call; a
 * live interview is offered only when the server is reachable and the ground rule is acknowledged. Pure data and
 * step logic; the room wires the actions.
 */

export type DemoStep = "precinct" | "interview" | "debrief" | "arena";

export const DEMO_STEPS: readonly DemoStep[] = ["precinct", "interview", "debrief", "arena"];

/** About four minutes: the guide shows elapsed time against it, never a countdown that hurries the presenter. */
export const DEMO_TARGET_MS = 4 * 60 * 1000;

export interface DemoCopy {
  readonly title: string;
  readonly body: string;
  /** What the presenter can point at on screen. */
  readonly look: string;
}

export const DEMO_COPY: Readonly<Record<DemoStep, DemoCopy>> = {
  precinct: {
    title: "The precinct",
    body: "Investigators practise interviews on synthetic cases. Each case file is a locked set of facts with scripted evidence, and the subject is either truthful or concealing something; the investigator does not know which.",
    look: "The case files on the board and the brief beside them.",
  },
  interview: {
    title: "The interview room",
    body: "The investigator asks up to twelve questions. After each answer the coach reads the exchange, points to exact words and records, and suggests a neutral follow-up. It never reads the subject's manner, only what was said.",
    look: "The coach's card on the right, the evidence wall behind the subject, and records flying onto it when they are released.",
  },
  debrief: {
    title: "The debrief wall",
    body: "When the finding is sealed, an independent referee scores the interview on five rubric dimensions and checks the coach's flags against its own labels. Every number comes from the published debrief; the page computes nothing.",
    look: "The score cards pinned to the wall, then the questions tab: what was asked, what the coach suggested, what was asked next.",
  },
  arena: {
    title: "The arena",
    body: "Coaches compete on matched cases under equal budgets. A coach is ranked only after passing the false-positive and isolation gates; overlapping rank intervals mean the order is uncertain.",
    look: "The gate panel above the ranks, the rank-interval bars, and the tournament matrix.",
  },
};

/** The step the room is showing: the interview step moves on to the debrief by itself once the debrief is up. */
export function followRoom(step: DemoStep, debriefShowing: boolean): DemoStep {
  return step === "interview" && debriefShowing ? "debrief" : step;
}

/** Elapsed time as m:ss. */
export function clockText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60))}:${String(s % 60).padStart(2, "0")}`;
}
