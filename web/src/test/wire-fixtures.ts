/**
 * Test helper: the shared wire fixtures (`contracts/fixtures/wire.json`, S6 12), read through Vite. The Python
 * contract tests run the same file. Returns a deep copy, so a test may change what it gets.
 */

interface WireCase {
  readonly id: string;
  readonly value: unknown;
}

const files = import.meta.glob<unknown>("../../../contracts/fixtures/wire.json", { eager: true, import: "default" });

export function fixture(id: string): unknown {
  const parsed = Object.values(files)[0] as { valid: readonly WireCase[] } | undefined;
  const found = parsed?.valid.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no valid wire fixture ${id}`);
  return structuredClone(found.value);
}
