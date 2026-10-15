import { useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MeshBasicMaterial } from "three";
import { DEBRIEF_WALL_SURFACE, type DebriefWall } from "../../lib/precinct/debriefWall";
import { createLocalSvgTexture } from "./localSvgTexture";

/** No inferred timeline, score animation, outcome coloring, or network resource. */
export function debriefWallSvg(model: DebriefWall): string {
  return renderToStaticMarkup(<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="810" viewBox="0 0 2048 810" role="img" aria-label="Published session debrief wall">
    <rect width="2048" height="810" fill="#173b36" />
    <path d="M64 150h1920" stroke="#a8b8ad" strokeWidth="2" />
    <g fill="#f6f5e9" fontFamily="sans-serif">
      <text x="64" y="88" fontSize="32" letterSpacing="5">{model.origin}</text>
      <text x="64" y="234" fontSize="64" fontWeight="700">{model.heading}</text>
      <text x="64" y="367" fontSize="64" fontWeight="700">{model.total}</text>
      {model.lines.slice(0, 5).map((line, index) => <text key={index} x="750" y={255 + index * 76} fontSize="32">{Array.from(line).slice(0, 68).join("")}{Array.from(line).length > 68 ? "…" : ""}</text>)}
      <text x="64" y="682" fontSize="30">Activity and scores are synthetic training feedback.</text>
      <text x="64" y="744" fontSize="28">Open the replay theater for the complete, readable record.</text>
    </g>
  </svg>);
}

function Surface({ model, interactive, onOpen }: { readonly model: DebriefWall; readonly interactive: boolean; readonly onOpen?: () => void }) {
  const material = useRef<MeshBasicMaterial>(null);
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => {
    const resource = createLocalSvgTexture((texture) => {
      if (material.current !== null) { material.current.map = texture; material.current.color.set("#ffffff"); material.current.needsUpdate = true; invalidate(); }
    }, { mipmaps: true });
    resource.update({ svg: debriefWallSvg(model) });
    return () => { resource.dispose(); };
  }, [model, invalidate]);
  return <mesh name="Published debrief wall" position={[...DEBRIEF_WALL_SURFACE.position]} onPointerDown={(event) => {
    event.stopPropagation();
    if (interactive && event.button === 0) onOpen?.();
  }}>
    <planeGeometry args={[...DEBRIEF_WALL_SURFACE.size]} />
    <meshBasicMaterial ref={material} color="#173b36" toneMapped={false} />
  </mesh>;
}

/** Scope/publication-keyed remount prevents a late old texture decode revealing a stale result. */
export function DebriefWallScreen(props: { readonly model: DebriefWall; readonly interactive: boolean; readonly onOpen?: () => void }) {
  return <Surface key={props.model.key} {...props} />;
}
