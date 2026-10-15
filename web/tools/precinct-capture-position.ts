/** SVG serializes very small finite coordinates in exponent notation; retain that real position. */
export function parseMinimapPosition(transform: string | null): { x: number; z: number } {
  const number = "([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?)";
  const match = new RegExp(`^translate\\(${number} ${number}\\) rotate\\(${number}\\)$`, "u").exec(transform ?? "");
  const x = Number(match?.[1]), z = Number(match?.[2]), yaw = Number(match?.[3]);
  if (match === null || !Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(yaw)) throw new Error(`Missing or malformed actual minimap transform: ${(transform ?? "null").slice(0, 160)}`);
  return { x, z };
}
