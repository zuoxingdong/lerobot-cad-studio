/* Getting a RobotModel from somewhere — a shipped package (a composition resolved against
   its base, attachments and parts), a dropped zip, a URDF tree or a handful of loose STLs —
   all ending at RobotModel.fromPackage, so there is one FK and one placement convention.
   No DOM beyond File/Blob duck-typing, so every path is testable in Node.  Needs fflate,
   core/robot-model.js, compose.js, mesh-parse.js and recent-store.js. */

import * as THREE from 'three';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { RobotModel, validateManifest, ROBOT_SCHEMA } from './robot-model.js';
import { robotSource, resolveIn, geometryIn, currentSource } from './embedded.js';
import {
  normSlashes, pickShallowest, parseJson, geometryFromZip, parseMesh, meshCb
} from './mesh-parse.js';
import { loadImportedPackage, saveImportedPackage, saveRecent, listRecent } from './recent-store.js';
import { groupFiles } from './link-folder.js';

export { validateManifest, ROBOT_SCHEMA };
export {
  setRobotSource, listEmbedded, isEmbeddedRobot, embeddedManifest, embeddedThumbnail
} from './embedded.js';
export { parseMesh } from './mesh-parse.js';
export {
  setRecentStore, saveRecent, listRecent, onRecentChange,
  loadImportedPackage, saveAltBlob, loadAltBlob, saveAltRecord,
  listAltRecords, removeRecent, clearRecent
} from './recent-store.js';

/* Every zip the studio writes.  DOS times are local wall-clock fields, so the clock (or a
   fixed UTC instant) would tell a reader the writer's timezone: one constant, from local fields. */
export function zipFiles(files, level = 6) { return zipSync(files, { level, mtime: new Date(2000, 0, 1) }); }

/* embedded packages: core/embedded.js owns the source and resolution */

/**
 * Build a RobotModel for an embedded package: the composition resolved (base, hide, attach,
 * parts), then `attachments` resolved against the other embedded packages.
 * @param {string} robotId
 * @param {{loadGeometry?:boolean}} [opts]
 * @returns {Promise<RobotModel>}
 */
export async function loadEmbedded(robotId, opts = {}) {
  const src = await robotSource();
  const model = await resolveComposition(resolveIn(src, robotId).doc, {
    geometryLoader: (id) => geometryIn(src, id),
    resolvePackage: async (pkgId) => {
      if (!src.ROBOTS[pkgId]) throw new Error(`package: "${robotId}" attaches "${pkgId}", which is not an embedded package`);
      return resolveIn(src, pkgId).doc;
    }
  });
  if (opts.loadGeometry) await model.loadGeometries();
  return model;
}

/* composition */

/**
 * Turn a manifest (with optional `attachments`) into one RobotModel tree.
 * @param {object} manifest
 * @param {{geometryLoader?:(robotId:string)=>Function,
 *          resolvePackage?:(pkgId:string)=>Promise<object>,
 *          packages?:Object<string,object>, strict?:boolean}} [opts]
 * @returns {Promise<RobotModel>}
 */
export async function resolveComposition(manifest, opts = {}) {
  const mkLoader = opts.geometryLoader || (() => null);
  /* `_chain` is the ancestry of this call: a package already in it is a cycle, and a
     sentence beats the RangeError an A-attaches-B-attaches-A zip would give. */
  const chain = opts._chain || [];
  if (chain.includes(manifest.id)) {
    throw new Error(`package: "${manifest.id}" attaches itself — ${[...chain, manifest.id].join(' → ')}`);
  }
  if (chain.length >= 16) {
    throw new Error(`package: attachments are nested more than 16 deep — ${[...chain, manifest.id].join(' → ')}`);
  }
  const childOpts = { ...opts, _chain: [...chain, manifest.id] };
  const root = RobotModel.fromPackage(manifest, mkLoader(manifest.id), { strict: opts.strict });
  for (const att of manifest.attachments || []) {
    let sub = opts.packages && opts.packages[att.package];
    if (!sub && opts.resolvePackage) sub = await opts.resolvePackage(att.package);   // eslint-disable-line no-await-in-loop
    if (!sub) throw new Error(`package: cannot resolve attachment "${att.package}"`);
    const child = await resolveComposition(sub, childOpts);                           // eslint-disable-line no-await-in-loop
    if (att.at && !root.frameMatrix(att.at)) {
      throw new Error(`package: "${manifest.id}" attaches "${att.package}" at frame "${att.at}", `
        + `which is not one of ${root.frameNames().join(', ') || '(no frames)'}`);
    }
    root.attach(child, att.at, att.local, { id: att.id || att.package });
  }
  return root;
}

