// @vitest-environment jsdom
/**
 * The live session hook (stage 2): a stop while the session is being created drops the late answer, and a session
 * whose first snapshot could not be read says so and reloads it on Reconnect, keeping the session.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ArenaApi, StartedSession } from "../../lib/api/arena";
import { ApiError } from "../../lib/api/client";
import type { TurnSubmit } from "../../lib/contracts/generated/types";
import { snapshot } from "../../test/trial-log";
import { useLiveSession } from "./useLiveSession";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const STARTED = { mode: "practice", case_id: "C-7Q2MXK4D", session_id: "11111111-1111-4111-8111-111111111111", trial_id: "22222222-2222-4222-8222-222222222222" } as StartedSession;

function api(overrides: Partial<ArenaApi>): ArenaApi {
  const refuse = () => Promise.reject(new Error("not in this test"));
  return {
    trialSnapshot: refuse,
    mintStreamTicket: refuse,
    mintVoiceTicket: refuse,
    readDebrief: refuse,
    requestDebrief: refuse,
    ackCard: () => Promise.resolve(),
    reportContractViolation: () => Promise.resolve(),
    submitTurn: refuse,
    requestEvidence: refuse,
    commitFinding: refuse,
    listCases: refuse,
    caseBrief: refuse,
    startSession: refuse,
    leaderboard: refuse,
    tournaments: refuse,
    tournament: refuse,
    tournamentEvents: refuse,
    me: refuse,
    ackEx4: refuse,
    progress: refuse,
    recording: refuse,
    speak: refuse,
    ...overrides,
  };
}

const OPTIONS = { caseId: "C-7Q2MXK4D", subjectName: "Jordan Pell", reducedMotion: true, paused: false };

describe("useLiveSession", () => {
  it("drops a session that arrives after the room was left", async () => {
    let answer: (s: StartedSession) => void = () => undefined;
    const startSession = vi.fn(() => new Promise<StartedSession>((r) => (answer = r)));
    const trialSnapshot = vi.fn(() => Promise.reject(new Error("unreachable")));
    const { result } = renderHook(() => useLiveSession({ api: api({ startSession, trialSnapshot }), ...OPTIONS }));
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.start("practice");
    });
    expect(result.current.phase).toBe("starting");
    act(() => {
      result.current.stop();
    });
    await act(async () => {
      answer(STARTED);
      await pending;
    });
    expect(result.current.phase).toBe("idle");
    expect(result.current.session).toBeNull();
    expect(trialSnapshot).not.toHaveBeenCalled();
  });

  it("says when the first snapshot could not be read, and Reconnect reads it again for the same session", async () => {
    const startSession = vi.fn(() => Promise.resolve(STARTED));
    const trialSnapshot = vi.fn(() => Promise.reject(new Error("down")));
    const { result } = renderHook(() => useLiveSession({ api: api({ startSession, trialSnapshot }), ...OPTIONS }));
    await act(async () => {
      await result.current.start("practice");
    });
    await waitFor(() => {
      expect(result.current.connectionError).toBe("The interview could not be loaded.");
    });
    const reads = trialSnapshot.mock.calls.length;
    act(() => {
      result.current.reconnect();
    });
    await waitFor(() => {
      expect(trialSnapshot.mock.calls.length).toBeGreaterThan(reads);
    });
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(result.current.session).toBe(STARTED);
  });

  it("goes back to the session this tab started on the case instead of starting another (S6 5.1)", async () => {
    const startSession = vi.fn(() => Promise.resolve(STARTED));
    const trialSnapshot = vi.fn<(id: string) => Promise<never>>(() => Promise.reject(new Error("down")));
    const { result } = renderHook(() => useLiveSession({ api: api({ startSession, trialSnapshot }), ...OPTIONS }));
    expect(result.current.resumable).toBeNull();
    await act(async () => {
      await result.current.start("practice");
    });
    act(() => {
      result.current.stop();
    });
    expect(result.current.resumable).toEqual(STARTED);
    const reads = trialSnapshot.mock.calls.length;
    await act(async () => {
      await result.current.resume();
    });
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(trialSnapshot.mock.calls.length).toBeGreaterThan(reads);
    expect(trialSnapshot.mock.calls.at(-1)?.[0]).toBe(STARTED.trial_id);
    expect(result.current.session).toEqual(STARTED);
  });

  it("offers to send a question again after a server-side failure, with the same request so the turn resumes", async () => {
    const bodies: TurnSubmit[] = [];
    let fail = true;
    const submitTurn = vi.fn((_trial: string, body: TurnSubmit) => {
      bodies.push(body);
      return fail ? Promise.reject(new ApiError(503, "subject_unavailable", "/api/trials/x/turns")) : Promise.resolve({ accepted: true } as never);
    });
    const deps = api({
      startSession: () => Promise.resolve(STARTED),
      trialSnapshot: () => Promise.resolve(snapshot({ mode: "practice" })),
      // No stream in this test: the ticket never comes.
      mintStreamTicket: () => new Promise<string>(() => undefined),
      submitTurn,
    });
    const { result } = renderHook(() => useLiveSession({ api: deps, ...OPTIONS }));
    await act(async () => {
      await result.current.start("practice");
    });
    await waitFor(() => {
      expect(result.current.trial.view).not.toBeNull();
    });
    await act(async () => {
      expect(await result.current.ask("Where were you at two?")).toBe(false);
    });
    expect(result.current.failedQuestion).toBe("Where were you at two?");
    fail = false;
    await act(async () => {
      await result.current.retryAsk();
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(result.current.failedQuestion).toBeNull();
  });

  it("does not offer to resend a refused question", async () => {
    const deps = api({
      startSession: () => Promise.resolve(STARTED),
      trialSnapshot: () => Promise.resolve(snapshot({ mode: "practice" })),
      mintStreamTicket: () => new Promise<string>(() => undefined),
      submitTurn: () => Promise.reject(new ApiError(422, "invalid", "/api/trials/x/turns")),
    });
    const { result } = renderHook(() => useLiveSession({ api: deps, ...OPTIONS }));
    await act(async () => {
      await result.current.start("practice");
    });
    await waitFor(() => {
      expect(result.current.trial.view).not.toBeNull();
    });
    await act(async () => {
      await result.current.ask("Where were you?");
    });
    expect(result.current.failedQuestion).toBeNull();
    expect(result.current.error).toBe("The request was refused as invalid.");
  });

  it("ignores a second start while the first is being created", async () => {
    let answer: (s: StartedSession) => void = () => undefined;
    const startSession = vi.fn(() => new Promise<StartedSession>((r) => (answer = r)));
    const { result } = renderHook(() => useLiveSession({ api: api({ startSession, trialSnapshot: () => Promise.reject(new Error("down")) }), ...OPTIONS }));
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.start("practice");
      void result.current.start("practice");
    });
    expect(startSession).toHaveBeenCalledTimes(1);
    await act(async () => {
      answer(STARTED);
      await first;
    });
  });
});
