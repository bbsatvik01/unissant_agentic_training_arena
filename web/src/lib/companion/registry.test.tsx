// @vitest-environment jsdom
/**
 * The companion character registry (S6 6.3 and 13; gokbase `kin/registry.ts` lines 108-137): the
 * only place character modules are referenced, each behind a dynamic import so that art stays out
 * of the entry chunk (FE-PET-5).
 */
import { cleanup, render } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { COMPANION_CHARACTERS, companionLoader, isCompanionCharacter } from "./registry";

afterEach(() => {
  cleanup();
});

describe("companion registry", () => {
  it("lists the development placeholder only, until DESIGN.md names the companion", () => {
    expect(COMPANION_CHARACTERS).toEqual(["placeholder"]);
  });

  it.each([["placeholder", true]] as const)("accepts %s", (value, expected) => {
    expect(isCompanionCharacter(value)).toBe(expected);
  });

  it.each([["pip"], ["Placeholder"], [""], ["__proto__"], ["constructor"], ["toString"], [null], [undefined], [7]])(
    "rejects %j",
    (value) => {
      expect(isCompanionCharacter(value)).toBe(false);
    },
  );

  it("loads a character lazily and renders the pose it is given, hidden from assistive technology", async () => {
    const Pet = companionLoader("placeholder");
    const view = render(
      <Suspense fallback={<span data-testid="loading" />}>
        <Pet state="noticing" motion="still" size={48} />
      </Suspense>,
    );
    const shown = await view.findByText("noticing");
    expect(shown.getAttribute("data-pose")).toBe("noticing");
    expect(shown.getAttribute("data-motion")).toBe("still");
    expect(shown.getAttribute("aria-hidden")).toBe("true");
    expect(view.queryByTestId("loading")).toBeNull();
  });

  it("returns the same lazy component on every call, so React keeps its loaded state", () => {
    expect(companionLoader("placeholder")).toBe(companionLoader("placeholder"));
  });
});
