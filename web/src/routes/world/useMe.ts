/**
 * Who is in the room (S6 2.1, 3.2, 4.1): `GET /api/me` read once the server is reachable and again on demand (after
 * a session ends, the study step may have moved), plus the EX-4 acknowledgement. Offline (no server) it stays null.
 */
import { useCallback, useEffect, useState } from "react";

import type { ArenaApi } from "../../lib/api/arena";
import type { Me } from "../../lib/api/client";

export interface MeControls {
  readonly me: Me | null;
  /** True when /api/me could not be read. */
  readonly failed: boolean;
  readonly refresh: () => void;
  /** Store the acknowledgement; resolves true once stored and reflected in `me`. */
  readonly acknowledge: () => Promise<boolean>;
}

export function useMe(api: Pick<ArenaApi, "me" | "ackEx4">, enabled: boolean): MeControls {
  const [me, setMe] = useState<Me | null>(null);
  const [failed, setFailed] = useState(false);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api.me().then(
      (m) => {
        if (cancelled) return;
        setMe(m);
        setFailed(false);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, enabled, round]);
  const refresh = useCallback(() => {
    setRound((r) => r + 1);
  }, []);
  const acknowledge = useCallback(async () => {
    try {
      const at = await api.ackEx4();
      setMe((m) => (m === null ? m : { ...m, ex4_acknowledged: at }));
      return true;
    } catch {
      // Shown by the onboarding panel as "could not be saved".
      return false;
    }
  }, [api]);
  return { me, failed, refresh, acknowledge };
}
