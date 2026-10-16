import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { PMREMGenerator, type Scene, type WebGLRenderer, type WebGLRenderTarget } from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

const ENVIRONMENT_INTENSITY = 0.45;

/** Own only this generated target. Never dispose or overwrite another environment owner's texture. */
export function installPrecinctEnvironment(gl: WebGLRenderer, scene: Scene): () => void {
  const previous = scene.environment;
  const intensity = scene.environmentIntensity;
  const pmrem = new PMREMGenerator(gl);
  let room: RoomEnvironment | undefined;
  let target: WebGLRenderTarget;
  try {
    room = new RoomEnvironment();
    target = pmrem.fromScene(room, 0.04);
  } catch (error) {
    room?.dispose(); pmrem.dispose(); throw error;
  }
  scene.environment = target.texture;
  scene.environmentIntensity = ENVIRONMENT_INTENSITY;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (scene.environment === target.texture) {
      scene.environment = previous;
      if (scene.environmentIntensity === ENVIRONMENT_INTENSITY) scene.environmentIntensity = intensity;
    }
    target.dispose(); room.dispose(); pmrem.dispose();
  };
}

/** Omitted Low does not construct RoomEnvironment, generate PMREM, or install a substitute light. */
export function PrecinctEnvironment({ enabled }: { readonly enabled: boolean }) {
  const get = useThree((state) => state.get);
  useEffect(() => {
    if (!enabled) return;
    const { gl, scene } = get();
    return installPrecinctEnvironment(gl, scene);
  }, [enabled, get]);
  return null;
}
