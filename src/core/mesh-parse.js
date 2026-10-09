/* Mesh decoding for core/package.js: one file's bytes -> a THREE.BufferGeometry, plus the
   archive path and JSON helpers its callers share.  Needs three and its addon loaders. */

import * as THREE from 'three';
import { strFromU8 } from 'fflate';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

/** A zip/OS path with forward slashes and no doubles. */
export function normSlashes(p) { return p.replace(/\\/g, '/').replace(/\/+/g, '/'); }

/** The path closest to the archive root — how the one real robot.json / meta.json is picked. */
export function pickShallowest(list) {
  if (!list.length) return null;
  return list.slice().sort((a, b) => (a.split('/').length - b.split('/').length) || a.localeCompare(b))[0];
}

export function parseJson(u8, name) {
  try { return JSON.parse(strFromU8(u8)); } catch (e) {
    throw new Error(`package: ${name} is not valid JSON — ${e.message}`);
  }
}

export function toArrayBuffer(u8) {
  if (u8 instanceof ArrayBuffer) return u8;
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

/* zip geometry */

export function geometryFromZip(entries, base, meshKey, warnings, names) {
  if (!meshKey) return null;
  const cands = [base + meshKey, meshKey, base + 'meshes/' + meshKey, meshKey.replace(/^\.\//, '')];
  let hit = cands.find((c) => entries[c]);
  if (!hit) {
    /* last resort: match on the basename — over the FILTERED name list, so a
       `__MACOSX/._part.stl` resource fork is never fed to the STL parser. */
    const want = meshKey.split('/').pop().toLowerCase();
    const pool = names || Object.keys(entries).filter((n) => !n.endsWith('/') && !/(^|\/)__MACOSX\//.test(n));
    hit = pool.find((n) => n.split('/').pop().toLowerCase() === want);
  }
  if (!hit) {
    warnings.push(`mesh "${meshKey}" is referenced by robot.json but is not in the zip`);
    return null;
  }
  /* one unreadable mesh is a warning, not the end of the import */
  try { return parseMesh(entries[hit], hit); }
  catch (e) { warnings.push(String(e.message || e).replace(/^package: /, '')); return null; }
}

/* mesh parsing */

const _stl = new STLLoader();

/** Parse one mesh file (bytes) by extension → THREE.BufferGeometry, or null. */
async function parseMeshAsync(bytes, name) {
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  if (ext === 'stl') return parseMesh(bytes, name);
  if (ext === 'obj') {
    const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
    return firstGeometry(new OBJLoader().parse(strFromU8(bytes)));
  }
  if (ext === '3mf') {
    const { ThreeMFLoader } = await import('three/addons/loaders/3MFLoader.js');
    return firstGeometry(new ThreeMFLoader().parse(toArrayBuffer(bytes)));
  }
  if (ext === 'dae') {
    const { ColladaLoader } = await import('three/addons/loaders/ColladaLoader.js');
    const res = new ColladaLoader().parse(strFromU8(bytes), '');
    return firstGeometry(res.scene);
  }
  if (ext === 'ply') {
    const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js');
    return new PLYLoader().parse(toArrayBuffer(bytes));
  }
  return null;
}

/** Synchronous parse — STL only (the format every path in the studio actually uses). */
export function parseMesh(bytes, name) {
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  if (ext && ext !== 'stl') return parseMeshAsync(bytes, name);      // a Promise; the model awaits it
  let g;
  try {
    g = _stl.parse(toArrayBuffer(bytes));
  } catch (e) {
    /* a truncated STL otherwise surfaces three's own "Offset is outside the bounds of the
       DataView"; the zip path has a human message for this and so must this one */
    throw new Error(`package: "${name}" is not a readable STL — the file is truncated or not an STL`);
  }
  const n = g.attributes && g.attributes.position ? g.attributes.position.count : 0;
  /* an 84-byte binary STL whose triangle count is 0 parsed happily and imported as a valid
     one-part robot with nothing in it */
  if (n < 3) throw new Error(`package: "${name}" has no triangles — there is no geometry to import`);
  if (!g.attributes.normal || allZero(g.attributes.normal)) g.computeVertexNormals();
  g.userData.meshKey = name;
  return g;
}

function allZero(attr) {
  const a = attr.array;
  for (let i = 0; i < Math.min(a.length, 96); i++) if (a[i] !== 0) return false;
  return true;
}

function firstGeometry(object3d) {
  const geos = [];
  object3d.updateMatrixWorld(true);
  object3d.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    geos.push(g);
  });
  if (!geos.length) return null;
  if (geos.length === 1) return geos[0];
  return mergeGeometries(geos);
}

/** Minimal position+normal merge — enough for import; CSG work happens in features/. */
function mergeGeometries(list) {
  let n = 0;
  for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  let o = 0;
  for (const g of list) {
    const p = g.attributes.position.array;
    pos.set(p, o * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}

/**
 * urdf-loader changed its mesh callback between 0.12 (`path, manager, done`) and 0.13
 * (`path, manager, material, done`).  Normalise to `(path, material, done)` so the studio
 * works with either, whatever the lockfile pins.
 */
export function meshCb(fn) {
  return (...args) => {
    const done = args[args.length - 1];
    const material = args.length >= 4 && typeof args[2] !== 'function' ? args[2] : undefined;
    return fn(args[0], material, done);
  };
}
