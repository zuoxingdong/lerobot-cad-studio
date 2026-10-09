/* core/robot-model.js joints: the real LeKiwi.urdf path, prismatic travel, mimic chains and
 * the PincOpen four-bar. */

import * as THREE from 'three';
import { RobotModel, validateManifest, mat4, matrixMaxDiff, manifestFromURDF, ROBOT_SCHEMA } from '../../../src/core/robot-model.js';
import * as PKG from '../../../src/core/package.js';
import { geometryIn, currentSource } from '../../../src/core/embedded.js';

await PKG.listEmbedded();
const MANIFEST = (id) => PKG.embeddedManifest(id);
import * as V3 from '../fixtures/v3-reference.mjs';
import { test, run, close, closeMatrix, ok, eq, installDOM } from './_harness.mjs';

const TOL = 1e-6;
const DEG = Math.PI / 180;

const build = (id) => RobotModel.fromPackage(MANIFEST(id), geometryIn(currentSource(), id));
const lekiwi = () => build('lekiwi');
const pincopen = () => build('pincopen');

/** lekiwi-pincopen as `resolveComposition` builds it: base inlined + pincopen attached. */
function composed() {
  const base = build('lekiwi-pincopen');
  base.attach(pincopen(), 'wrist_flange', null, { id: 'pincopen' });
  return base;
}

function deepEqualArray(a, b) { ok(JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); }

test('fromURDF — the real LeKiwi.urdf reproduces the package FK and visual origins', async () => {
  await installDOM();
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { importURDFText } = await import('../../../src/core/package.js');
  const dir = path.join(V3.STUDIO, 'assets', 'robots', 'lekiwi', 'urdf') + path.sep;
  const stub = (() => { const b = new ArrayBuffer(84 + 50); new DataView(b).setUint32(80, 1, true); return new Uint8Array(b); })();
  const res = await importURDFText(fs.readFileSync(dir + 'LeKiwi.urdf', 'utf8'), () => stub,
    { id: 'lekiwi-urdf', name: 'LeKiwi' });
  const u = res.model;
  const p = lekiwi();
  eq(u.links.length, 45); eq(u.joints.length, 44); eq(u.components.length, 45);

  for (const [name, q] of Object.entries({ zero: {}, ...V3.PRESETS })) {
    u.setJoints({ ...u.zeroPose(), ...q });
    p.setJoints({ ...p.zeroPose(), ...q });
    let worst = 0, id = '';
    for (const l of p.links) { const e = matrixMaxDiff(u.fk(l), p.fk(l)); if (e > worst) { worst = e; id = l; } }
    ok(worst <= TOL, `${name} / ${id}: ${worst}`);
  }

  u.setJoints(u.zeroPose()); p.setJoints(p.zeroPose());
  let wW = 0, wId = '';
  for (const c of p.components) {
    if (!u.component(c.id) || c.frame !== 'mesh') continue;
    const e = matrixMaxDiff(u.worldMatrix(c.id), p.worldMatrix(c.id));
    if (e > wW) { wW = e; wId = c.id; }
  }
  ok(wW <= TOL, `${wId}: ${wW}`);
});

test('manifestFromURDF handles <limit> tags and instanced geometry', async () => {
  await installDOM();
  const { default: URDFLoader } = await import('urdf-loader');
  const urdf = `<?xml version="1.0"?><robot name="two link">
    <link name="base"><visual><origin xyz="0 0 0.01" rpy="0 0 0"/>
      <geometry><mesh filename="a.stl" scale="0.001 0.001 0.001"/></geometry></visual></link>
    <link name="tip"><visual><origin xyz="0.002 0 0" rpy="0 0 0"/>
      <geometry><mesh filename="a.stl" scale="0.001 0.001 0.001"/></geometry></visual></link>
    <joint name="hinge" type="revolute"><parent link="base"/><child link="tip"/>
      <origin xyz="0 0 0.1" rpy="0 0 0"/><axis xyz="0 0 1"/>
      <limit lower="-1.5707963268" upper="1.5707963268" effort="1" velocity="1"/></joint></robot>`;
  const loader = new URDFLoader();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  /* urdf-loader 0.12 calls (path, manager, done); 0.13 calls (path, manager, material, done) */
  loader.loadMeshCb = (...a) => a[a.length - 1](new THREE.Mesh(geo, new THREE.MeshBasicMaterial()));
  const robot = loader.parse(urdf);
  const { manifest } = manifestFromURDF(robot, { id: 'two-link' });
  eq(manifest.components.length, 2);
  eq(manifest.kinematics.joint_limits_deg.hinge.lower.toFixed(4), '-90.0000');
  eq(manifest.kinematics.joint_limits_deg.hinge.upper.toFixed(4), '90.0000');
  /* one shared geometry used twice → both components are frame "mesh" */
  eq(manifest.components[0].mesh, manifest.components[1].mesh);
  eq(manifest.components[0].frame, 'mesh');
  /* <origin xyz="0 0 0.01"> with scale 0.001 on a mm mesh → local translation 10 mm */
  close('URDF local Z (mm)', manifest.components[0].local[14], 10, 1e-9, 'mm');
  close('URDF local scale', manifest.components[0].local[0], 1, 1e-9);
  const m = RobotModel.fromPackage(manifest, null, { strict: false });
  m.setJoints({ hinge: 90 });
  const tip = m.fk('tip');
  close('hinge 90° puts the tip axis on +Y', tip.elements[1], 1, 1e-9);
  close('hinge Z (mm)', tip.elements[14], 100, 1e-9, 'mm');
  eq(m.jointLimits().hinge.upper.toFixed(1), '90.0');
});

