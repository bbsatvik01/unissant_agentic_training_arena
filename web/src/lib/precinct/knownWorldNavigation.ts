/** Known bundled mesh assets only. No upload or recording can supply a file path. */
import officeMesh from "../../../public/world/precinct-office-navmesh.json";
import courtyardMesh from "../../../public/world/precinct-courtyard-navmesh.json";
import { effectivePrecinctColliders } from "./effectiveWorldGeometry";
import { precinctAsset } from "./worldVariant";
import { resolveWorldNavigation, type NavigationContext, type WorldNavigation } from "./worldNavigation";
import type { PrecinctManifest } from "../../components/precinct/sceneTypes";

/** Memoized by the immutable selected manifest and context; never performs geometry work per frame. */
const cache = new WeakMap<PrecinctManifest, Map<NavigationContext, PrecinctManifest>>();
export function navigatedPrecinctManifest(manifest: PrecinctManifest, context: NavigationContext = "live"): PrecinctManifest {
  const existing = cache.get(manifest)?.get(context);
  if (existing !== undefined) return existing;
  const colliders = effectivePrecinctColliders(manifest.colliders);
  const worldId = precinctAsset(manifest) === "/world/precinct-courtyard.glb" ? "courtyard" : "office";
  const value: unknown = worldId === "courtyard" ? courtyardMesh : officeMesh;
  const reason = context === "legacy-replay" ? "legacy-compatibility" : context === "sampled-replay" ? "replay-owned" : "missing";
  const missing: WorldNavigation = { player: null, staff: null, status: { context,
    player: { mode: "graph", reason }, staff: { mode: "graph", reason } } };
  const navigation = manifest.walkBounds === undefined ? missing
    : resolveWorldNavigation(value, worldId, { colliders, walkBounds: manifest.walkBounds }, context);
  const result: PrecinctManifest = { ...manifest, colliders, playerNavigationMesh: navigation.player,
    navigationMesh: navigation.staff, navigationStatus: navigation.status };
  const contexts = cache.get(manifest) ?? new Map<NavigationContext, PrecinctManifest>();
  contexts.set(context, result); cache.set(manifest, contexts);
  return result;
}
