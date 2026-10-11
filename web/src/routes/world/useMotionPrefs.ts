/**
 * Motion preferences (S6 6.6): the OS reduced-motion setting, and the header's pause control, remembered per viewer
 * in localStorage inside try/catch (default off).
 */
import { useCallback, useEffect, useState } from "react";

const KEY = "arena.pauseMotion";

function readPaused(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function query(): MediaQueryList | null {
  return typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
}

export function useMotionPrefs(): { reducedMotion: boolean; paused: boolean; togglePaused: () => void } {
  const [reducedMotion, setReduced] = useState(() => query()?.matches ?? false);
  const [paused, setPaused] = useState(readPaused);
  useEffect(() => {
    const mq = query();
    if (mq === null) return;
    const onChange = () => {
      setReduced(mq.matches);
    };
    mq.addEventListener("change", onChange);
    return () => {
      mq.removeEventListener("change", onChange);
    };
  }, []);
  const togglePaused = useCallback(() => {
    setPaused((p) => {
      try {
        window.localStorage.setItem(KEY, p ? "0" : "1");
      } catch {
        // Storage unavailable (private window, blocked site data): the control still works for this page.
      }
      return !p;
    });
  }, []);
  return { reducedMotion, paused, togglePaused };
}
