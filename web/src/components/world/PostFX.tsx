/**
 * Post-processing (D-025), kept tasteful: ground-truth ambient occlusion for contact depth (high tier only), a soft
 * bloom that only the practical lights reach (ceiling panels, screens, the recorder's light), and the filmic tone
 * mapping and colour output pass. Built on three's own passes, so no extra dependency. It renders the frame itself
 * (a positive useFrame priority), at the tier's settings.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Vector2 } from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

export function PostFX({ ao, bloom }: { ao: boolean; bloom: boolean }) {
  const get = useThree((s) => s.get);
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);

  // Built once per set of passes; resizes go through setSize below, never a rebuild.
  const composer = useMemo(() => {
    const { gl, scene, camera, size } = get();
    const c = new EffectComposer(gl);
    c.addPass(new RenderPass(scene, camera));
    if (ao) {
      const pass = new GTAOPass(scene, camera, size.width, size.height);
      pass.blendIntensity = 0.85;
      pass.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.5, thickness: 1, scale: 1 });
      c.addPass(pass);
    }
    if (bloom) c.addPass(new UnrealBloomPass(new Vector2(size.width, size.height), 0.22, 0.45, 1.35));
    c.addPass(new OutputPass());
    return c;
  }, [get, ao, bloom]);

  useEffect(() => {
    composer.setPixelRatio(dpr);
    composer.setSize(size.width, size.height);
  }, [composer, size, dpr]);

  // The composer's dispose leaves its passes' render targets alive: dispose every pass too.
  useEffect(
    () => () => {
      for (const pass of composer.passes) pass.dispose();
      composer.dispose();
    },
    [composer],
  );

  useFrame((_, delta) => {
    composer.render(delta);
  }, 1);
  return null;
}
