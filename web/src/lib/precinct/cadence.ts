/** A 10 Hz cadence that is independent of an engine's resettable elapsed-time clock. */
export function advanceCadence(elapsed: number, delta: number): { elapsed: number; due: boolean } {
  const previous = Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
  const step = Number.isFinite(delta) && delta > 0 ? delta : 0;
  const next = previous + step;
  // Tolerate floating-point accumulation (for example ten 0.01-second frames).
  const due = next >= 0.1 - Number.EPSILON;
  // Drop excess time deliberately: long or resumed frames must never trigger a burst.
  return { elapsed: due ? 0 : next, due };
}
