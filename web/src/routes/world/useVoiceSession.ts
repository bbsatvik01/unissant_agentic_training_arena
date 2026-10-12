/**
 * A live voice session in the room (S6 3.3, 6.2; WP-22; lift target: gokbase `useVoiceSession.ts`). The pure voice
 * machine (`lib/voice/voiceMachine`) holds the state; this hook is its I/O: the consent gate before the microphone,
 * the ticket (`POST /api/voice/tickets`), the same-origin WebSocket with the ticket as its only subprotocol, the
 * microphone frames and capture edges, the playback queue and its reports, and the mouths (`liveMouth`). The close
 * code is the only terminal signal; a transport drop offers "Reconnect", which mints a new ticket and opens a new
 * voice session that keeps only the stored transcript.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { ArenaApi } from "../../lib/api/arena";
import type { VoiceExchange } from "../../lib/contracts/generated/types";
import { liveMouth } from "../../lib/voice/liveMouth";
import { CAPTURE_FLOOR, CaptureEdges } from "../../lib/voice/liveWorld";
import {
  audioUtterance,
  controlFrame,
  frameToEvent,
  initialVoiceState,
  reconnectState,
  voiceReducer,
  type ExchangeEntry,
  type VoiceControl,
  type VoiceEvent,
  type VoiceState,
} from "../../lib/voice/voiceMachine";
import { MicrophoneRefusedError, openVoiceAudio, type VoiceAudio } from "./voiceAudio";

export interface VoiceControls {
  readonly state: VoiceState;
  /** The microphone is above its silence floor this frame. */
  readonly captureAboveFloor: boolean;
  /** Why the last start failed, in words, or null. */
  readonly error: string | null;
  /** Show the consent screen. */
  readonly open: () => void;
  readonly decline: () => void;
  /** Consent given: open the microphone, mint a ticket and connect. */
  readonly consent: () => void;
  readonly stop: () => void;
  readonly interrupt: () => void;
  /** After a transport drop: a new voice session on the same trial. */
  readonly reconnect: () => void;
}

interface Options {
  readonly api: ArenaApi;
  readonly trialId: string | null;
  /** The snapshot's stored windows (the reload view, S5 7.7). */
  readonly exchanges: readonly VoiceExchange[];
}

export function toEntries(exchanges: readonly VoiceExchange[]): ExchangeEntry[] {
  return exchanges.map((x) => ({ exchangeNo: x.exchange_no, lines: x.lines }));
}

