/** Fixed bundled geometry choices. Imported file content cannot introduce a URL or executable adapter. */
import officeRaw from "../../../public/world/precinct-manifest.json";
import courtyardRaw from "../../../public/world/precinct-courtyard-manifest.json";
import type { PrecinctManifest } from "../../components/precinct/sceneTypes";
import type { PrecinctWorldId } from "./sceneSelection";
import type { Vec3 } from "./types";
import type { WorldVariantMetadata } from "./worldVariant";

const xyz = (value: readonly number[]): Vec3 => [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0];
type AuthoredWorld = typeof officeRaw | typeof courtyardRaw;

export interface KnownPrecinctWorld {
  readonly id: PrecinctWorldId;
  readonly sceneId: "precinct-office-v1" | "northstar-courtyard-v1";
  readonly label: "Office" | "Courtyard";
  readonly manifest: PrecinctManifest;
  readonly authored: AuthoredWorld;
}

function manifest(value: AuthoredWorld, metadata: WorldVariantMetadata): PrecinctManifest {
  return { ...metadata,
    colliders: value.colliders.map((item) => ({ ...item, min: xyz(item.min), max: xyz(item.max) })),
    hotspots: value.hotspots.map((item) => ({ ...item, position: xyz(item.position) })),
    navigationNodes: value.navigationNodes.map((item) => ({ ...item, position: xyz(item.position) })),
  };
}

export const PRECINCT_WORLDS: Readonly<Record<PrecinctWorldId, KnownPrecinctWorld>> = {
  office: { id: "office", sceneId: "precinct-office-v1", label: "Office", authored: officeRaw,
    manifest: manifest(officeRaw, { asset: "precinct.glb", walkBounds: { min: xyz(officeRaw.walkBounds.min), max: xyz(officeRaw.walkBounds.max) } }) },
  courtyard: { id: "courtyard", sceneId: "northstar-courtyard-v1", label: "Courtyard", authored: courtyardRaw,
    manifest: manifest(courtyardRaw, { asset: "precinct-courtyard.glb",
      walkBounds: { min: xyz(courtyardRaw.walkBounds.min), max: xyz(courtyardRaw.walkBounds.max) },
      worldVariant: { id: courtyardRaw.worldVariant.id, footprintBounds: {
        min: xyz(courtyardRaw.worldVariant.footprintBounds.min), max: xyz(courtyardRaw.worldVariant.footprintBounds.max),
      } },
    }) },
};

/** Missing legacy scene identity always means Office, regardless of the exploration preference. */
export function actualPrecinctWorld(preference: PrecinctWorldId, replaying: boolean, recorded: PrecinctWorldId | undefined): PrecinctWorldId {
  return replaying ? recorded ?? "office" : preference;
}