test('manifestFromURDF converts a <mimic> offset into the CHILD joint\'s unit', async () => {
  await installDOM();
  const { default: URDFLoader } = await import('urdf-loader');
  const urdf = `<?xml version="1.0"?><robot name="mimics">
    <link name="base"/><link name="a"/><link name="b"/><link name="c"/>
    <joint name="drive" type="revolute"><parent link="base"/><child link="a"/>
      <origin xyz="0 0 0"/><axis xyz="0 0 1"/>
      <limit lower="0" upper="1.5707963268" effort="1" velocity="1"/></joint>
    <joint name="turn" type="revolute"><parent link="a"/><child link="b"/>
      <origin xyz="0 0 0"/><axis xyz="0 0 1"/>
      <mimic joint="drive" multiplier="2" offset="1.5707963268"/></joint>
    <joint name="slide" type="prismatic"><parent link="a"/><child link="c"/>
      <origin xyz="0 0 0"/><axis xyz="0 1 0"/>
      <mimic joint="drive" multiplier="1" offset="0.025"/></joint></robot>`;
  const loader = new URDFLoader();
  loader.loadMeshCb = (...a) => a[a.length - 1](null);
  const { manifest } = manifestFromURDF(loader.parse(urdf), { id: 'mimics' });
  const J = Object.fromEntries(manifest.kinematics.joints.map((j) => [j.name, j]));
  close('revolute mimic offset (deg)', J.turn.mimic.offset, 90, 1e-6, '°');
  close('prismatic mimic offset (mm)', J.slide.mimic.offset, 25, 1e-9, 'mm');
  eq(J.turn.mimic.multiplier, 2);
  const m = RobotModel.fromPackage(manifest, null, { strict: false });
  m.setJoints({ drive: 10 });
  close('turn at drive 10° (2 × 10 + 90)', m.jointValue('turn'), 110, 1e-6, '°');
  close('slide at drive 10 (1 × 10 + 25)', m.jointValue('slide'), 35, 1e-9, 'mm');
  deepEqualArray(m.controlJoints(), ['drive']);
});

/* prismatic + mimic */

/** A two-finger gripper: one revolute control joint, two prismatic fingers mimicking it. */
function gripperManifest(over = {}) {
  return {
    schema: ROBOT_SCHEMA, id: 'jaws', name: 'Jaws', units: 'mm', up: 'z',
    kinematics: {
      root_link: 'body', units: 'mm',
      joints: [
        { name: 'jaw', type: 'revolute', parent: 'body', child: 'hinge',
          xyz: [34.64, 0, 0], rpy: [0, 0, 0], axis: [0, 0, 1], limit_deg: [0, 30] },
        /* +Y finger: 1 mm of travel per degree of jaw */
        { name: 'jaw_L', type: 'prismatic', parent: 'hinge', child: 'finger_L',
          xyz: [0, 0, 0], rpy: [0, 0, 0], axis: [0, 1, 0],
          mimic: { joint: 'jaw', multiplier: 1, offset: 0 }, limit_mm: [0, 30] },
        /* −Y finger: the mirror */
        { name: 'jaw_R', type: 'prismatic', parent: 'hinge', child: 'finger_R',
          xyz: [0, 0, 0], rpy: [0, 0, 0], axis: [0, 1, 0],
          mimic: { joint: 'jaw', multiplier: -1, offset: 0 }, limit_mm: [-30, 0] },
        ...(over.joints || [])
      ]
    },
    components: [
      { id: 'finger_L', link: 'finger_L', frame: 'link', local: null, mesh: null },
      { id: 'finger_R', link: 'finger_R', frame: 'link', local: null, mesh: null }
    ],
    frames: {}, cameras: []
  };
}

