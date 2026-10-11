/**
 * Physically based materials for the world (D-025), with their textures drawn procedurally on a 2D canvas at load
 * time: speckled vinyl tile, painted plaster, acoustic fabric, oak laminate, brushed steel, cork. Each surface gets a
 * colour map and a matching normal map derived from the same height field, so light rakes across real-looking
 * grain and wear. Nothing is fetched; one cached instance per material is shared by every mesh that uses it.
 */
import {
  CanvasTexture,
  Color,
  LinearSRGBColorSpace,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from "three";

/** A small deterministic value noise, so textures are identical on every load. */
function noise2(seed: number): (x: number, y: number) => number {
  const hash = (x: number, y: number) => {
    let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = smooth(x - xi);
    const yf = smooth(y - yi);
    const a = hash(xi, yi);
    const b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1);
    const d = hash(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
}

interface Surface {
  readonly color: Texture;
  readonly normal: Texture;
  readonly roughness: Texture;
}

/** Draw a surface from a height-and-colour function: colour, roughness and a normal map from the height field. */
function surface(size: number, repeat: number, fn: (x: number, y: number) => { rgb: readonly [number, number, number]; h: number; r: number }): Surface {
  const height = new Float32Array(size * size);
  const color = document.createElement("canvas");
  const rough = document.createElement("canvas");
  const normal = document.createElement("canvas");
  for (const c of [color, rough, normal]) {
    c.width = size;
    c.height = size;
  }
  const cctx = color.getContext("2d");
  const rctx = rough.getContext("2d");
  const nctx = normal.getContext("2d");
  if (cctx === null || rctx === null || nctx === null) throw new Error("2D canvas unavailable");
  const cimg = cctx.createImageData(size, size);
  const rimg = rctx.createImageData(size, size);
  const nimg = nctx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const { rgb, h, r } = fn(x / size, y / size);
      const i = (y * size + x) * 4;
      cimg.data[i] = rgb[0];
      cimg.data[i + 1] = rgb[1];
      cimg.data[i + 2] = rgb[2];
      cimg.data[i + 3] = 255;
      const rv = Math.max(0, Math.min(255, Math.round(r * 255)));
      rimg.data[i] = rv;
      rimg.data[i + 1] = rv;
      rimg.data[i + 2] = rv;
      rimg.data[i + 3] = 255;
      height[y * size + x] = h;
    }
  }
  const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)] ?? 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 2;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 2;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      nimg.data[i] = Math.round(((-dx / len) * 0.5 + 0.5) * 255);
      nimg.data[i + 1] = Math.round(((dy / len) * 0.5 + 0.5) * 255);
      nimg.data[i + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      nimg.data[i + 3] = 255;
    }
  }
  cctx.putImageData(cimg, 0, 0);
  rctx.putImageData(rimg, 0, 0);
  nctx.putImageData(nimg, 0, 0);
  const wrap = (canvas: HTMLCanvasElement, srgb: boolean) => {
    const t = new CanvasTexture(canvas);
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = 8;
    t.colorSpace = srgb ? SRGBColorSpace : LinearSRGBColorSpace;
    return t;
  };
  return { color: wrap(color, true), normal: wrap(normal, false), roughness: wrap(rough, false) };
}

function mix(a: readonly [number, number, number], b: readonly [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const cache = new Map<string, MeshStandardMaterial>();

function cached(key: string, make: () => MeshStandardMaterial): MeshStandardMaterial {
  let m = cache.get(key);
  if (m === undefined) {
    m = make();
    cache.set(key, m);
  }
  return m;
}

function standard(s: Surface, extra: Partial<{ color: string; metalness: number; normalScale: number; envMapIntensity: number }> = {}): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ map: s.color, normalMap: s.normal, roughnessMap: s.roughness, roughness: 1, metalness: extra.metalness ?? 0 });
  if (extra.color !== undefined) m.color = new Color(extra.color);
  const n = extra.normalScale ?? 1;
  m.normalScale.set(n, n);
  m.envMapIntensity = extra.envMapIntensity ?? 1;
  return m;
}

