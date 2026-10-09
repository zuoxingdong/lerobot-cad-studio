/* core/robot-model.js over the shipped packages: FK, placement and composition, against the
 * committed snapshot, an independent reference FK and measured preset tips. */

import * as THREE from 'three';
import { RobotModel, validateManifest, mat4, matrixMaxDiff, manifestFromURDF, ROBOT_SCHEMA } from '../../../src/core/robot-model.js';
import { readFileSync } from 'node:fs';
import * as PKG from '../../../src/core/package.js';
import { geometryIn, currentSource } from '../../../src/core/embedded.js';

await PKG.listEmbedded();
/* the resolved manifest of a shipped package, and the world matrix at zero the committed
   snapshot holds for each component (verified against an independent FK when it was taken) */
const MANIFEST = (id) => PKG.embeddedManifest(id);
const SNAP = JSON.parse(readFileSync(new URL('../fixtures/packages-snapshot.json', import.meta.url), 'utf8'));
const stored = (id, cid) => SNAP[id].components[cid].world;
import * as V3 from '../fixtures/v3-reference.mjs';
import { test, run, close, closeMatrix, throws, ok, eq, defaultCameraMatrix } from './_harness.mjs';

const TOL = 1e-6;
const DEG = Math.PI / 180;

/* the shipped packages */
const build = (id) => RobotModel.fromPackage(MANIFEST(id), geometryIn(currentSource(), id));
const lekiwi = () => build('lekiwi');
const pincopen = () => build('pincopen');

/** lekiwi-pincopen as `resolveComposition` builds it: base inlined + pincopen attached. */
function composed() {
  const base = build('lekiwi-pincopen');
  base.attach(pincopen(), 'wrist_flange', null, { id: 'pincopen' });
  return base;
}

const N = {
  lekiwi: MANIFEST('lekiwi').components.length,
  pincopen: MANIFEST('pincopen').components.length,
  composed: MANIFEST('lekiwi-pincopen').components.length
};

/* An INDEPENDENT reference FK: build the chain in URDF metres and scale at the end, which
   is the other way round from robot-model.js (which scales each joint's translation).
   Agreement proves the S·M·S⁻¹ conjugation claim in the module header. */
function referenceFK(manifest, qDeg) {
  const K = manifest.kinematics;
  const P = Object.create(null);
  P[K.root_link] = new THREE.Matrix4();
  for (let pass = 0; pass < K.joints.length + 2; pass++) {
    let moved = false;
    for (const j of K.joints) {
      if (!P[j.parent] || P[j.child]) continue;
      const e = new THREE.Euler(j.rpy[0], j.rpy[1], j.rpy[2], 'ZYX');
      const M = new THREE.Matrix4().makeRotationFromEuler(e);
      M.setPosition(j.xyz[0], j.xyz[1], j.xyz[2]);                 // metres, unscaled
      const q = (qDeg[j.name] || 0) * DEG;
      if (q && (j.type === 'revolute' || j.type === 'continuous')) {
        const ax = new THREE.Vector3(j.axis[0], j.axis[1], j.axis[2]).normalize();
        M.multiply(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromAxisAngle(ax, q)));
      }
      P[j.child] = new THREE.Matrix4().multiplyMatrices(P[j.parent], M);
      moved = true;
    }
    if (!moved) break;
  }
  /* metres → mm at the very end: S · FK · S⁻¹ */
  for (const k of Object.keys(P)) {
    P[k].elements[12] *= 1000; P[k].elements[13] *= 1000; P[k].elements[14] *= 1000;
  }
  return P;
}

/* schema */

test('both robots and the PincOpen attachment validate against rps/robot@1', () => {
  for (const name of ['lekiwi', 'pincopen', 'lekiwi-pincopen']) {
    const r = validateManifest(MANIFEST(name));
    ok(r.ok, `${name}: ${r.errors.join('; ')}`);
  }
});

test('validateManifest says what is wrong, readably', () => {
  const r = validateManifest({ schema: 'rps/robot@1', id: 'x', components: [{ id: 'a', frame: 'link' }] });
  ok(!r.ok);
  ok(r.errors.some((e) => /needs a link/.test(e)), r.errors.join('; '));
  const dup = validateManifest({ schema: 'rps/robot@1', id: 'x', components: [{ id: 'a' }, { id: 'a' }] });
  ok(dup.errors.some((e) => /duplicate component id/.test(e)));
  throws('fromPackage rejects a bad manifest', () => RobotModel.fromPackage({ id: 'x' }), /invalid manifest/);
});

