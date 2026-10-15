import { renderToStaticMarkup } from "react-dom/server";
import type { BoardSurface } from "../../lib/precinct/boardSurfaces";

function clipped(value: string, maximum: number): string { const points = Array.from(value); return points.length <= maximum ? value : `${points.slice(0, maximum).join("")}…`; }
export function boardSurfaceSvg(model: BoardSurface): string {
  const card = model.target === "case_board", width = card ? 1536 : 2048, height = card ? 864 : 628;
  return renderToStaticMarkup(<svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} viewBox={`0 0 ${String(width)} ${String(height)}`} role="img" aria-label={card ? "Supplied public case" : "Selected published recognition source"}>
    <rect width={width} height={height} fill={card ? "#f3f0df" : "#173b36"} />
    <path d={`M48 118H${String(width - 48)}`} stroke={card ? "#63786e" : "#a8b8ad"} strokeWidth="3" />
    <g fill={card ? "#173b36" : "#f6f5e9"} fontFamily="sans-serif">
      <text x="48" y="74" fontSize={card ? 30 : 32} letterSpacing="2">{clipped(model.eyebrow, card ? 58 : 82)}</text>
      <text x="48" y={card ? 198 : 184} fontSize={card ? 45 : 48} fontWeight="700">{clipped(model.heading, card ? 49 : 70)}</text>
      {model.lines.slice(0, 4).map((line, index) => <text key={index} x="48" y={(card ? 310 : 270) + index * (card ? 110 : 74)} fontSize={card ? 34 : 36}>{clipped(line, card ? 70 : 94)}</text>)}
      <text x="48" y={height - 44} fontSize="28">{clipped(model.footer, card ? 78 : 105)}</text>
    </g>
  </svg>);
}
