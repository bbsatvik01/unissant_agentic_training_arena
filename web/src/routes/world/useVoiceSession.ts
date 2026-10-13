/**
 * A live voice session in the room (S6 3.3, 6.2; WP-22; lift target: gokbase `useVoiceSession.ts`). The pure voice
 * machine (`lib/voice/voiceMachine`) holds the state; this hook is its I/O: the consent gate before the microphone,
 * the ticket (`POST /api/voice/tickets`), the same-origin WebSocket with the ticket as its only subprotocol, the
 * microphone frames and capture edges, the playback queue and its reports, and the mouths (the room's audio lip sync, `audioMouth`). The close
 * code is the only terminal signal; a transport drop offers "Reconnect", which mints a new ticket and opens a new
 * voice session that keeps only the stored transcript.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { ArenaApi } from "../../lib/api/arena";
import type { VoiceExchange } from "../../lib/contracts/generated/types";
import { analyserSource, audioMouth } from "../../lib/world/audioLips";
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
  /** The speakers' lip-sync keys (`Persona.voice.gemini`): the Live audio drives their mouths through `audioMouth`. */
  readonly voices: { readonly subject: string; readonly investigator: string };
}

export function toEntries(exchanges: readonly VoiceExchange[]): ExchangeEntry[] {
  return exchanges.map((x) => ({ exchangeNo: x.exchange_no, lines: x.lines }));
}

function socketUrl(): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/voice/ws`;
}

export function useVoiceSession({ api, trialId, exchanges, voices }: Options): VoiceControls {
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
  /** Bumped on a new trial and on every connect: callbacks of an older socket or microphone are ignored. */
  const generation = useRef(0);

  const set = useCallback((next: VoiceState) => {
    stateRef.current = next;
    setState(next);
  }, []);
  const dispatch = useCallback((event: VoiceEvent) => {
    set(voiceReducer(stateRef.current, event));
  }, [set]);

  // A new trial (or leaving the room) hangs up the old session and starts clean.
  useEffect(() => {
    generation.current += 1;
    return () => {
      generation.current += 1;
      const ws = socket.current;
      if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(controlFrame({ type: "stop" }));
      ws?.close(1000);
      socket.current = null;
      audio.current?.close();
      audio.current = null;
      edges.current = new CaptureEdges();
      ready.current = false;
      // The next trial starts clean; its stored transcript arrives with its snapshot (below).
      set(initialVoiceState("live"));
      setError(null);
      setCaptureAboveFloor(false);
    };
  }, [trialId, set]);

  // The trial's stored transcript, before the socket opens (the snapshot's voice branch, S5 7.7).
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
    generation.current += 1;
    const gen = generation.current;
    const mine = () => generation.current === gen;
    setError(null);
    // The ticket is minted while the microphone opens (two independent waits); a ticket the attempt never uses
    // expires unredeemed after 60 s.
    const minting = api.mintVoiceTicket(trialId).then(
      (ticket) => ({ ticket }),
      () => null,
    );
    let opened: VoiceAudio;
    try {
      opened = await openVoiceAudio({
        onFrame: (pcm, level) => {
          if (!mine()) return;
          const edge = edges.current.next(level, performance.now());
          if (edge !== null) dispatch(edge);
          setCaptureAboveFloor(level > CAPTURE_FLOOR);
          const ws = socket.current;
          if (ready.current && ws !== null && ws.readyState === WebSocket.OPEN && stateRef.current.connection === "open") ws.send(pcm);
        },
        onPlayback: (utterance) => {
          if (!mine()) return;
          dispatch({ type: "playback", utterance });
          if (utterance === null && stateRef.current.connection === "ended") teardown();
        },
      });
    } catch (e) {
      if (!mine()) return;
      setError(e instanceof MicrophoneRefusedError ? "The microphone is not available. Allow it in the browser and try again." : "Voice could not start.");
      dispatch({ type: "ended", key: "error" });
      return;
    }
    if (!mine()) {
      opened.close();
      return;
    }
    audio.current = opened;
    const minted = await minting;
    if (minted === null) {
      if (!mine()) return;
      setError("Voice is not available for this interview right now (the daily voice limit, or another voice session is open).");
      dispatch({ type: "ended", key: "unavailable" });
      teardown();
      return;
    }
    if (!mine()) return;
    ready.current = false;
    const ws = new WebSocket(socketUrl(), [minted.ticket]);
    ws.binaryType = "arraybuffer";
    socket.current = ws;
    // The bar stays "Connecting" until the server's first frame: the socket opens at once, the Live session about a
    // second later (claim, reservation, context, Live handshake).
    ws.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
      if (!mine()) return;
      if (!ready.current) {
        ready.current = true;
        dispatch({ type: "socket_open" });
      }
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
      if (!mine()) return;
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
    const ws = socket.current;
    if (ws !== null && ws.readyState === WebSocket.OPEN) {
      send({ type: "stop" });
      return;
    }
    // Hung up while still connecting: cancel the attempt (its late microphone, ticket or socket is dropped), stop
    // the microphone now, and end.
    generation.current += 1;
    ws?.close(1000);
    teardown();
    dispatch({ type: "ended", key: "normal" });
  }, [send, teardown, dispatch]);
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
    const player = audio.current;
    if (!live || player === null) return;
    const detachSubject = audioMouth.attach(voices.subject, analyserSource(player.playbackAnalyser));
    const detachInvestigator = audioMouth.attach(voices.investigator, analyserSource(player.micAnalyser));
    return () => {
      detachSubject();
      detachInvestigator();
    };
  }, [live, voices.subject, voices.investigator]);

  return { state, captureAboveFloor, error, open, decline, consent, stop, interrupt, reconnect };
}