/** Distance between the two finger link origins, measured along the mirror axis. */
function jawGap(m, a = 'finger_L', b = 'finger_R') {
  const pa = new THREE.Vector3().setFromMatrixPosition(m.fk(a));
  const pb = new THREE.Vector3().setFromMatrixPosition(m.fk(b));
  return pa.distanceTo(pb);
}

test('prismatic joints translate along their axis by q MILLIMETRES', () => {
  const m = RobotModel.fromPackage({
    schema: ROBOT_SCHEMA, id: 'slide', units: 'mm', up: 'z',
    kinematics: { root_link: 'base', units: 'mm', joints: [
      { name: 'lift', type: 'prismatic', parent: 'base', child: 'head',
        xyz: [0, 0, 10], rpy: [0, 0, 0], axis: [0, 0, 1], limit_mm: [0, 120] }] },
    components: [{ id: 'head', link: 'head', frame: 'link', local: null, mesh: null }],
    frames: {}, cameras: []
  }, null);
  close('prismatic at 0', m.fk('head').elements[14], 10, 1e-12, 'mm');
  m.setJoints({ lift: 35 });
  close('prismatic at 35 mm', m.fk('head').elements[14], 45, 1e-12, 'mm');
  const L = m.jointLimits().lift;
  eq(L.type, 'prismatic');
  eq(L.units, 'mm', 'a prismatic joint is limited in mm, not degrees');
  eq(L.upper, 120);
  eq(m.clampPose({ lift: 999 }).lift, 120);
  /* a non-axis-aligned axis is normalised, so |travel| == |q| whatever the axis */
  const diag = RobotModel.fromPackage({
    schema: ROBOT_SCHEMA, id: 'd', units: 'mm', up: 'z',
    kinematics: { root_link: 'a', units: 'mm', joints: [
      { name: 's', type: 'prismatic', parent: 'a', child: 'b', xyz: [0, 0, 0], axis: [3, 4, 0] }] },
    components: [{ id: 'b', link: 'b', frame: 'link', local: null, mesh: null }], frames: {}, cameras: []
  }, null);
  diag.setJoints({ s: 50 });
  close('travel along a non-unit axis', new THREE.Vector3().setFromMatrixPosition(diag.fk('b')).length(), 50, 1e-12, 'mm');
});

test('mimic — one control joint drives both fingers, and the derived ones are not settable', () => {
  const m = RobotModel.fromPackage(gripperManifest(), null);

  /* only the control joint is exposed */
  deepEqualArray(m.controlJoints(), ['jaw']);
  deepEqualArray(Object.keys(m.jointLimits()), ['jaw']);
  eq(m.jointLimits().jaw.units, 'deg');
  deepEqualArray(Object.keys(m.getJoints()), ['jaw']);
  deepEqualArray(Object.keys(m.derivedJoints()), ['jaw_L', 'jaw_R']);

  /* setting the control joint moves both fingers, mirrored */
  close('gap at q = 0', jawGap(m), 0, 1e-12, 'mm');
  m.setJoints({ jaw: 20 });
  close('gap at q = 20°', jawGap(m), 40, 1e-12, 'mm');
  eq(m.derivedJoints().jaw_L, 20);
  eq(m.derivedJoints().jaw_R, -20);
  eq(m.jointValue('jaw_L'), 20);
  m.setJoints({ jaw: 30 });
  close('gap at q = 30°', jawGap(m), 60, 1e-12, 'mm');

  /* a derived joint is refused, said so, and left alone */
  m.setJoints({ jaw_L: 999, nonsense: 1 });
  deepEqualArray(m.lastDerivedJoints, ['jaw_L']);
  deepEqualArray(m.lastUnknownJoints, ['nonsense']);
  eq(m.derivedJoints().jaw_L, 30, 'a mimic joint still follows its source');

  /* clampPose drops what cannot be set and clamps what can */
  const c = m.clampPose({ jaw: 99, jaw_L: 5, ghost: 1 });
  deepEqualArray(Object.keys(c), ['jaw']);
  eq(c.jaw, 30);

  /* getJoints() round-trips: a design stores control joints only */
  const saved = m.getJoints();
  m.setJoints({ jaw: 0 });
  close('gap after reset', jawGap(m), 0, 1e-12, 'mm');
  m.setJoints(saved);
  eq(m.lastDerivedJoints.length, 0, 'a saved pose contains nothing underivable');
  close('gap after restore', jawGap(m), 60, 1e-12, 'mm');
  deepEqualArray(Object.keys(m.zeroPose()), ['jaw']);
});

