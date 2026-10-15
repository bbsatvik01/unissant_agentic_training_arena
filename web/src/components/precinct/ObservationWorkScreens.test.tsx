// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { deriveAgentWork, WORK_STYLES } from "../../lib/agent-work/model";
import { observationWork } from "../../lib/precinct/observationScreens";
import { AgentWorkSvg } from "../agent-work/AgentWorkMonitor";
import { observationAtlas } from "./ObservationWorkScreens";

const frame = deriveAgentWork({ view: null, arrivals: new Map(), nowMs: 1250, paused: true, reducedMotion: false });
describe("self-contained shared SVG screens", () => {
  it("embeds all four actual compositions, unique IDs and its own presentation CSS in one atlas", () => {
    const { svg } = observationAtlas(frame, 1024, 576);
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.documentElement.getAttribute("width")).toBe("1024");
    for (const style of WORK_STYLES) expect(doc.querySelector(`[data-scene="${style}"]`)).not.toBeNull();
    expect(doc.querySelectorAll("svg")).toHaveLength(5);
    expect(doc.querySelector("style")?.textContent).toContain("font-family");
    const ids = [...doc.querySelectorAll("[id]")].map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(doc.querySelectorAll("script, foreignObject, image, animate, animateTransform, iframe, a, [href]")).toHaveLength(0);
    expect(observationAtlas(frame, 1024, 576).svg).toBe(svg);
  });
  it.each(WORK_STYLES)("preserves %s's accessible title and description for the expanded DOM", (style) => {
    const doc = new DOMParser().parseFromString(renderToStaticMarkup(<AgentWorkSvg frame={frame} style={style} id="test-view" />), "image/svg+xml");
    const names = doc.documentElement.getAttribute("aria-labelledby")?.split(" ") ?? [];
    expect(names).toHaveLength(2);
    for (const name of names) expect(doc.getElementById(name)?.textContent).toBeTruthy();
    expect(doc.querySelector("desc")?.textContent).toContain("does not indicate truth or deception");
  });
  it("escapes labels instead of interpreting them as linked image/script markup", () => {
    const text = '<image href="https://untrusted.invalid/secret"/><script>alert(1)</script>';
    const unsafeText = { ...frame, caption: text, documents: [{ id: "r1", title: text, turn: 1 }] };
    const doc = new DOMParser().parseFromString(observationAtlas(unsafeText, 512, 288).svg, "image/svg+xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.querySelectorAll("script, image, [href]")).toHaveLength(0);
    expect(doc.querySelector("desc")?.textContent).toContain(text);
  });
  it("shows assessment withholding on the physical frame without stale coaching labels", () => {
    const protectedFrame = observationWork({ ...frame, cards: 4, items: [{ id: "card:1", label: "STALE COACHING", kind: "card", atMs: 0, turn: 1 }] }, true);
    const svg = observationAtlas(protectedFrame, 512, 288).svg;
    expect(svg).toContain("COACHING WITHHELD");
    expect(svg).not.toContain("STALE COACHING");
    expect(svg).not.toContain("4 coaching cards");
  });
});