function socketUrl(): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/voice/ws`;
}

export function useVoiceSession({ api, trialId, exchanges }: Options): VoiceControls {
  const initial = useCallback(() => {
    const entries = toEntries(exchanges);
    return initialVoiceState("live", entries, { used: entries.length, cap: 12 });
  }, [exchanges]);
  const [state, setState] = useState<VoiceState>(initial);
  const [captureAboveFloor, setCaptureAboveFloor] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef(state);
  const socket = useRef<WebSocket | null>(null);
  const audio = useRef<VoiceAudio | null>(null);
  const edges = useRef(new CaptureEdges());
  /** The server's first frame arrived: the Live session is open, so microphone audio is now sent (before it, the
   * audio would only queue up behind the session's opening). */
  const ready = useRef(false);

  const set = useCallback((next: VoiceState) => {
    stateRef.current = next;
    setState(next);
  }, []);
  const dispatch = useCallback((event: VoiceEvent) => {
    set(voiceReducer(stateRef.current, event));
  }, [set]);

  // A new trial starts from its own stored transcript.
  useEffect(() => {
    if (stateRef.current.connection === "idle") set(initial());
  }, [initial, set]);

  const teardown = useCallback(() => {
    socket.current = null;
    audio.current?.close();
    audio.current = null;
    setCaptureAboveFloor(false);
  }, []);

  const connect = useCallback(async () => {
    if (trialId === null) return;
    setError(null);
    let opened: VoiceAudio;
    try {
      opened = await openVoiceAudio({
        onFrame: (pcm, level) => {
          const edge = edges.current.next(level, performance.now());
          if (edge !== null) dispatch(edge);
          setCaptureAboveFloor(level > CAPTURE_FLOOR);
          const ws = socket.current;
          if (ready.current && ws !== null && ws.readyState === WebSocket.OPEN && stateRef.current.connection === "open") ws.send(pcm);
        },
        onPlayback: (utterance) => {
          dispatch({ type: "playback", utterance });
          if (utterance === null && stateRef.current.connection === "ended") teardown();
        },
      });
    } catch (e) {
      setError(e instanceof MicrophoneRefusedError ? "The microphone is not available. Allow it in the browser and try again." : "Voice could not start.");
      dispatch({ type: "ended", key: "error" });
      return;
    }
    audio.current = opened;
    let ticket: string;
    try {
      ticket = await api.mintVoiceTicket(trialId);
    } catch {
      setError("Voice is not available for this interview right now (the daily voice limit, or another voice session is open).");
      dispatch({ type: "ended", key: "unavailable" });
      teardown();
      return;
    }
    ready.current = false;
    const ws = new WebSocket(socketUrl(), [ticket]);
    ws.binaryType = "arraybuffer";
    socket.current = ws;
    ws.onopen = () => {
      dispatch({ type: "socket_open" });
    };
    ws.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
      ready.current = true;
      if (typeof e.data === "string") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(e.data);
        } catch {
          return;
        }
        const event = frameToEvent(parsed);
        if (event === null) return;
        if (event.type === "interrupted") audio.current?.flush();
        dispatch(event);
        return;
      }
      const utterance = audioUtterance(stateRef.current);
      if (utterance !== null) audio.current?.play(utterance, e.data);
    };
    ws.onclose = (e) => {
      const player = audio.current;
      player?.stopCapture();
      edges.current = new CaptureEdges();
      setCaptureAboveFloor(false);
      dispatch({ type: "socket_closed", code: e.code });
      if (e.code !== 4410) player?.flush();
      // The cap drains the received audio first (SG4-28); with nothing queued, the drained report is now.
      if (e.code !== 4410 || player === null || !player.busy()) {
        dispatch({ type: "playback", utterance: null });
        teardown();
      }
    };
  }, [api, trialId, dispatch, teardown]);

  const open = useCallback(() => {
    dispatch({ type: "open_consent" });
  }, [dispatch]);
  const decline = useCallback(() => {
    dispatch({ type: "consent_declined" });
  }, [dispatch]);
  const consent = useCallback(() => {
    dispatch({ type: "connect" });
    void connect();
  }, [connect, dispatch]);

  const send = useCallback((control: VoiceControl) => {
    const ws = socket.current;
    if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(controlFrame(control));
  }, []);
  const stop = useCallback(() => {
    send({ type: "stop" });
  }, [send]);
  const interrupt = useCallback(() => {
    audio.current?.flush();
    send({ type: "interrupt" });
  }, [send]);
  const reconnect = useCallback(() => {
    set(reconnectState(stateRef.current));
    void connect();
  }, [connect, set]);

  // The mouths follow the live audio while a session is connected.
  const live = state.connection === "open" || state.connection === "draining";
  useEffect(() => {
    if (!live) return;
    const detachSubject = liveMouth.attach("subject", () => audio.current?.playbackLevel() ?? 0);
    const detachInvestigator = liveMouth.attach("investigator", () => audio.current?.micLevel() ?? 0);
    return () => {
      detachSubject();
      detachInvestigator();
    };
  }, [live]);

  // Leaving the room (or a new trial) hangs up.
  useEffect(
    () => () => {
      socket.current?.close(1000);
      audio.current?.close();
    },
    [trialId],
  );

  return { state, captureAboveFloor, error, open, decline, consent, stop, interrupt, reconnect };
}
