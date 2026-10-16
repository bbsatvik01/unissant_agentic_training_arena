import { useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import type { MeshBasicMaterial } from "three";
import { CASE_BOARD_SURFACES, RECOGNITION_SURFACE, type BoardSurface, type BoardSurfaceModel } from "../../lib/precinct/boardSurfaces";
import { boardSurfaceSvg } from "./boardSurfaceSvg";
import { createLocalSvgTexture } from "./localSvgTexture";

function Surface({ model, placement, interactive, onOpen }: {
  readonly model: BoardSurface;
  readonly placement: { readonly position: readonly [number, number, number]; readonly size: readonly [number, number] };
  readonly interactive: boolean; readonly onOpen: (target: BoardSurface["target"]) => void;
}) {
  const material = useRef<MeshBasicMaterial>(null); const invalidate = useThree((state) => state.invalidate);
  useEffect(() => {
    const resource = createLocalSvgTexture((texture) => {
      if (material.current !== null) { material.current.map = texture; material.current.color.set("#ffffff"); material.current.needsUpdate = true; invalidate(); }
    }, { mipmaps: true });
    resource.update({ svg: boardSurfaceSvg(model) });
    return () => { resource.dispose(); };
  }, [model, invalidate]);
  return <mesh name={model.target === "case_board" ? "Public case surface" : "Published recognition surface"} position={[...placement.position]} onPointerDown={(event) => {
    event.stopPropagation(); if (interactive && event.button === 0) onOpen(model.target);
  }}>
    <planeGeometry args={[...placement.size]} /><meshBasicMaterial ref={material} color={model.target === "case_board" ? "#f3f0df" : "#173b36"} toneMapped={false} />
  </mesh>;
}
/** Display keys remount blank materials synchronously; old async SVG decodes are cancelled on cleanup. */
export function PrecinctBoardSurfaces({ model, interactive, onOpen }: { readonly model: BoardSurfaceModel; readonly interactive: boolean; readonly onOpen: (target: BoardSurface["target"]) => void }) {
  return <group name="Public station board overlays">
    {CASE_BOARD_SURFACES.map((placement, index) => { const card = model.cases[index]; return card === undefined ? null : <Surface key={card.key} model={card} placement={placement} interactive={interactive} onOpen={onOpen} />; })}
    <Surface key={model.recognition.key} model={model.recognition} placement={RECOGNITION_SURFACE} interactive={interactive} onOpen={onOpen} />
  </group>;
}
