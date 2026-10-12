/**
 * Commitment verification in the browser (S6 4.11, FE-TRUST-1; S4 7.2): a trial's commitment is
 * `sha256(nonce || convert_to(payload::text, 'UTF8'))`, with the 32-byte nonce published at reveal and the payload's
 * jsonb text form shown after reveal. The browser recomputes it with WebCrypto and compares it with the published
 * commitment; nothing is sent anywhere.
 */

export type Verdict = "match" | "mismatch" | "invalid";

const HEX64 = /^[0-9a-f]{64}$/;

/** A hex string as bytes, or null when it is not even-length hex. */
export function hexBytes(hex: string): Uint8Array | null {
  const h = hex.trim().toLowerCase().replace(/^\\x/, "");
  if (h.length % 2 !== 0 || !/^[0-9a-f]*$/.test(h)) return null;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function hexOf(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `sha256(nonce || payload)` in hex, or null when the nonce is not 32 bytes of hex. */
export async function commitmentOf(nonceHex: string, payloadText: string): Promise<string | null> {
  const nonce = hexBytes(nonceHex);
  if (nonce?.length !== 32) return null;
  const payload = new TextEncoder().encode(payloadText);
  const joined = new Uint8Array(nonce.length + payload.length);
  joined.set(nonce, 0);
  joined.set(payload, nonce.length);
  return hexOf(await crypto.subtle.digest("SHA-256", joined));
}

/** Whether the published commitment is what the nonce and payload hash to. */
export async function verifyCommitment(nonceHex: string, payloadText: string, commitmentHex: string): Promise<Verdict> {
  const expected = commitmentHex.trim().toLowerCase();
  if (!HEX64.test(expected)) return "invalid";
  const actual = await commitmentOf(nonceHex, payloadText);
  if (actual === null) return "invalid";
  return actual === expected ? "match" : "mismatch";
}
