import { describe, expect, it } from "vitest";
import { debriefWallSvg } from "./DebriefWallScreen";

describe("debrief wall SVG", () => {
  it("escapes public text and contains no linked image, script or remote resource", () => {
    const svg = debriefWallSvg({ key: "test", heading: "<script>wrong</script>", origin: "A & B", total: "Unscored session", lines: ["<foreignObject>unsafe</foreignObject>", "Long ".repeat(30)], published: true });
    expect(svg).toContain("&lt;script&gt;wrong&lt;/script&gt;");
    expect(svg).toContain("A &amp; B");
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("<foreignObject>");
    expect(svg).not.toContain("href=");
    expect(svg).not.toContain("<image");
    expect(svg).toContain("…");
    expect(svg).toContain('width="2048" height="810"');
  });
});