/* shape */

test('the shipped LeKiwi package builds: 45 links, 44 joints, 45 components', () => {
  const m = lekiwi();
  eq(m.links.length, 45);
  eq(m.joints.length, 44);
  eq(m.components.length, N.lekiwi);
  eq(m.rootLink, 'base_plate_layer1-v5');
  const wheels = m.components.filter((c) => /^4-Omni/.test(c.id));
  eq(wheels.length, 3);
  ok(wheels[0].geometry && wheels[0].geometry === wheels[1].geometry && wheels[1].geometry === wheels[2].geometry,
    'the three wheels must share one BufferGeometry');
});

/* verified: zero pose */

test('verified — zero-pose world matrices == the snapshot of each robot', () => {
  for (const id of ['lekiwi', 'lekiwi-pincopen']) {
    const m = build(id);
    let worst = 0, worstId = '', n = 0;
    for (const c of MANIFEST(id).components) {
      n += 1;
      const e = matrixMaxDiff(m.worldMatrix(c.id), mat4(stored(id, c.id)));
      if (e > worst) { worst = e; worstId = c.id; }
    }
    eq(n, MANIFEST(id).components.length);
    ok(worst <= TOL, `${id} / ${worstId}: ${worst}`);
  }
});

/* verified: the 7 poses */

test('verified — world == FK(link)·local at all 7 poses (independent reference FK)', () => {
  const manifest = MANIFEST('lekiwi');
  const m = RobotModel.fromPackage(manifest, null);
  const poses = { ...V3.EXTRA_POSES, ...V3.PRESETS };
  let worstAll = 0, worstPose = '';
  for (const [name, q] of Object.entries(poses)) {
    m.setJoints({ ...m.zeroPose(), ...q });
    const ref = referenceFK(manifest, q);
    let worst = 0, id = '';
    for (const c of m.components) {
      const expect = c.frame === 'robot'
        ? c.local.clone()
        : new THREE.Matrix4().multiplyMatrices(ref[c.link] || new THREE.Matrix4(), c.local);
      const e = matrixMaxDiff(m.worldMatrix(c.id), expect);
      if (e > worst) { worst = e; id = c.id; }
    }
    if (worst > worstAll) { worstAll = worst; worstPose = name + ' / ' + id; }
    ok(worst <= TOL, `${name}: ${id} off by ${worst}`);
  }
});

/* verified: preset tips */

const VERIFY_8 = {
  stowed: { jaw: [-24.6, -4.1, 195.7], tip: [-4.8, 97.5, 210.7] },
  'reach floor': { jaw: [-24.6, 153.2, 6.5], tip: [-4.8, 253.7, -14.1] },
  'reach table': { jaw: [-24.6, 135.3, 247.5], tip: [-4.8, 237.9, 242.9] },
  'raised max': { jaw: [-24.6, 141.3, 465.7], tip: [-4.8, 154.8, 567.4] }
};

test('verified — the four presets put the jaw origin and the PincOpen tip where they were measured', () => {
  const m = composed();
  for (const [name, q] of Object.entries(V3.PRESETS)) {
    m.setJoints({ ...m.zeroPose(), ...q });
    const jaw = new THREE.Vector3().setFromMatrixPosition(m.fk('Moving_Jaw_08d-v1'));
    const tip = new THREE.Vector3(70.6, 0, 0).applyMatrix4(m.frameMatrix('wrist_flange'));
    const want = VERIFY_8[name];
    const dJaw = maxAxis(jaw, want.jaw);
    const dTip = maxAxis(tip, want.tip);
    ok(dJaw <= 0.051 && dTip <= 0.051, `${name}: jaw Δ${dJaw.toFixed(3)} tip Δ${dTip.toFixed(3)}`);
  }
});

/* verified: the wheels */

const VERIFY_5 = [
  ['4-Omni-Directional-Wheel_Single_Body-v1', [-106.18, 60.60, 17.86]],
  ['4-Omni-Directional-Wheel_Single_Body-v1-1', [106.27, 62.06, 17.86]],
  ['4-Omni-Directional-Wheel_Single_Body-v1-2', [0.61, -142.26, 17.86]]
];

