// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace, type Texture } from "three";
import { createLocalSvgTexture } from "./localSvgTexture";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function images() {
  const made: HTMLImageElement[] = [];
  vi.stubGlobal("Image", function () { const image = document.createElement("img"); made.push(image); return image; });
  const latest = () => { const image = made.at(-1); if (image === undefined) throw new Error("No image requested"); return image; };
  return { made, latest };
}

describe("owned local SVG textures", () => {
  it("keeps valid Unicode and replaces XML controls or unpaired surrogates without failing the atlas", () => {
    const source = images(); const renderer = createLocalSvgTexture(vi.fn());
    expect(() => { renderer.update({ svg: "<svg>😀\u0000\ud800\n</svg>" }); }).not.toThrow();
    expect(decodeURIComponent(source.latest().src.split(",")[1] ?? "")).toBe("<svg>😀\ufffd\ufffd\n</svg>");
    renderer.dispose();
  });
  it("only encodes local image data, deduplicates images, and releases replaced resources", () => {
    const source = images(); const apply = vi.fn<(texture: Texture) => void>();
    const renderer = createLocalSvgTexture(apply);
    const first = { svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Public &amp; safe</text></svg>' };
    renderer.update(first); renderer.update(first);
    expect(source.made).toHaveLength(1);
    const image = source.latest();
    expect(image.src).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(first.svg)}`);
    image.dispatchEvent(new Event("load"));
    const texture = apply.mock.calls[0]?.[0];
    expect(texture).toBeDefined();
    if (texture === undefined) throw new Error("Missing texture");
    expect(texture.image).toBe(image); expect(texture.colorSpace).toBe(SRGBColorSpace);
    expect(texture.minFilter).toBe(LinearFilter); expect(texture.generateMipmaps).toBe(false);
    const release = vi.spyOn(texture, "dispose");
    renderer.update({ svg: "<svg />" }); source.latest().dispatchEvent(new Event("load"));
    expect(release).toHaveBeenCalledOnce(); expect(image.hasAttribute("src")).toBe(false);
    const latest = apply.mock.calls.at(-1)?.[0];
    if (latest === undefined) throw new Error("Missing replacement texture");
    const releaseLatest = vi.spyOn(latest, "dispose");
    renderer.dispose(); renderer.dispose();
    expect(releaseLatest).toHaveBeenCalledOnce(); expect(source.latest().hasAttribute("src")).toBe(false);
    renderer.update(first); expect(source.made).toHaveLength(2);
  });
  it("uses opt-in mipmaps for a static paper cover without changing dynamic screen defaults", () => {
    const source = images(); const apply = vi.fn<(texture: Texture) => void>();
    const renderer = createLocalSvgTexture(apply, { mipmaps: true });
    renderer.update({ svg: "<svg>Static public cover</svg>" }); source.latest().dispatchEvent(new Event("load"));
    expect(apply.mock.calls[0]?.[0].minFilter).toBe(LinearMipmapLinearFilter);
    expect(apply.mock.calls[0]?.[0].magFilter).toBe(LinearFilter);
    expect(apply.mock.calls[0]?.[0].generateMipmaps).toBe(true);
    renderer.dispose();
  });
  it("ignores a stale decode, permits retry after errors, and cancels pending work on exit", () => {
    const source = images(); const apply = vi.fn<(texture: Texture) => void>();
    const renderer = createLocalSvgTexture(apply);
    renderer.update({ svg: "<svg>old</svg>" });
    const old = source.latest(); const oldLoad = old.onload; const oldError = old.onerror;
    renderer.update({ svg: "<svg>new</svg>" });
    oldLoad?.call(old, new Event("load")); oldError?.call(old, new Event("error"));
    expect(apply).not.toHaveBeenCalled(); expect(old.hasAttribute("src")).toBe(false);
    source.latest().dispatchEvent(new Event("error"));
    renderer.update({ svg: "<svg>new</svg>" }); expect(source.made).toHaveLength(3);
    const last = source.latest(); const lateLoad = last.onload;
    renderer.dispose(); lateLoad?.call(last, new Event("load"));
    expect(apply).not.toHaveBeenCalled(); expect(last.onload).toBeNull(); expect(last.onerror).toBeNull();
    expect(last.hasAttribute("src")).toBe(false);
  });
});