test('mimic — multiplier + offset, chains, and a cycle that does not hang', () => {
  const off = RobotModel.fromPackage(gripperManifest({
    joints: [{ name: 'preload', type: 'prismatic', parent: 'hinge', child: 'pad',
      xyz: [0, 0, 0], axis: [0, 1, 0], mimic: { joint: 'jaw', multiplier: 0.5, offset: -2 } }]
  }), null, { strict: false });
  eq(off.jointValue('preload'), -2, 'offset applies at q = 0');
  off.setJoints({ jaw: 20 });
  eq(off.jointValue('preload'), 8, '0.5 × 20 − 2');

  /* a mimic of a mimic is followed (and warned about, because one level reads better) */
  const chain = RobotModel.fromPackage(gripperManifest({
    joints: [{ name: 'tip', type: 'prismatic', parent: 'finger_L', child: 'tip_L',
      xyz: [0, 0, 0], axis: [0, 1, 0], mimic: { joint: 'jaw_L', multiplier: 2, offset: 0 } }]
  }), null, { strict: false });
  chain.setJoints({ jaw: 10 });
  eq(chain.jointValue('tip'), 20, '2 × (1 × 10)');
  ok(chain.report.warnings.some((w) => /itself a mimic/.test(w)), chain.report.warnings.join('; '));

  /* a cycle degrades to 0 instead of blowing the stack */
  const cyc = RobotModel.fromPackage({
    schema: ROBOT_SCHEMA, id: 'cyc', units: 'mm', up: 'z',
    kinematics: { root_link: 'a', units: 'mm', joints: [
      { name: 'x', type: 'revolute', parent: 'a', child: 'b', xyz: [0, 0, 0], axis: [0, 0, 1], mimic: { joint: 'y', multiplier: 1 } },
      { name: 'y', type: 'revolute', parent: 'b', child: 'c', xyz: [0, 0, 0], axis: [0, 0, 1], mimic: { joint: 'x', multiplier: 1 } }] },
    components: [{ id: 'c', link: 'c', frame: 'link', local: null, mesh: null }], frames: {}, cameras: []
  }, null, { strict: false });
  eq(cyc.controlJoints().length, 0, 'a cycle leaves nothing settable');
  eq(cyc.jointValue('x'), 0);
  ok(cyc.fk('c').isMatrix4, 'FK still resolves');

  /* the validator catches a mimic pointing nowhere */
  const bad = validateManifest(gripperManifest({
    joints: [{ name: 'ghost', type: 'prismatic', parent: 'hinge', child: 'g', xyz: [0, 0, 0], mimic: { joint: 'nope' } }]
  }));
  ok(!bad.ok);
  ok(bad.errors.some((e) => /mimics "nope", which is not a joint/.test(e)), bad.errors.join('; '));
});

