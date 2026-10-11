/**
 * Hairline outlines (DESIGN.md: 1 px dividers): the edges of a box or a plane as line segments, placed as a child
 * of the mesh they outline so they share its transform.
 */
import { useEffect, useMemo } from "react";
import { BoxGeometry, EdgesGeometry, PlaneGeometry } from "three";

import { PALETTE } from "../../lib/world/palette";

interface HairlineProps {
  /** [width, height] for a plane, [width, height, depth] for a box. */
  readonly size: readonly [number, number] | readonly [number, number, number];
  readonly color?: string;
}

export function Hairline({ size, color = PALETTE.hairlineStrong }: HairlineProps) {
  const [w, h, d] = size;
  const geometry = useMemo(() => {
    const shape = d === undefined ? new PlaneGeometry(w, h) : new BoxGeometry(w, h, d);
    const edges = new EdgesGeometry(shape);
    shape.dispose();
    return edges;
  }, [w, h, d]);
  useEffect(
    () => () => {
      geometry.dispose();
    },
    [geometry],
  );
  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color={color} />
    </lineSegments>
  );
}
