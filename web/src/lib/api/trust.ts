/**
 * The trust center's reads (S5 5.5, S6 4.11): `GET /api/trust/{section}` for the server-backed sections and
 * `GET /api/config` for the local Phoenix address. Bodies are read by `lib/trust/*`.
 */
import type { ApiClient } from "./client";

export type TrustSection = "isolation" | "commitments" | "fairness" | "methodology" | "budget";

export interface TrustApi {
  readonly section: (section: TrustSection) => Promise<unknown>;
  readonly config: () => Promise<unknown>;
}

export function createTrustApi(client: ApiClient): TrustApi {
  return {
    section: (section) => client.get(`/api/trust/${section}`),
    config: () => client.get("/api/config"),
  };
}