/* zip import */

const MESH_EXT = /\.(stl|obj|3mf|dae|ply)$/i;

/**
 * Import a zip.  Detects, in order:
 *   1. a `robot.json` package (anywhere in the zip; its folder becomes the package root)
 *   2. a part folder    → `{kind:'parts', folders}` (part.json, or meta.json, + mesh/ + print/)
 *   3. a URDF + meshes  → urdf-loader, and a generated robot.json-equivalent manifest
 *   4. loose meshes     → an assembly-only robot
 * @param {File|Blob|ArrayBuffer|Uint8Array} file
 * @param {{id?:string, name?:string, strict?:boolean}} [opts]
 * @returns {Promise<{model:RobotModel, manifest:object, kind:'package'|'urdf'|'meshes',
 *                    report:object, files:string[], warnings:string[]}>}
 */
export async function importZip(file, opts = {}) {
  const bytes = await toBytes(file);
  let entries;
  try {
    entries = unzipSync(bytes);
  } catch (e) {
    throw new Error('package: that file is not a readable zip — ' + e.message);
  }
  const names = Object.keys(entries).filter((n) => !n.endsWith('/') && !/(^|\/)__MACOSX\//.test(n));
  if (!names.length) throw new Error('package: the zip is empty');

  const warnings = [];
  const robotJson = pickShallowest(names.filter((n) => /(^|\/)robot\.json$/i.test(n)));
  if (robotJson) {
    const root = robotJson.slice(0, robotJson.length - 'robot.json'.length);
    const manifest = parseJson(entries[robotJson], robotJson);
    if (manifest && manifest.kind === 'attachment') {
      throw new Error(`package: "${manifest.id}" is an attachment, not a robot; import the robot that attaches it`);
    }
    /* sub-packages shipped alongside (a composition zip): the zip's robots/<id>/robot.json */
    const packages = {};
    for (const n of names.filter((x) => x !== robotJson && /(^|\/)robot\.json$/i.test(x))) {
      const sub = parseJson(entries[n], n);
      if (sub && sub.id) packages[sub.id] = { manifest: sub, root: n.slice(0, n.length - 'robot.json'.length) };
    }
    const report = validateManifest(manifest);
    if (!report.ok && opts.strict !== false) {
      throw new Error('package: robot.json is not a valid ' + ROBOT_SCHEMA + ' —\n  · ' + report.errors.join('\n  · '));
    }
    warnings.push(...report.warnings);
    const model = await resolveComposition(manifest, {
      strict: opts.strict,
      geometryLoader: (pkgId) => {
        const base = pkgId === manifest.id ? root : (packages[pkgId] ? packages[pkgId].root : root);
        return (meshKey) => geometryFromZip(entries, base, meshKey, warnings, names);
      },
      resolvePackage: async (pkgId) => {
        if (packages[pkgId]) return packages[pkgId].manifest;
        const src = currentSource() || (await robotSource().catch(() => null));
        if (src && src.ROBOTS[pkgId]) return resolveIn(src, pkgId).doc;
        throw new Error(`package: the zip attaches "${pkgId}" but does not contain it`);
      }
    });
    return { model, manifest, kind: 'package', report, files: names, warnings };
  }

  const folders = partFolders(names.map((n) => [n, entries[n]]), opts.name || (file && file.name));
  if (folders) return { kind: 'parts', folders, files: names, warnings };

  const urdfs = names.filter((n) => /\.urdf$/i.test(n));
  const urdfName = pickShallowest(urdfs);
  if (urdfName) {
    /* a zip may hold more than one robot; say which one was read and which were not */
    if (urdfs.length > 1) {
      const rest = urdfs.filter((n) => n !== urdfName);
      warnings.push(`this zip holds ${urdfs.length} URDFs — "${urdfName}" was imported; `
        + `${rest.join(', ')} ${rest.length === 1 ? 'was' : 'were'} ignored`);
    }
    const out = await importURDFFromEntries(entries, urdfName, names, opts, warnings);
    /* keep the bytes so a reload can rebuild this robot (it is in no bundle) */
    if (opts.remember !== false && out.model) await saveImportedPackage(out.model.id, bytes);
    return { ...out, kind: 'urdf', files: names };
  }

  const meshNames = names.filter((n) => MESH_EXT.test(n));
  if (!meshNames.length) {
    throw new Error('package: the zip has no robot.json, no .urdf and no .stl/.obj/.3mf — nothing to import');
  }
  const loose = meshNames.map((n) => ({ name: n.split('/').pop(), bytes: entries[n], path: n }));
  const out = await buildAssemblyPackage(loose, opts, warnings);
  if (opts.remember !== false && out.model) await saveImportedPackage(out.model.id, bytes);
  return { ...out, kind: 'meshes', files: names };
}

/* URDF import */

/**
 * Import a URDF tree (+ its meshes) that already lives in memory.
 * @param {Object<string,Uint8Array>} entries  path → bytes
 * @param {string} urdfName  the URDF's path inside `entries`
 */
async function importURDFFromEntries(entries, urdfName, names, opts, warnings) {
  const { default: URDFLoader } = await import('urdf-loader');
  const dir = urdfName.replace(/[^/]+$/, '');
  const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const byBase = new Map(names.map((n) => [n.split('/').pop().toLowerCase(), n]));

  const resolve = (p) => {
    const clean = String(p).replace(/^package:\/\/[^/]+\//, '').replace(/^\.\//, '');
    const tries = [clean, dir + clean, urdfName.replace(/[^/]+$/, '') + clean];
    for (const t of tries) {
      const hit = byLower.get(normSlashes(t).toLowerCase());
      if (hit) return hit;
    }
    return byBase.get(clean.split('/').pop().toLowerCase()) || null;
  };

  const loader = new URDFLoader();
  loader.parseCollision = false;
  const pending = [];
  loader.loadMeshCb = meshCb((pathToModel, material, onComplete) => {
    const hit = resolve(pathToModel);
    if (!hit) {
      warnings.push(`URDF references "${pathToModel}", which is not in the zip`);
      onComplete(null);
      return;
    }
    let g = null;
    try { g = parseMesh(entries[hit], hit); }
    catch (e) {
      warnings.push(String(e.message || e).replace(/^package: /, ''));
      onComplete(null);
      return;
    }
    if (g && g.then) {
      /* a non-STL mesh: resolve later, then patch the placeholder geometry in place */
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
      pending.push(g.then((real) => { if (real) mesh.geometry = real; }));
      onComplete(mesh);
      return;
    }
    onComplete(new THREE.Mesh(g, material));
  });

  const robot = loader.parse(strFromU8(entries[urdfName]));
  if (pending.length) await Promise.all(pending);

  const model = RobotModel.fromURDF(robot, {
    id: opts.id || importId(robot.robotName || urdfName.replace(/.*\//, '').replace(/\.urdf$/i, ''),
      (currentSource() && currentSource().ROBOTS) || null),
    name: opts.name || robot.robotName || 'Imported robot',
    source: { kind: 'urdf-zip', urdf: urdfName },
    urdf: urdfName
  });
  return { model, manifest: model.manifest, report: validateManifest(model.manifest), warnings };
}

/**
 * Import a URDF from a string plus a mesh resolver (the path package.js uses when the URDF
 * does not come out of a zip — e.g. a folder drop).
 * @param {string} urdfText
 * @param {(path:string)=>Uint8Array|null} readFile
 */
export async function importURDFText(urdfText, readFile, opts = {}) {
  const { default: URDFLoader } = await import('urdf-loader');
  const warnings = [];
  const loader = new URDFLoader();
  loader.parseCollision = false;
  const pending = [];
  loader.loadMeshCb = meshCb((p, material, onComplete) => {
    const bytes = readFile(p);
    if (!bytes) { warnings.push(`URDF references "${p}", which could not be read`); onComplete(null); return; }
    const g = parseMesh(bytes, p);
    if (g && g.then) {
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
      pending.push(g.then((real) => { if (real) mesh.geometry = real; }));
      onComplete(mesh);
      return;
    }
    onComplete(new THREE.Mesh(g, material));
  });
  const robot = loader.parse(urdfText);
  if (pending.length) await Promise.all(pending);
  const model = RobotModel.fromURDF(robot, opts);
  return { model, manifest: model.manifest, report: validateManifest(model.manifest), warnings, kind: 'urdf' };
}

/* loose files */

/**
 * Loose `.stl` / `.3mf` / `.obj` files → an assembly-only robot: every component sits in
 * the robot frame (`frame:"robot"`, identity `local`), there is no kinematics, and the
 * gizmo is what moves them.
 * @param {Array<File|{name:string, bytes:Uint8Array}>} files
 * @returns {Promise<{model:RobotModel, manifest:object, kind:'meshes', report:object, warnings:string[]}>}
 */
export async function importFiles(files, opts = {}) {
  const warnings = [];
  const list = [];
  const all = Array.from(files || []);
  /* a part folder chosen as files: part.json (or meta.json) with its meshes */
  if (all.some((f) => /(^|\/)(part|meta)\.json$/i.test(f.webkitRelativePath || f.name || ''))) {
    const pairs = [];
    for (const f of all) {
      const bytes = ArrayBuffer.isView(f.bytes) ? f.bytes : new Uint8Array(await toArrayBufferAsync(f));   // eslint-disable-line no-await-in-loop
      pairs.push([f.webkitRelativePath || f.name || '', bytes]);
    }
    const folders = partFolders(pairs, opts.name);
    if (folders) return { kind: 'parts', folders, files: pairs.map(([n]) => n), warnings };
  }
  for (const f of all) {
    const name = f.name || 'part.stl';
    if (!MESH_EXT.test(name)) { warnings.push(`skipped "${name}": not a mesh file`); continue; }
    /* `f.bytes` is the in-memory form the tests and the zip path hand us, and it must be
       a typed array: a real `File` also has a `bytes` member — `Blob.prototype.bytes()` —
       and that one is a method, not the data. */
    const bytes = ArrayBuffer.isView(f.bytes) ? f.bytes : new Uint8Array(await toArrayBufferAsync(f));    // eslint-disable-line no-await-in-loop
    list.push({ name, bytes, path: name });
  }
  if (!list.length) throw new Error('package: no .stl/.3mf/.obj files to import');
  const out = await buildAssemblyPackage(list, opts, warnings);
  /* KEEP THE BYTES, exactly as both zip branches do.  Without this the import got a Recents
     row that `reopenImported()` could never answer, and reopening it was a silent dead end.
     They are stored as the zip `importZip()` will read back, so the reopen path is one path. */
  if (opts.remember !== false && out.model) {
    try {
      const files = {};
      for (const f of list) files[f.path || f.name] = f.bytes;
      await saveImportedPackage(out.model.id, zipFiles(files, 0));
    } catch (e) { /* IndexedDB blocked, or the bytes are too big: the import still opens */ }
  }
  return { ...out, kind: 'meshes' };
}

async function buildAssemblyPackage(list, opts, warnings) {
  const geometries = new Map();
  const components = [];
  const seen = new Set();
  let firstError = null;
  for (const f of list) {
    let g = null;
    try {
      g = parseMesh(f.bytes, f.name);
      if (g && g.then) g = await g;                                                   // eslint-disable-line no-await-in-loop
    } catch (e) {
      firstError = firstError || String(e.message || e);
      warnings.push(String(e.message || e).replace(/^package: /, ''));
      continue;
    }
    if (!g) { warnings.push(`could not parse "${f.name}"`); continue; }
    let id = slug(f.name.replace(MESH_EXT, ''));
    let n = 1;
    while (seen.has(id)) id = slug(f.name.replace(MESH_EXT, '')) + '-' + (n += 1);
    seen.add(id);
    geometries.set(f.path, g);
    components.push({
      id,
      label: f.name,
      group: 'imported',
      frame: 'robot',
      local: null,
      mesh: f.path,
      color: '#9aa3ad',
      printable: true,
      source: 'import:' + f.name
    });
  }
  /* one bad file among many is a warning; when NOTHING survived, the user needs the reason */
  if (!components.length) throw new Error(firstError || 'package: every file failed to parse');
  const manifest = {
    schema: ROBOT_SCHEMA,
    id: opts.id || importId(components.length === 1 ? components[0].label : 'assembly',
      (currentSource() && currentSource().ROBOTS) || null),
    name: opts.name || (components.length === 1 ? components[0].label : `Imported (${components.length} parts)`),
    units: 'mm',
    up: 'z',
    source: { kind: 'files', count: components.length },
    frame: { notes: 'assembly only: no kinematics, every part sits in the robot frame' },
    kinematics: { root_link: null, units: 'mm', joints: [] },
    components,
    frames: {},
    cameras: []
  };
  const report = validateManifest(manifest);
  const model = RobotModel.fromPackage(manifest, (key) => geometries.get(key) || null, { strict: false });
  return { model, manifest, report, warnings };
}

/* export a package */

/**
 * Serialise a model back to a package zip (`robot.json` + `meshes/`), so a design that
 * started as a URDF or loose STLs can be saved as a first-class package.
 * @returns {Uint8Array} zip bytes
 */
export function exportPackageZip(model, opts = {}) {
  const files = {};
  const manifest = JSON.parse(JSON.stringify(model.manifest));

  /* one namespace for every mesh written into the zip, so `a/x.stl` and `b/x.stl` — which
     both flatten to the basename `x.stl` — cannot silently overwrite each other. */
  const taken = new Set();
  const meshPath = (meshKey, prefix) => {
    const safe = String(meshKey).replace(/^.*\//, '').replace(/[^\w.-]+/g, '_') || 'mesh';
    const stem = safe.replace(/\.stl$/i, '');
    let name = (prefix ? prefix + '_' : '') + stem + '.stl';
    let n = 2;
    while (taken.has(name.toLowerCase())) name = (prefix ? prefix + '_' : '') + stem + '-' + (n++) + '.stl';
    taken.add(name.toLowerCase());
    return 'meshes/' + name;
  };

  /** write one model's own meshes and rewrite its manifest's mesh keys in place */
  const writeMeshes = (m, mf, prefix) => {
    const rename = new Map();                     // old mesh key -> path inside the zip
    const byGeometry = new Map();                 // BufferGeometry -> path (keeps instancing)
    for (const c of m.ownComponents) {
      if (!c.mesh || !c.geometry || rename.has(c.mesh)) continue;
      /* instanced parts share one geometry (the packed data says so with `mesh_ref`);
         write the STL once and point every instance at it, or a 3-wheel robot ships the
         same mesh three times and stops being instanced on the far side. */
      const shared = byGeometry.get(c.geometry);
      if (shared) { rename.set(c.mesh, shared); continue; }
      const path = meshPath(c.mesh, prefix);
      rename.set(c.mesh, path);
      byGeometry.set(c.geometry, path);
      files[path] = stlBytes(c.geometry);
    }
    /* the manifest must point at what the zip actually holds */
    for (const c of mf.components || []) if (rename.has(c.mesh)) c.mesh = rename.get(c.mesh);
  };

  if (opts.meshes !== false) writeMeshes(model, manifest, '');

  /* Each attached package is written as a sibling `robots/<id>/robot.json` with its own
     meshes, or re-importing the exported zip fails: `manifest.attachments` names it and
     the zip does not contain it. */
  const seen = new Set([model.id]);
  const writeAttachments = (m) => {
    for (const a of m.attachments || []) {
      const sub = a.model;
      if (!sub || seen.has(sub.id)) continue;
      seen.add(sub.id);
      const subManifest = JSON.parse(JSON.stringify(sub.manifest));
      if (opts.meshes !== false) writeMeshes(sub, subManifest, sub.id.replace(/[^\w.-]+/g, '_'));
      files[`robots/${sub.id}/robot.json`] = strToU8(JSON.stringify(subManifest, null, 2));
      writeAttachments(sub);
    }
  };
  writeAttachments(model);

  files['robot.json'] = strToU8(JSON.stringify(manifest, null, 2));
  if (opts.readme) files['README.md'] = strToU8(opts.readme);
  for (const [name, bytes] of Object.entries(opts.extraFiles || {})) files[name] = bytes;
  return zipFiles(files);
}

/** Part folders among [path, bytes] pairs, or null when there is no part.json / meta.json. */
export function partFolders(pairs, name) {
  const folders = groupFiles(pairs.map(([n, b]) => [n, new Blob([b])]), name || 'part')
    .filter((f) => f.files.has('part.json') || f.files.has('meta.json'));
  return folders.length ? folders : null;
}

/** Binary STL of a BufferGeometry (mm, the geometry's own frame). */
export function stlBytes(geometry) {
  const pos = geometry && geometry.attributes && geometry.attributes.position;
  if (!pos) throw new Error('package: stlBytes() needs a BufferGeometry with a position attribute');
  const idx = geometry.index;
  const verts = idx ? idx.count : pos.count;
  if (verts % 3 !== 0) {
    throw new Error(`package: this geometry has ${verts} ${idx ? 'indices' : 'vertices'}, `
      + 'which is not a whole number of triangles — an STL needs triangles');
  }
  const tris = verts / 3;
  const buf = new ArrayBuffer(84 + tris * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris, true);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), cb = new THREE.Vector3(), nrm = new THREE.Vector3();
  let o = 84;
  for (let t = 0; t < tris; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    cb.subVectors(c, b); ab.subVectors(a, b); nrm.crossVectors(cb, ab).normalize();
    dv.setFloat32(o, nrm.x, true); dv.setFloat32(o + 4, nrm.y, true); dv.setFloat32(o + 8, nrm.z, true);
    dv.setFloat32(o + 12, a.x, true); dv.setFloat32(o + 16, a.y, true); dv.setFloat32(o + 20, a.z, true);
    dv.setFloat32(o + 24, b.x, true); dv.setFloat32(o + 28, b.y, true); dv.setFloat32(o + 32, b.z, true);
    dv.setFloat32(o + 36, c.x, true); dv.setFloat32(o + 40, c.y, true); dv.setFloat32(o + 44, c.z, true);
    dv.setUint16(o + 48, 0, true);
    o += 50;
  }
  return new Uint8Array(buf);
}

/** Re-open a kept import by id — what a reload of `#/design/import-…` needs. */
export async function reopenImported(id) {
  const bytes = await loadImportedPackage(id);
  if (!bytes) return null;
  try { return await importZip(bytes, { id }); } catch (e) { return null; }
}

/* small utils */

/* `slug()` keeps Unicode letters and digits (NFKD first, so `ä` reads as `a` where it
   can): stripping every non-ASCII character collapses two differently-named imports onto
   `part`, `part-2`, … and the user cannot tell them apart. */
/**
 * The id an IMPORTED robot gets: `import-<slug>-<6 hex>`.
 *
 * The `import-` prefix cannot collide with a package id — a URDF named `lekiwi` would
 * otherwise claim the route of the SHIPPED package and the import would disappear behind
 * it — and the hex keeps two imports of the same file apart.
 * @param {string} base  a human name to keep in the id
 * @param {object} [known]  a map of ids already taken (e.g. `ROBOTS`)
 */
export function importId(base, known) {
  const stem = slug(base).slice(0, 32);
  for (let i = 0; i < 8; i++) {
    const id = `import-${stem}-${randomHex(6)}`;
    if (!known || !known[id]) return id;
  }
  return `import-${stem}-${Date.now().toString(16)}`;
}
function randomHex(n) {
  const g = typeof crypto !== 'undefined' && crypto.getRandomValues
    ? () => crypto.getRandomValues(new Uint8Array(1))[0]
    : () => Math.floor(Math.random() * 256);
  let out = '';
  while (out.length < n) out += g().toString(16).padStart(2, '0');
  return out.slice(0, n);
}

/* One of three slug rules, deliberately: this one hyphenates for an id, slot-anchors.js
   uses underscores for a workspace alternative, urdf-manifest.js is ASCII-only. */
function slug(s) {
  const v = String(s == null ? '' : s).normalize('NFKD').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return v || 'part';
}

async function toArrayBufferAsync(f) {
  if (f.arrayBuffer) return f.arrayBuffer();
  if (f instanceof ArrayBuffer) return f;
  throw new Error('package: cannot read ' + (f && f.name ? f.name : 'that file'));
}

async function toBytes(file) {
  if (file instanceof Uint8Array) return file;
  if (file instanceof ArrayBuffer) return new Uint8Array(file);
  if (file && typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  throw new Error('package: importZip needs a File, Blob, ArrayBuffer or Uint8Array');
}
