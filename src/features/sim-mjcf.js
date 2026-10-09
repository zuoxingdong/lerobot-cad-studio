/* The live design as a MuJoCo model: RobotModel + slot state + edited geometry ->
   {xml, meshes, sidecar}.  Collision geoms only (MuJoCo hulls them), one body per moving
   joint, wheels welded to the base, a planar base on velocity actuators, position servos on
   the arm and the jaw, the four-bar as joint equalities.  Metres, floor at z = 0.
   `sim-excludes.js` adds the loop-closure excludes; `sim-lab.js` reads the names used here. */

import * as THREE from 'three';
import { createCameras, adoptAllSlotOptions } from './cameras.js';
import { visibilityFor } from './slot-options.js';
import { cameraAdjuster } from './hinge.js';
import { designParts, designCarry, armed, mobile } from './sim-design.js';

export { simSupport } from './sim-design.js';
import { fmt, v3, labLayout, labXml, envBodies, propBodies } from './sim-scene.js';
import * as PH from './sim-physics.js';
import { wheelSpecs } from './sim-wheels.js';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const LINK_FRAMES = new Set(['link', 'mesh']);
export const sane = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '_');
const rows = (M) => { const e = M.elements; return [0, 1, 2, 3].map((r) => [e[r], e[4 + r], e[8 + r], e[12 + r]]); };

function orthonormal(M) {
  const R = new THREE.Matrix3().setFromMatrix4(M);
  for (let k = 0; k < 4; k++) {
    const T = R.clone().invert().transpose();
    for (let i = 0; i < 9; i++) R.elements[i] = 0.5 * (R.elements[i] + T.elements[i]);
  }
  return R;
}
function quatWxyz(R) {
  const [a, d, g, b, e, h, c, f, i] = R.elements;      // column-major 3x3
  const t = a + e + i;
  let q;
  if (t > 0) { const s = Math.sqrt(t + 1) * 2; q = [0.25 * s, (h - f) / s, (c - g) / s, (d - b) / s]; }
  else if (a > e && a > i) { const s = Math.sqrt(1 + a - e - i) * 2; q = [(h - f) / s, 0.25 * s, (b + d) / s, (c + g) / s]; }
  else if (e > i) { const s = Math.sqrt(1 + e - a - i) * 2; q = [(c - g) / s, (b + d) / s, 0.25 * s, (h + f) / s]; }
  else { const s = Math.sqrt(1 + i - a - e) * 2; q = [(d - b) / s, (c + g) / s, (h + f) / s, 0.25 * s]; }
  const n = Math.hypot(...q);
  return q.map((v) => v / n);
}

/**
 * The points of `geo` carried by `M` (mm), deduplicated, as a vertex-only MuJoCo .msh: MuJoCo
 * builds the convex hull itself, which is the collision shape and the inertia source
 * (`inertia="convex"`).  Handing it faces instead costs 12 µs a triangle in the compiler.
 */
