import { LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace, Texture } from "three";

export interface LocalSvgImage {
  /** Only a self-contained, locally serialized SVG. Never a remote URL. */
  readonly svg: string;
}

/** Owns exactly one visible texture and one pending browser decode; cancellation is latest-wins. */
export function createLocalSvgTexture(apply: (texture: Texture) => void, options: { readonly mipmaps?: boolean } = {}) {
  let visible: { image: HTMLImageElement; texture: Texture } | null = null;
  let pending: HTMLImageElement | null = null;
  let previousSource = "";
  let disposed = false;
  const releaseImage = (image: HTMLImageElement) => {
    image.onload = null; image.onerror = null; image.removeAttribute("src");
  };
  const cancelPending = () => {
    if (pending !== null) releaseImage(pending);
    pending = null;
  };
  return {
    update({ svg }: LocalSvgImage) {
      if (disposed || svg === previousSource) return;
      previousSource = svg;
      cancelPending();
      const image = new Image();
      pending = image;
      image.onload = () => {
        if (disposed || pending !== image) return;
        image.onload = null; image.onerror = null;
        pending = null;
        const texture = new Texture(image);
        texture.colorSpace = SRGBColorSpace;
        texture.minFilter = options.mipmaps === true ? LinearMipmapLinearFilter : LinearFilter; texture.magFilter = LinearFilter;
        texture.generateMipmaps = options.mipmaps === true; texture.needsUpdate = true;
        const previous = visible;
        visible = { image, texture };
        apply(texture);
        if (previous !== null) { previous.texture.dispose(); releaseImage(previous.image); }
      };
      image.onerror = () => {
        if (pending !== image) return;
        pending = null; previousSource = ""; releaseImage(image);
      };
      // The browser's SVG image sandbox has no script execution or document interaction.
      // React serializes every source string as text; the atlas includes no linked resources.
      // Text may contain malformed UTF-16 or XML-forbidden controls. Replace those display-only
      // code points rather than throwing in encodeURIComponent or breaking the entire atlas.
      const wellFormed = Array.from(svg, (character) => {
        const point = character.codePointAt(0) ?? 0;
        const control = point < 0x20 && point !== 9 && point !== 10 && point !== 13;
        return control || (point >= 0xd800 && point <= 0xdfff) || point === 0xfffe || point === 0xffff ? "\ufffd" : character;
      }).join("");
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(wellFormed)}`;
    },
    dispose() {
      disposed = true; cancelPending();
      if (visible !== null) { visible.texture.dispose(); releaseImage(visible.image); visible = null; }
    },
  };
}
