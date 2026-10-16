import { describe, expect, it } from "vitest";
import type { UnscoredDebrief } from "../contracts/generated/types";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { parseRecording } from "../world/parseRecording";
import { seek, startCursor } from "../world/recording";
import { DEBRIEF_WALL_SURFACE, projectDebriefWall } from "./debriefWall";

const parsed = parseRecording(structuredClone(raw));
if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
const recording = parsed.recording;
const debrief = recording.debrief;
const view = seek(recording, startCursor(recording), recording.durationMs).state.view;
if (debrief === null || !debrief.scored || view === null) throw new Error("Expected fixture publication");
const base = { scope: "own-recording", recorded: true, assessment: false, debrief, view };

describe("published debrief wall", () => {
  it("shows only the fixture's own actual published score and dimensions", () => {
    const model = projectDebriefWall(base);
    expect(model.published).toBe(true);
    expect(model.total).toBe(`${String(debrief.rubric.total)} / 100`);
    expect(model.origin).toContain("RECORDING · ITS OWN RESULT");
    expect(model.lines).toHaveLength(debrief.rubric.dimensions.length);
    expect(model.key).toContain(debrief.session_id);
  });
  it("labels a local result without claiming recorded scores as current progress", () => {
    expect(projectDebriefWall({ ...base, recorded: false }).origin).toBe("PUBLISHED LOCAL SESSION");
    expect(projectDebriefWall({ ...base, debrief: null }).lines.join(" ")).toContain("never count as your current progress");
  });
  it("fails closed before publication, before termination, for a foreign ready ID, or during assessment", () => {
    const variants = [
      { ...base, assessment: true }, { ...base, view: null }, { ...base, debrief: null },
      { ...base, view: { ...view, debriefReady: null } },
      { ...base, view: { ...view, debriefReady: "another-session" } },
      { ...base, view: { ...view, status: "awaiting_question" as const } },
    ];
    for (const value of variants) {
      const model = projectDebriefWall(value);
      expect(model.published).toBe(false);
      expect(model.total).toBe("No published score");
      expect(JSON.stringify(model)).not.toContain(debrief.outcome.resolution);
      expect(model.key).not.toContain("published:");
    }
  });
  it("never fabricates a number for an unscored or unscorable session", () => {
    const unscored: UnscoredDebrief = { schema_version: debrief.schema_version, session_id: debrief.session_id, scored: false, outcome: debrief.outcome };
    expect(projectDebriefWall({ ...base, debrief: unscored }).total).toBe("Unscored session");
    const unscorable = { ...debrief, rubric: { ...debrief.rubric, scorable: false, total: null, unscorable_reason: "Too little scored material." } };
    expect(projectDebriefWall({ ...base, debrief: unscorable }).lines[0]).toBe("Too little scored material.");
    expect(projectDebriefWall({ ...base, debrief: { ...unscorable, rubric: { ...unscorable.rubric, unscorable_reason: null } } }).lines[0]).toBe("This session could not be scored.");
    expect(projectDebriefWall({ ...base, debrief: { ...debrief, rubric: { ...debrief.rubric, total: null } } }).total).toBe("Score unavailable");
  });
  it("changes material identity on source, rewind and assessment transitions", () => {
    const ready = projectDebriefWall(base);
    expect(projectDebriefWall({ ...base, scope: "another-source" }).key).not.toBe(ready.key);
    expect(projectDebriefWall({ ...base, view: { ...view, debriefReady: null } }).key).not.toBe(ready.key);
    expect(projectDebriefWall({ ...base, assessment: true }).key).not.toBe(ready.key);
    expect(DEBRIEF_WALL_SURFACE).toEqual({ position: [8.1, 2.15, -25.685], size: [4.8, 1.9] });
  });
});
