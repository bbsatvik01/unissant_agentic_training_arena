/** Dependency-free benchmark theme contract, shared only by tooling and tests. */
export type BenchmarkTheme = "office" | "studio";
/** Strict CLI parser; the explicit return type preserves the union in benchmarkOptions. */
export function benchmarkThemeOption(value?: string): BenchmarkTheme {
  const theme = value ?? "office";
  if (theme !== "office" && theme !== "studio") throw new Error("Invalid --theme; use office or studio.");
  return theme;
}

type ThemeControlPage = {
  getByRole(role: "radio", options: { readonly name: string; readonly exact: true }): { check(): Promise<void> };
};
/** Use the existing settings control; no query override, storage write or DOM mutation. */
export async function selectBenchmarkTheme(page: ThemeControlPage, theme: BenchmarkTheme): Promise<void> {
  await page.getByRole("radio", { name: theme === "studio" ? "Studio" : "Office (original)", exact: true }).check();
}
/** A requested label alone is not evidence of the rendered theme. */
export function verifyBenchmarkTheme(observed: string | null, requested: BenchmarkTheme): BenchmarkTheme {
  if (observed !== requested) throw new Error(`Requested theme ${requested} was not applied; observed ${observed ?? "missing"}.`);
  return observed;
}
