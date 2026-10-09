/* The maths behind the inspector's Placement section: parent, XYZ + RPY, snap, drop to deck
   or ground, snap to grid, centre X.  Transforms are stored RELATIVE TO THE PARENT so a
   wrist-parented part follows the arm.  Needs three. */

import * as THREE from 'three';

/** snap steps the Placement section offers */
export const SNAP_MM = [1, 5, 20];
export const SNAP_DEG = [5, 15, 90];

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

/* parent-relative transforms */

/** A parent name resolved to a world matrix: "world", a link, a frame, or another part. */
export function parentMatrix(model, parent, parts) {
  /* "world" means the ROBOT frame, which is where a `frame: "robot"` component's transform
     lives — and the robot frame is not the world origin once the base has been driven
     (`model.setBasePose`).  Returning the identity here made
     `toLocal()` bake the base pose into the stored transform, and `worldMatrix` then applied
     it a second time: mate a part while driven and it jumped by twice the drive. */
  if (!parent || parent === 'world' || parent === 'root') {
    return model && model.baseMatrix ? model.baseMatrix() : new THREE.Matrix4();
  }
  if (parts && parts[parent] && parts[parent].world) return parts[parent].world.clone();
  if (model.hasLink && model.hasLink(parent)) return model.fk(parent);
  const f = model.frameMatrix(parent);
  if (f) return f;
  const c = model.component(parent);
  if (c) return model.worldMatrix(parent);
  return new THREE.Matrix4();
}

/** world = parent · local */
export function toWorld(model, parent, local, parts) {
  return new THREE.Matrix4().multiplyMatrices(parentMatrix(model, parent, parts), asM4(local));
}
/** local = parent⁻¹ · world — what to store when the gizmo drops a part in world space */
export function toLocal(model, parent, world, parts) {
  return new THREE.Matrix4().multiplyMatrices(parentMatrix(model, parent, parts).invert(), asM4(world));
}

/** `{position:[x,y,z], rotation:[r,p,y] degrees}` from a matrix, for the six mono fields. */
export function decompose(matrix) {
  const M = asM4(matrix);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  M.decompose(p, q, s);
  const e = new THREE.Euler().setFromQuaternion(q, 'ZYX');
  return {
    position: [p.x, p.y, p.z],
    rotation: [e.x * R2D, e.y * R2D, e.z * R2D],
    scale: [s.x, s.y, s.z],
  };
}
/** the inverse of `decompose` (scale is deliberately absent from the UI). */
export function compose(position, rotation_deg, scale) {
  const e = new THREE.Euler((rotation_deg[0] || 0) * D2R, (rotation_deg[1] || 0) * D2R, (rotation_deg[2] || 0) * D2R, 'ZYX');
  const M = new THREE.Matrix4().makeRotationFromEuler(e);
  M.scale(new THREE.Vector3(...(scale || [1, 1, 1])));
  M.setPosition(position[0] || 0, position[1] || 0, position[2] || 0);
  return M;
}

/** snap a translation / rotation triple to a step (Shift = fine → pass step 0) */
export function snap(values, step) {
  if (!step) return values.slice();
  return values.map((v) => Math.round(v / step) * step);
}

/* the five buttons */

/** the world-space bounding box of one geometry at a world matrix */
export function worldBox(geometry, world) {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  return geometry.boundingBox.clone().applyMatrix4(asM4(world));
}

/**
 * Translate along Z until the part's lowest point rests on a support.
 *
 * @param {object} o
 * @param {THREE.BufferGeometry} o.geometry
 * @param {THREE.Matrix4} o.world               the part's current world matrix
 * @param {(x,y,z)=>{z,what,id?}} [o.supportAt] a support query;
 *                                              without one, `o.z` or the ground is used
 * @param {number} [o.z]                        a literal support height
 * @returns {{world:THREE.Matrix4, dz:number, support:string, z:number}}
 */
export function dropTo(o) {
  const box = worldBox(o.geometry, o.world);
  const cx = (box.min.x + box.max.x) / 2, cy = (box.min.y + box.max.y) / 2;
  let s;
  if (Number.isFinite(o.z)) s = { z: o.z, what: o.support || 'plane' };
  else if (o.supportAt) s = o.supportAt(cx, cy, box.min.z - 1e-3);
  else s = { z: 0, what: 'ground' };
  const dz = s.z - box.min.z;
  const world = asM4(o.world).clone();
  world.elements[14] += dz;
  return { world, dz, support: s.what + (s.id ? ':' + s.id : ''), z: s.z };
}

