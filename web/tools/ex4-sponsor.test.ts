/**
 * FE-ONB-2 (S6 4.1): `EX4_TEXT` equals, character for character, the sponsor's sentence after the "Ground rule:"
 * label on slide 8 of the challenge text (`docs/challenge/unissant-use-case.txt`).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { EX4_TEXT } from "../src/lib/copy/ex4";

describe("EX-4 text", () => {
  it("is the sponsor's sentence after the Ground rule label", () => {
    const text = readFileSync(fileURLToPath(new URL("../../docs/challenge/unissant-use-case.txt", import.meta.url)), "utf8");
    const line = text.split("\n").find((l) => l.startsWith("Ground rule:"));
    expect(line).toBeDefined();
    expect(line?.slice("Ground rule:".length).trim()).toBe(EX4_TEXT);
  });
});
