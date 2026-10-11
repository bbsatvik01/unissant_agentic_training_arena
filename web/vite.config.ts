import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

/**
 * One origin (S6 1.3, S5 10.1): the dev server binds to loopback and proxies `/api`, including the
 * voice WebSocket (`ws: true`), to the local `arena-api` process, so the browser never sees a
 * second origin and no CORS exists anywhere. Production serves `dist/` from `arena-api` itself.
 */
const ARENA_API_ORIGIN = proxyTarget(process.env["ARENA_PROXY_TARGET"]);

/**
 * The proxy target: arena-api on 8080 by default. `ARENA_PROXY_TARGET=http://127.0.0.1:8082` fronts the referee
 * instead, so the trainer and admin consoles (S6 4.12, 4.13) boot from the referee's own `/api/me` in local
 * development. Only a loopback http origin is accepted. The referee checks each POST's Origin against its own
 * allowlist (`ARENA_BROWSER_ORIGINS`, default its own port), so console submissions through this dev server need
 * that allowlist to name the dev server's origin; the spec's path is the referee serving the built bundle itself.
 */
export function proxyTarget(value: string | undefined): string {
  if (value === undefined || value === "") return "http://127.0.0.1:8080";
  if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(value)) throw new Error(`ARENA_PROXY_TARGET must be http://127.0.0.1:<port>, not ${value}`);
  return value;
}

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