/** Speckled vinyl tile with seams, for the interview room floor. */
export function vinylFloor(): MeshStandardMaterial {
  return cached("vinyl", () => {
    const n = noise2(3);
    return standard(
      surface(512, 3, (x, y) => {
        const tile = 4;
        const fx = (x * tile) % 1;
        const fy = (y * tile) % 1;
        const seam = Math.min(fx, fy, 1 - fx, 1 - fy) < 0.006 ? 1 : 0;
        const speck = n(x * 220, y * 220) > 0.86 ? 1 : 0;
        const cloud = n(x * 9, y * 9) * 0.5 + n(x * 31, y * 31) * 0.5;
        const tone = mix([196, 192, 184], [176, 172, 165], cloud);
        const rgb = seam === 1 ? mix(tone, [120, 118, 112], 0.6) : speck === 1 ? mix(tone, [92, 90, 86], 0.7) : tone;
        return { rgb, h: seam === 1 ? -1 : cloud * 0.05, r: 0.42 + cloud * 0.2 + seam * 0.3 };
      }),
      { normalScale: 0.6 },
    );
  });
}

/** Painted plaster with a faint roller texture, for walls. */
export function plaster(tint: "light" | "warm" | "dim" = "light"): MeshStandardMaterial {
  return cached(`plaster-${tint}`, () => {
    const n = noise2(7);
    const base: [number, number, number] = tint === "warm" ? [226, 221, 212] : tint === "dim" ? [126, 128, 132] : [222, 223, 224];
    return standard(
      surface(256, 4, (x, y) => {
        const v = n(x * 60, y * 60) * 0.6 + n(x * 160, y * 160) * 0.4;
        return { rgb: mix(base, [base[0] - 14, base[1] - 14, base[2] - 14], v * 0.6), h: v * 0.25, r: 0.82 + v * 0.1 };
      }),
      { normalScale: 0.4 },
    );
  });
}

/** Acoustic fabric panels (dark grey weave), on the interview room's side walls. */
export function acousticFabric(): MeshStandardMaterial {
  return cached("fabric", () => {
    const n = noise2(11);
    return standard(
      surface(256, 3, (x, y) => {
        const weave = (Math.sin(x * 900) * Math.sin(y * 900) + 1) / 2;
        const v = n(x * 80, y * 80);
        return { rgb: mix([72, 74, 78], [58, 60, 64], v * 0.7 + weave * 0.3), h: weave * 0.4 + v * 0.3, r: 0.95 };
      }),
      { normalScale: 0.8 },
    );
  });
}

/** Oak laminate with grain and light wear, for table tops and desks. */
export function oakLaminate(): MeshStandardMaterial {
  return cached("oak", () => {
    const n = noise2(5);
    return standard(
      surface(512, 1, (x, y) => {
        const grain = Math.sin(y * 180 + n(x * 6, y * 40) * 9) * 0.5 + 0.5;
        const fine = n(x * 400, y * 30);
        const wear = n(x * 14, y * 14) > 0.72 ? 1 : 0;
        const rgb = mix(mix([168, 128, 88], [138, 100, 64], grain * 0.7 + fine * 0.3), [186, 152, 112], wear * 0.25);
        return { rgb, h: grain * 0.15 + fine * 0.1, r: 0.48 + fine * 0.15 + wear * 0.15 };
      }),
      { normalScale: 0.5 },
    );
  });
}

/** Brushed steel, for table legs, chair frames, door hardware. */
export function brushedSteel(): MeshStandardMaterial {
  return cached("steel", () => {
    const n = noise2(13);
    return standard(
      surface(256, 2, (x, y) => {
        const brush = n(x * 2, y * 600);
        return { rgb: mix([150, 153, 158], [126, 129, 134], brush), h: brush * 0.2, r: 0.32 + brush * 0.18 };
      }),
      { metalness: 1, normalScale: 0.3 },
    );
  });
}

