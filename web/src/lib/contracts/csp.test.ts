/**
 * S6 1.3: the page runs under `script-src 'self'` with no `'unsafe-eval'`, so the browser can compile no code.
 * With `Function` and `eval` made to throw, as such a CSP makes them, the validation layer still loads and works.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { fixture } from "../../test/wire-fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("wire validation under the page's CSP", () => {
  it("loads and validates without generating code", async () => {
    const refuse = () => {
      throw new EvalError("Refused to evaluate a string as JavaScript because 'unsafe-eval' is not allowed");
    };
    vi.stubGlobal("Function", new Proxy(Function, { construct: refuse, apply: refuse }));
    vi.stubGlobal("eval", refuse);
    vi.resetModules();
    const { isWire } = await import("./validate");
    expect(isWire("snapshot", fixture("snapshot:text"))).toBe(true);
    expect(isWire("snapshot", { ...(fixture("snapshot:text") as object), role: "deceptive" })).toBe(false);
  });
});