export function hullCloud(geo, M) {
  const p = geo.attributes.position.array, idx = geo.index ? geo.index.array : null;
  const n = idx ? idx.length : p.length / 3, e = M.elements;
  const f = new Float32Array(3 * n), u = new Uint32Array(f.buffer);
  let size = 1;
  while (size < 2 * n) size <<= 1;
  const slot = new Int32Array(size).fill(-1);
  let m = 0;
  for (let t = 0; t < n; t++) {
    const k = (idx ? idx[t] : t) * 3, x = p[k], y = p[k + 1], z = p[k + 2];
    f[3 * m] = e[0] * x + e[4] * y + e[8] * z + e[12];
    f[3 * m + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    f[3 * m + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    const a = u[3 * m], b = u[3 * m + 1], c = u[3 * m + 2];
    let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) & (size - 1);
    for (;;) {
      const s = slot[h];
      if (s < 0) { slot[h] = m++; break; }
      if (u[3 * s] === a && u[3 * s + 1] === b && u[3 * s + 2] === c) break;
      h = (h + 1) & (size - 1);
    }
  }
  /* sorted by bit pattern: the file must not depend on the triangle order (a BVH reorders it) */
  const order = new Uint32Array(m).map((_, i) => i).sort((a, b) => (u[3 * a] - u[3 * b]) || (u[3 * a + 1] - u[3 * b + 1]) || (u[3 * a + 2] - u[3 * b + 2]));
  const out = new Uint8Array(16 + 12 * m);
  new DataView(out.buffer).setInt32(0, m, true);          // nvertex, 0 normals, 0 uv, 0 faces
  const w = new Uint32Array(out.buffer, 16, 3 * m);
  for (let i = 0; i < m; i++) { const k = 3 * order[i]; w[3 * i] = u[k]; w[3 * i + 1] = u[k + 1]; w[3 * i + 2] = u[k + 2]; }
  return out;
}

/* the attachment path of a sub-model: '' for the root, 'pincopen/' for the gripper */
function prefixOf(m) {
  const ids = [];
  for (let x = m; x && x.parent; x = x.parent.owner) ids.unshift(x.parent.id);
  return ids.length ? ids.join('/') + '/' : '';
}

/* links of one model, parents first, the order the joint list discovers them */
function orderedLinks(sub) {
  const out = [sub.rootLink], seen = new Set(out);
  for (let changed = true; changed;) {
    changed = false;
    for (const j of sub.ownJoints) if (seen.has(j.parent) && !seen.has(j.child)) { seen.add(j.child); out.push(j.child); changed = true; }
  }
  return out;
}

const unmodelledOf = (model) => (mobile(model) ? PH.UNMODELLED : []);      // the base's electronics

function buildTree(model, vis) {
  const bodies = [], byKey = new Map(), linkBody = new Map();
  const drive = new Set((model.manifest.kinematics || {}).drive_joints || []);
  const add = (b) => { bodies.push(b); byKey.set(b.key, b); return b; };
  function walk(sub, prefix, rootKey) {
    linkBody.set(prefix + sub.rootLink, rootKey);
    for (const link of orderedLinks(sub).slice(1)) {
      const j = sub.ownJoints.find((x) => x.child === link);
      if (!j.moving) { linkBody.set(prefix + link, linkBody.get(prefix + j.parent)); continue; }
      const kind = j.mimic ? 'fourbar' : prefix ? 'jaw' : drive.has(j.name) ? 'wheel' : 'arm';
      const lim = !j.mimic && j.limits && Number.isFinite(j.limits.lower) ? [j.limits.lower, j.limits.upper] : null;
      add({ key: sane(prefix + j.name), parent: linkBody.get(prefix + j.parent), link: prefix + link,
        joint: kind === 'wheel' ? null : { name: sane(prefix + j.name), qname: prefix + j.name, axis: j.axis, kind, lim,
          type: j.type === 'prismatic' ? 'slide' : 'hinge',
          mimic: j.mimic ? { joint: sane(prefix + j.mimic.joint), mult: j.mimic.multiplier ?? 1, offset: j.mimic.offset || 0 } : null },
        wheel: kind === 'wheel', geoms: [], sites: [], cams: [] });
      linkBody.set(prefix + link, sane(prefix + j.name));
    }
    for (const a of sub.attachments) {
      const q = prefix + a.id;
      if (!a.model.components.some((c) => vis.get(q + '/' + c.id))) continue;   // swapped out
      const spec = sub.ownFrames[a.frame] || {};
      const host = spec.link ? linkBody.get(prefix + spec.link) : rootKey;
      add({ key: sane(q), parent: host || rootKey, attach: q, joint: null, geoms: [], sites: [], cams: [] });
      walk(a.model, q + '/', sane(q));
    }
  }
  add({ key: 'base', parent: null, link: model.rootLink, joint: null, geoms: [], sites: [], cams: [] });
  walk(model, '', 'base');
  const world = (b) => (b.attach ? model.frameMatrix(b.attach) : model.fk(b.link));
  for (const b of bodies) b.W = world(b);
  for (const b of bodies) {
    b.local = b.parent ? byKey.get(b.parent).W.clone().invert().multiply(b.W) : new THREE.Matrix4();
  }
  return { bodies, byKey, linkBody };
}

/* the lowest fitted point at q = 0, mm */
function lowestZ(model, vis) {
  let z = Infinity;
  for (const c of model.components) {
    const g = vis.get(c.id) && c.geometry;
    if (!g || !g.attributes || !g.attributes.position) continue;
    if (!g.boundingBox) g.computeBoundingBox();
    z = Math.min(z, g.boundingBox.clone().applyMatrix4(model.worldMatrix(c.id)).min.z);
  }
  return Number.isFinite(z) ? z : 0;
}

function bodyOfComponent(T, c) {
  const prefix = prefixOf(c.owner);
  if (LINK_FRAMES.has(c.frame) && c.link && T.linkBody.has(prefix + c.link)) return T.linkBody.get(prefix + c.link);
  return prefix ? sane(prefix.slice(0, -1)) : 'base';
}

/* the shallowest body a camera does not move against, over two poses */
function carrierOf(model, T, cams, id, poses) {
  const locals = poses.map((q) => {
    model.setJoints(q);
    const p = cams.getPose(id);
    return p && p.ok ? T.bodies.map((b) => (b.attach ? model.frameMatrix(b.attach) : model.fk(b.link)).invert().multiply(p.matrix)) : null;
  });
  if (locals.some((l) => !l)) return null;
  for (let i = 0; i < T.bodies.length; i++) {
    const a = locals[0][i].elements, b = locals[1][i].elements;
    if (a.every((v, k) => Math.abs(v - b[k]) < 1e-6)) return T.bodies[i];
  }
  return T.byKey.get('base');
}

/**
 * @param {{model, slots, design, scene, geometry?:Map<string,object>, cameras?:object}} o
 *   `scene` is assets/scenes/lab/scene.json; `geometry` overrides a component's mesh (an edit); `labScene` adds the decor.
 * @returns {{emit:(excludes:string[][])=>string, meshes:Map<file,Uint8Array>, sidecar:object,
 *            staticExcludes:string[][], sweep:object}}
 */
export function buildMjcf(o) {
  const { model, slots, design } = o;
  const keepQ = model.getJoints(), keepBase = { ...model.basePose };
  const zero = Object.fromEntries(model.controlJoints().map((k) => [k, 0]));
  const undo = designParts(model, slots, design);
  model.setBasePose(null);
  model.setJoints(zero);
  try { return build(o, zero); } finally { undo(); model.setJoints(keepQ); model.setBasePose(keepBase); }
}

function build({ model, slots, design, scene, geometry, cameras, labScene }, zero) {
  const vis = visibilityFor(model, slots, design);
  const T = buildTree(model, vis);
  const K = model.manifest.kinematics || {};
  const partDocs = model.manifest.parts || {};
  const rawOf = new Map();
  for (const m of [model, ...model.attachments.map((a) => a.model)]) for (const c of m.manifest.components || []) rawOf.set(m === model ? c.id : `${m.parent.id}/${c.id}`, c);

  /* components: a mesh in its body's frame, a mass on the geom */
  const meshes = new Map(), masses = {}, notes = [];
  let fastKg = 0;
  for (const c of model.components) {
    if (!vis.get(c.id)) continue;
    const base = c.geometry;
    const geo = (geometry && geometry.get(c.id)) || base;
    if (!geo || !geo.attributes || !geo.attributes.position) { notes.push(`no geometry for ${c.id}`); continue; }
    const u = geo.userData || {};
    const pristine = u.opsBase || (geo !== base ? base : null);
    const raw = rawOf.get(c.id) || {};
    const pm = raw.part_of && partDocs[raw.part_of] ? (partDocs[raw.part_of].meshes || []).find((m) => m.id === raw.part_mesh) : null;
    const mass = PH.componentMass({ id: c.id, committedCm3: pm ? pm.volume_cm3 : null }, geo, pristine);
    if (raw.part_of && mass.basis === 'mesh' && !PH.isWatertight(geo)) notes.push(`mass: ${c.id} is not watertight, its signed volume is a guess`);
    const bk = bodyOfComponent(T, c);
    const b = T.byKey.get(bk);
    const M = b.W.clone().invert().multiply(model.worldMatrix(c.id));
    const name = sane(c.id);
    meshes.set(`${name}.msh`, hullCloud(geo, M));
    b.geoms.push({ name, kg: mass.kg + mass.fastenerKg, tip: raw.group === 'fingertip' });
    fastKg += mass.fastenerKg;
    masses[c.id] = { g: +(mass.kg * 1000).toFixed(2), basis: mass.basis, cm3: mass.cm3 == null ? null : +mass.cm3.toFixed(3),
      printed: mass.printed, printable: !!c.printable, fastener_g: +(mass.fastenerKg * 1000).toFixed(2), body: bk };
  }

  /* sites: the pads on each finger, the grasp datum on the attached gripper body; the pad covers */
  const hands = T.bodies.filter((x) => x.attach).map((b) => ({ b, sub: model.attachments.find((a) => a.id === b.attach)?.model, pre: b.attach + '/' })), covers = [];
  for (const { b, sub, pre } of hands) {
    const pad = sub && sub.ownFrames.fingertip_pad && sub.ownFrames.fingertip_pad.origin;
    if (!pad) continue;
    const P = new THREE.Vector3(...pad).applyMatrix4(b.W), fbs = [];
    for (const [link, name] of [['finger_L', 'pad_L'], ['finger_R', 'pad_R']]) {
      const fb = T.byKey.get(T.linkBody.get(`${pre}${link}`));
      if (fb) { fb.sites.push({ name, pos: P.clone().applyMatrix4(fb.W.clone().invert()) }); fbs.push(fb); }
    }
    b.sites.push({ name: 'grasp', pos: new THREE.Vector3(...pad) });
    const fingers = fbs.length < 2 ? [] : fbs.map((fb) => ({ body: fb.key, M: b.W.clone().invert().multiply(fb.W).elements, tips: fb.geoms.filter((g) => g.tip).map((g) => g.name) }));
    for (const c of fingers.length ? PH.padCovers(fingers, meshes) : []) { (T.byKey.get(c.body).pads ||= []).push(c.geom); covers.push(c); }
  }

  /* cameras: posed by the fitted slot options, carried by the body they ride */
  const cams = cameras || createCameras(model);
  if (!cameras) adoptAllSlotOptions(cams, slots, design, cameraAdjuster(model, design, designCarry(model, slots, design)));
  const probe = Object.fromEntries(Object.keys(zero).map((k, i) => [k, 7 + 3 * i]));
  const camOut = {};
  for (const id of cams.ids) {
    const b = carrierOf(model, T, cams, id, [zero, probe]);
    model.setJoints(zero);
    if (!b) continue;
    const rec = cams.get(id), pose = cams.getPose(id);
    const hfov = (design && design.cameras && design.cameras[id] && design.cameras[id].hfov_deg) || rec.hfov_deg;
    const fovy = 2 * Math.atan(Math.tan(hfov * D2R / 2) / rec.aspect) * R2D;
    const L = b.W.clone().invert().multiply(pose.matrix);
    b.cams.push({ id, L: new THREE.Matrix4().setFromMatrix3(orthonormal(L)).setPosition(new THREE.Vector3().setFromMatrixPosition(L)), fovy });
    camOut[id] = { body: b.key, fovy_deg: fovy, hfov_deg: hfov, near_mm: rec.near, local_mm: rows(L), robot_mm: {} };
  }
  for (const p of [{ id: 'zero', q: zero }, ...(model.manifest.presets || [])]) {
    model.setJoints({ ...zero, ...p.q });
    for (const id of Object.keys(camOut)) camOut[id].robot_mm[p.id] = rows(cams.getPose(id).matrix);
  }
  model.setJoints(zero);

  /* the floor: the package's ground, else (a fixed base) 5 mm under the lowest point */
  const fixedGround = !mobile(model) && !Number.isFinite(model.manifest.frame && model.manifest.frame.ground_z);
  const groundZ = fixedGround ? lowestZ(model, vis) - 5 : model.groundZ || 0;
  /* the lab, for an arm only: the bench top is the reach-table grasp point above the floor */
  let lab = null;
  if (armed(model)) {
    const grasp = T.bodies.find((b) => b.attach && b.sites.some((s) => s.name === 'grasp'));
    const table = (model.manifest.presets || []).find((p) => p.id === 'reach_table');
    model.setJoints({ ...zero, ...(table ? table.q : {}) });
    const gp = grasp ? new THREE.Vector3(...grasp.sites.find((s) => s.name === 'grasp').pos.toArray()).applyMatrix4(model.frameMatrix(grasp.attach))
      : new THREE.Vector3(70, 0, 0).applyMatrix4(model.frameMatrix('wrist_flange') || new THREE.Matrix4());
    model.setJoints(zero);
    lab = labLayout(scene, gp.z - groundZ);
  }
  const decor = lab && labScene ? labScene : null;            // the lab decor: visual only
  if (decor) { decor.lib.meshFiles(decor, lab).forEach((b, f) => meshes.set(f, b)); lab.anim = decor.lib.labAnim(decor.decor, lab); }

  const unmodelled = unmodelledOf(model).map(([item, kg, at]) => ({ body: 'base', item, g: kg * 1000, at_robot_mm: at }));
  const nPla = Object.values(masses).filter((m) => m.printed).length;
  unmodelled.push({ body: '(the part itself)', item: `M3 fastener allowance, ${PH.FASTENER_MASS_FRAC * 100} % of each of ${nPla} PLA parts`,
    g: +(fastKg * 1000).toFixed(1), at_robot_mm: null });

  const staticExcludes = T.bodies.filter((b) => b.parent).map((b) => [b.key, b.parent].sort())
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
  const joints = T.bodies.filter((b) => b.joint);
  const jaw = joints.find((b) => b.joint.kind === 'jaw');
  const mult = {};
  for (const b of joints.filter((x) => x.joint.kind === 'jaw' || x.joint.kind === 'fourbar')) {
    let k = 1, j = b.joint;
    for (let g = 0; j && j.mimic && g < 8; g++) { k *= j.mimic.mult; j = joints.find((x) => x.joint.name === j.mimic.joint)?.joint; }
    mult[b.joint.name] = k;
  }
  const sub = jaw ? model.attachments.find((a) => jaw.key.startsWith(sane(a.id)))?.model || null : null;
  const env = lab ? envBodies(lab, !!decor) : ['world'];
  const robotKg = Object.values(masses).reduce((s, m) => s + m.g / 1000 + m.fastener_g / 1000, 0)
    + unmodelledOf(model).reduce((s, u) => s + u[1], 0);
  const sidecar = {
    schema: 'rps/sim@1', robot: model.id, ground_z_mm: groundZ, slots: { ...(design.slots || {}) },
    arm_joints: joints.filter((b) => b.joint.kind === 'arm').map((b) => b.joint.name),
    jaw_joints: jaw ? [jaw.joint.qname] : [],
    wheel_joints: [], wheel_bodies: T.bodies.filter((b) => b.wheel).map((b) => b.key), wheels: wheelSpecs(model).map((w) => ({ ...w, body: sane(w.joint) })),
    joint_limits_deg: { ...(K.joint_limits_deg || {}) },
    presets: Object.fromEntries((model.manifest.presets || []).map((p) => [p.id, { ...p.q }])),
    cameras: camOut,
    linkage: sub ? (sub.manifest.kinematics || {}).linkage || null : null,
    jaw_max_deg: jaw && jaw.joint.lim ? jaw.joint.lim[1] : 0,
    jaw: jaw ? { joint: jaw.joint.name, mimic: mult } : null,
    fk: { urdf: `assets/robots/${(model.manifest.composition || {}).base || model.id}/${K.urdf || ''}`, root_link: model.rootLink,
      bodies: Object.fromEntries(joints.filter((b) => b.joint.kind === 'arm').map((b) => [b.key, b.link])) },
    scene: lab ? scene.id || 'lab' : null, env_bodies: env, props: lab ? propBodies(lab) : [],
    sites: Object.fromEntries(T.bodies.flatMap((b) => b.sites.map((s) => [s.name, { body: b.key, local_mm: s.pos.toArray().map((v) => +v.toFixed(6)) }]))),
    lab, decor: decor ? { group: 1, collision_group: 3 } : null, pad_cover: covers.length ? { ...PH.PAD_COVER, geoms: covers } : null, robot_mass_kg: +robotKg.toFixed(4), masses, mass_unmodelled: unmodelled,
    visible_ids: Object.keys(masses).sort(), components: Object.keys(masses).length,
    printable: Object.values(masses).filter((m) => m.printable).length,
    drive: mobile(model) ? { v_max_mps: PH.DRIVE_V_MAX, w_max_radps: PH.DRIVE_W_MAX } : { v_max_mps: 0, w_max_radps: 0 }, notes,
  };
  const sweep = { jawMax: sidecar.jaw_max_deg, mult, presets: sidecar.presets, env, arm: sidecar.arm_joints };
  const emit = (ex) => { const x = emitXml(model, T, meshes, lab, scene, ex, groundZ); return decor ? decor.lib.decorXml(x, lab, decor.decor, env) : x; };
  return { emit, meshes, sidecar, staticExcludes, sweep };
}

function emitXml(model, T, meshes, lab, scene, excludes, groundZ) {
  const A = [];
  A.push(`<mujoco model="${sane(model.id)}">`);
  A.push('  <compiler angle="radian" meshdir="meshes" autolimits="true" balanceinertia="true"/>');
  A.push(`  <option timestep="${fmt(PH.TIMESTEP)}" integrator="implicitfast" cone="elliptic" impratio="10" gravity="0 0 -9.81"/>`);
  A.push(`  <size memory="${PH.ARENA}"/>`);
  A.push('  <visual><global offwidth="1280" offheight="960"/><map znear="0.01" zfar="30"/></visual>');
  A.push('  <default>', '    <default class="collision">');
  const PC = PH.PAD_COVER, bits = (b) => `contype="${b[0]}" conaffinity="${b[1]}"`;
  A.push(`      <geom type="mesh" group="1" condim="4" friction="0.9 0.01 0.001" solref="0.004 1" solimp="0.95 0.99 0.001" rgba="0.78 0.8 0.83 1" ${bits(PH.ROBOT_BITS)}/>`);
  A.push('      <default class="pad">', `        <geom ${bits(PH.PAD_BITS)} priority="1" condim="6" friction="${v3(PC.friction)}" solref="${v3(PC.solref)}" solimp="${v3(PC.solimp)}" mass="0" rgba="0.1 0.1 0.12 1"/>`, '      </default>');
  A.push('    </default>', '    <default class="arm">');
  A.push(`      <joint type="hinge" damping="${fmt(PH.ARM.damping)}" armature="${fmt(PH.ARM.armature)}" frictionloss="${fmt(PH.ARM.frictionloss)}"/>`);
  A.push(`      <position kp="${fmt(PH.ARM.kp)}" kv="${fmt(PH.ARM.kv)}" forcerange="-${fmt(PH.STS3215_TORQUE)} ${fmt(PH.STS3215_TORQUE)}"/>`);
  A.push('    </default>', '    <default class="fourbar">', '      <joint type="hinge" damping="0.02" armature="0.0005"/>', '    </default>', '  </default>');
  A.push('  <asset>');
  A.push('    <texture name="grid" type="2d" builtin="checker" rgb1="0.78 0.79 0.81" rgb2="0.86 0.87 0.89" width="512" height="512"/>');
  A.push('    <material name="floor" texture="grid" texrepeat="24 24" texuniform="true"/>');
  for (const file of meshes.keys()) A.push(`    <mesh name="${file.replace(/\.msh$/, '')}" file="${file}" scale="0.001 0.001 0.001" inertia="convex"/>`);
  A.push('  </asset>');
  A.push('  <worldbody>');
  A.push('    <light name="key" pos="0.6 -0.8 2.2" dir="-0.2 0.3 -1" directional="true" diffuse="0.6 0.6 0.6"/>');
  A.push('    <geom name="floor" type="plane" size="0 0 0.05" material="floor" condim="4" friction="0.9 0.01 0.001"/>');
  if (lab) A.push(...labXml(scene, lab));
  const body = (b, ind) => {
    const p = ' '.repeat(ind);
    const pos = b.parent ? new THREE.Vector3().setFromMatrixPosition(b.local).multiplyScalar(0.001) : new THREE.Vector3(0, 0, -groundZ / 1000);
    const q = quatWxyz(orthonormal(b.local));
    const quat = Math.abs(q[0] - 1) < 1e-12 ? '' : ` quat="${v3(q)}"`;
    A.push(`${p}<body name="${b.key}" pos="${v3(pos.toArray())}"${quat}>`);
    if (!b.parent) {
      A.push(`${p}  <joint name="base_x" type="slide" axis="1 0 0" damping="0" armature="0.4"/>`);
      A.push(`${p}  <joint name="base_y" type="slide" axis="0 1 0" damping="0" armature="0.4"/>`);
      A.push(`${p}  <joint name="base_yaw" type="hinge" axis="0 0 1" damping="0" armature="0.05"/>`);
    }
    const j = b.joint;
    if (j) {
      const cls = j.kind === 'arm' ? ' class="arm"' : ' class="fourbar"';
      const rng = j.lim ? ` range="${fmt(j.lim[0] * D2R)} ${fmt(j.lim[1] * D2R)}"` : '';
      A.push(`${p}  <joint name="${j.name}" type="${j.type}" axis="${v3(j.axis)}"${cls}${rng}/>`);
    }
    const nc = b.wheel ? ' contype="0" conaffinity="0"' : '';
    for (const g of b.geoms) A.push(`${p}  <geom class="collision" name="col_${g.name}" mesh="${g.name}" mass="${fmt(g.kg)}"${nc}/>`);
    for (const g of b.pads || []) A.push(`${p}  <geom class="pad" name="${g}" mesh="${g}"/>`);
    if (!b.parent) unmodelledOf(model).forEach(([, kg, at], i) => A.push(`${p}  <geom name="mass_${i}" type="sphere" size="0.005" pos="${v3(at.map((v) => v / 1000))}" mass="${fmt(kg)}" contype="0" conaffinity="0" group="4"/>`));
    if (!b.geoms.length && b.parent) A.push(`${p}  <inertial pos="0 0 0" mass="0.0001" diaginertia="1e-8 1e-8 1e-8"/>`);
    for (const s of b.sites) A.push(`${p}  <site name="${s.name}" pos="${v3(s.pos.toArray().map((v) => v / 1000))}" size="0.003" group="5"/>`);
    for (const c of b.cams) {
      const e = c.L.elements;
      A.push(`${p}  <camera name="${c.id}" pos="${v3([e[12] / 1000, e[13] / 1000, e[14] / 1000])}" xyaxes="${v3([e[0], e[1], e[2], e[4], e[5], e[6]])}" fovy="${fmt(c.fovy)}" resolution="640 480"/>`);
    }
    for (const ch of T.bodies) if (ch.parent === b.key) body(ch, ind + 2);
    A.push(`${p}</body>`);
  };
  body(T.bodies[0], 4);
  A.push('  </worldbody>');
  const eq = T.bodies.filter((b) => b.joint && b.joint.mimic);
  if (eq.length) {
    A.push('  <equality>');
    for (const b of eq) {
      const m = b.joint.mimic;
      A.push(`    <joint name="eq_${b.joint.name}" joint1="${b.joint.name}" joint2="${m.joint}" polycoef="${fmt(m.offset * D2R)} ${fmt(m.mult)} 0 0 0" solref="0.002 1" solimp="0.99 0.9999 0.0001"/>`);
    }
    A.push('  </equality>');
  }
  A.push('  <contact>');
  for (const [a, b] of excludes) A.push(`    <exclude body1="${a}" body2="${b}"/>`);
  A.push('  </contact>');
  A.push('  <actuator>');
  const V = fmt(PH.DRIVE_V_MAX), W = fmt(PH.DRIVE_W_MAX);
  A.push(`    <velocity name="drive_x" joint="base_x" kv="600" ctrlrange="-${V} ${V}" forcerange="-250 250"/>`);
  A.push(`    <velocity name="drive_y" joint="base_y" kv="600" ctrlrange="-${V} ${V}" forcerange="-250 250"/>`);
  A.push(`    <velocity name="drive_yaw" joint="base_yaw" kv="120" ctrlrange="-${W} ${W}" forcerange="-60 60"/>`);
  const T3 = fmt(PH.STS3215_TORQUE);
  for (const b of T.bodies) {
    const j = b.joint;
    if (!j || (j.kind !== 'arm' && j.kind !== 'jaw')) continue;
    const r = `ctrlrange="${fmt(j.lim[0] * D2R)} ${fmt(j.lim[1] * D2R)}"`;
    A.push(j.kind === 'arm' ? `    <position class="arm" name="act_${j.name}" joint="${j.name}" ${r}/>`
      : `    <position name="act_${j.name}" joint="${j.name}" kp="${fmt(PH.JAW.kp)}" kv="${fmt(PH.JAW.kv)}" ${r} forcerange="-${T3} ${T3}"/>`);
  }
  A.push('  </actuator>');
  A.push('</mujoco>');
  return A.join('\n') + '\n';
}
