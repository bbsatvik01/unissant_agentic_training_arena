/** Lossless EXT_meshopt_compression; deliberately no quantization, weld, reorder, or simplification. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MeshoptEncoder } from '../web/node_modules/meshoptimizer/index.js';
import { MeshoptDecoder } from '../web/node_modules/three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from '../web/node_modules/three/examples/jsm/loaders/GLTFLoader.js';

const EXTENSION = 'EXT_meshopt_compression';
const MAX_BYTES = 5 * 1024 * 1024;
const local = (path) => fileURLToPath(new URL(path, import.meta.url));
const defaults = {
  input: local('../web/public/world/precinct.glb'),
  output: local('../web/public/world/precinct.glb'),
  manifest: local('../web/public/world/precinct-manifest.json'),
  source: local('./northstar-precinct.blend'),
  report: local('./compression-report.json'),
};
const { values } = parseArgs({ options: Object.fromEntries(Object.keys(defaults).map((key) => [key, { type: 'string' }])) });
const paths = { ...defaults, ...values };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const parseGlb = (bytes) => {
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  const binaryHeader = 20 + jsonLength;
  assert.equal(bytes.readUInt32LE(binaryHeader + 4), 0x004e4942);
  assert.equal(binaryHeader + 8 + bytes.readUInt32LE(binaryHeader), bytes.length);
  return {
    json: JSON.parse(bytes.toString('utf8', 20, binaryHeader)),
    binary: bytes.subarray(binaryHeader + 8),
  };
};
const writeGlb = (json, binary) => {
  const jsonBytes = Buffer.from(JSON.stringify(json));
  const jsonLength = Math.ceil(jsonBytes.length / 4) * 4;
  const binaryLength = Math.ceil(binary.length / 4) * 4;
  const result = Buffer.alloc(28 + jsonLength + binaryLength);
  result.write('glTF');
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(jsonLength, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  result.fill(0x20, 20, 20 + jsonLength);
  jsonBytes.copy(result, 20);
  result.writeUInt32LE(binaryLength, 20 + jsonLength);
  result.writeUInt32LE(0x004e4942, 24 + jsonLength);
  binary.copy(result, 28 + jsonLength);
  return result;
};
const sourceBytes = await readFile(paths.input);
const original = parseGlb(sourceBytes);
assert.equal(original.json.buffers.length, 1, 'Input must have one embedded GLB buffer');
assert.equal(original.json.buffers[0].uri, undefined, 'External data is unsupported');
assert(!original.json.extensionsUsed?.includes(EXTENSION), 'Input is already compressed; re-export from Blender first');
assert.equal(original.json.images?.length ?? 0, 0, 'This lossless pipeline is for the untextured precinct');
assert.equal(original.json.animations?.length ?? 0, 0);
const manifestBytes = await readFile(paths.manifest);
const manifest = JSON.parse(manifestBytes);
const sourceFile = await readFile(paths.source);
const json = structuredClone(original.json);
await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
assert(MeshoptEncoder.supported && MeshoptDecoder.supported);
const chunks = [];
const viewProofs = [];
let offset = 0;
for (const [index, view] of json.bufferViews.entries()) {
  assert.equal(view.buffer, 0);
  assert.equal(view.extensions, undefined, 'Unexpected source buffer-view extension');
  const accessors = json.accessors.filter((accessor) => accessor.bufferView === index);
  assert.equal(accessors.length, 1, 'Expected one tightly packed accessor per view');
  const accessor = accessors[0];
  assert.equal(accessor.sparse, undefined);
  assert.equal(accessor.byteOffset ?? 0, 0);
  const isIndex = accessor.type === 'SCALAR' && [5123, 5125].includes(accessor.componentType);
  assert(isIndex || (accessor.type === 'VEC3' && accessor.componentType === 5126));
  const stride = isIndex ? (accessor.componentType === 5123 ? 2 : 4) : 12;
  assert.equal(view.byteLength, accessor.count * stride);
  assert.equal(view.byteStride ?? stride, stride);
  const bytes = original.binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  // INDICES preserves exact index order. TRIANGLES can cyclically rotate a triangle's indices.
  const mode = isIndex ? 'INDICES' : 'ATTRIBUTES';
  const compressed = Buffer.from(MeshoptEncoder.encodeGltfBuffer(bytes, accessor.count, stride, mode, 0));
  const decoded = Buffer.alloc(view.byteLength);
  MeshoptDecoder.decodeGltfBuffer(decoded, accessor.count, stride, compressed, mode, 'NONE');
  assert.deepEqual(decoded, bytes, `Buffer view ${index} changed after decoding`);
  const padding = (4 - offset % 4) % 4;
  if (padding) { chunks.push(Buffer.alloc(padding)); offset += padding; }
  view.buffer = 1;
  view.extensions = { [EXTENSION]: { buffer: 0, byteOffset: offset, byteLength: compressed.length, byteStride: stride, count: accessor.count, mode, filter: 'NONE' } };
  chunks.push(compressed);
  offset += compressed.length;
  viewProofs.push({ index, mode, decodedBytes: bytes.length, compressedBytes: compressed.length, originalSha256: hash(bytes), decodedSha256: hash(decoded) });
}
json.buffers = [
  { byteLength: offset },
  { byteLength: original.json.buffers[0].byteLength, extensions: { [EXTENSION]: { fallback: true } } },
];
json.extensionsUsed = [...(json.extensionsUsed ?? []), EXTENSION];
json.extensionsRequired = [...(json.extensionsRequired ?? []), EXTENSION];
const output = writeGlb(json, Buffer.concat(chunks));
assert(output.length < MAX_BYTES, `Compressed asset must be below ${MAX_BYTES} bytes`);
const reread = parseGlb(output);
const reconstructed = Buffer.alloc(original.binary.length);
for (const [index, view] of reread.json.bufferViews.entries()) {
  const ext = view.extensions[EXTENSION];
  const decoded = Buffer.alloc(view.byteLength);
  MeshoptDecoder.decodeGltfBuffer(decoded, ext.count, ext.byteStride, reread.binary.subarray(ext.byteOffset, ext.byteOffset + ext.byteLength), ext.mode, ext.filter);
  assert.deepEqual(decoded, original.binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength), `Serialized view ${index} failed`);
  decoded.copy(reconstructed, view.byteOffset ?? 0);
}
assert.deepEqual(reconstructed, original.binary, 'Full decoded binary must be byte-identical, including zero padding');
// Only storage declarations and the required decoder extension may change in JSON.
const semantic = structuredClone(reread.json);
semantic.buffers = original.json.buffers;
semantic.bufferViews = original.json.bufferViews;
for (const key of ['extensionsUsed', 'extensionsRequired']) {
  if (key in original.json) semantic[key] = original.json[key]; else delete semantic[key];
}
assert.deepEqual(semantic, original.json, 'Scene/material/accessor metadata changed');
// Exercise the same loader and decoder shipped by the application, without a renderer.
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const asArrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const loadedBefore = await loader.parseAsync(asArrayBuffer(sourceBytes), '');
const loadedAfter = await loader.parseAsync(asArrayBuffer(output), '');
const meshSnapshot = (scene) => {
  const meshes = [];
  scene.traverse((object) => {
    if (!object.isMesh) return;
    const geometry = object.geometry;
    meshes.push({ name: object.name, matrix: object.matrix.elements, material: object.material.name,
      index: geometry.index ? { type: geometry.index.array.constructor.name, bytes: Buffer.from(geometry.index.array.buffer, geometry.index.array.byteOffset, geometry.index.array.byteLength) } : null,
      attributes: Object.fromEntries(Object.entries(geometry.attributes).map(([key, value]) => [key, { itemSize: value.itemSize, normalized: value.normalized, type: value.array.constructor.name, bytes: Buffer.from(value.array.buffer, value.array.byteOffset, value.array.byteLength) }])) });
  });
  return meshes;
};
assert.deepEqual(meshSnapshot(loadedAfter.scene), meshSnapshot(loadedBefore.scene), 'Three.js loaded mesh data differs');
manifest.performance.fileBytes = output.length;
const compareManifest = structuredClone(manifest);
compareManifest.performance.fileBytes = JSON.parse(manifestBytes).performance.fileBytes;
assert.deepEqual(compareManifest, JSON.parse(manifestBytes), 'Navigation or semantic manifest content changed');
const measuredTriangles = original.json.meshes.reduce((sum, mesh) => sum + mesh.primitives.reduce((total, primitive) => {
  assert.equal(primitive.mode ?? 4, 4);
  return total + original.json.accessors[primitive.indices ?? primitive.attributes.POSITION].count / 3;
}, 0), 0);
assert.equal(measuredTriangles, manifest.performance.triangles);
const report = {
  passed: true, compression: EXTENSION, encoder: 'meshoptimizer@1.1.1 (MIT)', decoder: 'Three.js bundled MeshoptDecoder',
  inputBytes: sourceBytes.length, outputBytes: output.length, committedFileLimitBytes: MAX_BYTES,
  bytesSaved: sourceBytes.length - output.length, reductionPercent: Number(((1 - output.length / sourceBytes.length) * 100).toFixed(4)),
  inputSha256: hash(sourceBytes), outputSha256: hash(output), sourceBytes: sourceFile.length, sourceSha256: hash(sourceFile),
  originalBinarySha256: hash(original.binary), decodedBinarySha256: hash(reconstructed),
  originalSceneMetadataSha256: hash(JSON.stringify(original.json)),
  triangles: measuredTriangles, meshMaterialGroups: original.json.meshes.length, materials: original.json.materials.length,
  nodes: original.json.nodes.length, accessors: original.json.accessors.length, compressedBufferViews: viewProofs.length,
  sourcePreserved: true, sceneMetadataUnchanged: true, allDecodedBufferBytesIdentical: true,
  threeLoaderMeshesIdentical: meshSnapshot(loadedAfter.scene).length, navigationAndCollidersUnchanged: true,
  geometryRemoved: false, quantization: false, triangleOrVertexReordering: false, textures: 0,
  browserRenderVerified: false, historySizeGateResolved: false,
  note: 'Byte-identical decoded geometry and identical scene/material metadata establish asset visual preservation. Browser integration/render and branch-history push-clean are separate checks.',
  bufferViews: viewProofs,
};
await writeFile(paths.output, output);
await writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(paths.report, `${JSON.stringify(report, null, 2)}\n`);
assert.equal((await stat(paths.output)).size, output.length);
console.log(JSON.stringify({ ...report, bufferViews: `${viewProofs.length} per-view hash proofs in report` }, null, 2));
