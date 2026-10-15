// @vitest-environment jsdom
/** Deterministic reference regression; no timing threshold or raised timeout. */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { RECORDED_CASE_ID } from "../../lib/world/cases";
import { usePrecinctSession } from "./usePrecinctSession";

const options = { reducedMotion: true, paused: false, audioInRoom: true };
const network = vi.fn(), speak = vi.fn();
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("fetch", network);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1)); vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("SpeechSynthesisUtterance", class { constructor(readonly text: string) {} });
  vi.stubGlobal("speechSynthesis", { speak, cancel: vi.fn(), getVoices: () => [{ name: "Local test voice", lang: "en-US", localService: true }] });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("stable public session array fallbacks", () => {
  it("reuses empty references through comfort and draft updates, then passes through the loaded public packet", async () => {
    const { result, rerender } = renderHook(usePrecinctSession, { initialProps: options });
    const documents = result.current.documents, released = result.current.released;
    expect(documents).toEqual([]); expect(released).toEqual([]);
    rerender({ ...options, paused: true, audioInRoom: false });
    act(() => { result.current.updateDraft("Preparation question"); });
    expect(result.current.documents).toBe(documents); expect(result.current.released).toBe(released);
    for (let index = 0; index < 12; index += 1) { rerender({ ...options, paused: true, audioInRoom: false }); expect(result.current.documents).toBe(documents); expect(result.current.released).toBe(released); }
    act(() => { result.current.selectCase(RECORDED_CASE_ID); });
    await waitFor(() => { expect(result.current.packetState).toBe("ready"); });
    const loaded = result.current.documents;
    expect(loaded).toBe(result.current.packet?.initial_documents); expect(loaded.length).toBeGreaterThan(0);
    expect(result.current.released).toBe(released);
    rerender(options); expect(result.current.documents).toBe(loaded); expect(result.current.released).toBe(released);
    act(() => { result.current.disconnectLocalBackend(); });
    expect(result.current.packet).toBeNull(); expect(result.current.documents).toBe(documents); expect(result.current.released).toBe(released);
    expect(network).not.toHaveBeenCalled(); expect(speak).not.toHaveBeenCalled();
  });
  it("passes canonical released arrays through unchanged and restores the idle fallback", async () => {
    const { result, rerender } = renderHook(usePrecinctSession, { initialProps: options });
    const empty = result.current.released;
    await act(async () => { await result.current.loadBundledRecording(); });
    const release = raw.events.find((event) => event.frame.type === "evidence.released");
    if (release === undefined) throw new Error("Existing fixture needs a public evidence release");
    act(() => { result.current.playback.seekTo(release.at_ms + 1); });
    const actual = result.current.released;
    expect(actual).toBe(result.current.view?.released); expect(actual.length).toBeGreaterThan(0);
    rerender({ ...options, audioInRoom: false }); expect(result.current.released).toBe(actual);
    act(() => { result.current.disconnectLocalBackend(); }); expect(result.current.released).toBe(empty);
    expect(network).not.toHaveBeenCalled(); expect(speak).not.toHaveBeenCalled();
  });
});
