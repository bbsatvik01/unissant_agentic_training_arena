/**
 * Playback of a recorded run (D-021): a requestAnimationFrame clock moves the playback time at the chosen speed,
 * and `seek` feeds the recording's frames through the same trial reducer the live room uses. The world state is
 * derived from that reducer state on every tick and published only when it changes; the session clock is kept in
 * a ref so figures can read it every frame without re-rendering React.
 *
 * Live mode (after WP-13) publishes the same three things (trial state, world state, clock) from the session
 * controller; the scene and the overlay cannot tell the two apart.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { initialTrialState, type TrialState } from "../../lib/trial/trialReducer";
import { seek, startCursor, type PlaybackCursor, type Recording, type Speed, SPEEDS } from "../../lib/world/recording";
import { initialWorldReplayState, type WorldReplayState } from "../../lib/world/worldEvents";
import { speechSync } from "../../lib/voice/speechSync";
import { deriveWorld, type WorldState } from "../../lib/world/worldState";

export interface PlaybackControls {
  readonly trial: TrialState;
  readonly world: WorldState | null;
  /** Captured public world samples at this SAME trial cursor; never replay as live commands. */
  readonly capturedWorld: WorldReplayState;
  readonly clock: { current: number };
  /** Exact public recorded arrivals at the shown cursor, including backward scrubs. */
  readonly arrivals: ReadonlyMap<string, number>;
  readonly playing: boolean;
  readonly speed: Speed;
  readonly duration: number;
  readonly play: () => void;
  readonly pause: () => void;
  readonly setSpeed: (speed: Speed) => void;
  readonly seekTo: (t: number) => void;
}

interface Options {
  readonly subjectName: string;
  readonly reducedMotion: boolean;
  readonly paused: boolean;
}

/** What playback has published, tagged with the recording it belongs to. */
interface Published {
  readonly recording: Recording | null;
  readonly arrivals: ReadonlyMap<string, number>;
  readonly trial: TrialState;
  readonly world: WorldState | null;
  /** Captured public world samples at this SAME trial cursor; never replay as live commands. */
  readonly capturedWorld: WorldReplayState;
}

function worldAt(cursor: PlaybackCursor, options: Options, recording: Recording): WorldState | null {
  const world = deriveWorld({
    view: cursor.state.view,
    nowMs: cursor.t,
    arrivals: cursor.arrivals,
    subjectName: options.subjectName,
    investigatorActive: false,
    reducedMotion: options.reducedMotion,
    paused: options.paused,
    voice: speechSync.activeFor,
  });
  return world !== null && recording.published_at_ms !== undefined && cursor.t < recording.published_at_ms
    ? { ...world, debriefReady: false } : world;
}

export function usePlayback(recording: Recording | null, options: Options): PlaybackControls {
  const cursor = useRef<{ recording: Recording; at: PlaybackCursor } | null>(null);
  const clock = useRef(0);
  const worldKey = useRef("");
  const optionsRef = useRef(options);
  const [published, setPublished] = useState<Published>({ recording: null, arrivals: new Map(), trial: initialTrialState(), world: null, capturedWorld: initialWorldReplayState() });
  const [playingFor, setPlayingFor] = useState<Recording | null>(null);
  const [speed, changeSpeed] = useState<Speed>(1);
  const [playScope, setPlayScope] = useState({ recording, paused: options.paused });
  // Invalidate play intent when its render inputs change. Never restart it on unpause or replacement.
  if (playScope.recording !== recording || playScope.paused !== options.paused) {
    setPlayScope({ recording, paused: options.paused });
    setPlayingFor(null);
  }
  useEffect(() => {
    optionsRef.current = options;
  });

  const { subjectName, reducedMotion, paused } = options;
  // Until the first publish for a new recording, show its opening snapshot.
  const start = useMemo(() => {
    if (recording === null) return null;
    const at = seek(recording, startCursor(recording), 0);
    return { recording, arrivals: at.arrivals, trial: at.state, world: worldAt(at, { subjectName, reducedMotion, paused }, recording), capturedWorld: at.world };
  }, [recording, subjectName, reducedMotion, paused]);
  const shown: Published = published.recording === recording && recording !== null ? published : (start ?? { recording: null, arrivals: new Map(), trial: initialTrialState(), world: null, capturedWorld: initialWorldReplayState() });

  const current = useCallback((rec: Recording): PlaybackCursor => (cursor.current?.recording === rec ? cursor.current.at : startCursor(rec)), []);

  const publish = useCallback((rec: Recording, next: PlaybackCursor) => {
    const prev = cursor.current?.recording === rec ? cursor.current.at : null;
    cursor.current = { recording: rec, at: next };
    clock.current = next.t;
    const world = worldAt(next, optionsRef.current, rec);
    const key = JSON.stringify(world);
    const changed = key !== worldKey.current || prev?.state !== next.state || prev.arrivals !== next.arrivals || prev.world !== next.world;
    worldKey.current = key;
    // Only a change of state re-renders: the playback time lives in `clock`, read by the scrubber on its own.
    setPublished((p) => (!changed && p.recording === rec ? p : { recording: rec, arrivals: next.arrivals, trial: next.state, world, capturedWorld: next.world }));
  }, []);

  // Reset every part of the shared clock/cursor on replacement, even before Play is pressed.
  useEffect(() => {
    if (recording === null) { cursor.current = null; clock.current = 0; worldKey.current = ""; }
    else if (cursor.current?.recording !== recording) publish(recording, seek(recording, startCursor(recording), 0));
  }, [recording, publish]);

  // Motion preferences change the derived world (still poses) even while playback is paused.
  useEffect(() => {
    if (recording !== null && cursor.current?.recording === recording) publish(recording, cursor.current.at);
  }, [reducedMotion, paused, recording, publish]);

  const active = !paused && playingFor === recording ? playingFor : null;
  const playing = active !== null;
  useEffect(() => {
    if (active === null) return;
    const rec = active;
    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      const at = current(rec);
      const t = at.t + Math.max(0, Number.isFinite(now - last) ? now - last : 0) * speed;
      last = now;
      publish(rec, seek(rec, at, t));
      if (t >= rec.durationMs) {
        setPlayingFor(null);
        return;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [active, speed, publish, current]);

  const play = useCallback(() => {
    if (recording === null || optionsRef.current.paused) return;
    if (current(recording).t >= recording.durationMs) publish(recording, seek(recording, startCursor(recording), 0));
    setPlayingFor(recording);
  }, [recording, publish, current]);
  const pause = useCallback(() => {
    setPlayingFor(null);
  }, []);
  const setSpeed = useCallback((value: Speed) => { if (SPEEDS.includes(value)) changeSpeed(value); }, []);
  const seekTo = useCallback(
    (t: number) => {
      if (recording !== null) publish(recording, seek(recording, current(recording), t));
    },
    [recording, publish, current],
  );

  return { capturedWorld: shown.capturedWorld, arrivals: shown.arrivals, trial: shown.trial, world: shown.world, clock, playing, speed, duration: recording?.durationMs ?? 0, play, pause, setSpeed, seekTo };
}
