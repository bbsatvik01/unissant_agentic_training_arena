import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

/**
 * One origin (S6 1.3, S5 10.1): the dev server binds to loopback and proxies `/api`, including the
 * voice WebSocket (`ws: true`), to the local `arena-api` process, so the browser never sees a
 * second origin and no CORS exists anywhere. Production serves `dist/` from `arena-api` itself.
 */
const ARENA_API_ORIGIN = "http://127.0.0.1:8080";

/**
 * The `/api` proxy to `target`. `changeOrigin` rewrites Host to the target's, because `arena-api`
 * answers any Host other than its own loopback port with 421 (S5 10.3, DNS rebinding guard); the
 * browser's Origin header passes through unchanged for the server's Origin check. Tested against a
 * real upstream in `tools/vite-proxy.test.ts`.
 */
export function arenaApiProxy(target: string): Record<string, ProxyOptions> {
  return {
    "/api": { target, ws: true, changeOrigin: true },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    proxy: arenaApiProxy(ARENA_API_ORIGIN),
  },
});
