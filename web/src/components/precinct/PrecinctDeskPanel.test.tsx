// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaseCard } from "../../lib/world/cases";
import { createNotebookWorkspace } from "../../lib/precinct/notebookWorkspace";
import { dossierPacket } from "../../test/dossier-fixtures";
import { PrecinctDeskPanel, type PrecinctDeskPanelProps } from "./PrecinctDeskPanel";
import { PrecinctCaseChoicePanel } from "./PrecinctCaseChoicePanel";

afterEach(cleanup);
const card: CaseCard = { case_id: dossierPacket.case_id, title: dossierPacket.title, objective: dossierPacket.objective, domain: dossierPacket.domain, difficulty_level: dossierPacket.difficulty_level, subject: dossierPacket.subject, facility: dossierPacket.setting, initial_documents: 2, requestable_records: 1 };
function props(readOnly = false): PrecinctDeskPanelProps {
  const controller = createNotebookWorkspace({ caseId: dossierPacket.case_id, scope: "test-session", readOnly });
  return { session: { packet: dossierPacket, packetState: "ready", selectedCase: card, released: [] }, notebook: { key: "test-session:case", snapshot: controller.getSnapshot(), actions: controller.actions, readOnly, prepareForNewRun: () => false, discardPreparation: () => undefined, carryAvailable: false, carryCount: 0, carryPreparation: () => ({ ok: false, error: "No preparation offer" }) }, reviewed: false, onReviewed: vi.fn(), onChooseCase: vi.fn(), onUiEvent: vi.fn() };
}

describe("PrecinctDeskPanel", () => {
  it.each(["empty", "loading", "unavailable"] as const)("shows %s truthfully without completing the review", (packetState) => {
    const input = props();
    render(<PrecinctDeskPanel {...input} session={{ ...input.session, packet: null, packetState, selectedCase: packetState === "empty" ? null : card }} />);
    expect(screen.getByRole("region", { name: "Desk packet status" })).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark case file reviewed" })).toBeNull();
    expect(input.onReviewed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Choose a case at the board" }));
    expect(input.onChooseCase).toHaveBeenCalledOnce();
  });
  it("refuses a packet that does not belong to the selected public case", () => {
    const input = props();
    render(<PrecinctDeskPanel {...input} session={{ ...input.session, selectedCase: { ...card, case_id: "different-case" } }} />);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByText(dossierPacket.subject.display_name)).toBeNull();
  });
  it("requires the explicit reviewed-file action and makes repeated completion inert", () => {
    const input = props();
    const { rerender } = render(<PrecinctDeskPanel {...input} />);
    fireEvent.click(screen.getByRole("tab", { name: /Documents/ }));
    expect(input.onReviewed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Mark case file reviewed" }));
    expect(input.onReviewed).toHaveBeenCalledOnce();
    rerender(<PrecinctDeskPanel {...input} reviewed />);
    fireEvent.click(screen.getByRole("button", { name: "Case file reviewed" }));
    expect(input.onReviewed).toHaveBeenCalledOnce();
  });
  it("carries preparation only on the explicit button and emits the resulting document for replay capture", () => {
    const input = props();
    const document = { ...input.notebook.snapshot.document, entries: [{ id: "prep-1", kind: "question" as const, text: "Prepared question.", citations: [], createdAtMs: 2, updatedAtMs: 2 }] };
    const carryPreparation = vi.fn(() => ({ ok: true as const, document, command: null }));
    render(<PrecinctDeskPanel {...input} notebook={{ ...input.notebook, carryAvailable: true, carryCount: 1, carryPreparation }} />);
    expect(carryPreparation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Carry preparation notes into this run" }));
    expect(carryPreparation).toHaveBeenCalledOnce();
    expect(input.onUiEvent).toHaveBeenCalledWith({ type: "notebook.carry", document });
  });
  it("surfaces a refused preparation copy without pretending it was carried", () => {
    const input = props();
    render(<PrecinctDeskPanel {...input} notebook={{ ...input.notebook, carryAvailable: true, carryCount: 1, carryPreparation: () => ({ ok: false, error: "Current notes are unchanged." }) }} />);
    fireEvent.click(screen.getByRole("button", { name: "Carry preparation notes into this run" }));
    expect(screen.getByRole("alert").textContent).toBe("Current notes are unchanged.");
    expect(input.onUiEvent).not.toHaveBeenCalled();
  });
  it("does not let recorded-file browsing advance live training or expose notebook actions", () => {
    const input = props(true);
    render(<PrecinctDeskPanel {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark case file reviewed" }));
    expect(input.onReviewed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: /Notebook/ }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore saved copy" })).toBeNull();
  });
});

describe("public case choice", () => {
  it("calls only the explicit public selection callback, never by mounting or opening the desk", () => {
    const onSelect = vi.fn();
    const onDesk = vi.fn();
    const { rerender } = render(<PrecinctCaseChoicePanel session={{ cases: [card], selectedCase: null, packetState: "empty", source: "idle" }} onSelect={onSelect} onDesk={onDesk} />);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: `Select ${card.title}` }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(card.case_id);
    rerender(<PrecinctCaseChoicePanel session={{ cases: [card], selectedCase: card, packetState: "ready", source: "idle" }} onSelect={onSelect} onDesk={onDesk} />);
    fireEvent.click(screen.getByRole("button", { name: "Go to my dossier desk" }));
    expect(onDesk).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledOnce();
  });
  it("allows an explicit return to the public preparation packet from a recording of the same case", () => {
    const onSelect = vi.fn();
    render(<PrecinctCaseChoicePanel session={{ cases: [card], selectedCase: card, packetState: "ready", source: "recording" }} onSelect={onSelect} onDesk={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: `Select ${card.title}` }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(card.case_id);
  });
  it("does not invent an assignment or unlock criteria when no cases are offered", () => {
    render(<PrecinctCaseChoicePanel session={{ cases: [], selectedCase: null, packetState: "empty", source: "idle" }} onSelect={vi.fn()} onDesk={vi.fn()} />);
    expect(screen.getByText("No public assignments are offered by this source.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
