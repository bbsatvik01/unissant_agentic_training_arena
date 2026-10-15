/** Original presentation cover, not a reproduction or summary of an evidence document. */
import { useEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";
import { renderToStaticMarkup } from "react-dom/server";
import type { MeshBasicMaterial } from "three";
import type { PublicEvidenceSource } from "../../lib/precinct/evidenceTable";
import { createLocalSvgTexture, type LocalSvgImage } from "./localSvgTexture";

export const PRESENTED_PAPER = {
  position: [8.15, 0.807, -13.35] as const,
  rotation: [-Math.PI / 2, 0, 0] as const,
  size: [0.58, 0.40] as const,
};

/** A cover title can wrap or abbreviate; the public reader keeps the original full title and text. */
export function paperTitleLines(title: string): readonly string[] {
  const characters = Array.from(title.trim().replace(/\s+/gu, " "));
  const shown = characters.slice(0, 140).join("") + (characters.length > 140 ? "…" : "");
  const lines: string[] = [];
  let line = "";
  for (const word of shown.split(" ")) {
    if (line.length !== 0 && line.length + word.length > 28) { lines.push(line); line = ""; }
    for (const character of Array.from(word)) {
      if (Array.from(line).length >= 28) { lines.push(line); line = ""; }
      line += character;
    }
    line += " ";
  }
  if (line.trim().length !== 0) lines.push(line.trim());
  return lines.map((value) => value.trim()).slice(0, 7);
}

/** React escapes every supplied label. No links, images, scripts, body text or outcome enters this SVG. */
export function presentedEvidenceSvg(source: PublicEvidenceSource): LocalSvgImage {
  const idSize = Math.min(100, 740 / Math.max(1, Array.from(source.ref.id).length * 0.62));
  return { svg: renderToStaticMarkup(<svg xmlns="http://www.w3.org/2000/svg" width="870" height="600" viewBox="0 0 870 600" role="img" aria-label="Presented public source cover">
    <rect width="870" height="600" fill="#f7f4e9" />
    <rect x="22" y="22" width="826" height="556" fill="none" stroke="#c5c9bd" strokeWidth="2" />
    <rect x="22" y="22" width="826" height="14" fill="#284d42" />
    <g fontFamily="sans-serif" fill="#253c33">
      <text x="62" y="88" fontSize="30" letterSpacing="3">PRESENTED SOURCE</text>
      <text x="62" y="130" fontSize="26" letterSpacing="2">{source.ref.kind === "document" ? "OPENING DOCUMENT" : "RELEASED RECORD"}</text>
      <text x="62" y="242" fontSize={idSize} fontWeight="700">{source.ref.id}</text>
      {paperTitleLines(source.title).map((line, index) => <text key={index} x="62" y={295 + index * 34} fontSize="34">{line}</text>)}
      <text x="62" y="552" fontSize="22">Open the public source reader for its full original text.</text>
    </g>
  </svg>) };
}

interface Props {
  readonly source: PublicEvidenceSource;
  readonly interactive: boolean;
  readonly onInspect?: () => void;
}

function PaperSurface({ source, interactive, onInspect }: Props) {
  const material = useRef<MeshBasicMaterial>(null);
  const invalidate = useThree((state) => state.invalidate);
  const { kind, id } = source.ref;
  const { title } = source;
  useEffect(() => {
    const resource = createLocalSvgTexture((texture) => {
      if (material.current === null) return;
      material.current.map = texture; material.current.needsUpdate = true; invalidate();
    }, { mipmaps: true });
    resource.update(presentedEvidenceSvg({ ref: { kind, id }, title }));
    return () => { resource.dispose(); };
  }, [kind, id, title, invalidate]);
  return <mesh name="precinct-presented-public-evidence" position={PRESENTED_PAPER.position} rotation={PRESENTED_PAPER.rotation} onPointerDown={(event) => {
    event.stopPropagation();
    if (interactive && event.button === 0) onInspect?.();
  }}>
    <planeGeometry args={[...PRESENTED_PAPER.size]} />
    <meshBasicMaterial ref={material} color="#ffffff" toneMapped={false} />
  </mesh>;
}

/** A replacement source gets a fresh material immediately; no late decode can display the old source. */
export function PresentedEvidencePaper(props: Props) {
  return <PaperSurface key={JSON.stringify([props.source.ref.kind, props.source.ref.id, props.source.title])} {...props} />;
}