test('verified — the three wheel centres, and they do not move with the arm', () => {
  const m = lekiwi();
  const centre = (id) => {
    const g = m.component(id).geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    return new THREE.Box3().copy(g.boundingBox).applyMatrix4(m.worldMatrix(id)).getCenter(new THREE.Vector3());
  };
  const zero = {};
  for (const [id, want] of VERIFY_5) {
    const c = centre(id);
    zero[id] = c.clone();
    const d = c.distanceTo(new THREE.Vector3(...want));
    ok(d <= 0.01, `${id}: ${c.toArray().map((v) => v.toFixed(2))} vs ${want}`);
  }
  let drift = 0;
  for (const q of Object.values(V3.PRESETS)) {
    m.setJoints({ ...m.zeroPose(), ...q });
    for (const [id] of VERIFY_5) drift = Math.max(drift, centre(id).distanceTo(zero[id]));
  }
  ok(drift <= 1e-9);
});

/* composition */

test('composition — PincOpen lands on the wrist flange', () => {
  const m = composed();
  m.setJoints(m.zeroPose());
  /* the package's own ground truth… */
  const packed = mat4(MANIFEST('lekiwi-pincopen').frames.wrist_flange.matrix_at_zero);
  closeMatrix('wrist_flange vs matrix_at_zero', m.frameMatrix('wrist_flange'), packed, TOL);
  /* …and the v3 number it has to keep reproducing */
  const v3 = mat4(V3.v3Frames().wrist_mount.matrix);
  closeMatrix('wrist_flange vs the v3 wrist_mount', m.frameMatrix('wrist_flange'), v3, TOL);
  closeMatrix('attachMatrix(pincopen)', m.attachMatrix('pincopen'), packed, TOL);

  let worst = 0, id = '', n = 0;
  for (const c of MANIFEST('pincopen').components) {
    n += 1;
    const want = mat4(stored('lekiwi-pincopen', 'pincopen/' + c.id));
    const e = matrixMaxDiff(m.worldMatrix('pincopen/' + c.id), want);
    if (e > worst) { worst = e; id = c.id; }
  }
  eq(n, N.pincopen);
  ok(worst <= TOL, `${id}: ${worst}`);
});

test('composition — the gripper follows the arm, and detach() puts it back', () => {
  const m = composed();
  eq(m.components.length, N.composed + N.pincopen);
  eq(m.components.length, 78);   /* 56 inline + 22 attached (PincOpen + its drive motor) */
  eq(m.cameras.map((c) => c.id).join(','), 'front,wrist,top');
  const at0 = new THREE.Vector3().setFromMatrixPosition(m.attachMatrix('pincopen'));
  m.setJoints({ arm_shoulder_pan: 30, arm_shoulder_lift: -90 });
  const at1 = new THREE.Vector3().setFromMatrixPosition(m.attachMatrix('pincopen'));
  ok(at0.distanceTo(at1) > 100, 'the attachment must follow the arm');
  const cam = new THREE.Vector3().setFromMatrixPosition(defaultCameraMatrix(m, 'wrist'));
  ok(cam.distanceTo(at1) < 300, 'the wrist camera stays near the flange');
  const top = new THREE.Vector3().setFromMatrixPosition(defaultCameraMatrix(m, 'top'));
  close('the mast camera is bolted to the deck', top.z, 504.8546824323, 1e-6, 'mm');
  m.detach('pincopen');
  eq(m.components.length, N.composed);
  eq(m.frameNames().includes('pincopen'), false);
});

function maxAxis(v, want) {
  return Math.max(Math.abs(v.x - want[0]), Math.abs(v.y - want[1]), Math.abs(v.z - want[2]));
}

/* cameras, frames, boxes */

