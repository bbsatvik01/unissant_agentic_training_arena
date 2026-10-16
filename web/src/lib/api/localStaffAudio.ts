/** Same-origin, finite authored WAV assets only; no TTS/API/provider or microphone transport. */
export async function readLocalStaffAudio(clip: { readonly url: string; readonly bytes: number; readonly sha256: string }, signal: AbortSignal): Promise<ArrayBuffer> {
  if (!/^\/audio\/staff-v1\/[a-z-]+\.wav$/u.test(clip.url) || !Number.isSafeInteger(clip.bytes) || clip.bytes <= 44 || clip.bytes >= 5 * 1024 * 1024 || !/^[a-f0-9]{64}$/u.test(clip.sha256)) throw new Error("Invalid local voice asset.");
  const response = await fetch(clip.url, { signal, credentials: "omit", mode: "same-origin", redirect: "error" });
  if (!response.ok || response.body === null) throw new Error("Local voice asset unavailable.");
  const reader = response.body.getReader();
  const bytes = new Uint8Array(clip.bytes);
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (length + chunk.value.byteLength > bytes.byteLength) throw new Error("Unexpected local voice asset size.");
      bytes.set(chunk.value, length); length += chunk.value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (length !== bytes.byteLength || signal.aborted) throw new Error("Incomplete local voice asset.");
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
  signal.throwIfAborted();
  if (hash !== clip.sha256) throw new Error("Local voice asset integrity check failed.");
  return bytes.buffer;
}
