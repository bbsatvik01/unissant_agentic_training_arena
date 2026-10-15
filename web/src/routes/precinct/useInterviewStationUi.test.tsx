// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useInterviewStationUi } from "./useInterviewStationUi";

const source = { ref: { kind: "document" as const, id: "doc-01" }, title: "Public document" };
afterEach(cleanup);

describe("route-owned interview UI", () => {
  it("retains only room intent for an explicit owner while public run scope resets", () => {
    const { result, rerender } = renderHook(({ scope, room }) => useInterviewStationUi(scope, [source], false, room), { initialProps: { scope: "idle", room: "idle" } });
    act(() => { result.current.actions.call(); result.current.actions.sit(); result.current.actions.tab("evidence"); result.current.actions.cite(1, "A quote."); result.current.actions.evidence({ type: "present", source: source.ref }); });
    rerender({ scope: "starting", room: "idle" });
    expect(result.current.state).toMatchObject({ called: true, seated: true, tab: "transcript", citation: null, table: { scope: "starting", selected: null, presented: null } });
    act(() => { result.current.actions.leave(); });
    rerender({ scope: "run", room: "idle" });
    expect(result.current.state.called).toBe(true); expect(result.current.state.seated).toBe(false);
    rerender({ scope: "recording", room: "recording" });
    expect(result.current.state.called).toBe(false); expect(result.current.state.seated).toBe(false);
  });
  it("keeps explicit local affordances and only current public references", () => {
    const { result, rerender } = renderHook(({ scope, sources, readOnly }) => useInterviewStationUi(scope, sources, readOnly), { initialProps: { scope: "one", sources: [source], readOnly: false } });
    act(() => { result.current.actions.call(); result.current.actions.sit(); result.current.actions.tab("evidence"); result.current.actions.cite(1, "A quote."); result.current.actions.evidence({ type: "present", source: source.ref }); });
    expect(result.current.state).toMatchObject({ called: true, seated: true, tab: "evidence", citation: { turn: 1, nonce: 1 }, table: { presented: source.ref } });
    act(() => { result.current.actions.cite(1, "A quote."); result.current.actions.leave(); });
    expect(result.current.state.citation?.nonce).toBe(2); expect(result.current.state.seated).toBe(false);
    rerender({ scope: "one", sources: [], readOnly: false });
    expect(result.current.state.table.presented).toBeNull(); expect(result.current.state.table.selected).toBeNull();
    rerender({ scope: "one", sources: [source], readOnly: false });
    expect(result.current.state.table.presented).toBeNull();
    rerender({ scope: "two", sources: [source], readOnly: false });
    expect(result.current.state.called).toBe(false); expect(result.current.state.citation).toBeNull();
    rerender({ scope: "one", sources: [source], readOnly: false });
    expect(result.current.state.called).toBe(false); expect(result.current.state.table.presented).toBeNull();
  });
  it("deduplicates no-ops and keeps recording presentation read-only", () => {
    const { result } = renderHook(() => useInterviewStationUi("recorded", [source], true));
    const initial = result.current.state;
    act(() => { expect(result.current.actions.leave()).toBe(false); expect(result.current.actions.tab("transcript")).toBe(false); expect(result.current.actions.evidence({ type: "present", source: source.ref })).toBe(false); });
    expect(result.current.state).toBe(initial);
    act(() => { result.current.actions.evidence({ type: "select", source: source.ref }); });
    expect(result.current.state.table.selected).toEqual(source.ref); expect(result.current.state.table.presented).toBeNull();
  });
});