test('cameras — the DEVICE is the package\'s, the MOUNT is the fitted option\'s', () => {
  const m = lekiwi();
  for (const c of m.cameras) {
    eq(c.posed, false, `${c.id}: the package declares a device, not a mount`);
    eq(m.cameraMatrix(c.id), null, `${c.id}: nothing poses it until an option does`);
  }
  const want = mat4([1, 0, 0, 0, 0, -0.173648177667, 0.984807753012, 0, 0, -0.984807753012, -0.173648177667, 0, 0, 111.752153256, 25.0531121631, 1]);
  closeMatrix('front camera world (front_camera → stock)', defaultCameraMatrix(m, 'front'), want, 1e-6);
  close('front vFOV (87.3° hFOV, 4:3)', m.cameraVFov('front'), 71.1647, 1e-3, '°');
  /* the stock wrist camera hangs off the arm, so it moves */
  const w0 = new THREE.Vector3().setFromMatrixPosition(defaultCameraMatrix(m, 'wrist'));
  m.setJoints({ arm_shoulder_lift: -60 });
  const w1 = new THREE.Vector3().setFromMatrixPosition(defaultCameraMatrix(m, 'wrist'));
  ok(w0.distanceTo(w1) > 50, 'a camera carried by a link follows its link');

  const c = composed();
  const top = new THREE.Vector3().setFromMatrixPosition(defaultCameraMatrix(c, 'top'));
  close('top camera Z', top.z, 504.8546824323, 1e-6, 'mm');
  close('top camera Y', top.y, -18.5710809786, 1e-6, 'mm');
  const dir = new THREE.Vector3(0, 0, -1).transformDirection(defaultCameraMatrix(c, 'top'));
  close('top camera tilt', Math.asin(-dir.z) / DEG, 45, 1e-6, '°');
  close('top camera pan', Math.atan2(dir.x, dir.y) / DEG, 10, 1e-6, '°');
  close('top vFOV (87.3° hFOV, 4:3)', c.cameraVFov('top'), 71.1647, 1e-3, '°');
});

test('frames — matrix frames resolve, data-only frames do not pretend to', () => {
  const m = composed();
  const names = m.frameNames();
  ok(names.includes('wrist_flange'));
  ok(names.includes('cam_top_corner'), names.join(','));
  ok(names.includes('pincopen'), 'the attachment itself is a frame');
  ok(names.includes('pincopen/fingertip_pad'), names.filter((n) => n.startsWith('pincopen')).join(','));
  /* the ones that are numbers, not poses */
  for (const d of ['deck_grid', 'ground', 'reach_disc', 'pan_axis']) {
    eq(m.frameMatrix(d), null, `${d} is data, not a pose`);
  }
  eq(m.frameData('deck_grid').z, 57);
  eq(m.frameData('ground').z, -32.9);
  ok(m.frames.wrist_flange.isMatrix4, 'model.frames.<name> is a live Matrix4 getter');
  const a = m.frames.wrist_flange.elements[13];
  m.setJoints({ arm_shoulder_lift: -60 });
  ok(Math.abs(m.frames.wrist_flange.elements[13] - a) > 1, 'the getter re-evaluates at the new pose');
});

test('boundingBox and toJSON', () => {
  const m = lekiwi();
  const box = m.boundingBox();
  const size = box.getSize(new THREE.Vector3());
  eq(box.missing, 0); eq(box.used, 45);
  ok(size.x > 250 && size.x < 350 && size.y > 350 && size.y < 450 && size.z > 220 && size.z < 330, size.toArray().join(' x '));
  ok(m.boundingBox({ ids: [] }).isEmpty(), 'an empty id list gives an empty box, not NaN');
  const j = JSON.parse(JSON.stringify(m.toJSON()));
  eq(j.schema, ROBOT_SCHEMA); eq(j.components.length, 45);
});

test('an attached component\'s state and geometry write through to its owner', () => {
  const c = composed();
  const att = c.components.find((x) => x.id.startsWith('pincopen/') && x.geometry);
  const sub = c.attachments[0].model;
  const local = att.id.slice('pincopen/'.length);
  c.component(att.id).visible = false;
  c.component(att.id).color = '#123456';
  c._flatten();
  eq(c.component(att.id).visible, false, 'visibility survives a re-flatten');
  eq(c.component(att.id).color, '#123456');
  eq(sub.component(local).visible, false);
  const g = sub.component(local).geometry;
  sub.component(local).geometry = null;
  eq(c.component(att.id).geometry, null);
  const missing = c.boundingBox().missing;
  sub.component(local).geometry = g;
  ok(c.component(att.id).geometry === g, 'the fill arrives with no re-flatten');
  ok(c.boundingBox().missing < missing);
});

await run('core/robot-model — FK, placement, composition, URDF');
