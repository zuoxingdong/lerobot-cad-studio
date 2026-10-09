/* The page's packaged robots, parts and scenes: the data is src/data/packed.js (npm run pack writes it),
   this module the API over it.  Meshes decode once, on first use, and are cached by "<owner>:<meshId>". */

import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { gunzipSync } from 'fflate';
import { ROBOTS, PARTS, SCENES } from './packed.js';

export { ROBOTS, PARTS, SCENES };

const _loader = new STLLoader();
const _geom = new Map();          // "<owner>:<meshId>" -> THREE.BufferGeometry

/** true for a package the user opens as a robot; an attachment package (`kind: "attachment"`)
    is only reached through the composition that attaches it. */
export function isRobot(robotId) { return !!ROBOTS[robotId] && ROBOTS[robotId].manifest.kind !== 'attachment'; }
/** robot ids a user can open, home-page order. */
export function robotIds() { return Object.keys(ROBOTS).filter(isRobot); }
/** part ids in this bundle. */
export function partIds() { return Object.keys(PARTS); }
/** the raw robot.json of a package (an rps/robot@2 composition is NOT resolved here). */
export function manifest(robotId) { return ROBOTS[robotId].manifest; }
/** a part.json, with its fitted print data. */
export function part(partId) { return PARTS[partId] ? PARTS[partId].part : null; }
/** a scene.json. */
export function scene(sceneId) { return SCENES[sceneId] ? SCENES[sceneId].scene : null; }

function _table(owner) {
  if (owner.startsWith('part:')) {
    const p = PARTS[owner.slice(5)];
    if (!p) throw new Error('assets: unknown part "' + owner.slice(5) + '"');
    return p.meshes;
  }
  const r = ROBOTS[owner];
  if (!r) throw new Error('assets: unknown robot "' + owner + '"');
  return r.meshes;
}

/** "<owner>:<meshId>" of whoever stores this mesh (follows mesh_ref); owner = robot id or "part:<id>". */
export function meshOwner(owner, meshId) {
  let o = owner, mid = meshId;
  for (let i = 0; i < 8; i++) {
    const m = _table(o)[mid];
    if (!m) throw new Error('assets: unknown mesh "' + mid + '" in "' + o + '"');
    if (!m.mesh_ref) return o + ':' + mid;
    const c = m.mesh_ref.lastIndexOf(':');
    o = m.mesh_ref.slice(0, c);
    mid = m.mesh_ref.slice(c + 1);
  }
  throw new Error('assets: mesh_ref cycle at ' + owner + ':' + meshId);
}

function _b64(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function _build(key, bytes) {
  const g = _loader.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  g.computeVertexNormals();       // stored facet normals are zeroed -> flat CAD shading
  g.userData.meshKey = key;
  _geom.set(key, g);
  return g;
}

function _stored(key) {
  const c = key.lastIndexOf(':');
  return _table(key.slice(0, c))[key.slice(c + 1)];
}

/** true when loadGeometry() can answer from cache with no decoding work. */
export function isLoaded(owner, meshId) { return _geom.has(meshOwner(owner, meshId)); }

/**
 * THREE.BufferGeometry for one mesh, in that mesh's own frame (mm), SYNCHRONOUSLY.
 * Instanced meshes share one geometry object - place them with the component's matrix.
 */
export function loadGeometry(owner, meshId) {
  const key = meshOwner(owner, meshId);
  const g = _geom.get(key);
  if (g) return g;
  return _build(key, gunzipSync(_b64(_stored(key).stl_gz)));
}

/** same, as a Promise; uses the native DecompressionStream('gzip') when available. */
export async function loadGeometryAsync(owner, meshId) {
  const key = meshOwner(owner, meshId);
  const g = _geom.get(key);
  if (g) return g;
  if (typeof DecompressionStream !== 'undefined') {
    try {
      const s = new Blob([_b64(_stored(key).stl_gz)]).stream().pipeThrough(new DecompressionStream('gzip'));
      const ab = await new Response(s).arrayBuffer();
      return _geom.get(key) || _build(key, new Uint8Array(ab));
    } catch (e) { /* fall through to the synchronous decoder */ }
  }
  return loadGeometry(owner, meshId);
}

/** decode every mesh of one owner; onProgress(done, total, meshId) optional. */
export async function preloadAll(owner, onProgress) {
  const ids = Object.keys(_table(owner));
  let done = 0;
  for (const id of ids) {
    await loadGeometryAsync(owner, id);
    done += 1;
    if (onProgress) onProgress(done, ids.length, id);
    if (done % 8 === 0) await new Promise((r) => setTimeout(r, 0));
  }
}

export default ROBOTS;
