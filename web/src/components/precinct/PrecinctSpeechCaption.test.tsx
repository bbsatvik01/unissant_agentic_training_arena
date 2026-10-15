// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PrecinctSpeechCaption } from "./PrecinctSpeechCaption";
const caption = { role: "subject" as const, speaker: "Jordan Pell", text: "The <public> words remain literal.", label: "Read-aloud · synthesized speech" };
afterEach(() => { cleanup(); document.body.replaceChildren(); });
function host(tag = "div") { const element = document.createElement(tag); document.body.appendChild(element); return element; }

describe("one accessible immersive caption", () => {
  it("moves the same live region into the active modal and back without duplicate nodes or text mutations", () => {
    const hud = host(); const dialog = host("dialog"); dialog.setAttribute("open", "");
    const { rerender } = render(<PrecinctSpeechCaption caption={caption} target={hud} />);
    const region = screen.getByRole("status", { name: "Speech caption" });
    const text = region.querySelector("p")?.lastChild;
    expect(region.textContent).toContain("Jordan Pell:"); expect(region.textContent).toContain(caption.text);
    expect(region.querySelector("public")).toBeNull(); expect(region.getAttribute("aria-atomic")).toBe("true"); expect(region.getAttribute("tabindex")).toBe("0");
    for (const target of [dialog, hud, dialog, hud]) {
      rerender(<PrecinctSpeechCaption caption={{ ...caption }} target={target} />);
      expect(screen.getAllByRole("status", { name: "Speech caption" })).toEqual([region]);
      expect(target.contains(region)).toBe(true); expect(region.querySelector("p")?.lastChild).toBe(text);
    }
  });
  it("defers announcements to the visible transcript and leaves only one readable caption", () => {
    const target = host(); const { rerender } = render(<PrecinctSpeechCaption caption={caption} target={target} />);
    const region = screen.getByRole("status", { name: "Speech caption" });
    rerender(<PrecinctSpeechCaption caption={caption} target={target} announce={false} />);
    expect(screen.queryByRole("status", { name: "Speech caption" })).toBeNull();
    expect(screen.getByRole("group", { name: "Speech caption" })).toBe(region);
    expect(region.getAttribute("aria-live")).toBe("off");
    rerender(<PrecinctSpeechCaption caption={null} target={target} />);
    expect(screen.queryByRole("status", { name: "Speech caption" })).toBeNull(); expect(target.textContent).toBe("");
  });
  it("shows fallback text honestly and removes detached/closed caption content", () => {
    const target = host(); const { rerender, unmount } = render(<PrecinctSpeechCaption caption={{ ...caption, label: "Live voice · transcript pending", text: "Audio is playing. Transcript text is not available yet." }} target={target} />);
    expect(screen.getByText("Live voice · transcript pending")).toBeTruthy();
    rerender(<PrecinctSpeechCaption caption={caption} target={null} />);
    expect(screen.queryByRole("status", { name: "Speech caption" })).toBeNull();
    unmount(); expect(target.childElementCount).toBe(0);
  });
});
