/** One explicit offline recorder. The existing Canvas frame owns clock advancement. */
import { useCallback, useLayoutEffect, useMemo } from "react";
import { localStaffPlaybackActivity } from "../../lib/precinct/localStaffPlaybackActivity";
import type { RecordingCase } from "../../lib/world/recording";
import { createLocalWorldCapture } from "../../lib/world/localWorldCapture";
import { createWorldCapture } from "../../lib/world/worldCapture";
import { createMountedSceneContext, readKnownScene, type MountedSceneContext, type SceneContextReader } from "../../lib/world/sceneContext";
import type { CameraData, InputData, PoseData } from "../../lib/world/worldEvents";
import { useWorldCapture } from "./useWorldCapture";

/** Private capability state, never mutated through a value passed into a hook. */
function createLocalBinding(packet: RecordingCase | null, readScene: SceneContextReader | undefined) {
  let active = false;
  const local = packet === null ? null : createLocalWorldCapture({ packet, isActive: () => active, readUncapturedAudio: localStaffPlaybackActivity.getSnapshot, ...(readScene === undefined ? {} : { readScene }) });
  const controller = local?.controller ?? createWorldCapture({ context: () => null });
  return { local, controller, isActive: () => active,
    setActive: (value: boolean) => { active = value; if (!active) controller.stop(); } };
}
export function useLocalWorldCapture(packet: RecordingCase | null, source: "idle" | "live" | "recording", paused: boolean, captureScene?: MountedSceneContext) {
  const mountedScene = useMemo(() => createMountedSceneContext(), []);
  const sceneRequired = captureScene !== undefined;
  const binding = useMemo(() => createLocalBinding(packet, sceneRequired ? mountedScene.read : undefined), [packet, mountedScene, sceneRequired]);
  useLayoutEffect(() => {
    const update = () => { mountedScene.set(captureScene === undefined ? null : readKnownScene(captureScene.read)); binding.controller.validateScene(); };
    update();
    const unsubscribe = captureScene?.subscribe(update);
    return () => { unsubscribe?.(); mountedScene.set(null); binding.controller.validateScene(); };
  }, [binding, captureScene, mountedScene]);
  useLayoutEffect(() => {
    const update = () => { binding.controller.validateUncapturedAudio(); };
    update(); return localStaffPlaybackActivity.subscribe(update);
  }, [binding]);
  const capture = useWorldCapture(binding.controller);
  useLayoutEffect(() => {
    binding.setActive(source === "idle" && !paused);
    return () => { binding.setActive(false); };
  }, [binding, source, paused]);
  const scope = capture.snapshot.trialId;
  const owns = useCallback(() => scope !== null && binding.isActive() && binding.controller.getSnapshot().trialId === scope
    && binding.controller.getSnapshot().status === "recording", [binding, scope]);
  const onActorSample = useCallback((sample: PoseData) => { if (owns()) binding.controller.pose(sample); }, [binding, owns]);
  const onCameraSample = useCallback((sample: CameraData) => { if (owns()) binding.controller.camera(sample); }, [binding, owns]);
  const onControlInput = useCallback((sample: Extract<InputData, { action: "key" | "click" }>) => { if (owns()) binding.controller.input(sample); }, [binding, owns]);
  const beforeFrame = useCallback(() => { if (owns()) binding.local?.advanceClock(); }, [binding, owns]);
  return { ...capture, local: binding.local, beforeFrame, onCameraSample, onControlInput,
    actorCapture: scope !== null && source === "idle" && !paused && capture.snapshot.status === "recording" ? { scope, onActorSample } : undefined,
    localClock: source === "idle" && scope !== null ? binding.local?.clock ?? null : null };
}
