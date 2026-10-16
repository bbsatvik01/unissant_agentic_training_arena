import { Mesh, Texture, type Material, type Scene, type WebGLRenderer } from "three";

function dimension(value: unknown, name: "width" | "height"): number | null {
  if (value === null || typeof value !== "object" || !(name in value)) return null;
  const result: unknown = Reflect.get(value, name);
  return typeof result === "number" && Number.isFinite(result) && result > 0 ? result : null;
}

/** Run on explicit snapshot only, never in useFrame. Estimates are not measured GPU memory. */
export function inspectPrecinctScene(scene: Scene) {
  const textures = new Set<Texture>(); const materials = new Set<Material>();
  let meshes = 0; let uncullableMeshes = 0; let shadowCastingMeshes = 0;
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const mesh = object as Mesh;
    meshes += 1; if (!mesh.frustumCulled) uncullableMeshes += 1; if (mesh.castShadow) shadowCastingMeshes += 1;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
  });
  for (const material of materials) {
    for (const value of Object.values(material) as unknown[]) if (value instanceof Texture) textures.add(value as Texture);
  }
  let rgba8Bytes = 0; let unknownDimensions = 0;
  const dimensions: { width: number; height: number; mipmaps: boolean }[] = [];
  for (const texture of textures) {
    const source: unknown = texture.image;
    const width = dimension(source, "width"), height = dimension(source, "height");
    if (width === null || height === null) { unknownDimensions += 1; continue; }
    const mipmaps = texture.generateMipmaps || texture.mipmaps.length > 1;
    rgba8Bytes += width * height * 4 * (mipmaps ? 4 / 3 : 1); dimensions.push({ width, height, mipmaps });
  }
  return { environmentMapActive: scene.environment !== null, environmentIntensity: scene.environmentIntensity,
    meshes, uncullableMeshes, shadowCastingMeshes, uniqueMaterials: materials.size,
    transparentMaterials: [...materials].filter((material) => material.transparent).length,
    materialTextures: textures.size, unknownTextureDimensions: unknownDimensions, textureDimensions: dimensions,
    materialTextureRgba8MiBEstimate: rgba8Bytes / 1024 / 1024,
    textureEstimateCaveat: "RGBA8 + mip-chain estimate, deduplicated by Texture. Excludes environment/render targets; real formats, compression and driver allocation differ. Not measured VRAM." };
}

export function inspectPrecinctRenderer(gl: WebGLRenderer) {
  const context = gl.getContext(); const debug = context.getExtension("WEBGL_debug_renderer_info");
  const renderer: unknown = debug === null ? context.getParameter(context.RENDERER) : context.getParameter(debug.UNMASKED_RENDERER_WEBGL);
  const vendor: unknown = debug === null ? context.getParameter(context.VENDOR) : context.getParameter(debug.UNMASKED_VENDOR_WEBGL);
  const name = typeof renderer === "string" ? renderer : "unavailable";
  return { renderer: name, vendor: typeof vendor === "string" ? vendor : "unavailable", unmaskedAvailable: debug !== null,
    softwareRenderer: /swiftshader|llvmpipe|softpipe|software/i.test(name),
    contextLost: context.isContextLost(), webglVersion: String(context.getParameter(context.VERSION)),
    shadowsEnabled: gl.shadowMap.enabled, geometries: gl.info.memory.geometries, textures: gl.info.memory.textures,
    programs: gl.info.programs?.length ?? 0, actualGpuMemoryBytes: null,
    userAgent: navigator.userAgent, deviceDpr: window.devicePixelRatio,
    hardwareConcurrency: navigator.hardwareConcurrency };
}
