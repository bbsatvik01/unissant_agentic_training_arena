/** Same validated API/CSRF path, with an explicit local-only gate for the offline-first precinct. */
import { isLoopbackOrigin } from "../precinct/session";
import { createArenaApi } from "./arena";
import { createApiClient, type FetchLike } from "./client";

export interface LocalApiGate {
  readonly enabled: () => boolean;
  readonly origin: () => { readonly protocol: string; readonly hostname: string };
  /** Test seam only. Production always uses the common client's same-origin requests. */
  readonly transport?: FetchLike;
}

export function createPrecinctLocalApi(gate: LocalApiGate) {
  return createArenaApi(createApiClient({ fetch: (input, init) => {
    if (!gate.enabled() || !isLoopbackOrigin(gate.origin())) return Promise.reject(new Error("Explicit local backend connection required."));
    return gate.transport === undefined ? fetch(input, init) : gate.transport(input, init);
  } }));
}

/** Mutable transport permission lives outside React render data; only explicit event handlers change it. */
export function createPrecinctLocalConnection(gate: Omit<LocalApiGate, "enabled">) {
  let enabled = false;
  const api = createPrecinctLocalApi({ ...gate, enabled: () => enabled });
  return { api, isEnabled: () => enabled, enable: () => { enabled = true; }, disable: () => { enabled = false; } };
}
