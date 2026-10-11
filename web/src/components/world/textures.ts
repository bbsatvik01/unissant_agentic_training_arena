/**
 * Procedural textures drawn on a 2D canvas: papers, case files, signs and the mesh-gradient backdrop. No image or
 * font is fetched (the demo runs offline under the page's CSP); text uses the DESIGN.md stacks with system
 * fallbacks.
 */
import { CanvasTexture, SRGBColorSpace } from "three";

import { PALETTE } from "../../lib/world/palette";

const SANS = "Inter, system-ui, -apple-system, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const el = document.createElement("canvas");
  el.width = width;
  el.height = height;
  const ctx = el.getContext("2d");
  if (ctx === null) throw new Error("2D canvas unavailable");
  return [el, ctx];
}

function texture(el: HTMLCanvasElement): CanvasTexture {
  const t = new CanvasTexture(el);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Wrap `text` into lines no wider than `width`, at most `max` lines (the last ends with an ellipsis if cut). */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, max: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line === "" ? word : `${line} ${word}`;
    if (ctx.measureText(next).width > width && line !== "") {
      lines.push(line);
      line = word;
      if (lines.length === max) break;
    } else line = next;
  }
  if (lines.length < max && line !== "") lines.push(line);
  if (lines.length === max && words.join(" ").length > lines.join(" ").length) {
    lines[max - 1] = `${(lines[max - 1] ?? "").replace(/\s+\S*$/, "")}...`;
  }
  return lines;
}

/** A sheet of paper: mono label, title, then grey text lines. Portrait, about A4 proportions. */
export function paperTexture(label: string, title: string, note: string): CanvasTexture {
  const [el, ctx] = canvas(360, 480);
  ctx.fillStyle = PALETTE.canvas;
  ctx.fillRect(0, 0, 360, 480);
  ctx.strokeStyle = PALETTE.hairline;
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, 356, 476);
  ctx.fillStyle = PALETTE.mute;
  ctx.font = `400 22px ${MONO}`;
  ctx.fillText(label.toUpperCase(), 28, 52);
  ctx.fillStyle = PALETTE.ink;
  ctx.font = `600 30px ${SANS}`;
  const titleLines = wrap(ctx, title, 304, 4);
  titleLines.forEach((line, i) => {
    ctx.fillText(line, 28, 100 + i * 36);
  });
  let y = 116 + titleLines.length * 36;
  ctx.fillStyle = PALETTE.hairline;
  for (let i = 0; i < 9 && y < 430; i += 1, y += 26) ctx.fillRect(28, y, i % 3 === 2 ? 190 : 300, 9);
  ctx.fillStyle = PALETTE.body;
  ctx.font = `400 20px ${MONO}`;
  ctx.fillText(note, 28, 456);
  return texture(el);
}

/** A case file on the hub's board: case id, title, subject and an optional badge. Landscape. */
export function caseFileTexture(caseId: string, title: string, subject: string, badge: string | null): CanvasTexture {
  const [el, ctx] = canvas(640, 400);
  ctx.fillStyle = PALETTE.canvas;
  ctx.fillRect(0, 0, 640, 400);
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(0, 0, 640, 64);
  ctx.fillStyle = PALETTE.canvas;
  ctx.font = `400 24px ${MONO}`;
  ctx.fillText(caseId, 28, 42);
  if (badge !== null) {
    ctx.font = `500 22px ${SANS}`;
    const w = ctx.measureText(badge).width + 28;
    ctx.fillStyle = PALETTE.canvas;
    ctx.beginPath();
    ctx.roundRect(612 - w, 16, w, 32, 16);
    ctx.fill();
    ctx.fillStyle = PALETTE.ink;
    ctx.fillText(badge, 626 - w, 40);
  }
  ctx.fillStyle = PALETTE.ink;
  ctx.font = `600 38px ${SANS}`;
  wrap(ctx, title, 584, 3).forEach((line, i) => {
    ctx.fillText(line, 28, 124 + i * 46);
  });
  ctx.fillStyle = PALETTE.body;
  ctx.font = `400 26px ${SANS}`;
  ctx.fillText(subject, 28, 356);
  ctx.strokeStyle = PALETTE.hairlineStrong;
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, 636, 396);
  return texture(el);
}

/** A one-line sign: mono caption on white. */
export function signTexture(text: string): CanvasTexture {
  const [el, ctx] = canvas(512, 96);
  ctx.fillStyle = PALETTE.canvas;
  ctx.fillRect(0, 0, 512, 96);
  ctx.fillStyle = PALETTE.ink;
  ctx.font = `400 34px ${MONO}`;
  ctx.textAlign = "center";
  ctx.fillText(text.toUpperCase(), 256, 60);
  return texture(el);
}

/** The DESIGN.md mesh gradient: soft overlapping blobs of its stops on near-white, used once at hero scale. */
export function meshGradientTexture(): CanvasTexture {
  const [el, ctx] = canvas(1024, 512);
  ctx.fillStyle = PALETTE.canvasSoft;
  ctx.fillRect(0, 0, 1024, 512);
  const blobs: readonly [number, number, number, string][] = [
    [180, 300, 360, PALETTE.mesh[0]],
    [380, 160, 300, PALETTE.mesh[1]],
    [560, 340, 340, PALETTE.mesh[2]],
    [700, 180, 300, PALETTE.mesh[3]],
    [860, 330, 320, PALETTE.mesh[4]],
    [960, 140, 260, PALETTE.mesh[5]],
  ];
  ctx.globalAlpha = 0.55;
  for (const [x, y, r, color] of blobs) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(250,250,250,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1024, 512);
  }
  ctx.globalAlpha = 1;
  const fade = ctx.createLinearGradient(0, 0, 0, 512);
  fade.addColorStop(0, "rgba(250,250,250,0.15)");
  fade.addColorStop(1, "rgba(250,250,250,0.75)");
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, 1024, 512);
  return texture(el);
}
