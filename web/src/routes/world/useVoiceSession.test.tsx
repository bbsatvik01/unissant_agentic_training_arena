// @vitest-environment jsdom
/**
 * The voice session hook (WP-22): consent, ticket and socket with the ticket as its subprotocol, frames into the
 * machine, audio sent only once the server spoke first, the close code as the terminal signal, and a new trial
 * starting clean while the old socket's late callbacks are ignored.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArenaApi } from "../../lib/api/arena";
import type { VoiceExchange } from "../../lib/contracts/generated/types";
import { audioMouth } from "../../lib/world/audioLips";
import { useVoiceSession } from "./useVoiceSession";
import type { VoiceAudio, VoiceAudioHooks } from "./voiceAudio";

const audio = vi.hoisted(() => ({ hooks: [] as VoiceAudioHooks[], closed: 0, played: [] as number[] }));

function analyser(): AnalyserNode {
  return { context: { sampleRate: 24_000 }, fftSize: 512, getByteFrequencyData: () => undefined } as unknown as AnalyserNode;
}

vi.mock("./voiceAudio", () => ({
  MicrophoneRefusedError: class extends Error {},
  openVoiceAudio: (hooks: VoiceAudioHooks): Promise<VoiceAudio> => {
    audio.hooks.push(hooks);
    return Promise.resolve({
      play: (utterance: number) => {
        audio.played.push(utterance);
      },
      flush: () => undefined,
      busy: () => false,
      playbackAnalyser: analyser(),
      micAnalyser: analyser(),
      stopCapture: () => undefined,
      close: () => {
        audio.closed += 1;
      },
    });
  },
}));

class FakeSocket {
  static all: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  binaryType = "blob";
  sent: (string | ArrayBuffer)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.all.push(this);
  }
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  frame(f: object) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

beforeEach(() => {
  FakeSocket.all = [];
  audio.hooks = [];
  audio.closed = 0;
  audio.played = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TICKET = "a".repeat(64);
const NONE: readonly VoiceExchange[] = [];
const VOICES = { subject: "subject:Jordan Pell", investigator: "investigator" };

function api(): ArenaApi {
  return { mintVoiceTicket: vi.fn(() => Promise.resolve(TICKET)) } as unknown as ArenaApi;
}

describe("useVoiceSession", () => {
  it("connects with the ticket as subprotocol, sends audio only after the first server frame, and ends on the close code", async () => {
    const { result } = renderHook(() => useVoiceSession({ api: api(), trialId: "t1", exchanges: NONE, voices: VOICES }));
    act(() => {
      result.current.open();
    });
    expect(result.current.state.status).toBe("consent");
    act(() => {
      result.current.consent();
    });
    await waitFor(() => {
      expect(FakeSocket.all).toHaveLength(1);
    });
    const ws = FakeSocket.all[0];
    if (ws === undefined) throw new Error("no socket");
    expect(ws.protocols).toEqual([TICKET]);
    expect(ws.url).toMatch(/\/api\/voice\/ws$/);
    act(() => {
      ws.open();
    });
    // The socket is open but Live is not: still connecting, and no audio is sent.
    expect(result.current.state.status).toBe("connecting");
    const pcm = new ArrayBuffer(3200);
    act(() => {
      audio.hooks[0]?.onFrame(pcm, 0);
    });
    expect(ws.sent).toEqual([]);
    act(() => {
      ws.frame({ type: "exchange_count", used: 0, cap: 12 });
    });
    expect(result.current.state.status).toBe("listening");
    act(() => {
      audio.hooks[0]?.onFrame(pcm, 0);
      ws.frame({ type: "utterance_start", utterance: 1 });
      ws.onmessage?.({ data: new ArrayBuffer(4) });
      ws.frame({ type: "exchange", exchange_no: 1, lines: [{ role: "subject", text: "Here.", partial: false }] });
    });
    expect(ws.sent).toEqual([pcm]);
    expect(audio.played).toEqual([1]);
    // The Live audio drives both speakers' lips through the room's audio lip sync while connected.
    expect(audioMouth.active(VOICES.subject)).toBe(true);
    expect(audioMouth.active(VOICES.investigator)).toBe(true);
    expect(result.current.state.transcript).toHaveLength(1);
    act(() => {
      result.current.stop();
    });
    expect(ws.sent.at(-1)).toBe(JSON.stringify({ type: "stop" }));
    act(() => {
      ws.onclose?.({ code: 1000 });
    });
    expect(result.current.state.status).toBe("ended");
    expect(result.current.state.endedKey).toBe("normal");
    expect(audio.closed).toBe(1);
    expect(audioMouth.active(VOICES.subject)).toBe(false);
  });

  it("starts a new trial clean and ignores the old socket's late frames", async () => {
    const { result, rerender } = renderHook(({ trialId }: { trialId: string }) => useVoiceSession({ api: api(), trialId, exchanges: NONE, voices: VOICES }), { initialProps: { trialId: "t1" } });
    act(() => {
      result.current.open();
      result.current.consent();
    });
    await waitFor(() => {
      expect(FakeSocket.all).toHaveLength(1);
    });
    const old = FakeSocket.all[0];
    act(() => {
      old?.open();
      old?.onclose?.({ code: 1000 });
    });
    expect(result.current.state.status).toBe("ended");
    rerender({ trialId: "t2" });
    expect(result.current.state.status).toBe("idle");
    act(() => {
      old?.onclose?.({ code: 4409 });
      old?.frame({ type: "exchange_count", used: 5, cap: 12 });
    });
    expect(result.current.state.status).toBe("idle");
    act(() => {
      result.current.open();
    });
    expect(result.current.state.status).toBe("consent");
  });

  it("offers reconnect after a drop and opens a new socket with a new ticket", async () => {
    const minted = vi.fn(() => Promise.resolve(TICKET));
    const mint = { mintVoiceTicket: minted } as unknown as ArenaApi;
    const { result } = renderHook(() => useVoiceSession({ api: mint, trialId: "t1", exchanges: NONE, voices: VOICES }));
    act(() => {
      result.current.open();
      result.current.consent();
    });
    await waitFor(() => {
      expect(FakeSocket.all).toHaveLength(1);
    });
    act(() => {
      FakeSocket.all[0]?.open();
      FakeSocket.all[0]?.onclose?.({ code: 1006 });
    });
    expect(result.current.state.endedKey).toBe("transport");
    act(() => {
      result.current.reconnect();
    });
    await waitFor(() => {
      expect(FakeSocket.all).toHaveLength(2);
    });
    expect(minted).toHaveBeenCalledTimes(2);
    expect(result.current.state.status).toBe("connecting");
  });
});

describe("useVoiceSession hang up while connecting", () => {
  it("cancels a pending ticket: no socket opens and the microphone is closed", async () => {
    let release: (t: string) => void = () => undefined;
    const pending = { mintVoiceTicket: vi.fn(() => new Promise<string>((r) => (release = r))) } as unknown as ArenaApi;
    const { result } = renderHook(() => useVoiceSession({ api: pending, trialId: "t1", exchanges: NONE, voices: VOICES }));
    act(() => {
      result.current.open();
      result.current.consent();
    });
    await waitFor(() => {
      expect(audio.hooks).toHaveLength(1);
    });
    act(() => {
      result.current.stop();
    });
    expect(result.current.state.status).toBe("ended");
    expect(audio.closed).toBe(1);
    await act(async () => {
      release(TICKET);
      await Promise.resolve();
    });
    expect(FakeSocket.all).toHaveLength(0);
  });
});
