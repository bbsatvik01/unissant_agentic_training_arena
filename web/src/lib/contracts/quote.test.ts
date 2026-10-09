import { describe, expect, it } from "vitest";

import { contentText, normalize, quoteOk, type RecordContent } from "./quote";

/** The shared fixture file, read through Vite (the Python tests read the same file). */
const files = import.meta.glob<unknown>("../../../../contracts/fixtures/citations.json", {
  eager: true,
  import: "default",
});

interface QuoteCase {
  readonly id: string;
  readonly quote: string;
  readonly text?: string;
  readonly content?: RecordContent;
  readonly expected: boolean;
}

function quoteCases(): readonly QuoteCase[] {
  const fixture = Object.values(files)[0] as { quote_cases: readonly QuoteCase[] } | undefined;
  if (fixture === undefined) throw new Error("contracts/fixtures/citations.json not found");
  return fixture.quote_cases;
}

describe("quoteOk on S2's shared quote fixture file (D6, FE-COACH-3)", () => {
  const cases = quoteCases();

  it("reads every case of the file", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(cases.map((c) => c.id)).toEqual(expect.arrayContaining(["CQ-1", "CQ-2", "CQ-4", "CQ-5", "FE-4", "N-6", "N-7"]));
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const text = c.text ?? (c.content ? contentText(c.content) : "");
    expect(quoteOk(c.quote, text)).toBe(c.expected);
  });
});

describe("normalize", () => {
  it("folds dashes, curly quotes and Python whitespace and keeps case", () => {
    expect(normalize("  \u201cA\u201d\u2014b\u2019s\t\n C  ")).toBe("\"A\"-b's C");
    expect(normalize("\u2010\u2011\u2012\u2013\u2014\u2015\u2212")).toBe("-------");
    expect(normalize("a\u001fb\u0085c")).toBe("a b c");
    expect(normalize("a\ufeffb")).toBe("a\ufeffb");
  });
});

describe("contentText", () => {
  it("renders the body alone when there is no table", () => {
    expect(contentText({ body: "Only the body." })).toBe("Only the body.");
    expect(contentText({ body: "Only the body.", table: null })).toBe("Only the body.");
  });

  it("renders the column line and one line per row", () => {
    const content = { body: "Log.", table: { columns: ["Time", "Event"], rows: [["21:00", "none"]] } };
    expect(contentText(content)).toBe("Log.\nTime | Event\n21:00 | none");
  });
});
