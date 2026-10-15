import type { PrecinctFrameMeasurements } from "../../lib/precinct/renderMeasurements";
import type { PRECINCT_RENDER_BUDGET } from "../../lib/precinct/renderQuality";
import type { Tier } from "../../lib/world/quality";
import type { inspectPrecinctRenderer, inspectPrecinctScene } from "./inspectPrecinctRenderer";

export type PrecinctPerformanceReport = ReturnType<PrecinctFrameMeasurements["report"]> & {
  readonly schema: "arena.precinct-render-performance.v1";
  readonly production: boolean;
  readonly sceneAsset: string;
  readonly renderer: ReturnType<typeof inspectPrecinctRenderer>;
  readonly scene: ReturnType<typeof inspectPrecinctScene>;
  readonly budgets: typeof PRECINCT_RENDER_BUDGET;
  readonly observers: { readonly longtask: boolean; readonly event: boolean };
  readonly measurementNotes: readonly string[];
};
export interface PrecinctPerformanceApi {
  start(): void;
  stop(): PrecinctPerformanceReport;
  snapshot(): PrecinctPerformanceReport;
  status(): { readonly active: boolean; readonly tier: Tier; readonly continuous: boolean; readonly visible: boolean;
    readonly cameraPosition: readonly number[]; readonly cameraQuaternion: readonly number[]; readonly calls: number; readonly triangles: number;
    readonly drawingBuffer: { readonly width: number; readonly height: number }; readonly dpr: number; readonly sceneAsset: string; readonly production: boolean };
}
declare global { interface Window { __arenaPrecinctPerformance?: PrecinctPerformanceApi } }
