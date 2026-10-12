// @vitest-environment jsdom
/**
 * Onboarding (S6 4.1): the sponsor's ground rule in full (its text is checked against the challenge text in
 * tools/ex4-sponsor.test.ts, FE-ONB-2), an acknowledgement that cannot be dismissed until stored (FE-ONB-1's gate), and the
 * stored state shown afterwards.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EX4_TEXT } from "../../lib/copy/ex4";
import { Onboarding } from "./Onboarding";

afterEach(() => {
  cleanup();
});

describe("Onboarding", () => {
  it("shows the ground rule in full and cannot be closed until acknowledged", async () => {
    const ack = vi.fn(() => Promise.resolve(true));
    render(<Onboarding acknowledged={null} onAcknowledge={ack} onClose={null} />);
    expect(screen.getByText(EX4_TEXT)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "I have read the ground rule" }));
    await waitFor(() => {
      expect(ack).toHaveBeenCalledTimes(1);
    });
  });

  it("says when the acknowledgement could not be saved", async () => {
    render(<Onboarding acknowledged={null} onAcknowledge={() => Promise.resolve(false)} onClose={null} />);
    fireEvent.click(screen.getByRole("button", { name: "I have read the ground rule" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("shows the stored acknowledgement instead of the button once acknowledged, and can be closed", () => {
    const close = vi.fn();
    render(<Onboarding acknowledged="2026-10-11T12:00:00Z" onAcknowledge={() => Promise.resolve(true)} onClose={close} />);
    expect(screen.queryByRole("button", { name: "I have read the ground rule" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(close).toHaveBeenCalled();
  });

  it("uses none of the words the copy rules forbid", () => {
    render(<Onboarding acknowledged={null} onAcknowledge={() => Promise.resolve(true)} onClose={null} />);
    expect(document.body.textContent).not.toMatch(/\bAI\b|\bagents?\b|interrogation|streak|liars|caught/i);
  });
});
