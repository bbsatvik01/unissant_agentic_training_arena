import { useEffect, useSyncExternalStore } from "react";
import type { WorldCapture } from "../../lib/world/worldCapture";

/** The parent owns this stable controller and context; a timer alone never enables capture or writes. */
export function useWorldCapture(controller: WorldCapture) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    const timer = window.setInterval(() => { void controller.tick(); }, 100);
    return () => { window.clearInterval(timer); controller.stop(); controller.disableSender(); };
  }, [controller]);
  return { controller, snapshot };
}
