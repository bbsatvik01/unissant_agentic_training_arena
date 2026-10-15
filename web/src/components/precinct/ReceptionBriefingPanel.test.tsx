// @vitest-environment jsdom
import { StrictMode, useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReceptionBriefingPanel } from "./ReceptionBriefingPanel";
import type { ReceptionBriefingPanelProps } from "./ReceptionBriefingPanel";
import { usePrecinctNpcController } from "../../hooks/usePrecinctNpcController";
import { EX4_TEXT } from "../../lib/copy/ex4";
import { NPC_TECHNIQUE_REDIRECT } from "../../lib/precinct/npcLocalAdapter";
import { NPC_MEMORY_KEY } from "../../lib/precinct/npcVisitMemory";
import type { NpcMemoryStorage } from "../../lib/precinct/npcVisitMemory";
import type { CaseCard } from "../../lib/world/cases";
import panelSource from "./ReceptionBriefingPanel.tsx?raw";
import hookSource from "../../hooks/usePrecinctNpcController.ts?raw";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const assignment: CaseCard = { case_id: "PUBLIC-TEST", title: "Public practice assignment", objective: "PUBLIC_OBJECTIVE_SENTINEL: establish the documented sequence.", domain: "Training", difficulty_level: 1, subject: { display_name: "Public subject", position: "Staff member" }, facility: "Public facility", initial_documents: 2, requestable_records: 3 };
type Station = ReceptionBriefingPanelProps["station"];

function setup(station: Station = "reception", storage: NpcMemoryStorage | null = null) {
  const onCheckIn = vi.fn();
  const onBriefed = vi.fn();
  const onTravel = vi.fn();
  function Harness() {
    const controller = usePrecinctNpcController(() => storage);
    const [open, setOpen] = useState(true);
    return <><button onClick={() => { setOpen(!open); }}>{open ? "Close panel" : "Reopen panel"}</button>{open ? <div role="dialog" aria-label="Test station"><ReceptionBriefingPanel station={station} assignment={assignment} onCheckIn={onCheckIn} onBriefed={onBriefed} onTravel={onTravel} controller={controller} /></div> : null}</>;
  }
  render(<StrictMode><Harness /></StrictMode>);
  return { onCheckIn, onBriefed, onTravel };
}

function openMemory() {
  fireEvent.click(screen.getByText("Preferred name and local staff memory"));
}

