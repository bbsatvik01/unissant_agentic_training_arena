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
import { seek, startCursor, type PlaybackCursor, type Recording, type Speed } from "../../lib/world/recording";
import { deriveWorld, type WorldState } from "../../lib/world/worldState";

export interface PlaybackControls {
  readonly trial: TrialState;
  readonly world: WorldState | null;
  readonly clock: { current: number };
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
  readonly trial: TrialState;
  readonly world: WorldState | null;
}

function worldAt(cursor: PlaybackCursor, options: Options): WorldState | null {
  return deriveWorld({
    view: cursor.state.view,
    nowMs: cursor.t,
    arrivals: cursor.arrivals,
    subjectName: options.subjectName,
    investigatorActive: false,
    reducedMotion: options.reducedMotion,
    paused: options.paused,
  });
}

export function usePlayback(recording: Recording | null, options: Options): PlaybackControls {
  const cursor = useRef<{ recording: Recording; at: PlaybackCursor } | null>(null);
  const clock = useRef(0);
  const worldKey = useRef("");
  const optionsRef = useRef(options);
  const [published, setPublished] = useState<Published>({ recording: null, trial: initialTrialState(), world: null });
  const [playingFor, setPlayingFor] = useState<Recording | null>(null);
  const [speed, setSpeed] = useState<Speed>(1);
  useEffect(() => {
    optionsRef.current = options;
  });

  const { subjectName, reducedMotion, paused } = options;
  // Until the first publish for a new recording, show its opening snapshot.
  const start = useMemo(() => {
    if (recording === null) return null;
    const at = startCursor(recording);
    return { recording, trial: at.state, world: worldAt(at, { subjectName, reducedMotion, paused }) };
  }, [recording, subjectName, reducedMotion, paused]);
  const shown: Published = published.recording === recording && recording !== null ? published : (start ?? { recording: null, trial: initialTrialState(), world: null });

  const current = useCallback((rec: Recording): PlaybackCursor => (cursor.current?.recording === rec ? cursor.current.at : startCursor(rec)), []);

  const publish = useCallback((rec: Recording, next: PlaybackCursor) => {
    const prev = cursor.current?.recording === rec ? cursor.current.at : null;
    cursor.current = { recording: rec, at: next };
    clock.current = next.t;
    const world = worldAt(next, optionsRef.current);
    const key = JSON.stringify(world);
    const changed = key !== worldKey.current || prev?.state !== next.state;
    worldKey.current = key;
    // Only a change of state re-renders: the playback time lives in `clock`, read by the scrubber on its own.
    setPublished((p) => (!changed && p.recording === rec ? p : { recording: rec, trial: next.state, world }));
  }, []);

  // Motion preferences change the derived world (still poses) even while playback is paused.
  useEffect(() => {
    if (recording !== null && cursor.current?.recording === recording) publish(recording, cursor.current.at);
  }, [reducedMotion, paused, recording, publish]);

  const active = playingFor === recording ? playingFor : null;
  const playing = active !== null;
  useEffect(() => {
    if (active === null) return;
    const rec = active;
    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      const at = current(rec);
      const t = at.t + (now - last) * speed;
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
    if (recording === null) return;
    if (current(recording).t >= recording.durationMs) publish(recording, startCursor(recording));
    setPlayingFor(recording);
  }, [recording, publish, current]);
  const pause = useCallback(() => {
    setPlayingFor(null);
  }, []);
  const seekTo = useCallback(
    (t: number) => {
      if (recording !== null) publish(recording, seek(recording, current(recording), t));
    },
    [recording, publish, current],
  );

  return { trial: shown.trial, world: shown.world, clock, playing, speed, duration: recording?.durationMs ?? 0, play, pause, setSpeed, seekTo };
}
