"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useSyncExternalStore, type CSSProperties } from "react";

import { PipelineView } from "@/components/pipeline/pipeline-view";
import { usePreferences } from "@/components/shell/preferences";
import { Kbd } from "@/components/ui/pill";
import { Segmented } from "@/components/ui/segmented";
import type { CaptureForm } from "@/lib/live/capture";
import { isControlTarget, isTypingTarget, keyAction, type KeyAction } from "@/lib/pipeline/keys";
import { parseRunView, RUN_VIEWS, type RunView } from "@/lib/pipeline/steps";

import { ReplayDock, ReplayEntry } from "./replay-dock";
import { RunFeedProvider, useRunFeed } from "./run-feed";
import { SwarmPanel } from "./swarm-panel";
import { SeedError, WarRoom, WorkingNow, type WarRoomSource } from "./war-room";

const noop = () => () => undefined;

/** True once the page runs in the browser (stored preferences are readable), false during the server render. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}

/**
 * A live run's three views on one route and one feed: War Room (the dense dashboard), Pipeline (steps on a rail,
 * the chosen step's work on a canvas) and Office (the agent office as the whole canvas). `?view=` opens a view
 * from a link; otherwise the view this browser chose last. Switching keeps every connection open.
 */
export function RunViews({ runId, source, capture }: { runId: string; source: Extract<WarRoomSource, { kind: "live" }>; capture: CaptureForm }) {
  return (
    <RunFeedProvider runId={runId}>
      <Views runId={runId} source={source} capture={capture} />
    </RunFeedProvider>
  );
}

/** Room the docked replay transport takes at the bottom of the viewport (a sticky rail keeps clear of it). */
const DOCK_SPACE: CSSProperties = { ["--replay-dock" as string]: "9.75rem" };

function Views({ runId, source, capture }: { runId: string; source: Extract<WarRoomSource, { kind: "live" }>; capture: CaptureForm }) {
  const feed = useRunFeed();
  const prefs = usePreferences();
  const params = useSearchParams();
  const hydrated = useHydrated();
  const linked = parseRunView(params.get("view"));
  const view: RunView | null = linked ?? (hydrated ? (prefs.runView ?? "war-room") : null);
  const pipelineKeys = useRef<((a: KeyAction) => void) | null>(null);

  const choose = useCallback(
    (v: RunView) => {
      prefs.setRunView(v);
      const url = new URL(window.location.href);
      url.searchParams.set("view", v);
      if (v !== "pipeline") url.searchParams.delete("step");
      window.history.replaceState(null, "", url);
    },
    [prefs],
  );

  const lastG = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      const action = keyAction({
        key: e.key,
        meta: e.metaKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        typing: isTypingTarget(t?.tagName, t?.isContentEditable ?? false),
        onControl: isControlTarget(t?.tagName, t?.getAttribute("role")),
        shortcuts: prefs.shortcuts,
        pipeline: view === "pipeline",
        pendingG: Date.now() - lastG.current < 900,
      });
      if (e.key === "g" && !e.metaKey && !e.ctrlKey) lastG.current = Date.now();
      if (!action) return;
      if (action.type === "view") choose(action.view);
      else if (pipelineKeys.current) pipelineKeys.current(action);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prefs.shortcuts, view, choose]);

  return (
    <div style={feed?.replayOffer.active ? DOCK_SPACE : undefined} data-replay={feed?.replay ? "" : undefined}>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        {view ? (
          <Segmented
            label="Run view"
            value={view}
            onChange={choose}
            itemClassName="h-8 px-3.5"
            options={RUN_VIEWS.map((v, i) => ({
              value: v.value,
              name: v.label,
              label: (
                <>
                  {v.label}
                  {prefs.shortcuts && <span className="hidden font-mono text-micro opacity-60 lg:inline">{i + 1}</span>}
                </>
              ),
            }))}
          />
        ) : (
          <div className="h-9 w-72 animate-pulse-soft rounded-md border border-hairline" aria-hidden />
        )}
        <div className="flex flex-wrap items-center gap-3">
          {view === "pipeline" && prefs.shortcuts && (
            <p className="hidden items-center gap-1.5 text-xs text-muted lg:flex">
              <Kbd>j</Kbd>
              <Kbd>k</Kbd> steps <Kbd>[</Kbd>
              <Kbd>]</Kbd> phases <Kbd>L</Kbd> {feed?.replay ? "replayed step" : "live"}
            </p>
          )}
          {feed && <ReplayEntry feed={feed} />}
        </div>
      </div>
      <RunFeedErrors />
      {view === "war-room" && <WarRoom runId={runId} source={source} swarm={<SwarmPanel runId={runId} />} />}
      {view === "pipeline" && <PipelineView runId={runId} capture={capture} keysRef={pipelineKeys} />}
      {view === "office" && <OfficeView runId={runId} />}
      {view === null && <div className="hatch h-[60vh] rounded-lg" aria-busy="true" aria-label="Opening the run" />}
      {feed && <ReplayDock feed={feed} />}
    </div>
  );
}

/** The shared feed's read failures, shown above whichever view is open (each view reads the same feed). */
function RunFeedErrors() {
  const feed = useRunFeed();
  if (!feed?.stream.seedError) return null;
  return (
    <div className="mb-4">
      <SeedError transport={feed.stream} />
    </div>
  );
}

/** The agent office as the whole canvas, with the stage working now above it; its Graph toggle stays. */
function OfficeView({ runId }: { runId: string }) {
  const feed = useRunFeed();
  return (
    <div className="space-y-4">
      {feed && <WorkingNow store={feed.stream.store} at={feed.replay?.state.r} />}
      <SwarmPanel
        runId={runId}
        title="Agent office"
        lede="Every agent of this run at its desk: S4 researchers at the web terminal, S7 verdicts stamped at the verification desk, S9 capture teams and the red team, S10 evaluators in the board room."
      />
    </div>
  );
}
