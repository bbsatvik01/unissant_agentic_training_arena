import { describe, expect, it } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import coached from "../../fixtures/recordings/F01-coached.json";
import { CASES, RECORDED_CASE_ID } from "../world/cases";
import type { Progress, ProgressSession } from "../progress/progress";
import { BUNDLED_STATION_TAPES, TRAINING_STATION_PANELS, TRAINING_STATION_TITLES, canReplayOwnSession, ownArchiveTapes, ownSkillSession, stationCaseEntries, trainingStationForPanel, type TrainingStationId } from "./stationSources";

const session = (id: string, status = "finalized", voice = false): ProgressSession => ({ session_id: id, trial_id: `trial-${id}`, phase: "practice", mode: "practice", voice, status, created_at: "2026-10-15", case_title: "Synthetic test case" });
const progress: Progress = { sessions: [session("running", "running"), session("first"), session("voice", "finalized", true), session("last", "terminated")], kpi1: null };

describe("station source boundaries", () => {
  it("resolves explicit landmarks before room fallbacks, with honest titles", () => {
    for (const kind of Object.keys(TRAINING_STATION_PANELS) as TrainingStationId[]) {
      expect(trainingStationForPanel(TRAINING_STATION_PANELS[kind], "coach_lab")).toBe(kind);
      expect(TRAINING_STATION_TITLES[kind].length).toBeGreaterThan(0);
    }
    expect(trainingStationForPanel(null, "records")).toBeNull();
    expect(trainingStationForPanel("board_wall", "board_wall")).toBe("cases");
    expect(trainingStationForPanel("room", "coach_lab")).toBe("coach_lab");
    expect(trainingStationForPanel("records", "records")).toBe("archive");
    expect(trainingStationForPanel("reception", "lobby")).toBeNull();
    expect(trainingStationForPanel("unknown")).toBeNull();
  });
  it("offers only the actual bundled public dossier offline without fabricated locks", () => {
    const entries = stationCaseEntries(CASES, false);
    expect(entries.filter((entry) => entry.availability.kind === "available").map((entry) => entry.card.case_id)).toEqual([RECORDED_CASE_ID]);
    expect(entries.filter((entry) => entry.card.case_id !== RECORDED_CASE_ID).every((entry) => entry.availability.kind === "preview")).toBe(true);
    expect(entries.every((entry) => entry.availability.kind !== "locked")).toBe(true);
    expect(stationCaseEntries([], false)).toEqual([]);
  });
  it("marks only the supplied local-backend offers available without deriving unlocks from difficulty", () => {
    const entries = stationCaseEntries(CASES.slice(1, 3), true);
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.availability.kind === "available" && entry.availability.detail.includes("ground-rule"))).toBe(true);
    expect(entries.map((entry) => entry.card)).toEqual(CASES.slice(1, 3));
  });
  it("keeps neutral tape metadata equal to both actual fixtures, without invented dates, phases or outcomes", () => {
    for (const tape of BUNDLED_STATION_TAPES) {
      const fixture = tape.id === "coached" ? coached : raw;
      expect(tape.trialId).toBe(fixture.trial_id); expect(tape.caseId).toBe(fixture.case.case_id);
      expect(tape.caseTitle).toBe(fixture.case.title); expect(tape.mode).toBe(fixture.snapshot.mode);
      expect(tape.channel).toBe(fixture.snapshot.channel);
      expect(tape).not.toHaveProperty("created_at"); expect(tape).not.toHaveProperty("phase"); expect(tape).not.toHaveProperty("score");
      expect(tape.label).not.toMatch(/truthful|deceptive/i);
    }
  });
  it("retains the actual history order and disables unfinished or voice v1 replay", () => {
    const tapes = ownArchiveTapes(progress);
    expect(tapes.map((tape) => tape.session)).toEqual(progress.sessions);
    expect(tapes.map((tape) => tape.replayAvailable)).toEqual([false, true, false, true]);
    expect(canReplayOwnSession(progress, "trial-first")).toBe(true);
    expect(canReplayOwnSession(progress, "trial-last")).toBe(true);
    expect(canReplayOwnSession(progress, "trial-voice")).toBe(false);
    expect(canReplayOwnSession(progress, "trial-running")).toBe(false);
    expect(canReplayOwnSession(progress, "unowned")).toBe(false);
  });
  it("selects one ended own session without sorting by score or inventing completion", () => {
    expect(ownSkillSession(progress, null)?.session_id).toBe("first");
    expect(ownSkillSession(progress, "last")?.session_id).toBe("last");
    expect(ownSkillSession(progress, "unowned")?.session_id).toBe("first");
    expect(ownSkillSession({ sessions: [session("running", "running")], kpi1: null }, null)).toBeNull();
    expect(ownArchiveTapes({ sessions: [], kpi1: null })).toEqual([]);
  });
});
