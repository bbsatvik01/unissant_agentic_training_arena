/**
 * The EVL-7 rubric as the debrief shows it (S6 4.7: "the dimension's anchor text for that score from the rubric
 * bundled with the build"): the five dimensions of docs/spec/S3-scoring-rubrics-metrics.md section 2, their checks
 * and their 0-4 anchors, copied verbatim (rubric.test.ts compares this file with the spec). The scores themselves
 * always come from the published debrief; nothing here computes one.
 */

export interface RubricDimensionText {
  readonly name: string;
  readonly checks: Readonly<Record<string, string>>;
  readonly anchors: Readonly<Record<"0" | "1" | "2" | "3" | "4", string>>;
}

export const RUBRIC: Readonly<Record<"D1" | "D2" | "D3" | "D4" | "D5", RubricDimensionText>> = {
  "D1": {
    "name": "clarity and neutrality",
    "checks": {
      "1a": "No leading or suggestive question",
      "1b": "Open or probing share",
      "1c": "No poorly framed question",
      "1d": "No loaded or demeanor wording"
    },
    "anchors": {
      "4": "Every question is a single neutral ask; most invite a narrative (\"Walk me through...\", \"What task required entry?\"); nothing suggests an answer or comments on how the subject sounds.",
      "3": "One kind of lapse, for example one compound question in an otherwise clean, open interview.",
      "2": "Two kinds of lapse, for example several closed questions and one leading question.",
      "1": "Three kinds of lapse; the interview leans on closed and leading questions.",
      "0": "Questioning is dominated by leading, compound or closed questions and refers to the subject's demeanor (\"You seem nervous...\")."
    }
  },
  "D2": {
    "name": "response relevance",
    "checks": {
      "2a": "Presses evasion",
      "2b": "Respects uncertainty",
      "2c": "On objective",
      "2d": "Builds on answers"
    },
    "anchors": {
      "4": "Each question picks up the last answer; a non-answer is met with a neutral rephrase of the same ask; \"I don't know\" is accepted or helped with a cue, not hammered.",
      "3": "Tracks answers well with one lapse, for example lets one evasive answer pass.",
      "2": "Questions often read like a prepared list that ignores what was just said.",
      "1": "Mostly ignores answers; repeats demands the subject has said they cannot meet.",
      "0": "No visible connection between answers and the next question, or questions drift from the objective."
    }
  },
  "D3": {
    "name": "evidence-based follow-up",
    "checks": {
      "3a": "Names the gap",
      "3b": "Checkable detail",
      "3c": "Uses released records",
      "3d": "Account before disclosure",
      "3e": "Raises contradictions"
    },
    "anchors": {
      "4": "Names what is missing, asks for checkable specifics, lets the subject commit to an account before showing a record, and puts every inconsistency to the subject neutrally.",
      "3": "Evidence-led with one omission, for example a contradiction left unraised.",
      "2": "Uses evidence sometimes; discloses a record before asking for the account, or asks only general questions.",
      "1": "Little use of evidence; records are read out as accusations.",
      "0": "No question uses the answers' content or the records."
    }
  },
  "D4": {
    "name": "testing alternative explanations",
    "checks": {
      "4a": "Invites explanation",
      "4b": "Tests offered explanations",
      "4c": "Discriminating question",
      "4d": "No premature conclusion"
    },
    "anchors": {
      "4": "Treats the after-hours entry as unexplained, asks the subject to explain it, then asks which panel they touched, a detail that differs between the two accounts.",
      "3": "Tests alternatives with one lapse, for example one presupposing question.",
      "2": "Asks for explanations but never checks them, or checks them while presupposing guilt.",
      "1": "Treats one reading as settled for most of the interview.",
      "0": "Confession-seeking: every question presupposes the violation."
    }
  },
  "D5": {
    "name": "supported closure",
    "checks": {
      "5a": "Committed and cited",
      "5b": "Citations hold",
      "5c": "Content basis",
      "5d": "Calibrated confidence",
      "5e": "Names corroboration"
    },
    "anchors": {
      "4": "\"Insufficient evidence, roughly even chance: turn 4 conflicts with the panel log; verify the Lab C panel log and the work-order system.\"",
      "3": "Supported and cited, with one weakness, for example confidence one step too strong.",
      "2": "A finding with citations that only partly support it.",
      "1": "A finding with a citation but resting on how the subject came across.",
      "0": "No finding, or a confident finding with no content basis."
    }
  }
};

/** The anchor for a dimension's score, or null for an unknown dimension or score. */
export function anchorFor(dimension: string, score: number): string | null {
  const dim = (RUBRIC as Readonly<Record<string, RubricDimensionText | undefined>>)[dimension];
  if (dim === undefined || !Number.isInteger(score) || score < 0 || score > 4) return null;
  return dim.anchors[String(score) as "0" | "1" | "2" | "3" | "4"];
}

/** A check's short name, or its id when the bundled rubric does not know it. */
export function checkName(id: string): string {
  for (const dim of Object.values(RUBRIC)) {
    const name = dim.checks[id];
    if (name !== undefined) return name;
  }
  return id;
}
