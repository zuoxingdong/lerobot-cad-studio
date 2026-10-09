/* Shared fixtures for tests/features/*.test.mjs.
 * Everything is built against the REAL generated package data
 * (`src/data/assets.js` + `core/package.js` + `core/robot-model.js`), never a mock,
 * so a number that moves here is a number that moved in the product. */

import * as THREE from 'three';
import * as pkg from '../../../src/core/package.js';
import { defaultDesign } from '../../../src/core/store.js';
import { buildSlots } from '../../../src/features/slots.js';
import { createCameras, adoptAllSlotOptions } from '../../../src/features/cameras.js';
import { createCollisionWorld } from '../../../src/features/collide.js';

export const ROBOT = 'lekiwi-pincopen';

let _cache = null;

/** model + slots + default design, built once per process. */
export async function studio() {
  if (_cache) return _cache;
  const model = await pkg.loadEmbedded(ROBOT);
  const slots = buildSlots(model);
  const design = slots.applyDefaults(defaultDesign(ROBOT));
  _cache = { model, slots, design, pkg };
  return _cache;
}

/** …plus a collision world primed on the default design (slow: builds BVHs). */
export async function withCollide() {
  const s = await studio();
  if (s.collide) return s;
  const collide = createCollisionWorld({ model: s.model });
  collide.setActiveFromDesign(s.design);
  collide.checkPose({});                     // force the BVH build + the baseline
  s.collide = collide;
  return s;
}

/**
 * The camera registry of the DEFAULT design, posed the way the page poses it.
 *
 * The package declares the camera DEVICE and the fitted slot option declares WHERE IT IS, so
 * a registry never handed a design has no poses at all — which is the point (see
 * `features/cameras.js adoptSlotOption`).  `fitted()` below is a registry for any other design.
 */
export async function withCameras() {
  const s = await studio();
  if (!s.cameras) s.cameras = createCameras(s.model);
  /* re-adopt on EVERY call, exactly as the page re-adopts on every reconcile: the
     registry is shared across the file, and a test that clears an override would
     otherwise leave the next one with an unposed camera. */
  adoptAllSlotOptions(s.cameras, s.slots, s.design);
  return s;
}

/** a registry posed by whatever `design` fits — `studio()`'s model and slots. */
export function fittedCameras(design, s) {
  const st = s || _cache;
  const cams = createCameras(st.model);
  adoptAllSlotOptions(cams, st.slots, design);
  return cams;
}

/** a FRESH registry posed by the DEFAULT design — for a test that must not share state. */
export async function freshCameras() {
  const s = await studio();
  return fittedCameras(s.design, s);
}

/** a small table printer, so a test run reads as a report */
export function table(title, rows) {
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (cells) => '  ' + cells.map((v, i) => String(v ?? '').padEnd(w[i])).join('  ');
  console.log('\n  ' + title);
  console.log(line(cols));
  console.log('  ' + w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(cols.map((c) => r[c])));
}

export const round = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n;
export const near = (a, b, tol) => Math.abs(a - b) <= tol;

/**
 * A tip FRAME (`features/tip.js flangeTip` / `hingeTip`) evaluated to a point in the robot
 * frame at a given pose — what `features/tip.js tipPoint()` does, and what the IK solver's
 * the cut IK solver's `tipPose()` did.
 * @param {object} model  a RobotModel
 * @param {{link:string, local:THREE.Matrix4}} frame
 * @param {object} [q]    joint values to pose at; the model's pose is restored afterwards
 * @returns {THREE.Vector3} in mm, robot frame
 */
export function tipAt(model, frame, q) {
  const keep = q ? model.getJoints() : null;
  if (q) model.setJoints(q);
  const base = (model.hasLink && model.hasLink(frame.link))
    ? model.fk(frame.link) : (model.frameMatrix(frame.link) || model.fk(frame.link));
  const p = new THREE.Vector3().setFromMatrixPosition(
    new THREE.Matrix4().multiplyMatrices(base, frame.local));
  if (keep) model.setJoints(keep);
  return p;
}

/* The corner mast's top camera at another index hole: its shipped sensor point, panned 10°,
   `tilt` nose-down (robot mm). */
export const CORNER_SENSOR = [-75.3399, -18.5711, 504.8547];
export function cornerTopFrames(tilt = 45, pan = 10) {
  const t = tilt * Math.PI / 180, p = pan * Math.PI / 180;
  return { cam_top: { origin: CORNER_SENSOR.slice(), tilt_deg: tilt,
    dir: [Math.sin(p) * Math.cos(t), Math.cos(p) * Math.cos(t), -Math.sin(t)] } };
}