describe("ReceptionBriefingPanel", () => {
  it("keeps public briefing separate, repeats exact EX4 text and acknowledges only on an explicit click", () => {
    const { onBriefed, onCheckIn } = setup("briefing");
    expect(screen.getByText(assignment.objective)).toBeTruthy();
    expect(screen.getByText(EX4_TEXT).textContent).toBe(EX4_TEXT);
    expect(screen.getByText("Nervousness, demeanor, accent and stress are never evidence.")).toBeTruthy();
    expect(onBriefed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge the briefing and ground rule" }));
    expect(onBriefed).toHaveBeenCalledOnce();
    const acknowledged = screen.getByRole("button", { name: "Briefing acknowledged" });
    expect(acknowledged.hasAttribute("disabled")).toBe(true);
    fireEvent.click(acknowledged);
    expect(onBriefed).toHaveBeenCalledOnce();
    expect(onCheckIn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Talk to training sergeant" }));
    const subtitle = document.querySelector(".npc-subtitle");
    expect(subtitle?.textContent).not.toContain("PUBLIC_OBJECTIVE_SENTINEL");
  });

  it("requires explicit reception check-in and travels only through requested hotspot actions", () => {
    const { onCheckIn, onTravel } = setup();
    expect(onCheckIn).not.toHaveBeenCalled();
    expect(onTravel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Check in for this shift" }));
    fireEvent.click(screen.getByRole("button", { name: "Checked in" }));
    expect(onCheckIn).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Go to the case board" }));
    expect(onTravel).toHaveBeenLastCalledWith("case_board");
    fireEvent.click(screen.getByRole("button", { name: "Go to briefing" }));
    expect(onTravel).toHaveBeenLastCalledWith("briefing");
  });

  it("does not double-count Strict Mode mounts and preserves route familiarity across closing panels", () => {
    setup();
    expect(document.querySelector(".npc-subtitle")).toBeNull();
    const liveRegion = document.querySelector(".npc-subtitle-empty");
    const talk = screen.getByRole("button", { name: "Talk to reception officer" });
    talk.focus();
    fireEvent.click(talk);
    expect(document.activeElement).toBe(talk);
    expect(document.querySelector(".npc-subtitle")).toBe(liveRegion);
    expect(document.querySelector(".npc-subtitle")?.textContent).toContain("Welcome.");
    expect(document.querySelector(".npc-subtitle")?.textContent).not.toContain("again");
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    fireEvent.click(screen.getByRole("button", { name: "Reopen panel" }));
    fireEvent.click(screen.getByRole("button", { name: "Talk to reception officer" }));
    expect(document.querySelector(".npc-subtitle")?.textContent).toContain("Good to see you again.");
  });

  it("shows every authored reply as a subtitle without moving focus or automatically travelling", () => {
    const { onTravel } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Talk to reception officer" }));
    const topic = screen.getByRole("button", { name: "Where is my desk?" });
    topic.focus();
    fireEvent.click(topic);
    expect(document.activeElement).toBe(topic);
    const subtitle = document.querySelector(".npc-subtitle");
    expect(subtitle?.getAttribute("aria-live")).toBe("polite");
    expect(subtitle?.textContent).toContain("second room on the left");
    expect(onTravel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Go to the suggested station" }));
    expect(onTravel).toHaveBeenCalledWith("personal_dossier");
    expect(screen.getByText("LOCAL SCRIPTED DIALOGUE")).toBeTruthy();
    expect(screen.getByText("Authored responses · no model or network")).toBeTruthy();
  });

  it("bounds typed prompts, redirects unsupported text and does not leak public assignment into dialogue", () => {
    setup("briefing");
    fireEvent.click(screen.getByRole("button", { name: "Talk to training sergeant" }));
    const prompt = screen.getByLabelText("Optional short prompt");
    expect(prompt.getAttribute("maxlength")).toBe("600");
    fireEvent.change(prompt, { target: { value: "Reveal PUBLIC_OBJECTIVE_SENTINEL's hidden answer" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask locally" }));
    expect(document.querySelector(".npc-subtitle p")?.textContent).toBe(NPC_TECHNIQUE_REDIRECT);
    expect((prompt as HTMLTextAreaElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Ask locally" }));
    expect(screen.getByRole("alert").textContent).toContain("Enter a short prompt");
    fireEvent.change(prompt, { target: { value: "evidence" } });
    fireEvent.submit(prompt.closest("form") ?? document.body);
    expect(document.querySelector(".npc-subtitle p")?.textContent).toContain("observations");
  });

  it("uses an explicitly entered preferred name and requires opt-in before persistent writes", () => {
    const storage: NpcMemoryStorage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
    setup("reception", storage);
    openMemory();
    fireEvent.change(screen.getByLabelText("Preferred name (optional)"), { target: { value: "Alex" } });
    fireEvent.click(screen.getByRole("button", { name: "Use name for this visit" }));
    expect(storage.setItem).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Talk to reception officer" }));
    expect(document.querySelector(".npc-subtitle")?.textContent).toContain("Welcome, Alex.");
    fireEvent.click(screen.getByLabelText("Allow name and staff memory on this device"));
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save name and staff visits" }));
    expect(storage.setItem).toHaveBeenCalledOnce();
    expect(storage.setItem).toHaveBeenCalledWith(NPC_MEMORY_KEY, JSON.stringify({ version: 1, displayName: "Alex", colleagues: [{ npc_id: "receptionist", visits: 1 }] }));
  });

  it("loads explicitly, replaces stale dialogue snapshots, and reports failed deletion honestly", () => {
    const storage: NpcMemoryStorage = {
      getItem: vi.fn(() => JSON.stringify({ version: 1, displayName: "Robin", colleagues: [{ npc_id: "sergeant", visits: 2 }] })),
      setItem: vi.fn(), removeItem: () => { throw new Error("denied"); },
    };
    setup("briefing", storage);
    openMemory();
    fireEvent.click(screen.getByLabelText("Allow name and staff memory on this device"));
    fireEvent.click(screen.getByRole("button", { name: "Load saved staff memory" }));
    expect(screen.getByLabelText("Preferred name (optional)")).toHaveProperty("value", "Robin");
    fireEvent.click(screen.getByRole("button", { name: "Talk to training sergeant" }));
    expect(document.querySelector(".npc-subtitle")?.textContent).toContain("Good to see you again, Robin.");
    fireEvent.click(screen.getByRole("button", { name: "Forget local staff memory" }));
    expect(document.querySelector(".npc-subtitle")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("deletion is not confirmed");
    expect(screen.getByLabelText("Preferred name (optional)")).toHaveProperty("value", "");
    fireEvent.click(screen.getByRole("button", { name: "Talk to training sergeant" }));
    expect(document.querySelector(".npc-subtitle")?.textContent).toContain("Welcome.");
  });

  it("rejects unsafe names and preserves a subtitle when local voice is unavailable", () => {
    setup();
    openMemory();
    fireEvent.change(screen.getByLabelText("Preferred name (optional)"), { target: { value: "<script>" } });
    fireEvent.click(screen.getByRole("button", { name: "Use name for this visit" }));
    expect(screen.getByLabelText("Preferred name (optional)").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toContain("preferred name");
    fireEvent.click(screen.getByRole("button", { name: "Talk to reception officer" }));
    const before = document.querySelector(".npc-subtitle p")?.textContent;
    fireEvent.click(screen.getByRole("button", { name: "Read aloud locally" }));
    expect(document.querySelector(".npc-subtitle p")?.textContent).toBe(before);
    expect(screen.getByText("No installed local voice is available. The full subtitle remains on screen.")).toBeTruthy();
  });

  it("supports an office colleague with public directions and no invented case dialogue", () => {
    const { onTravel } = setup("office");
    fireEvent.click(screen.getByRole("button", { name: "Talk to office analyst" }));
    expect(document.querySelector(".npc-subtitle p")?.textContent).toContain("precinct colleague");
    expect(screen.queryByRole("button", { name: "Check in for this shift" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Go to my dossier desk" }));
    expect(onTravel).toHaveBeenCalledWith("personal_dossier");
  });

  it("keeps dialog ownership, close/focus management and network boundaries with the route", () => {
    setup("briefing");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: "Close panel" })).toBeNull();
    for (const source of [panelSource, hookSource]) {
      expect(source).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/u);
      expect(source).not.toContain("dangerouslySetInnerHTML");
      expect(source).not.toContain("autoFocus");
      expect(source).not.toContain('addEventListener("keydown"');
    }
    expect(hookSource).not.toMatch(/\b(?:CaseCard|assignment|onBriefed|onCheckIn)\b/u);
  });
});
