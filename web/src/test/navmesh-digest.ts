/** Browser-compatible real SHA-256 for authored test fixtures; no Node globals in app sources. */
export async function navmeshDigest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
