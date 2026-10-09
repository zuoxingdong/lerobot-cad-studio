/* features/sim-mjcf.js + sim-excludes.js: the default design compiles in MuJoCo WASM with the
 * model contract sim-lab.js reads, the xml is deterministic, an edited part weighs its new
 * volume, and a MuJoCo pose reads back onto the RobotModel. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { studio } from './_harness.mjs';
import { buildMjcf } from '../../../src/features/sim-mjcf.js';
import { compileDesign, designHash } from '../../../src/features/sim-excludes.js';
import { loadEngine, createSim, indexSim, robotPose, propPoses, idOf } from '../../../src/features/sim-engine.js';
import { sceneDoc } from '../../../src/features/sim-scene.js';
import { applyOps } from '../../../src/features/ops.js';
import { MASS_PART_MAX_KG, PAD_COVER, PAD_BITS, mshPoints } from '../../../src/features/sim-physics.js';

const s = await studio();
const scene = await sceneDoc('lab');
const mj = await loadEngine();
const input = { model: s.model, slots: s.slots, design: s.design, scene };
const built = buildMjcf(input);
const cache = new Map();
const first = compileDesign(mj, built, { cache });
const m = first.model;
const name = (t, i) => mj.mj_id2name(m, mj.mjtObj[`mjOBJ_${t}`].value, i);

test('the default design compiles: bodies, joints, actuators, excludes', () => {
  assert.deepEqual([m.nbody, m.nq, m.nv, m.nu, m.nmesh, m.neq], [23, 23, 22, 10, 71, 6]);
  const acts = Array.from({ length: m.nu }, (_, i) => name('ACTUATOR', i));
  assert.deepEqual(acts, ['drive_x', 'drive_y', 'drive_yaw', ...built.sidecar.arm_joints.map((j) => `act_${j}`), 'act_pincopen_jaw']);
  for (const b of ['base', 'pincopen', 'pincopen_jaw_finger_L', 'pincopen_jaw_finger_R', 'st_lh', 'st_inc', 'st_reader', 'puck_1', 'base_back_wheel']) assert.ok(idOf(mj, m, 'body', b) >= 0, b);
  for (const st of ['grasp', 'pad_L', 'pad_R']) assert.ok(idOf(mj, m, 'site', st) >= 0, st);
  for (const c of ['front', 'wrist', 'top']) assert.ok(idOf(mj, m, 'camera', c) >= 0, c);
  const joints = Array.from({ length: m.njnt }, (_, i) => name('JOINT', i));
  assert.ok(!joints.some((j) => j.includes('wheel')), 'no wheel joints');
  assert.equal(m.nexclude, first.sidecar.model.excludes_static + 2);
  assert.deepEqual(Object.keys(first.sidecar.model.baseline).sort(),
    ['pincopen_jaw_finger_L|pincopen_jaw_rod2_L', 'pincopen_jaw_finger_R|pincopen_jaw_rod2_R']);
  for (const v of Object.values(first.sidecar.model.baseline)) assert.ok(v > 8 && v < 10.5, `loop overlap ${v}`);
});

test('the fingertip covers: the grip hull moved PAD_COVER.mm toward the other finger, fabric contact, the world only', () => {
  const pc = built.sidecar.pad_cover;
  assert.deepEqual(pc.geoms.map((g) => [g.geom, g.body]), [['pad_pincopen_tip_support', 'pincopen_jaw_finger_L'], ['pad_pincopen_tip_support_2', 'pincopen_jaw_finger_R']]);
  for (const { geom, normal } of pc.geoms) {
    const P = mshPoints(built.meshes.get(`${geom.slice(4)}.msh`)), Q = mshPoints(built.meshes.get(`${geom}.msh`));
    assert.equal(P.length, Q.length);
    for (let i = 0; i < P.length; i++) assert.ok(Math.abs(Q[i] - P[i] - PAD_COVER.mm * normal[i % 3]) < 1e-4, geom);
    const g = idOf(mj, m, 'geom', geom);
    assert.deepEqual([m.geom_contype[g], m.geom_conaffinity[g], m.geom_priority[g], m.geom_condim[g]], [...PAD_BITS, 1, 6]);
    assert.deepEqual(Array.from(m.geom_friction.subarray(3 * g, 3 * g + 3)), PAD_COVER.friction);
  }
  assert.deepEqual(pc.geoms.map((g) => g.normal[1]), [1, -1]);        // PincOpen closes along the gripper Y
});

test('masses: the robot is in its package band, no printed part over 250 g', () => {
  const kg = first.sidecar.robot_mass_kg;
  const [lo, hi] = s.model.manifest.mass.band_kg;
  assert.ok(kg >= lo && kg <= hi, `${kg} kg not in ${lo}..${hi}`);
  let total = 0;
  for (let b = 0; b < m.nbody; b++) if (!first.sidecar.env_bodies.includes(name('BODY', b))) total += m.body_mass[b];
  assert.ok(Math.abs(total - kg) < 0.001, `compiled ${total} vs sidecar ${kg}`);
  const printed = Object.entries(first.sidecar.masses).filter(([, v]) => v.printed);
  assert.ok(printed.length > 30);
  for (const [id, v] of printed) assert.ok(v.g + v.fastener_g <= MASS_PART_MAX_KG * 1000, `${id} ${v.g} g`);
  assert.equal(first.sidecar.masses['SO_ARM100_08k_Mirror-v1'].basis, 'voxel');
  assert.equal(first.sidecar.masses.corner_mast_printed_spar_lower.basis, 'committed');
});

test('the same design gives the same xml and meshes; the excludes come from the cache', () => {
  const again = buildMjcf(input);
  assert.equal(again.emit(again.staticExcludes), built.emit(built.staticExcludes));
  assert.equal(designHash('', again.meshes), designHash('', built.meshes));
  const second = compileDesign(mj, again, { cache });
  assert.equal(second.cached, true);
  assert.equal(second.xml, first.xml);
  assert.equal(second.hash, first.hash);
  console.log(`  first compile + sweep ${first.ms.first + first.ms.compile} ms, cached compile ${second.ms.compile} ms`);
  second.model.delete();
});

test('an edited part weighs its own new volume', () => {
  const id = 'corner_mast_printed_spar_lower';
  const g0 = s.model.component(id).geometry;
  const r = applyOps(g0, [{ op: 'scale', s: 1.1, about: 'center' }]);
  assert.notEqual(r.geometry, g0);
  const edited = buildMjcf({ ...input, geometry: new Map([[id, r.geometry]]) });
  const a = built.sidecar.masses[id], b = edited.sidecar.masses[id];
  assert.equal(b.basis, 'edited');
  assert.ok(Math.abs(b.cm3 / a.cm3 - 1.331) < 0.005, `${a.cm3} -> ${b.cm3} cm3`);
  assert.ok(b.g > a.g * 1.3);
  assert.notEqual(edited.emit(edited.staticExcludes), built.emit(built.staticExcludes));
  assert.equal(s.model.component(id).geometry, g0, 'the model is untouched');
});

test('a MuJoCo pose reads back onto the RobotModel: same grasp point, same prop frame', () => {
  const sim = createSim(mj, m);
  const ix = indexSim(mj, m, first.sidecar);
  const q = { ...s.model.manifest.presets.find((p) => p.id === 'reach_table').q, 'pincopen/jaw': 12 };
  const d = sim.data;
  for (const a of ix.arm) d.qpos[a.adr] = q[a.name] * Math.PI / 180;
  for (const [n, k] of Object.entries(first.sidecar.jaw.mimic)) d.qpos[m.jnt_qposadr[idOf(mj, m, 'joint', n)]] = 12 * k * Math.PI / 180;
  d.qpos[ix.base[0].q] = 0.1; d.qpos[ix.base[1].q] = -0.05; d.qpos[ix.base[2].q] = 0.3;
  sim.forward();
  const r = robotPose(d, ix);
  const keepQ = s.model.getJoints(), keepB = { ...s.model.basePose };
  s.model.setBasePose(r.base);
  s.model.setJoints(r.joints);
  const pad = s.model.attachments[0].model.ownFrames.fingertip_pad.origin;
  const want = new THREE.Vector3(...pad).applyMatrix4(s.model.frameMatrix('pincopen'));
  const sid = idOf(mj, m, 'site', 'grasp');
  const got = Array.from(d.site_xpos.subarray(3 * sid, 3 * sid + 3), (v, i) => v * 1000 + (i === 2 ? s.model.groundZ : 0));
  s.model.setJoints(keepQ);
  s.model.setBasePose(keepB);
  assert.ok(Math.hypot(got[0] - want.x, got[1] - want.y, got[2] - want.z) < 0.01, `${got} vs ${want.toArray()}`);
  const props = propPoses(d, ix);
  assert.deepEqual(props.map((p) => p.name), ['puck_1']);
  const [x, y, z] = first.sidecar.lab.props[0].start_bottom;
  assert.ok(Math.hypot(props[0].pos_mm[0] - x, props[0].pos_mm[1] - y, props[0].pos_mm[2] - s.model.groundZ - z) < 1e-6);
  sim.free({ keepModel: true });
});

test.after(() => m.delete());
