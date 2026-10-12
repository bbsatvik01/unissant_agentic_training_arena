import { describe, expect, it } from "vitest";

import { fixture } from "../../test/wire-fixtures";
import type { FlagItem, LabelItem, ReviewItem, RubricItem } from "../contracts/generated/types";
import { isWire } from "../contracts/validate";
import { blankDraft, missing, OTHER_SUBCHECKS, PER_QUESTION, toSubmission, turnId } from "./review";

const item = (id: string): ReviewItem => fixture(id) as ReviewItem;

describe("review drafts (S3 7.3, S6 4.12)", () => {
  it("lists every rubric sub-check except the five per-question ones", () => {
    expect(OTHER_SUBCHECKS).toHaveLength(22 - PER_QUESTION.length);
    for (const id of PER_QUESTION) expect(OTHER_SUBCHECKS).not.toContain(id);
    expect(turnId(3)).toBe("t03");
  });

  it("builds a T-RUB draft from the item's questions and finding citations, blocks submit until complete, then submits a valid body", () => {
    const rub = item("review-item:T-RUB") as RubricItem;
    const draft = blankDraft(rub);
    if (draft.task !== "T-RUB") throw new Error("kind");
    expect(draft.followups.map((f) => f.turn_id)).toEqual(rub.questions.map((q) => turnId(q.turn_no)));
    expect(missing(draft).length).toBeGreaterThan(0);
    expect(toSubmission(draft)).toBe(null);
    for (const f of draft.followups) Object.assign(f, { question_type: "open", not_leading: true, well_framed: true, no_loaded_wording: true, on_objective: true, builds_on_previous: false });
    for (const s of draft.subchecks) s.result = "na";
    for (const c of draft.citations) c.supports_basis = true;
    expect(missing(draft)).toEqual([]);
    const body = toSubmission(draft);
    expect(body).not.toBe(null);
    expect(isWire("review-submission", body)).toBe(true);
    // No 0-4 dimension score anywhere in the body (FE-REV-3).
    expect(JSON.stringify(body)).not.toMatch(/"D[1-5]"|"score"|"dimension/);
    draft.subchecks[0]?.turn_ids.push("t01", "t02", "t03", "t04", "t05");
    expect(missing(draft)).toEqual([`Check ${OTHER_SUBCHECKS[0] ?? ""}: at most four deciding turns`]);
  });

  it("asks for the evasion kind or framing problem only with that label, and drops it otherwise", () => {
    const lab = item("review-item:T-LAB") as LabelItem;
    const draft = blankDraft(lab);
    if (draft.task !== "T-LAB") throw new Error("kind");
    const fill = (label: string) => {
      for (const t of draft.turns) Object.assign(t, { label, no_contradiction: true, no_invention: true, uncertainty_respected: true, disclosure_policy_respected: true, in_character: true, platform_attack: false });
    };
    fill("evasion");
    expect(missing(draft)[0]).toMatch(/evasion kind/);
    for (const t of draft.turns) t.eva_subtype = "deflection";
    expect(missing(draft)).toEqual([]);
    fill("responsive");
    const body = toSubmission(draft);
    expect(body?.task).toBe("T-LAB");
    if (body?.task === "T-LAB") expect(body.turns.every((t) => t.eva_subtype === null && t.pfq_reason === null)).toBe(true);
    fill("poorly_framed_question");
    expect(missing(draft)[0]).toMatch(/framing problem/);
  });

  it("builds a T-FLAG draft per flag and submits the four answers", () => {
    const fl = item("review-item:T-FLAG") as FlagItem;
    const draft = blankDraft(fl);
    if (draft.task !== "T-FLAG") throw new Error("kind");
    expect(draft.flags.map((f) => f.flag_ref)).toEqual(fl.flags.map((f) => f.flag_ref));
    for (const f of draft.flags) Object.assign(f, { quote_relevant: true, claim_holds: false, content_based: true, no_outside_facts: true });
    expect(toSubmission(draft)).toMatchObject({ task: "T-FLAG" });
  });
});