/** Drop onto the package's deck plate (`frames.deck_grid.z`). */
export function dropToDeck(model, geometry, world) {
  const g = deckGrid(model);
  return dropTo({ geometry, world, z: g ? g.z : 0, support: 'deck' });
}
/** Drop onto the package's ground plane (`frame.ground_z`). */
export function dropToGround(model, geometry, world) {
  return dropTo({ geometry, world, z: Number.isFinite(model.groundZ) ? model.groundZ : 0, support: 'ground' });
}

export function deckGrid(model) {
  try {
    const g = model.frameData('deck_grid');
    return g && Number.isFinite(g.pitch) ? g : null;
  } catch (e) { return null; }
}

/**
 * Snap the part's XY centre to the nearest deck hole (`frames.deck_grid`:
 * pitch, z, radius).  Holes outside the usable radius are not offered.
 * @returns {{world, hole:[x,y], moved:[dx,dy], ok, why?}}
 */
export function snapToGrid(model, geometry, world, opts = {}) {
  const g = opts.grid || deckGrid(model);
  const W = asM4(world).clone();
  if (!g) return { world: W, hole: null, moved: [0, 0], ok: false, why: 'this package declares no deck grid' };
  const box = worldBox(geometry, W);
  const cx = (box.min.x + box.max.x) / 2, cy = (box.min.y + box.max.y) / 2;
  const pitch = g.pitch;
  let hx = Math.round(cx / pitch) * pitch, hy = Math.round(cy / pitch) * pitch;
  if (Number.isFinite(g.radius) && Math.hypot(hx, hy) > g.radius) {
    /* walk inwards to the nearest hole that is really on the plate */
    let best = null, bd = Infinity;
    const n = Math.ceil(g.radius / pitch);
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
      const x = i * pitch, y = j * pitch;
      if (Math.hypot(x, y) > g.radius) continue;
      const d = Math.hypot(x - cx, y - cy);
      if (d < bd) { bd = d; best = [x, y]; }
    }
    if (!best) return { world: W, hole: null, moved: [0, 0], ok: false, why: 'no hole within the usable radius' };
    [hx, hy] = best;
  }
  W.elements[12] += hx - cx;
  W.elements[13] += hy - cy;
  return { world: W, hole: [hx, hy], moved: [hx - cx, hy - cy], ok: true };
}

/** Robot-frame box of the parts no joint moves (chassis, deck, mounts), at zero pose. */
export function bodyBox(model) {
  const keep = model.getJoints();
  const joints = model.controlJoints();
  const box = new THREE.Box3();
  try {
    model.setJoints(Object.fromEntries(joints.map((k) => [k, 0])));
    const at0 = new Map();
    for (const c of model.components) {
      if (c.geometry && c.visible !== false && c.group !== 'imported') at0.set(c.id, model._worldMatrix(c.id));
    }
    model.setJoints(Object.fromEntries(joints.map((k, i) => [k, 7 + 3 * i])));
    for (const [id, A] of at0) {
      const B = model._worldMatrix(id);
      if (A.elements.some((v, i) => Math.abs(v - B.elements[i]) > 1e-6)) continue;
      box.union(worldBox(model.component(id).geometry, A));
    }
  } finally { model.setJoints(keep); }
  return box;
}

/**
 * Where a loose mesh lands: as authored when it clears the robot's body, else beside the
 * robot on the ground (+X side, 40 mm clear).  One offset for a whole set of meshes.
 * @returns {THREE.Matrix4|null} a robot-frame translation, or null to keep it where it is
 */
export function landing(model, geometries) {
  const box = new THREE.Box3();
  for (const g of geometries) box.union(worldBox(g, new THREE.Matrix4()));
  const body = bodyBox(model);
  if (box.isEmpty() || body.isEmpty() || !box.intersectsBox(body)) return null;
  const groundZ = Number.isFinite(model.groundZ) ? model.groundZ : 0;
  return new THREE.Matrix4().makeTranslation(body.max.x + 40 - box.min.x,
    (body.min.y + body.max.y) / 2 - (box.min.y + box.max.y) / 2, groundZ - box.min.z);
}

/** Centre the part on X = 0 (the robot's mirror plane). */
export function centreX(geometry, world, x = 0) {
  const W = asM4(world).clone();
  const box = worldBox(geometry, W);
  const dx = x - (box.min.x + box.max.x) / 2;
  W.elements[12] += dx;
  return { world: W, dx };
}

/* -------------------------------------------------------------------- utils */
function asM4(m) {
  if (!m) return new THREE.Matrix4();
  if (m.isMatrix4) return m;
  if (Array.isArray(m) && m.length === 16) return new THREE.Matrix4().fromArray(m);
  return new THREE.Matrix4();
}
