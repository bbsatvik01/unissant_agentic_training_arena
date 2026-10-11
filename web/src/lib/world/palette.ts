/**
 * The world's colours, from DESIGN.md (D-018): ink on near-white, a grey ladder for surfaces and hairlines, and the
 * mesh gradient's stops as the only decoration. Materials take these values and nothing else; there is no glow,
 * no purple-to-blue signature and no colour that codes a figure's state (PRB-4: no stress-coded colour).
 */
export const PALETTE = {
  ink: "#171717",
  body: "#4d4d4d",
  mute: "#888888",
  hairline: "#ebebeb",
  hairlineStrong: "#a1a1a1",
  canvas: "#ffffff",
  canvasSoft: "#fafafa",
  canvasSoft2: "#f5f5f5",
  floor: "#e9e9e9",
  observation: "#d9d9d9",
  glass: "#cfd8e3",
  link: "#0070f3",
  skin: ["#e7c3a5", "#c99a78", "#8d5f43", "#f0d2b8"],
  cloth: ["#4d4d4d", "#2b3a4a", "#5b5148", "#3f4a3d"],
  /** The mesh gradient stops (develop, preview, ship pairs), in DESIGN.md order. */
  mesh: ["#007cf0", "#00dfd8", "#7928ca", "#ff0080", "#ff4d4d", "#f9cb28"],
} as const;
