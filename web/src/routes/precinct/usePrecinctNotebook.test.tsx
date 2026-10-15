// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dossierPacket, dossierRelease } from "../../test/dossier-fixtures";
import { usePrecinctNotebook, type PrecinctNotebookOptions } from "./usePrecinctNotebook";

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });
const base: PrecinctNotebookOptions = { packet: dossierPacket, released: [], scope: "user-a:live:session-a", readOnly: false, caseId: dossierPacket.case_id, source: "live", runKey: "session-a" };
const draft = { kind: "question", text: "Which assignment explains the entry?", citations: [] } as const;

describe("usePrecinctNotebook", () => {
  it("keeps notes and the subscription stable across ordinary route renders and public releases", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { result, rerender } = renderHook(usePrecinctNotebook, { initialProps: base });
    const actions = result.current.actions;
    act(() => { result.current.actions.add(draft); });
    rerender({ ...base, released: [dossierRelease] });
    expect(result.current.actions).toBe(actions);
    expect(result.current.snapshot.document.entries).toHaveLength(1);
    act(() => { expect(result.current.actions.add({ ...draft, citations: [{ kind: "record", id: dossierRelease.record_id }] }).ok).toBe(true); });
    expect(result.current.snapshot.document.entries).toHaveLength(2);
    rerender(base);
    act(() => { expect(result.current.actions.add({ ...draft, citations: [{ kind: "record", id: dossierRelease.record_id }] }).ok).toBe(false); });
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });
  it("starts empty after case, run, user, or replay scope changes without reading the old notebook", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const { result, rerender } = renderHook(usePrecinctNotebook, { initialProps: base });
    const variations: PrecinctNotebookOptions[] = [
      { ...base, packet: { ...dossierPacket, case_id: "case-b" } },
      { ...base, scope: "user-a:live:session-b" },
      { ...base, scope: "user-b:live:session-a" },
      { ...base, scope: "user-a:recording:trial-a", readOnly: true },
      { ...base, packet: null, caseId: null },
      base,
    ];
    for (const options of variations) {
      if (!result.current.readOnly) act(() => { result.current.actions.add(draft); });
      rerender(options);
      expect(result.current.snapshot.document.entries).toHaveLength(0);
      expect(result.current.snapshot.savingEnabled).toBe(false);
    }
    expect(getItem).not.toHaveBeenCalled();
  });
  it("restores only after the explicit restore action and preserves source validation", () => {
    const { result, rerender } = renderHook(usePrecinctNotebook, { initialProps: base });
    act(() => { result.current.actions.add(draft); result.current.actions.enableSaving(); });
    rerender({ ...base, scope: "another-session" });
    rerender(base);
    expect(result.current.snapshot.document.entries).toEqual([]);
    act(() => { expect(result.current.actions.restoreSaved().ok).toBe(true); });
    expect(result.current.snapshot.document.entries[0]?.text).toBe(draft.text);
    expect(result.current.snapshot.savingEnabled).toBe(true);
  });
  it("surfaces blocked device storage while keeping memory notes editable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const { result } = renderHook(usePrecinctNotebook, { initialProps: base });
    act(() => { result.current.actions.add(draft); });
    act(() => { expect(result.current.actions.enableSaving().ok).toBe(false); });
    expect(result.current.snapshot.persistence).toBe("error");
    expect(result.current.snapshot.document.entries[0]?.text).toBe(draft.text);
  });
});

describe("preparation into a new live run", () => {
  const preparation: PrecinctNotebookOptions = { ...base, scope: "browser-preparation:case-a", source: "idle", runKey: null };
  const starting: PrecinctNotebookOptions = { ...base, scope: "user-a:live:starting", source: "live", packet: null, runKey: null };
  const running: PrecinctNotebookOptions = { ...base, scope: "user-a:live:new-run", source: "live", runKey: "new-run" };
  it("offers an explicitly armed preparation through packet loading, and copies it only on acceptance", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { result, rerender } = renderHook(usePrecinctNotebook, { initialProps: preparation });
    act(() => { result.current.actions.add({ ...draft, citations: [{ kind: "document", id: "doc-01" }] }); });
    const prepared = result.current.snapshot.document;
    act(() => { expect(result.current.prepareForNewRun()).toBe(true); });
    rerender(starting);
    expect(result.current.carryAvailable).toBe(false);
    rerender({ ...running, packet: null });
    expect(result.current.carryAvailable).toBe(false);
    rerender(running);
    expect(result.current.snapshot.document.entries).toEqual([]);
    expect(result.current.carryAvailable).toBe(true);
    expect(result.current.carryCount).toBe(1);
    act(() => { expect(result.current.carryPreparation().ok).toBe(true); });
    expect(result.current.snapshot.document).toEqual(prepared);
    expect(result.current.snapshot.savingEnabled).toBe(false);
    expect(result.current.carryAvailable).toBe(false);
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });
  it("does not infer a carry for an unarmed same-case start, Resume, or unrelated recording", () => {
    const { result, rerender } = renderHook(usePrecinctNotebook, { initialProps: preparation });
    act(() => { result.current.actions.add(draft); });
    rerender(running);
    expect(result.current.carryAvailable).toBe(false);
    act(() => { expect(result.current.carryPreparation().ok).toBe(false); });
    rerender(preparation);
    act(() => { result.current.actions.add(draft); result.current.prepareForNewRun(); result.current.discardPreparation(); });
    rerender({ ...running, runKey: "historical-run", scope: "historical-run" });
    expect(result.current.carryAvailable).toBe(false);
    rerender(preparation);
    act(() => { result.current.actions.add(draft); result.current.prepareForNewRun(); });
    rerender({ ...running, readOnly: true, source: "recording", runKey: null, scope: "recording" });
    rerender(running);
    expect(result.current.carryAvailable).toBe(false);
    expect(result.current.snapshot.document.entries).toEqual([]);
  });
  it("keeps an offered preparation intact when acceptance would overwrite current run notes", () => {
    const { result, rerender } = renderHook(usePrecinctNotebook, { initialProps: preparation });
    act(() => { result.current.actions.add(draft); result.current.prepareForNewRun(); });
    rerender(running);
    act(() => { result.current.actions.add({ ...draft, text: "A new run note." }); });
    act(() => { expect(result.current.carryPreparation().ok).toBe(false); });
    expect(result.current.carryAvailable).toBe(true);
    expect(result.current.snapshot.document.entries[0]?.text).toBe("A new run note.");
    act(() => { expect(result.current.prepareForNewRun()).toBe(false); });
    expect(result.current.carryAvailable).toBe(false);
  });
});
