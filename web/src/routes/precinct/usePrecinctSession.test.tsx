// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import coached from "../../fixtures/recordings/F01-coached.json";
import { LOCAL_VOICE_UNAVAILABLE } from "../../lib/precinct/localReadAloud";
import { CASES, RECORDED_CASE_ID } from "../../lib/world/cases";
import { usePrecinctSession } from "./usePrecinctSession";

const options = { reducedMotion: true, paused: false, audioInRoom: true };
const transport = vi.fn<(input: string, init: RequestInit) => Promise<Response>>();
const speak = vi.fn();
beforeEach(() => {
  transport.mockReset(); transport.mockRejectedValue(new Error("No network in this test")); speak.mockReset();
  vi.stubGlobal("fetch", transport);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1)); vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("SpeechSynthesisUtterance", class { constructor(readonly text: string) {} });
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: { speak, cancel: vi.fn(), getVoices: () => [{ name: "Daniel", lang: "en-GB", localService: true }] } });
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });
function fileWith(text: () => Promise<string>): File { const file = new File([], "run.json", { type: "application/json" }); Object.defineProperty(file, "text", { value: text }); return file; }

describe("precinct runtime composition", () => {
  it("connects only on request and keeps the existing EX-4 acknowledgement gate", async () => {
    const profile = { user_id: "local-user", display_name: "Local trainee", roles: ["trainee"], csrf_token: "test-token", ex4_acknowledged: null };
    transport.mockImplementation((input) => {
      const value = input === "/api/me" ? profile : input === "/api/cases" ? { cases: CASES } : input === "/api/me/ack-ex4" ? { ex4_acknowledged: "2026-10-15T09:00:00Z" } : { case: CASES[0], brief: { initial_documents: raw.case.initial_documents } };
      return Promise.resolve(new Response(JSON.stringify(value), { status: 200 }));
    });
    const { result } = renderHook(() => usePrecinctSession(options));
    expect(transport).not.toHaveBeenCalled();
    await act(async () => { await result.current.connectLocalBackend(); });
    expect(result.current.backend).toBe("connected"); expect(transport).toHaveBeenCalledTimes(2);
    act(() => { result.current.selectCase(RECORDED_CASE_ID); });
    await waitFor(() => { expect(result.current.packetState).toBe("ready"); });
    expect(result.current.canStart).toBe(false);
    act(() => { result.current.startInterview("practice"); });
    expect(transport.mock.calls.some(([path]) => path === "/api/sessions")).toBe(false);
    await act(async () => { expect(await result.current.acknowledgeGroundRule()).toBe(true); });
    expect(result.current.canStart).toBe(true);
    act(() => { result.current.disconnectLocalBackend(); });
    expect(result.current.backend).toBe("offline"); expect(result.current.me).toBeNull(); expect(result.current.selectedCase).toBeNull();
  });

  it("ignores a connection that finishes after explicit disconnect and coalesces repeated connection clicks", async () => {
    let answer: (value: Response) => void = () => undefined;
    transport.mockImplementation((path) => path === "/api/me" ? new Promise<Response>((resolve) => { answer = resolve; }) : Promise.resolve(new Response(JSON.stringify({ cases: CASES }), { status: 200 })));
    const { result } = renderHook(() => usePrecinctSession(options));
    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.connectLocalBackend(); void result.current.connectLocalBackend(); });
    expect(transport).toHaveBeenCalledTimes(2);
    act(() => { result.current.disconnectLocalBackend(); });
    await act(async () => { answer(new Response(JSON.stringify({ user_id: "local-user", display_name: "Local trainee", roles: [], csrf_token: "test-token", ex4_acknowledged: null }), { status: 200 })); await pending; });
    expect(result.current.backend).toBe("offline"); expect(result.current.me).toBeNull();
  });

  it("reports a local connection failure without trying a hosted fallback", async () => {
    const { result } = renderHook(() => usePrecinctSession(options));
    await act(async () => { await result.current.connectLocalBackend(); });
    expect(result.current.backend).toBe("error"); expect(result.current.backendError).toContain("local backend did not answer");
    expect(transport.mock.calls.every(([path]) => path.startsWith("/api/"))).toBe(true);
    await act(async () => { await result.current.loadBundledRecording(); });
    expect(result.current.source).toBe("recording");
  });
  it("mounts offline and opens only a public packet without a backend probe, future events, score or audio", async () => {
    const { result } = renderHook(() => usePrecinctSession(options));
    expect(result.current.backend).toBe("offline"); expect(result.current.view).toBeNull(); expect(result.current.debrief).toBeNull();
    act(() => { result.current.selectCase(RECORDED_CASE_ID); });
    await waitFor(() => { expect(result.current.packetState).toBe("ready"); });
    expect(result.current.packet?.case_id).toBe(RECORDED_CASE_ID);
    expect(result.current.documents.length).toBeGreaterThan(0);
    expect(result.current.packet).not.toHaveProperty("debrief"); expect(result.current.packet).not.toHaveProperty("events");
    expect(result.current.released).toEqual([]); expect(result.current.view).toBeNull(); expect(result.current.world).toBeNull();
    expect(result.current.sound).toBe(false); expect(result.current.canStart).toBe(false);
    expect(transport).not.toHaveBeenCalled(); expect(speak).not.toHaveBeenCalled();
  });

  it("explicitly loads v1 with no autoplay, scrubs exact state, and never reuses its score after selecting a case", async () => {
    const { result } = renderHook(() => usePrecinctSession(options));
    await act(async () => { await result.current.loadBundledRecording(); });
    expect(result.current.source).toBe("recording"); expect(result.current.playback.playing).toBe(false); expect(result.current.sound).toBe(false);
    expect(result.current.debrief).toBeNull(); expect(result.current.questionReason).toContain("Recorded run");
    act(() => { result.current.playback.seekTo(result.current.playback.duration); });
    expect(result.current.view?.status).toBe("ended"); expect(result.current.debrief?.session_id).toBe(raw.debrief.session_id);
    act(() => { result.current.playback.seekTo(0); });
    expect(result.current.debrief).toBeNull(); expect(result.current.released.length).toBe(0);
    act(() => { result.current.selectCase(RECORDED_CASE_ID); });
    expect(result.current.source).toBe("idle"); expect(result.current.debrief).toBeNull(); expect(result.current.view).toBeNull();
    expect(transport).not.toHaveBeenCalled(); expect(speak).not.toHaveBeenCalled();
  });

  it("ignores a late imported run after a newer selection, including selecting the same case", async () => {
    let resolve: (value: string) => void = () => undefined;
    const slow = fileWith(() => new Promise<string>((done) => { resolve = done; }));
    const { result } = renderHook(() => usePrecinctSession(options));
    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.importRecording(slow); });
    act(() => { result.current.selectCase(RECORDED_CASE_ID); });
    await act(async () => { resolve(JSON.stringify(raw)); await pending; });
    expect(result.current.source).toBe("idle"); expect(result.current.recordingTrialId).toBeNull(); expect(result.current.debrief).toBeNull();
  });

  it("loads the real coached run under its own public case and reveals only its original published debrief", async () => {
    const { result } = renderHook(() => usePrecinctSession(options));
    expect(result.current.recordingTrialId).toBeNull();
    await act(async () => { await result.current.loadCoachedRecording(); });
    expect(result.current.recordingState).toBe("ready");
    expect(result.current.source).toBe("recording");
    expect(result.current.recordingTrialId).toBe(coached.trial_id);
    expect(result.current.selectedCase?.case_id).toBe(coached.case.case_id);
    expect(result.current.packet?.case_id).toBe(coached.case.case_id);
    expect(result.current.packet).not.toHaveProperty("debrief");
    expect(result.current.packet).not.toHaveProperty("outcome");
    expect(result.current.playback.playing).toBe(false);
    expect(result.current.clock.current).toBe(0);
    expect(result.current.sound).toBe(false);
    expect(result.current.debrief).toBeNull();
    expect(result.current.referee).toBeNull();
    const publishedAt = coached.events.find((event) => event.frame.type === "debrief.ready")?.at_ms;
    if (publishedAt === undefined) throw new Error("Coached fixture has no published debrief");
    act(() => { result.current.playback.seekTo(publishedAt - 1); });
    expect(result.current.view?.status).toBe("ended");
    expect(result.current.debrief).toBeNull();
    act(() => { result.current.playback.seekTo(result.current.playback.duration); });
    expect(result.current.debrief).toEqual(coached.debrief);
    if (result.current.debrief?.scored !== true) throw new Error("Expected the original scored debrief");
    expect(result.current.debrief.provenance).toEqual(coached.debrief.provenance);
    act(() => { result.current.playback.seekTo(0); });
    expect(result.current.debrief).toBeNull();
    expect(result.current.referee).toBeNull();
    await act(async () => { await result.current.loadBundledRecording(); });
    expect(result.current.recordingTrialId).toBe(raw.trial_id);
    expect(result.current.debrief).toBeNull();
    act(() => { result.current.playback.seekTo(result.current.playback.duration); });
    expect(result.current.debrief).toEqual(raw.debrief);
    expect(transport).not.toHaveBeenCalled(); expect(speak).not.toHaveBeenCalled();
  });

  it("lets the explicit coached choice supersede a slow file import and resets audio on repeat loads", async () => {
    let resolve: (value: string) => void = () => undefined;
    const { result } = renderHook(() => usePrecinctSession(options));
    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.importRecording(fileWith(() => new Promise<string>((done) => { resolve = done; }))); });
    await act(async () => { await result.current.loadCoachedRecording(); });
    act(() => { result.current.setSound(true); result.current.setEarpiece(true); result.current.playback.play(); });
    await act(async () => { resolve(JSON.stringify(raw)); await pending; });
    expect(result.current.recordingTrialId).toBe(coached.trial_id);
    await act(async () => { await result.current.loadCoachedRecording(); });
    expect(result.current.sound).toBe(false); expect(result.current.earpiece).toBe(false);
    expect(result.current.playback.playing).toBe(false); expect(result.current.clock.current).toBe(0);
    expect(result.current.debrief).toBeNull();
    expect(transport).not.toHaveBeenCalled(); expect(speak).not.toHaveBeenCalled();
  });

  it.each([{ voices: [] }, { voices: [{ name: "Remote English", lang: "en-US", localService: false }] }])("refuses offline read-aloud without an installed local voice", async ({ voices }) => {
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: { speak, cancel: vi.fn(), getVoices: () => voices } });
    const { result } = renderHook(() => usePrecinctSession(options));
    await act(async () => { await result.current.loadCoachedRecording(); });
    act(() => { result.current.setSound(true); });
    expect(result.current.sound).toBe(false);
    expect(result.current.readAloudError).toBe(LOCAL_VOICE_UNAVAILABLE);
    expect(result.current.playback.playing).toBe(false);
    expect(transport).not.toHaveBeenCalled(); expect(speak).not.toHaveBeenCalled();
    act(() => { result.current.setSound(false); });
    expect(result.current.readAloudError).toBeNull();
  });

  it("refuses malformed imports without destroying the current validated run", async () => {
    const { result } = renderHook(() => usePrecinctSession(options));
    await act(async () => { await result.current.loadBundledRecording(); });
    const id = result.current.recordingTrialId;
    await act(async () => { await result.current.importRecording(fileWith(() => Promise.resolve("{"))); });
    expect(result.current.recordingError).toBe("That file is not JSON."); expect(result.current.recordingTrialId).toBe(id);
    await act(async () => { await result.current.importRecording(fileWith(() => Promise.resolve('{"format":"wrong"}'))); });
    expect(result.current.recordingError).toContain("Recording refused"); expect(result.current.recordingTrialId).toBe(id);
  });

  it("drops older imported recordings and resets audio when a new run is installed", async () => {
    let resolve: (value: string) => void = () => undefined;
    const { result } = renderHook(() => usePrecinctSession(options));
    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.importRecording(fileWith(() => new Promise<string>((done) => { resolve = done; }))); });
    await act(async () => { await result.current.loadBundledRecording(); });
    act(() => { result.current.setSound(true); });
    await act(async () => { resolve("{}"); await pending; });
    expect(result.current.recordingError).toBeNull(); expect(result.current.source).toBe("recording");
    await act(async () => { await result.current.loadBundledRecording(); });
    expect(result.current.sound).toBe(false); expect(result.current.playback.playing).toBe(false);
  });

  it("explains unavailable offline packets instead of inventing documents", () => {
    const other = CASES.find((card) => card.case_id !== RECORDED_CASE_ID);
    if (other === undefined) throw new Error("No second fixture case");
    const { result } = renderHook(() => usePrecinctSession(options));
    act(() => { result.current.selectCase(other.case_id); });
    expect(result.current.packetState).toBe("unavailable"); expect(result.current.documents).toEqual([]);
    act(() => { result.current.selectCase("not-offered"); });
    expect(result.current.selectedCase?.case_id).toBe(other.case_id);
  });

  it("makes no typed/voice/network actions until explicit connection and blocks playback while paused", async () => {
    const { result, rerender } = renderHook((value) => usePrecinctSession(value), { initialProps: options });
    act(() => { result.current.startInterview("voice"); result.current.voice.open(); result.current.voice.consent(); });
    await act(async () => { expect(await result.current.ask("A question")).toBe(false); expect(await result.current.requestEvidence("record-01")).toBeNull(); await result.current.loadLocalRecording("not-authorized"); });
    expect(transport).not.toHaveBeenCalled();
    await act(async () => { await result.current.loadBundledRecording(); });
    act(() => { result.current.playback.play(); }); expect(result.current.playback.playing).toBe(true);
    rerender({ ...options, paused: true }); expect(result.current.playback.playing).toBe(false);
    act(() => { result.current.playback.play(); }); expect(result.current.playback.playing).toBe(false);
  });
});
