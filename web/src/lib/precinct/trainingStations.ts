/** Public-only station projections. No inferred access, client scores, role labels or API calls. */
import { RUBRIC, anchorFor } from "../copy/rubric";
import type { ScoreState, ProgressSession } from "../progress/progress";
import { sessionEnded } from "../progress/progress";
import type { CaseCard } from "../world/cases";

export type SkillId = keyof typeof RUBRIC;
export const SKILL_IDS: readonly SkillId[] = ["D1", "D2", "D3", "D4", "D5"];

/** Availability must be provided by the route's verified adapter, or explicitly labeled local preview. */
export type CaseAvailability =
  | { readonly kind: "available"; readonly detail: string }
  | { readonly kind: "locked"; readonly detail: string }
  | { readonly kind: "preview"; readonly detail: string };
export interface CaseBoardEntry {
  readonly card: CaseCard;
  readonly availability: CaseAvailability;
}

/** A public difficulty ladder, not an invented unlocking system. Stable within each difficulty. */
export function caseBoardEntries(entries: readonly CaseBoardEntry[], query: string, difficulty: number | null): readonly CaseBoardEntry[] {
  const search = query.trim().toLocaleLowerCase();
  return entries.filter(({ card }) => (difficulty === null || card.difficulty_level === difficulty) && `${card.title} ${card.objective} ${card.domain} ${card.case_id}`.toLocaleLowerCase().includes(search))
    .toSorted((a, b) => a.card.difficulty_level - b.card.difficulty_level);
}

export function caseDifficulties(entries: readonly CaseBoardEntry[]): readonly number[] {
  return [...new Set(entries.map(({ card }) => card.difficulty_level))].toSorted((a, b) => a - b);
}

export interface SkillNode {
  readonly id: SkillId;
  readonly title: string;
  readonly score: number | null;
  readonly anchor: string | null;
  readonly status: string;
}

/** Render one published debrief verbatim. Never aggregate sessions, infer mastery or fill missing scores with 0. */
export function skillNodes(score: ScoreState | undefined): readonly SkillNode[] {
  return SKILL_IDS.map((id) => {
    const dimension = score !== undefined && typeof score !== "string" && score.kind === "scored" ? score.dimensions.find((d) => d.id === id) : undefined;
    const anchor = dimension === undefined ? null : anchorFor(id, dimension.score);
    const value = anchor === null || dimension === undefined ? null : dimension.score;
    let status = "Not measured";
    if (score === "scoring") status = "Scoring in progress";
    else if (score !== undefined && typeof score !== "string" && score.kind !== "scored") status = score.reason ?? "No published score";
    else if (value !== null) status = "Published rubric score";
    return { id, title: RUBRIC[id].name, score: value, anchor, status };
  });
}

export interface CoursePrimer {
  readonly id: SkillId;
  readonly title: string;
  readonly aim: string;
  readonly steps: readonly string[];
  readonly example: string;
  readonly reflection: string;
}

/** Authored technique examples, not answers to any case or an accredited course. */
export const COURSE_PRIMERS: readonly CoursePrimer[] = [
  { id: "D1", title: RUBRIC.D1.name, aim: "Make room for the person's own account.", steps: ["Ask one thing at a time.", "Start with an open invitation, then clarify.", "Remove assumptions and comments on demeanor."], example: "Walk me through what you did when you arrived.", reflection: "Would this question make equal sense if either explanation were true?" },
  { id: "D2", title: RUBRIC.D2.name, aim: "Let the last answer shape the next question.", steps: ["Name the specific part of the question still unanswered.", "Distinguish a missing answer from explicit uncertainty.", "Offer a neutral memory cue without supplying an answer."], example: "You described the shift. What task required entry?", reflection: "Did I follow what was actually said, rather than my prepared list?" },
  { id: "D3", title: RUBRIC.D3.name, aim: "Turn gaps into checkable details.", steps: ["Ask for the account before disclosing a released record.", "Identify the exact statement and the record that differ.", "Invite an explanation and seek corroboration."], example: "How does that time relate to the time recorded in this log?", reflection: "Can I point to the statement or released record behind my follow-up?" },
  { id: "D4", title: RUBRIC.D4.name, aim: "Test plausible explanations fairly.", steps: ["Keep more than one explanation open.", "Ask for a detail that would distinguish the accounts.", "Check an offered explanation instead of assuming it is true or false."], example: "What record could help us check that explanation?", reflection: "What evidence would change my current view?" },
  { id: "D5", title: RUBRIC.D5.name, aim: "Match the finding to the available evidence.", steps: ["Cite exact turns and released records.", "Keep confidence proportional to the evidence.", "Use insufficient evidence when warranted and name what to verify next."], example: "The available accounts differ. Verify the work order and timeline before reaching a finding.", reflection: "Have I identified what is supported, what is uncertain, and what still needs checking?" },
];

/** A tape is playable only when the caller actually has a recording adapter for that finished run. */
export interface ArchiveTape {
  readonly session: ProgressSession;
  readonly replayAvailable: boolean;
  readonly sourceLabel: string;
}
export function canReplayTape(tape: ArchiveTape): boolean {
  return tape.replayAvailable && sessionEnded(tape.session);
}