test('the shipped PincOpen jaw: one control joint drives a real four-bar chain', async () => {
  const K = MANIFEST('pincopen').kinematics || {};
  const joints = K.joints || [];
  const mimics = joints.filter((j) => j.mimic);
  const control = joints.filter((j) => MOVING_TYPES.has(j.type) && !j.mimic);
  const m = pincopen();
  ok(m.report.ok, m.report.errors.join('; '));

  /* only the control joint is settable; every mimic is derived */
  deepEqualArray(m.controlJoints(), control.map((j) => j.name));
  deepEqualArray(Object.keys(m.derivedJoints()).sort(), mimics.map((j) => j.name).sort());
  eq(control.length, 1, 'a four-bar gripper has exactly one degree of freedom');
  for (const j of mimics) eq(m.jointLimits()[j.name], undefined, `${j.name} must not be user-settable`);

  const drive = control[0].name;                                  // 'jaw'
  const lim = m.jointLimits()[drive];
  eq(lim.units, 'deg', 'the crank is an ANGLE; the millimetre gap is control_display');
  const open = lim.upper;
  const L = K.linkage.link_length_mm, th0 = K.linkage.closed_crank_deg * DEG;
  const gapFormula = (q) => 2 * L * (Math.sin(th0) - Math.sin(th0 - q * DEG));

  await m.loadGeometries();
  m.setJoints(m.zeroPose());
  const closedSpan = tipSpan(m);
  close('vs kinematics.stroke_mm.closed_gap_mm', closedSpan, K.stroke_mm.closed_gap_mm, 0.1, 'mm');

  /* every bar's distal pivot stays ON the finger pivot it drives */
  const inv0 = {};
  m.setJoints(m.zeroPose());
  for (const l of K.links) inv0[l] = m.fk(l).clone().invert();
  const carry = (link, p) => p.clone().applyMatrix4(inv0[link]).applyMatrix4(m.fk(link));

  let worstPivot = 0, worstSpin = 0, worstGap = 0;
  for (const q of [0, 10, 20, open]) {
    m.setJoints({ [drive]: q });
    let pivot = 0;
    for (const bar of K.linkage.bars) {
      for (const [tag, s] of [['L', 1], ['R', -1]]) {
        const p = new THREE.Vector3(bar.coupler_xy[0], bar.coupler_xy[1] * s, 0);
        pivot = Math.max(pivot, carry(bar[`link_${tag}`], p).distanceTo(carry(`finger_${tag}`, p)));
      }
    }
    /* the coupler keeps its ORIENTATION: a parallel jaw, by definition */
    let spin = 0;
    for (const t of ['finger_L', 'finger_R']) {
      const R = m.fk(t).clone().setPosition(0, 0, 0);
      spin = Math.max(spin, matrixMaxDiff(R, new THREE.Matrix4()));
    }
    /* the POSED Tip_Support MESHES reproduce the declared gap */
    const span = tipSpan(m);             // real vertices, min/max Y of the two contact faces
    const gap = span - closedSpan;
    pivot > worstPivot && (worstPivot = pivot);
    spin > worstSpin && (worstSpin = spin);
    Math.abs(gap - gapFormula(q)) > worstGap && (worstGap = Math.abs(gap - gapFormula(q)));
  }
  ok(worstPivot < 0.02, `a bar came off its finger pivot by ${worstPivot.toFixed(4)} mm`);
  ok(worstSpin < 1e-9, `the finger rotated: ${worstSpin}`);
  ok(worstGap < 0.1, `the meshes disagree with linkage.gap_formula by ${worstGap.toFixed(4)} mm`);

  /* closed is closed, wide open is the declared stroke */
  m.setJoints(m.zeroPose());
  close('gap at the zero pose', gapFormula(0), 0, 1e-9, 'mm');
  close('gap wide open', gapFormula(open), K.stroke_mm.max_opening_mm, 1e-3, 'mm');

  /* the zero pose is the snapshot's, for every component (it stores 1e-7) */
  const movingLinks = new Set(mimics.map((j) => j.child));
  const moving = m.components.filter((c) => movingLinks.has(c.link));
  ok(moving.length === 12, 'four coupler parts + two bars on each side ride the chain');
  const at0 = moving.map((c) => m.worldMatrix(c.id));
  m.setJoints({ [drive]: open });
  let travel = 0;
  moving.forEach((c, i) => { travel = Math.max(travel, matrixMaxDiff(m.worldMatrix(c.id), at0[i])); });
  ok(travel > 1, 'the linkage meshes must actually move with the jaw');
  m.setJoints(m.zeroPose());
  const body = m.components.find((c) => !movingLinks.has(c.link));
  const b0 = m.worldMatrix(body.id);
  m.setJoints({ [drive]: open });
  closeMatrix('the body stays put', m.worldMatrix(body.id), b0, 1e-12);

  /* and it all works through the composition, under the `pincopen/` prefix */
  const c = composed();
  ok(c.controlJoints().includes('pincopen/' + drive), c.controlJoints().join(','));
  for (const j of mimics) ok(!c.controlJoints().includes('pincopen/' + j.name), j.name);
  c.setJoints({ ['pincopen/' + drive]: open });
  eq(c.lastDerivedJoints.length, 0);
  c.setJoints({ ['pincopen/' + mimics[0].name]: 5 });
  deepEqualArray(c.lastDerivedJoints, ['pincopen/' + mimics[0].name]);
});

/** The Y gap between the two posed Tip_Support MESHES, from their real vertices. */
function tipSpan(m) {
  const tips = m.components.filter((c) => /^tip_support(_2)?$/.test(c.id));
  if (tips.length !== 2) throw new Error('pincopen: expected two Tip_Support instances');
  const edge = tips.map((c) => {
    const M = m.worldMatrix(c.id);
    const pos = c.geometry.attributes.position;
    const v = new THREE.Vector3();
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(M);
      if (v.y < lo) lo = v.y;
      if (v.y > hi) hi = v.y;
    }
    return { lo, hi };
  }).sort((a, b) => a.lo - b.lo);
  return edge[1].lo - edge[0].hi;          // -Y finger's +Y face to +Y finger's -Y face
}

const MOVING_TYPES = new Set(['revolute', 'continuous', 'prismatic']);

await run('core/robot-model-joints — the URDF path, prismatic and mimic');
