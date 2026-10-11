// @vitest-environment jsdom
/**
 * The consoles (S6 4.12, 4.13) against a stubbed transport: on the arena-api origin they read "Not available here"
 * and make no review or admin request (FE-REV-4, FE-ADM-1); a trainer opens an item, answers it and submits
 * (FE-REV-3) with no timestamp on screen (FE-REV-2); an admin cannot reveal while a precondition fails (FE-ADM-2).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fixture } from "../test/wire-fixtures";
import { ConsoleRoute } from "./ConsoleRoute";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ARENA_ME = { user_id: "u1", display_name: "Local investigator", roles: ["admin", "investigator", "trainer"], ex4_acknowledged: null, study: null, csrf_token: "tok" };
const CONSOLE_ME = { user_id: "u1", display_name: "Rater", roles: ["admin", "trainer"], csrf_token: "tok" };

function serve(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchStub = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const key = `${init?.method ?? "GET"} ${url}`;
    calls.push(key);
    const body = routes[key];
    if (body === undefined) return Promise.resolve(new Response(JSON.stringify({ code: "not_found" }), { status: 404, headers: { "Content-Type": "application/json" } }));
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  });
  vi.stubGlobal("fetch", fetchStub);
  return calls;
}

describe("ConsoleRoute", () => {
  it.each(["review", "admin"] as const)("%s reads Not available here on the arena-api origin and asks nothing else", async (kind) => {
    const calls = serve({ "GET /api/me": ARENA_ME });
    render(<ConsoleRoute kind={kind} />);
    expect(await screen.findByText("Not available here.")).toBeTruthy();
    expect(calls).toEqual(["GET /api/me"]);
  });

  it("lets a trainer open an item, answer every field and submit, with no timestamp on screen", async () => {
    const item = fixture("review-item:T-FLAG") as { flags: unknown[] };
    const list = { items: [{ item_id: "11111111-1111-4111-8111-111111111111", task: "T-FLAG", submitted: false }] };
    const calls = serve({
      "GET /api/me": CONSOLE_ME,
      "GET /api/review/items": list,
      "GET /api/review/items/11111111-1111-4111-8111-111111111111": item,
      "POST /api/review/items/11111111-1111-4111-8111-111111111111": { outcome: "recorded", judgment: "j1" },
    });
    render(<ConsoleRoute kind="review" />);
    fireEvent.click(await screen.findByRole("button", { name: /Item 1: Coach flags/ }));
    await screen.findByText("Each flag");
    const submit = screen.getByRole("button", { name: "Submit" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    for (const select of screen.getAllByRole("combobox")) fireEvent.change(select, { target: { value: "yes" } });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    // FE-REV-2: no ISO date-times in the text or attributes.
    expect(document.body.innerHTML).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    fireEvent.click(submit);
    expect(await screen.findByText("Submitted. Thank you.")).toBeTruthy();
    expect(calls).toContain("POST /api/review/items/11111111-1111-4111-8111-111111111111");
    expect(item.flags.length).toBeGreaterThan(0);
  });

  it("shows a repeat submission as already submitted", async () => {
    serve({
      "GET /api/me": CONSOLE_ME,
      "GET /api/review/items": { items: [{ item_id: "22222222-2222-4222-8222-222222222222", task: "T-FLAG", submitted: false }] },
      "GET /api/review/items/22222222-2222-4222-8222-222222222222": fixture("review-item:T-FLAG"),
      "POST /api/review/items/22222222-2222-4222-8222-222222222222": { outcome: "exists" },
    });
    render(<ConsoleRoute kind="review" />);
    fireEvent.click(await screen.findByRole("button", { name: /Item 1/ }));
    await screen.findByText("Each flag");
    for (const select of screen.getAllByRole("combobox")) fireEvent.change(select, { target: { value: "no" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("Already submitted.")).toBeTruthy();
  });

  it("renders a T-RUB item with Investigator and Subject labels and the case file", async () => {
    serve({
      "GET /api/me": CONSOLE_ME,
      "GET /api/review/items": { items: [{ item_id: "33333333-3333-4333-8333-333333333333", task: "T-RUB", submitted: false }] },
      "GET /api/review/items/33333333-3333-4333-8333-333333333333": fixture("review-item:T-RUB"),
    });
    render(<ConsoleRoute kind="review" />);
    fireEvent.click(await screen.findByRole("button", { name: /Item 1: Questioning and finding/ }));
    expect(await screen.findByText("Case file")).toBeTruthy();
    expect(screen.getAllByText("Investigator").length).toBeGreaterThan(0);
    expect(document.body.innerHTML).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it("keeps Reveal disabled while a precondition fails, says when a route is missing, and shows the kill switch read-only", async () => {
    const calls = serve({
      "GET /api/me": CONSOLE_ME,
      "GET /api/admin/budget": [{ bucket: "global", parent: null, ceiling_usd: "75", liability_usd: "3.2", open_usd: "0", headroom_usd: "71.8", kill_switch: false }],
      "GET /api/admin/tournaments": [{ id: "t1", name: "dev-1", split: "dev", status: "scoring" }],
      "GET /api/admin/tournaments/t1": { preconditions: [{ name: "Roster frozen", passed: true }, { name: "Every subject review resolved", passed: false }] },
    });
    render(<ConsoleRoute kind="admin" />);
    const reveal = await screen.findByRole("button", { name: "Reveal" });
    await waitFor(() => {
      expect(screen.getByText("Every subject review resolved: not met")).toBeTruthy();
    });
    expect((reveal as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Off.")).toBeTruthy();
    const budget = screen.getByRole("region", { name: "Budget" });
    expect(within(budget).getByText("$75.00")).toBeTruthy();
    expect(calls.some((c) => c.startsWith("POST"))).toBe(false);
  });

  it("records a blinded validity verdict, subject invalid only with a reason", async () => {
    const calls = serve({
      "GET /api/me": CONSOLE_ME,
      "GET /api/admin/reviews": [{ trial_id: "tr-1", proposal: "subject_invalid", reasons: ["F5 on T3"] }],
      "POST /api/admin/reviews/tr-1": { ok: true },
    });
    render(<ConsoleRoute kind="admin" />);
    const invalid = await screen.findByRole("button", { name: "Subject invalid" });
    expect((invalid as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("F5 on T3")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), { target: { value: "platform attack" } });
    fireEvent.click(invalid);
    expect(await screen.findByText("Verdict recorded.")).toBeTruthy();
    expect(calls).toContain("POST /api/admin/reviews/tr-1");
    expect(document.body.textContent).not.toMatch(/\bS[1-3]\b|candidate/);
  });

  it("shows the whole committed finding to the rater, corroboration included", async () => {
    const rub = fixture("review-item:T-RUB") as { finding: Record<string, unknown> };
    const item = { ...rub, finding: { ...rub.finding, label: "insufficient_evidence", corroboration_needed: ["Radio log for 14:00-14:10"], alternative_explanations: ["Dispatched verbally"] } };
    serve({
      "GET /api/me": CONSOLE_ME,
      "GET /api/review/items": { items: [{ item_id: "44444444-4444-4444-8444-444444444444", task: "T-RUB", submitted: false }] },
      "GET /api/review/items/44444444-4444-4444-8444-444444444444": item,
    });
    render(<ConsoleRoute kind="review" />);
    fireEvent.click(await screen.findByRole("button", { name: /Item 1/ }));
    expect(await screen.findByText("Radio log for 14:00-14:10")).toBeTruthy();
    expect(screen.getByText("Dispatched verbally")).toBeTruthy();
  });
});
