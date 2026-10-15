"use client";

import { useCallback, useSyncExternalStore } from "react";

import type { SwarmFrame } from "@/lib/war-room/swarm-time";

/**
 * The graph's frame store: the rAF loop publishes one frame per animation frame; a component reads a primitive slice
 * of it (`useFrame`), so React re-renders it only when that slice changes (presence, status, counts), never per frame.
 * Continuous values (ring progress, comets, heat) are written to registered elements by the loop itself.
 */
export class FrameStore {
  frame: SwarmFrame | null = null;
  /** Recorded time of the frame (the local replay's clock, or the feed's latest message). */
  recorded = NaN;
  private listeners = new Set<() => void>();
  readonly elements = new Map<string, Element>();

  publish(frame: SwarmFrame, recorded: number): void {
    this.frame = frame;
    this.recorded = recorded;
    for (const l of this.listeners) l();
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  /** A ref callback that keeps `key -> element` for the loop's imperative writes. */
  register(key: string): (el: Element | null) => void {
    return (el) => {
      if (el) this.elements.set(key, el);
      else this.elements.delete(key);
    };
  }
}

type Slice = string | number | boolean | null;

/** A primitive slice of the current frame; the component re-renders only when it changes. */
export function useFrame<T extends Slice>(store: FrameStore, select: (f: SwarmFrame | null) => T): T {
  const get = useCallback(() => select(store.frame), [store, select]);
  return useSyncExternalStore(store.subscribe, get, get);
}
