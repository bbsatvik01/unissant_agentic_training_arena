// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SnapshotRelease } from "../../lib/contracts/generated/types";
import { EX4_TEXT } from "../../lib/copy/ex4";
import { dossierSources } from "../../lib/precinct/dossier";
import { createNotebookController, type NotebookController, type NotebookStorage } from "../../lib/precinct/notebookController";
import type { RecordingCase } from "../../lib/world/recording";
import { dossierPacket, dossierRelease } from "../../test/dossier-fixtures";
import { DossierPanel, type DossierPanelProps, type DossierUiEvent } from "./DossierPanel";

afterEach(cleanup);
function Harness({ controller, ...props }: Omit<DossierPanelProps, "notebook" | "notebookActions"> & { readonly controller: NotebookController }) {
  const notebook = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return <DossierPanel {...props} notebook={notebook} notebookActions={controller.actions} />;
}
function setup(packet: RecordingCase = dossierPacket, released: readonly SnapshotRelease[] = [dossierRelease]) {
  const data = new Map<string, string>();
  const storage: NotebookStorage = {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { data.set(key, value); }),
    removeItem: vi.fn((key: string) => { data.delete(key); }),
  };
  let nextId = 0;
  const controller = createNotebookController({ caseId: packet.case_id, scope: "test-session", sources: dossierSources(packet, released).map((source) => source.ref), storage: () => storage, now: () => 100, createId: () => `n-${String(++nextId)}` });
  const onUiEvent = vi.fn<(event: DossierUiEvent) => void>();
  const onPresentEvidence = vi.fn();
  const view = render(<Harness packet={packet} released={released} controller={controller} onUiEvent={onUiEvent} onPresentEvidence={onPresentEvidence} />);
  return { ...view, controller, onUiEvent, onPresentEvidence, storage, data };
}
function openTab(name: string) { fireEvent.click(screen.getByRole("tab", { name: new RegExp(name, "i") })); }
function addNote(text = "Ask which task was assigned.") {
  fireEvent.change(screen.getByRole("textbox", { name: "New note" }), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Add note" }));
}

describe("DossierPanel", () => {
  it("renders a public overview with the exact ground rule and no duplicate modal", () => {
    const { container, storage } = setup();
    expect(screen.getByRole("heading", { name: dossierPacket.title })).toBeTruthy();
    expect(screen.getByText(EX4_TEXT)).toBeTruthy();
    expect(within(screen.getByRole("tabpanel")).getByText(dossierPacket.objective)).toBeTruthy();
    expect(container.querySelector("dialog, [role=dialog]")).toBeNull();
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(screen.getAllByRole("tab")).toHaveLength(6);
  });
  it("supports roving-tab keyboard navigation and reading scale callbacks", () => {
    const { container, onUiEvent } = setup();
    const overview = screen.getByRole("tab", { name: /Overview/ });
    overview.focus();
    fireEvent.keyDown(overview, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /Documents/ }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Documents/ }));
    fireEvent.keyDown(document.activeElement ?? overview, { key: "End" });
    expect(screen.getByRole("tab", { name: /Notebook/ }).getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(screen.getByRole("tab", { name: /Notebook/ }), { key: "Home" });
    fireEvent.keyDown(overview, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Notebook/ }));
    fireEvent.keyDown(screen.getByRole("tab", { name: /Notebook/ }), { key: "Enter" });
    fireEvent.change(screen.getByRole("combobox", { name: "Dossier reading size" }), { target: { value: "150" } });
    expect(container.querySelector(".dossier-panel")?.getAttribute("data-reading-scale")).toBe("150");
    expect(onUiEvent).toHaveBeenCalledWith({ type: "reading.scale", percent: 150 });
    expect(onUiEvent).toHaveBeenCalledWith({ type: "page.open", page: "documents" });
  });
  it("shows complete literal original text and table cells with source pagination", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const packet = { ...dossierPacket, initial_documents: dossierPacket.initial_documents.map((source, index) => index === 0 ? { ...source, content: { ...source.content, body: hostile } } : source) };
    const { container, onUiEvent } = setup(packet);
    openTab("Documents");
    expect(within(screen.getByRole("article")).getByText(hostile)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Time", "Door", "Event"]);
    expect(screen.getByRole("cell", { name: "14:09:40" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Access policy" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Radio log" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
    expect(onUiEvent).toHaveBeenCalledWith({ type: "source.open", source: { kind: "record", id: "rec-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.getByRole("heading", { name: "Access policy" })).toBeTruthy();
  });
  it("keeps the public profile grounded and labels the source-led timeline", () => {
    setup();
    openTab("Subject");
    expect(screen.getByRole("heading", { name: "Avery Vale" })).toBeTruthy();
    expect(within(screen.getByRole("tabpanel")).getByText("Facilities technician")).toBeTruthy();
    expect(screen.getByText("This profile contains only the supplied public details.", { exact: false })).toBeTruthy();
    openTab("Timeline");
    const panel = within(screen.getByRole("tabpanel"));
    expect(panel.getByText("Record date (metadata)")).toBeTruthy();
    expect(panel.getByText(/source order/)).toBeTruthy();
    expect(panel.queryByText("16:00")).toBeNull();
    fireEvent.click(panel.getByRole("button", { name: "doc-01 · row 2" }));
    expect(screen.getByRole("tab", { name: /Documents/ }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Documents/ }));
  });
  it("offers read and evidence-table callbacks for public sources only", () => {
    const { onPresentEvidence, onUiEvent } = setup(dossierPacket, []);
    openTab("Evidence");
    expect(screen.queryByRole("button", { name: /Read Radio log/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Place on table Door log" }));
    expect(onPresentEvidence).toHaveBeenCalledWith({ kind: "document", id: "doc-01" });
    expect(onUiEvent).toHaveBeenCalledWith({ type: "evidence.present", source: { kind: "document", id: "doc-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Read Access policy" }));
    expect(screen.getByRole("heading", { name: "Access policy" })).toBeTruthy();
  });
  it("adds, edits, cites and removes bounded trainee notes, including explicitly tentative contradictions", () => {
    const { controller, onUiEvent, storage } = setup();
    openTab("Notebook");
    fireEvent.change(screen.getByRole("combobox", { name: "Note type" }), { target: { value: "contradiction" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "doc-01 Door log" }));
    addNote("These accounts may differ. Check an alternative explanation.");
    expect(controller.getSnapshot().document.entries[0]).toMatchObject({ kind: "contradiction", citations: [{ kind: "document", id: "doc-01" }] });
    expect(screen.getByText("01 / Possible contradiction")).toBeTruthy();
    expect(onUiEvent.mock.calls.some(([event]) => event.type === "notebook.change" && event.command.type === "add")).toBe(true);
    expect(onUiEvent.mock.calls.some(([event]) => event.type === "notebook.draft")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Edit note 1" }));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Edit note" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit note" }), { target: { value: "A revised question." } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(controller.getSnapshot().document.entries[0]?.text).toBe("A revised question.");
    fireEvent.click(screen.getByRole("button", { name: "Open cited source doc-01: Door log" }));
    expect(screen.getByRole("heading", { name: "Door log" })).toBeTruthy();
    openTab("Notebook");
    fireEvent.click(screen.getByRole("button", { name: "Remove note 1" }));
    expect(controller.getSnapshot().document.entries).toHaveLength(0);
    expect(storage.setItem).not.toHaveBeenCalled();
  });
  it("requires explicit save opt-in and separate confirmation for clearing and forgetting", () => {
    const { controller, storage, data } = setup();
    openTab("Notebook"); addNote();
    expect(storage.setItem).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save on this device" }));
    expect(controller.getSnapshot().savingEnabled).toBe(true);
    expect(data.size).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear session notes" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(controller.getSnapshot().document.entries).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear session notes" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm clear" }));
    expect(controller.getSnapshot().document.entries).toHaveLength(0);
    expect(data.size).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Forget saved copy" }));
    expect(data.size).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Confirm forget" }));
    expect(data.size).toBe(0);
    expect(screen.getByRole("status").textContent).toContain("Saved copy removed");
  });
  it("keeps an unsaved draft on validation failure and honestly reports storage failure", () => {
    const { storage, controller } = setup();
    openTab("Notebook");
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    expect(screen.getByRole("alert").textContent).toContain("Write a note");
    addNote();
    vi.mocked(storage.setItem).mockImplementation(() => { throw new Error("quota"); });
    fireEvent.click(screen.getByRole("button", { name: "Save on this device" }));
    expect(screen.getByRole("status").textContent).toContain("Device saving failed");
    expect(controller.getSnapshot().document.entries).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Retry device save" })).toBeTruthy();
  });
  it("handles empty packets and hides a different case's notebook", () => {
    const packet = { ...dossierPacket, initial_documents: [] };
    const { rerender, controller, onUiEvent } = setup(packet, []);
    openTab("Documents");
    expect(screen.getByText("This packet has no documents or released records yet.")).toBeTruthy();
    openTab("Timeline");
    expect(screen.getByText(/No explicitly labeled date or time cells/)).toBeTruthy();
    rerender(<Harness packet={{ ...packet, case_id: "other-case" }} released={[]} controller={controller} onUiEvent={onUiEvent} />);
    openTab("Notebook");
    expect(screen.getByRole("alert").textContent).toContain("not ready for this case");
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});


it("keeps v1 replay read-only even if a caller mistakenly supplies a working notebook snapshot", () => {
  const { rerender, controller, onUiEvent, storage } = setup();
  act(() => { controller.actions.add({ kind: "question", text: "Future working note must not appear in replay.", citations: [] }); });
  rerender(<Harness packet={dossierPacket} released={[]} controller={controller} onUiEvent={onUiEvent} notebookReadOnly />);
  openTab("Notebook");
  expect(screen.getByRole("status").textContent).toContain("does not contain notebook history");
  expect(screen.queryByText("Future working note must not appear in replay.")).toBeNull();
  expect(screen.queryByRole("textbox", { name: "New note" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Save on this device" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Restore saved copy" })).toBeNull();
  expect(screen.getByRole("tab", { name: /Notebook/ }).querySelector(".dossier-tab-count")).toBeNull();
  expect(storage.getItem).not.toHaveBeenCalled();
  expect(storage.setItem).not.toHaveBeenCalled();
});


it("publishes each accepted notebook document with original metadata in the mutation event", () => {
  const { controller, onUiEvent } = setup();
  openTab("Notebook");
  addNote("First wording.");
  const original = controller.getSnapshot().document.entries[0];
  fireEvent.click(screen.getByRole("button", { name: "Edit note 1" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Edit note" }), { target: { value: "Revised wording." } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  const changed = onUiEvent.mock.calls.map(([event]) => event).findLast((event) => event.type === "notebook.change");
  expect(changed?.type).toBe("notebook.change");
  if (changed?.type === "notebook.change") {
    expect(changed.command.type).toBe("edit");
    expect(changed.document).toEqual(controller.getSnapshot().document);
    expect(changed.document.entries[0]).toMatchObject({ id: original?.id, createdAtMs: original?.createdAtMs, text: "Revised wording." });
  }
});
