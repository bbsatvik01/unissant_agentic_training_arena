import { EX4_TEXT } from "../lib/copy/ex4";

/**
 * Unstyled placeholder for the scaffold. The slice UI (WP-19) replaces it; nothing presentational
 * starts before the 2026-10-18 slice gate and DESIGN.md (S6 preamble, 11).
 */
export function Placeholder() {
  return (
    <main>
      <h1>Investigative AI Training Arena</h1>
      <p>{EX4_TEXT}</p>
    </main>
  );
}
