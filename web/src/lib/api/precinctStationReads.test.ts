import { describe, expect, it, vi } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { parseRecording } from "../world/parseRecording";
import { createPrecinctLocalConnection } from "./precinctLocalApi";
import { createPrecinctStationReads, type PrecinctStationReads } from "./precinctStationReads";

const parsed = parseRecording(raw);
if (!parsed.ok || parsed.recording.debrief === null) throw new Error("Expected a validated fixture debrief");
const debrief = parsed.recording.debrief;
const api = (): PrecinctStationReads => ({ progress: vi.fn(() => Promise.resolve({ sessions: [] })), readDebrief: vi.fn(() => Promise.resolve(debrief)), tournaments: vi.fn(() => Promise.resolve([])), tournament: vi.fn(() => Promise.resolve({})), tournamentEvents: vi.fn(() => Promise.resolve({ visibility: "counts" as const, progress: [] })), leaderboard: vi.fn(() => Promise.resolve({})) });

describe("narrow guarded station reads", () => {
  it("exposes only existing read capabilities and preserves their functions", async () => {
    const original = api(); const reads = createPrecinctStationReads(original);
    expect(Object.keys(reads).toSorted()).toEqual(["leaderboard", "progress", "readDebrief", "tournament", "tournamentEvents", "tournaments"]);
    expect(reads.progress).toBe(original.progress); expect(reads.leaderboard).toBe(original.leaderboard);
    expect(reads.tournaments).toBe(original.tournaments); expect(reads.tournament).toBe(original.tournament); expect(reads.tournamentEvents).toBe(original.tournamentEvents);
    expect(await reads.readDebrief(debrief.session_id)).toBe(debrief);
  });
  it("refuses a valid but different session's published score while preserving the no-score scoring response", async () => {
    const original = api(); const reads = createPrecinctStationReads(original);
    await expect(reads.readDebrief("another-session")).rejects.toThrow("requested session");
    const waiting = createPrecinctStationReads({ ...original, readDebrief: () => Promise.resolve({ status: "scoring" }) });
    await expect(waiting.readDebrief("owned-session")).resolves.toEqual({ status: "scoring" });
  });
  it("creates no transport, cannot enable the local gate, and stale references fail closed after disconnect", async () => {
    const transport = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ sessions: [], kpi1: null }), { status: 200 })));
    const connection = createPrecinctLocalConnection({ origin: () => ({ hostname: "127.0.0.1", protocol: "http:" }), transport });
    const reads = createPrecinctStationReads(connection.api);
    expect(transport).not.toHaveBeenCalled();
    await expect(reads.progress()).rejects.toThrow("Explicit local backend"); expect(transport).not.toHaveBeenCalled();
    connection.enable(); await reads.progress(); expect(transport).toHaveBeenCalledTimes(1);
    connection.disable(); await expect(reads.progress()).rejects.toThrow("Explicit local backend"); expect(transport).toHaveBeenCalledTimes(1);
  });
  it("retains loopback-only transport checks even if a read facade is retained", async () => {
    const transport = vi.fn();
    const connection = createPrecinctLocalConnection({ origin: () => ({ hostname: "example.com", protocol: "https:" }), transport });
    const reads = createPrecinctStationReads(connection.api); connection.enable();
    await expect(reads.tournaments()).rejects.toThrow("Explicit local backend"); expect(transport).not.toHaveBeenCalled();
  });
});
