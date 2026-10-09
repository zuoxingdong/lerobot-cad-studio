/* The packages this page ships (src/data/assets.js): one source, one resolved manifest per
   robot id.  Needs core/compose.js; the bundle is imported lazily so tests can inject their
   own. */

import { resolveRobot } from './compose.js';

let _source = null;
const _resolved = new Map();       // robot id -> {doc, meshes}

/**
 * Override where embedded packages come from.  `src/data/assets.js` reads the `packed.js` that
 * `tools/build/pack_assets.py` writes; tests inject their own table instead.
 * @param {{ROBOTS:object, PARTS?:object, loadGeometry:(owner:string, meshId:string)=>any}|null} src
 */
export function setRobotSource(src) { _source = src; _resolved.clear(); }

/** The current source, or null before it is loaded. */
export function currentSource() { return _source; }

export async function robotSource() {
  if (_source) return _source;
  try {
    _source = await import('../data/assets.js');
  } catch (e) {
    throw new Error('package: no robot data — src/data/packed.js is missing (run tools/build/pack_assets.py) '
      + 'and setRobotSource() was never called. ' + e.message);
  }
  return _source;
}

function partsOf(src) {
  return Object.keys(src.PARTS || {}).map((id) => ({ doc: src.PARTS[id].part, owner: 'part:' + id, from: `assets/parts/${id}/` }));
}

export function resolveIn(src, id, chain = []) {
  const hit = _resolved.get(id);
  if (hit) return hit;
  const entry = src.ROBOTS[id];
  if (!entry) throw new Error(`package: unknown robot "${id}" (have: ${Object.keys(src.ROBOTS).join(', ')})`);
  if (chain.includes(id)) throw new Error(`package: "${id}" is built on itself — ${[...chain, id].join(' → ')}`);
  const r = resolveRobot(entry.manifest, {
    robot: (b) => (src.ROBOTS[b] ? resolveIn(src, b, [...chain, id]) : null),
    parts: () => partsOf(src)
  });
  const out = { doc: r.manifest, meshes: r.meshes };
  _resolved.set(id, out);
  return out;
}

export function geometryIn(src, id) {
  const r = resolveIn(src, id);
  return (key) => {
    const hit = r.meshes.get(key);
    return hit ? src.loadGeometry(hit.owner, hit.mesh) : src.loadGeometry(id, key);
  };
}

/** true for an embedded package the user opens as a robot (not an attachment package). */
export function isEmbeddedRobot(robotId) {
  const e = _source && _source.ROBOTS[robotId];
  return !!e && e.manifest.kind !== 'attachment';
}

/** Ids of the embedded robots, compositions included; attachment packages are left out. */
export async function listEmbedded() {
  await robotSource();
  return Object.keys(_source.ROBOTS).filter(isEmbeddedRobot);
}

/** The resolved (`rps/robot@1`) manifest of an embedded package; needs the source loaded. */
export function embeddedManifest(robotId) {
  if (!_source) throw new Error('package: embeddedManifest() before the robot data is loaded');
  return resolveIn(_source, robotId).doc;
}

/** base64 PNG of an embedded package's thumbnail, or null. */
export function embeddedThumbnail(robotId) {
  const e = _source && _source.ROBOTS[robotId];
  return (e && e.thumbnail) || null;
}