/** Cork, for the case board. */
export function cork(): MeshStandardMaterial {
  return cached("cork", () => {
    const n = noise2(17);
    return standard(
      surface(512, 2, (x, y) => {
        const v = n(x * 180, y * 180);
        const big = n(x * 25, y * 25);
        return { rgb: mix([176, 136, 96], [126, 92, 60], v * 0.7 + big * 0.3), h: v, r: 0.92 };
      }),
      { normalScale: 1.2 },
    );
  });
}

/** Wood planks, for the hub floor. */
export function woodPlanks(): MeshStandardMaterial {
  return cached("planks", () => {
    const n = noise2(19);
    return standard(
      surface(512, 4, (x, y) => {
        const rows = 8;
        const row = Math.floor(y * rows);
        const offset = (row * 0.37) % 1;
        const fx = (x + offset) % 1;
        const seam = (y * rows) % 1 < 0.02 || fx % 0.5 < 0.004 ? 1 : 0;
        const grain = Math.sin(fx * 120 + n(fx * 10, y * 50) * 6) * 0.5 + 0.5;
        const plank = n(row * 3.1, Math.floor((x + offset) * 2) * 1.7);
        const rgb = mix(mix([150, 112, 76], [116, 84, 54], grain * 0.5 + plank * 0.5), [70, 52, 36], seam * 0.7);
        return { rgb, h: seam === 1 ? -1 : grain * 0.1, r: 0.55 + grain * 0.1 + seam * 0.3 };
      }),
      { normalScale: 0.6 },
    );
  });
}

/** Plain painted or plastic surfaces, by name. */
export function paint(key: "ink" | "chair" | "frame" | "white" | "monitor" | "observation" | "cabinet" | "door" | "rubber"): MeshStandardMaterial {
  return cached(`paint-${key}`, () => {
    const spec: Readonly<Record<typeof key, readonly [string, number, number]>> = {
      ink: ["#1c1c1e", 0.55, 0],
      chair: ["#232427", 0.6, 0],
      frame: ["#2a2b2e", 0.4, 0.6],
      white: ["#f2f2f0", 0.6, 0],
      monitor: ["#121214", 0.35, 0.2],
      observation: ["#5d6066", 0.85, 0],
      cabinet: ["#8a8d92", 0.45, 0.7],
      door: ["#6f6a63", 0.55, 0],
      rubber: ["#0f0f10", 0.9, 0],
    };
    const [color, roughness, metalness] = spec[key];
    return new MeshStandardMaterial({ color, roughness, metalness });
  });
}

/** Emissive panel for practical lights and screens (bloom picks these up). */
export function emissive(key: "ceiling" | "screen" | "screenDim" | "daylight" | "led"): MeshStandardMaterial {
  return cached(`emissive-${key}`, () => {
    const spec: Readonly<Record<typeof key, readonly [string, number]>> = {
      ceiling: ["#fffaf0", 2.2],
      screen: ["#dfe9ff", 1.6],
      screenDim: ["#3a4458", 0.6],
      daylight: ["#e9f1ff", 1.8],
      led: ["#ff3b30", 4],
    };
    const [color, intensity] = spec[key];
    return new MeshStandardMaterial({ color: "#000000", emissive: color, emissiveIntensity: intensity, roughness: 1 });
  });
}

let glassMaterial: MeshPhysicalMaterial | null = null;

/** The one-way mirror: a dark, glossy, faintly see-through pane that reflects the room's environment. */
export function oneWayGlass(): MeshPhysicalMaterial {
  glassMaterial ??= new MeshPhysicalMaterial({
    color: "#2b3036",
    metalness: 0.6,
    roughness: 0.04,
    transparent: true,
    opacity: 0.42,
    envMapIntensity: 1.6,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
  });
  return glassMaterial;
}
