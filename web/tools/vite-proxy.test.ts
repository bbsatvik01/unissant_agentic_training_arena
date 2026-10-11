/**
 * The dev proxy against a real upstream (S5 10.3): `arena-api` accepts only `Host:
 * 127.0.0.1:<its port>` and answers anything else with 421 (DNS rebinding guard), so the proxy must
 * rewrite Host to the target for HTTP, SSE and the voice WebSocket upgrade, while the browser's
 * Origin passes through unchanged for the server's Origin check.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createServer as createViteServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";

import viteConfig, { arenaApiProxy, proxyTarget } from "../vite.config.ts";

const BROWSER_ORIGIN = "http://127.0.0.1:5173";

interface Seen {
  readonly host: string | undefined;
  readonly origin: string | undefined;
}

const seenOf = (req: IncomingMessage): Seen => ({ host: req.headers.host, origin: req.headers.origin });

const portOf = (server: { address(): AddressInfo | string | null }): number => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server is not listening on TCP");
  return address.port;
};

let upstream: Server | null = null;
let vite: ViteDevServer | null = null;

afterEach(async () => {
  await vite?.close();
  vite = null;
  const server = upstream;
  upstream = null;
  if (server !== null) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  }
});

/** A loopback upstream that reports the Host and Origin it received, then a dev server proxying to it. */
async function start(onUpgrade: (seen: Seen) => void): Promise<{ upstreamPort: number; devPort: number }> {
  const server = createHttpServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(seenOf(req)));
  });
  server.on("upgrade", (req: IncomingMessage, socket) => {
    onUpgrade(seenOf(req));
    socket.destroy();
  });
  upstream = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const upstreamPort = portOf(server);
  const dev = await createViteServer({
    configFile: false,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, strictPort: false, proxy: arenaApiProxy(`http://127.0.0.1:${String(upstreamPort)}`) },
  });
  vite = dev;
  await dev.listen();
  const httpServer = dev.httpServer;
  if (httpServer === null) throw new Error("dev server has no HTTP server");
  return { upstreamPort, devPort: portOf(httpServer) };
}

describe("arenaApiProxy: the dev proxy satisfies arena-api's Host guard", () => {
  it("forwards /api requests with the target's Host and the browser's Origin", async () => {
    const { upstreamPort, devPort } = await start(() => undefined);
    const response = await fetch(`http://127.0.0.1:${String(devPort)}/api/me`, { headers: { origin: BROWSER_ORIGIN } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ host: `127.0.0.1:${String(upstreamPort)}`, origin: BROWSER_ORIGIN });
  });

  it("forwards the voice WebSocket upgrade with the target's Host", async () => {
    let resolveSeen: (seen: Seen) => void = () => undefined;
    const upgraded = new Promise<Seen>((resolve) => {
      resolveSeen = resolve;
    });
    const { upstreamPort, devPort } = await start((seen) => {
      resolveSeen(seen);
    });
    const socket = new WebSocket(`ws://127.0.0.1:${String(devPort)}/api/voice/ws`);
    socket.addEventListener("error", () => undefined);
    const seen = await upgraded;
    socket.close();
    expect(seen.host).toBe(`127.0.0.1:${String(upstreamPort)}`);
  });

  it("proxies only /api, and the dev server sends it to arena-api's loopback port 8080", () => {
    expect(Object.keys(arenaApiProxy("http://127.0.0.1:8080"))).toEqual(["/api"]);
    expect(viteConfig.server?.host).toBe("127.0.0.1");
    expect(viteConfig.server?.proxy).toEqual(arenaApiProxy("http://127.0.0.1:8080"));
  });
});

describe("proxy target", () => {
  it("defaults to arena-api and accepts only a loopback http origin", () => {
    expect(proxyTarget(undefined)).toBe("http://127.0.0.1:8080");
    expect(proxyTarget("")).toBe("http://127.0.0.1:8080");
    expect(proxyTarget("http://127.0.0.1:8082")).toBe("http://127.0.0.1:8082");
    for (const bad of ["http://localhost:8082", "https://127.0.0.1:8082", "http://10.0.0.1:8082", "http://127.0.0.1:8082/x"]) expect(() => proxyTarget(bad)).toThrow();
  });
});
