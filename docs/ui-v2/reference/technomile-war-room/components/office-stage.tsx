"use client";

import dynamic from "next/dynamic";
import { useSyncExternalStore, type ComponentType } from "react";

import { Segmented } from "@/components/ui/segmented";

import { AgentOffice } from "./agent-office";
import { OFFICE_STYLES, type OfficeStyleProps } from "./office-styles";

/** The default office style: AgentOffice, rendered as it always was. */
export const CLASSIC_STYLE = "classic";
const STORAGE_KEY = "bh.officeStyle";

/* ------------------------------------------------------------------------------------------------ the stored choice */

const listeners = new Set<() => void>();
// used when storage is blocked (private mode, quota): the choice still holds for this tab
let memory = CLASSIC_STYLE;
// once a write fails, storage holds a stale choice: this tab follows its own copy from then on
let writeFailed = false;

function readStyle(): string {
  if (writeFailed) return memory;
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? memory;
  } catch {
    return memory;
  }
}

function writeStyle(id: string) {
  memory = id;
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
    writeFailed = false;
  } catch {
    // storage unavailable: the in-memory copy keeps this tab consistent
    writeFailed = true;
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The office style this browser chose: Classic until one is chosen, during the server render, and for an id no
 *  longer offered. */
export function useOfficeStyle(): [string, (id: string) => void] {
  const raw = useSyncExternalStore(subscribe, readStyle, () => CLASSIC_STYLE);
  const known = raw === CLASSIC_STYLE || OFFICE_STYLES.some((s) => s.id === raw);
  return [known ? raw : CLASSIC_STYLE, writeStyle];
}

/* ------------------------------------------------------------------------------------------------ the switcher */

export function OfficeStyleSwitch({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted" aria-hidden>
        Style
      </span>
      <Segmented
        label="Office style"
        value={value}
        onChange={onChange}
        itemClassName="h-7 px-2.5 text-xs"
        options={[{ value: CLASSIC_STYLE, label: "Classic" }, ...OFFICE_STYLES.map((s) => ({ value: s.id, label: s.label }))]}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ the stage */

function StyleLoading() {
  return <div className="hatch aspect-[1280/800] w-full rounded-lg border border-hairline" aria-busy="true" aria-label="Loading the office style" />;
}

// each style is its own client chunk, fetched the first time a viewer picks it; never rendered on the server
const LOADED: Readonly<Record<string, ComponentType<OfficeStyleProps>>> = Object.fromEntries(
  OFFICE_STYLES.map((s) => [s.id, dynamic(s.load, { ssr: false, loading: () => <StyleLoading /> })]),
);

/** The office in the chosen style: Classic (AgentOffice, unchanged) unless another style is picked. */
export function OfficeStage({ style, ...props }: OfficeStyleProps & { style: string }) {
  const Chosen = style === CLASSIC_STYLE ? undefined : LOADED[style];
  if (Chosen) return <Chosen {...props} />;
  return (
    <AgentOffice
      view={props.view}
      record={props.record}
      live={props.live}
      driven={props.driven}
      onReplayRun={props.onReplayRun}
      focus={props.focus}
      onFocus={props.onFocus}
      onReplay={props.onReplay}
      recordError={props.recordError}
    />
  );
}
