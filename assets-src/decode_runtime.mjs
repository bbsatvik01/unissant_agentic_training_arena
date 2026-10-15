/** Verify every decoded byte with the application decoder; optionally write a temporary audit GLB. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MeshoptDecoder } from '../web/node_modules/three/examples/jsm/libs/meshopt_decoder.module.js';

const EXT = 'EXT_meshopt_compression';
const local = (path) => fileURLToPath(new URL(path, import.meta.url));
const { values } = parseArgs({ options: { input: { type: 'string', default: local('../web/public/world/precinct.glb') }, output: { type: 'string' }, report: { type: 'string', default: local('./compression-report.json') } } });
const data = await readFile(values.input);
const proof = JSON.parse(await readFile(values.report, 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
assert.equal(data.toString('ascii', 0, 4), 'glTF');
assert.equal(data.readUInt32LE(4), 2);
assert.equal(data.readUInt32LE(8), data.length);
assert.equal(data.readUInt32LE(16), 0x4e4f534a);
const header = 20 + data.readUInt32LE(12);
assert.equal(data.readUInt32LE(header + 4), 0x004e4942);
assert.equal(header + 8 + data.readUInt32LE(header), data.length);
const json = JSON.parse(data.toString('utf8', 20, header));
assert.equal(hash(data), proof.outputSha256, 'Runtime differs from compression report; rerun compression');
assert(json.extensionsRequired.includes(EXT));
assert.equal(json.buffers.length, 2);
assert.equal(json.buffers[1].extensions[EXT].fallback, true);
assert(json.buffers.every((buffer) => buffer.uri === undefined));
const binary = data.subarray(header + 8);
const decoded = Buffer.alloc(Math.ceil(json.buffers[1].byteLength / 4) * 4);
assert.equal(proof.bufferViews.length, json.bufferViews.length);
await MeshoptDecoder.ready;
for (const [index, view] of json.bufferViews.entries()) {
  const ext = view.extensions[EXT];
  assert.equal(view.buffer, 1);
  assert.equal(ext.buffer, 0);
  assert.equal(ext.filter, 'NONE');
  assert.equal(ext.count * ext.byteStride, view.byteLength);
  assert(ext.byteOffset >= 0 && ext.byteOffset + ext.byteLength <= json.buffers[0].byteLength);
  const offset = view.byteOffset ?? 0;
  assert(offset >= 0 && offset + view.byteLength <= json.buffers[1].byteLength);
  const output = decoded.subarray(offset, offset + view.byteLength);
  MeshoptDecoder.decodeGltfBuffer(output, ext.count, ext.byteStride, binary.subarray(ext.byteOffset, ext.byteOffset + ext.byteLength), ext.mode, ext.filter);
  assert.equal(hash(output), proof.bufferViews[index].originalSha256, `Decoded view ${index} differs from source`);
  view.buffer = 0;
  delete view.extensions;
}
assert.equal(hash(decoded), proof.originalBinarySha256);
json.buffers = [{ byteLength: json.buffers[1].byteLength }];
for (const key of ['extensionsUsed', 'extensionsRequired']) {
  json[key] = json[key].filter((extension) => extension !== EXT);
  if (!json[key].length) delete json[key];
}
assert.equal(hash(JSON.stringify(json)), proof.originalSceneMetadataSha256, 'Scene/material/accessor metadata differs from source');
let triangles = 0;
let vertices = 0;
for (const mesh of json.meshes) for (const primitive of mesh.primitives) {
  assert.equal(primitive.mode ?? 4, 4);
  const position = json.accessors[primitive.attributes.POSITION];
  const positionView = json.bufferViews[position.bufferView];
  assert.equal(position.type, 'VEC3');
  assert.equal(position.componentType, 5126);
  vertices += position.count;
  for (let i = 0; i < position.count * 3; i++) assert(Number.isFinite(decoded.readFloatLE((positionView.byteOffset ?? 0) + (position.byteOffset ?? 0) + i * 4)));
  if (primitive.indices === undefined) { triangles += position.count / 3; continue; }
  const accessor = json.accessors[primitive.indices];
  const view = json.bufferViews[accessor.bufferView];
  const bytes = accessor.componentType === 5123 ? 2 : 4;
  assert.equal(accessor.type, 'SCALAR');
  assert([5123, 5125].includes(accessor.componentType));
  assert.equal(accessor.count % 3, 0);
  for (let i = 0; i < accessor.count; i++) {
    const at = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + i * bytes;
    assert((bytes === 2 ? decoded.readUInt16LE(at) : decoded.readUInt32LE(at)) < position.count, 'Index outside vertex array');
  }
  triangles += accessor.count / 3;
}
assert.equal(triangles, proof.triangles);
if (values.output) {
  assert.notEqual(values.output, values.input, 'Decoded audit output must not replace the compressed runtime');
  const encodedJson = Buffer.from(JSON.stringify(json));
  const jsonLength = Math.ceil(encodedJson.length / 4) * 4;
  const output = Buffer.alloc(28 + jsonLength + decoded.length);
  output.write('glTF'); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(jsonLength, 12); output.writeUInt32LE(0x4e4f534a, 16);
  output.fill(0x20, 20, 20 + jsonLength); encodedJson.copy(output, 20);
  output.writeUInt32LE(decoded.length, 20 + jsonLength); output.writeUInt32LE(0x004e4942, 24 + jsonLength);
  decoded.copy(output, 28 + jsonLength);
  assert.equal(hash(output), proof.inputSha256, 'Decoded GLB is not byte-identical to original export');
  await writeFile(values.output, output, { flag: 'wx' });
}
console.log(JSON.stringify({ passed: true, runtimeSha256: hash(data), decodedBinarySha256: hash(decoded), triangles, vertices, meshMaterialGroups: json.meshes.length, decodedBufferViews: json.bufferViews.length, sourceMetadataIdentical: true }, null, 2));
