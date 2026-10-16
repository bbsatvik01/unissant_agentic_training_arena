// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { initialWorldReplayState, reduceWorldEvent } from "../../lib/world/worldEvents";
import { RecordedWorldStatePanel } from "./RecordedWorldStatePanel";
afterEach(cleanup);
describe("read-only recorded state projection", () => {
  it("shows actual metadata and drafts without writable controls or resolving legacy ambiguous IDs", () => {
    let world = reduceWorldEvent(initialWorldReplayState(), { t_ms: 12, kind: "input", data: { action: "notebook", operation: "upsert", note_id: "n", text: "<script>Literal note</script>", metadata: { kind: "contradiction", citations: [{ kind: "document", id: "same" }], createdAtMs: 1000, updatedAtMs: 2000 } } });
    world = reduceWorldEvent(world, { t_ms: 15, kind: "input", data: { action: "notebook", operation: "draft", draft: { kind: "question", text: "Whose timestamp?", citations: [], editingId: "n" } } });
    const { container, rerender } = render(<RecordedWorldStatePanel world={world} />);
    expect(screen.getByText("<script>Literal note</script>")).toBeTruthy(); expect(screen.getByText(/trainee note, not a finding/)).toBeTruthy();
    expect(screen.getByText(/created 1000; updated 2000/)).toBeTruthy(); expect(screen.getByText(/Captured draft/)).toBeTruthy(); expect(screen.getByText(/Ambiguous IDs are not resolved/)).toBeTruthy();
    expect(container.querySelector("input, textarea, button, script, dialog, canvas")).toBeNull();
    rerender(<RecordedWorldStatePanel world={initialWorldReplayState()} notebookOnly />);
    expect(screen.queryByText("<script>Literal note</script>")).toBeNull(); expect(screen.queryByText("Recorded evidence and panel markers")).toBeNull();
    expect(screen.getByText(/Device notes are not substituted/)).toBeTruthy();
  });
  it("states text-only note limitations without inventing metadata", () => {
    const world = reduceWorldEvent(initialWorldReplayState(), { t_ms: 1, kind: "input", data: { action: "notebook", operation: "upsert", note_id: "n", text: "Legacy" } });
    render(<RecordedWorldStatePanel world={world} />); expect(screen.getByText(/Original note kind, citations and timestamps were not captured/)).toBeTruthy();
  });
});
