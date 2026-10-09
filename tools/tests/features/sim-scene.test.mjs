/* features/sim-scene.js: the rps/scene@2 workcell resolves to the rps/lab@2 sidecar block, the
 * compiled model carries every task fixture under its fixed name and size, the puck has the
 * stated geometry, mass, CoM and contact params, a puck dropped into each nest settles seated,
 * and each station's reach corridor holds no geometry but its nest and the puck. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { studio } from './_harness.mjs';
import { buildMjcf } from '../../../src/features/sim-mjcf.js';
import { compileDesign } from '../../../src/features/sim-excludes.js';
import { loadEngine } from '../../../src/features/sim-engine.js';
import { sceneDoc, labLayout } from '../../../src/features/sim-scene.js';
import { stationFrames } from '../../../src/features/sim-scene-decor.js';
import { labSceneFiles } from '../../sim/lib.mjs';

const s = await studio();
const mj = await loadEngine();
const scene = await sceneDoc('lab');
const c = compileDesign(mj, buildMjcf({ model: s.model, slots: s.slots, design: s.design, scene, labScene: labSceneFiles() }));
const m = c.model, lab = c.sidecar.lab;
const id = (t, n) => mj.mj_name2id(m, mj.mjtObj[`mjOBJ_${t}`].value, n);
const name = (t, i) => mj.mj_id2name(m, mj.mjtObj[`mjOBJ_${t}`].value, i) || '';
const by0 = (anim, node) => anim.find((a) => a.node === node);
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

/* the sidecar lab block without `anim` */
const CONTRACT = {
  schema: 'rps/lab@2', T_mm: 277.33, room: { x: [-2100, 2300], y: [-1500, 1950] }, dock: [0, 0, 0],
  clearance: { r_low: 167, r_high: 240, high_z: 350, min: 80 },
  stations: [
    { id: 'lh', kind: 'liquid_handler', body: 'st_lh', yaw: 0, park: [0, 490, 0], plinth_rect: { x: [-450, 450], y: [750, 1310] }, top_z: 277.33,
      nest: { xy: [0, 810], floor_z: 277.33, inner: 54, wall: 6, collar_h: 8, lead: 6, top_z: 291.33 }, lid: null, cycle: null, start: 'done' },
    { id: 'inc', kind: 'incubator', body: 'st_inc', yaw: -90, park: [740, 490, -90], plinth_rect: { x: [1000, 1450], y: [190, 790] }, top_z: 277.33,
      nest: { xy: [1060, 490], floor_z: 277.33, inner: 54, wall: 6, collar_h: 14, lead: 6, top_z: 297.33 },
      lid: { hinge: [1115, 490, 395.33], axis: [0, -1, 0], closed_deg: 100 }, cycle: { clear: 200, dwell: 1.0, close: 0.8, run: 4.0, open: 0.8 } },
    { id: 'reader', kind: 'reader', body: 'st_reader', yaw: 90, park: [-740, 490, 90], plinth_rect: { x: [-1450, -1000], y: [190, 790] }, top_z: 277.33,
      nest: { xy: [-1060, 490], floor_z: 277.33, inner: 54, wall: 6, collar_h: 8, lead: 6, top_z: 291.33 },
      lid: { hinge: [-1115, 490, 417.33], axis: [0, 1, 0], closed_deg: 95 }, cycle: { clear: 200, dwell: 1.0, close: 0.6, run: 3.0, open: 0.6 },
      result: [0.22, 0.31, 0.93, 0.27] }],
  waypoints: [{ id: 'via_mid', pose: [0, 490, 0], via: true }],
  props: [{ id: 'puck_1', kind: 'puck', body: 'puck_1', joint: 'puck_1_free', at: 'lh', d: 50, post_d: 17, knob_top: 106, grip_z: 80, mass_kg: 0.05, start_bottom: [0, 810, 277.33],
    /* 1.3 mL in a 9.0 mm bore over a 6.5 mm cone; the first slosh mode at 10.08 Hz (sim-liquid.js) */
    liquid: { r_mm: 4.5, z_low_mm: 14, z_rest_mm: 32.268042, z_top_mm: 45.6, h_mm: 20.434709, omega: 63.354681, zeta: 0.2, s_max: 2.747477, accel_tau_s: 0.01,
      wells: [[11.313708, 11.313708], [-11.313708, 11.313708], [-11.313708, -11.313708], [11.313708, -11.313708]],
      tints: [[0.88, 0.89, 0.7], [0.93, 0.83, 0.62], [0.8, 0.91, 0.74], [0.93, 0.8, 0.8]], glow: [0.35, 1, 0.5], hit: 2 } }],
};

test('scene.json is rps/scene@2 and resolves to the contract lab block', () => {
  assert.equal(scene.schema, 'rps/scene@2');
  const { anim, ...rest } = lab;
  assert.deepEqual(rest, CONTRACT);
  assert.deepEqual(labLayout(scene, 277.3312), { ...CONTRACT, anim: [] }, 'T is kept to 0.01 mm');
  assert.throws(() => labLayout({ ...scene, schema: 'rps/scene@1' }, 277));
  assert.deepEqual(anim.map((a) => a.node), ['lh.led', 'lh.gantry', 'inc.lid', 'inc.led', 'reader.lid', 'reader.led', 'reader.glow', 'reader.bars', 'wall.loop', 'wall.bars']);
  assert.deepEqual(by0(anim, 'inc.led').geoms.slice(0, 2), ['anim_inc_led_0', 'anim_inc_ring_0'], 'the contract geoms lead');
  const by = Object.fromEntries(anim.map((a) => [a.node, a]));
  assert.deepEqual(by['inc.lid'], { node: 'inc.lid', station: 'inc', kind: 'hinge', geoms: ['anim_inc_lid_0'], ...CONTRACT.stations[1].lid });
  assert.deepEqual(by['reader.bars'].geoms, [1, 2, 3, 4].map((k) => `anim_reader_bar_${k}`));
  assert.equal(by['reader.bars'].base_z, 427.33);
  assert.deepEqual([by['lh.gantry'].axis, by['lh.gantry'].travel, by['lh.gantry'].period_s], [[1, 0, 0], [-250, 250], 3]);
  for (const a of anim) for (const g of a.geoms) assert.ok(id('GEOM', g) >= 0, `anim geom ${g} is in the model`);
  assert.deepEqual(c.sidecar.env_bodies, ['decor', 'puck_1', 'st_inc', 'st_lh', 'st_reader', 'world']);
  assert.deepEqual(stationFrames(lab).map((f) => [f.x, f.y, f.yaw]), scene.stations.map((x) => [...x.origin, x.yaw]));
});

test('every fixture is in the model with its spec name, size and contact', () => {
  const box = (g) => Array.from(m.geom_size.subarray(3 * g, 3 * g + 3), (v) => +(2000 * v).toFixed(4));
  for (const st of scene.stations) {
    const b = id('BODY', `st_${st.id}`), T = lab.T_mm;
    assert.ok(b > 0, st.id);
    const pl = id('GEOM', `st_${st.id}_plinth`), bd = id('GEOM', `st_${st.id}_body`);
    assert.deepEqual(box(pl), [...st.plinth, T]);
    assert.deepEqual(box(bd), [st.body.x[1] - st.body.x[0], st.body.y[1] - st.body.y[0], st.body.h]);
    assert.deepEqual(Array.from(m.geom_friction.subarray(3 * pl, 3 * pl + 3)).map((v) => +v.toFixed(4)), [0.8, 0.01, 0.001]);
    assert.equal(m.geom_condim[pl], 4);
    const ch = st.nest.collar_h;
    for (let k = 1; k <= 4; k++) {
      const cg = id('GEOM', `st_${st.id}_c${k}`), lg = id('GEOM', `st_${st.id}_l${k}`);
      assert.ok(cg > 0 && lg > 0 && m.geom_bodyid[cg] === b && m.geom_bodyid[lg] === b, `collar ${k}`);
      assert.deepEqual(box(cg).sort((x, y) => x - y), (k <= 2 ? [6, ch, 66] : [6, ch, 54]).sort((x, y) => x - y));
      assert.deepEqual(box(lg), [66, +(6 * Math.SQRT2).toFixed(4), 2], 'lead-in: mouth 66, a 6 mm leg at 45°');
      const q = Array.from(m.geom_quat.subarray(4 * lg, 4 * lg + 4));
      const tilt = Math.acos(1 - 2 * (q[1] ** 2 + q[2] ** 2)) * 180 / Math.PI;
      near(Math.min(tilt, 180 - tilt), 45, 1e-6, 'the lead-in face is at 45°');
    }
  }
  assert.equal(m.geom_group[id('GEOM', 'st_lh_plinth')], 3, 'scenery collision is group 3');
});

test('the puck: geoms, 50 g, CoM 30 mm above its bottom, the tube contact on the post', () => {
  const b = id('BODY', 'puck_1'), j = id('JOINT', 'puck_1_free');
  assert.ok(b > 0 && m.jnt_type[j] === mj.mjtJoint.mjJNT_FREE.value && m.jnt_bodyid[j] === b);
  near(m.body_mass[b], 0.05, 1e-9, 'mass');
  near(m.body_ipos[3 * b + 2] * 1000, 30, 0.1, 'CoM z');
  const want = { foot: [46, 2, 1], body: [50, 22, 13], post: [17, 76, 62], knob: [19, 6, 103] };
  for (let k = 1; k <= 4; k++) Object.assign(want, { [`tube_${k}`]: [10.8, 40.6, 26.3], [`cap_${k}`]: [12.5, 6, 49.6] });
  for (const [g0, [d, h, z]] of Object.entries(want)) {
    const g = id('GEOM', `puck_1_${g0}`);
    assert.ok(g > 0 && m.geom_bodyid[g] === b, g0);
    near(m.geom_size[3 * g] * 2000, d, 1e-6, `${g0} d`);
    near(m.geom_size[3 * g + 1] * 2000, h, 1e-6, `${g0} h`);
    near(m.geom_pos[3 * g + 2] * 1000, z, 1e-6, `${g0} z`);
  }
  for (let k = 0; k < 4; k++) {
    const g = id('GEOM', `puck_1_tube_${k + 1}`), a = (45 + 90 * k) * Math.PI / 180;
    near(m.geom_pos[3 * g] * 1000, 16 * Math.cos(a), 1e-6, 'well x');
    near(m.geom_pos[3 * g + 1] * 1000, 16 * Math.sin(a), 1e-6, 'well y');
  }
  for (const g0 of ['post', 'knob']) {
    const g = id('GEOM', `puck_1_${g0}`);
    assert.deepEqual(Array.from(m.geom_friction.subarray(3 * g, 3 * g + 3)).map((v) => +v.toFixed(4)), [0.8, 0.05, 0.002]);
    assert.equal(m.geom_condim[g], 6);
    assert.deepEqual(Array.from(m.geom_solref.subarray(2 * g, 2 * g + 2)).map((v) => +v.toFixed(4)), [0.008, 1]);
    assert.deepEqual(Array.from(m.geom_solimp.subarray(5 * g, 5 * g + 3)).map((v) => +v.toFixed(4)), [0.95, 0.99, 0.001]);
  }
  const g = id('GEOM', 'puck_1_body');
  assert.deepEqual(Array.from(m.geom_friction.subarray(3 * g, 3 * g + 3)).map((v) => +v.toFixed(4)), [0.6, 0.01, 0.001]);
});

/* free-drop the puck (bottom at `z` mm) at nest + (dx, dy); -> radial, bottom above the floor, tilt */
function drop(st, dx, dy, z, seconds) {
  const d = new mj.MjData(m);
  try {
    mj.mj_resetData(m, d);
    const qa = m.jnt_qposadr[id('JOINT', 'puck_1_free')], b = id('BODY', 'puck_1');
    d.qpos.set([(st.nest.xy[0] + dx) / 1000, (st.nest.xy[1] + dy) / 1000, z / 1000, 1, 0, 0, 0], qa);
    for (let k = 0; k < seconds / m.opt.timestep; k++) mj.mj_step(m, d);
    const X = d.xpos, R = d.xmat;
    return { radial: Math.hypot(X[3 * b] * 1000 - st.nest.xy[0], X[3 * b + 1] * 1000 - st.nest.xy[1]),
      above: X[3 * b + 2] * 1000 - st.nest.floor_z, tilt: Math.acos(Math.min(1, R[9 * b + 8])) * 180 / Math.PI };
  } finally { d.delete(); }
}
const seated = (r) => r.radial <= 2.5 && r.above <= 2.5 && r.tilt < 5;

test('a puck dropped into each nest settles seated', () => {
  for (const st of lab.stations) {
    const top = st.nest.top_z;
    for (const [dx, dy, z, sec] of [[0, 0, top + 20, 3], [1.5, 0, top + 10, 3], [0, -1.5, top + 10, 3], [-1, 1, st.nest.floor_z + 2, 2]]) {
      const r = drop(st, dx, dy, z, sec);
      assert.ok(seated(r), `${st.id} (${dx}, ${dy}) from ${z}: ${JSON.stringify(r)}`);
    }
  }
  for (const st of lab.stations.filter((x) => x.nest.collar_h <= 8)) {
    const r = drop(st, 6, 0, st.nest.top_z + 25, 10);      // onto the lead-in, inside the ±8 mm funnel
    assert.ok(seated(r), `${st.id} funnel: ${JSON.stringify(r)}`);
  }
});

/* world AABBs of geom g after mj_forward, mm: [[min, max], ...]; a mesh per triangle, else its box */
function aabbs(d, g) {
  const X = d.geom_xpos, R = d.geom_xmat;
  const w = (p) => [0, 1, 2].map((i) => (X[3 * g + i] + R[9 * g + 3 * i] * p[0] + R[9 * g + 3 * i + 1] * p[1] + R[9 * g + 3 * i + 2] * p[2]) * 1000);
  const bound = (pts) => [[0, 1, 2].map((i) => Math.min(...pts.map((p) => p[i]))), [0, 1, 2].map((i) => Math.max(...pts.map((p) => p[i])))];
  const mid = m.geom_dataid[g];
  if (m.geom_type[g] === mj.mjtGeom.mjGEOM_MESH.value && mid >= 0) {
    const v = m.mesh_vert, f = m.mesh_face, va = m.mesh_vertadr[mid], fa = m.mesh_faceadr[mid], out = [];
    for (let k = 0; k < m.mesh_facenum[mid]; k++) {
      out.push(bound([0, 1, 2].map((j) => { const q = va + f[3 * (fa + k) + j]; return w([v[3 * q], v[3 * q + 1], v[3 * q + 2]]); })));
    }
    return out;
  }
  const a = m.geom_aabb.subarray(6 * g, 6 * g + 6);
  return [bound(Array.from({ length: 8 }, (_, k) => w([0, 1, 2].map((i) => a[i] + ((k >> i) & 1 ? 1 : -1) * a[3 + i]))))];
}

test('each reach corridor (local x ±80, y -300..105, z T..T+300) is free but for its nest and the puck', () => {
  const d = new mj.MjData(m);
  mj.mj_forward(m, d);
  const env = new Set(c.sidecar.env_bodies), T = lab.T_mm;
  const hits = (f, yMax) => {
    const nest = new RegExp(`^st_${f.id}_[cl][1-4]$|^nest_${f.id}$`), out = [];
    const [ux, uy] = [-Math.sin(f.yaw * Math.PI / 180), Math.cos(f.yaw * Math.PI / 180)], [vx, vy] = [uy, -ux];
    for (let g = 0; g < m.ngeom; g++) {
      const bn = name('BODY', m.geom_bodyid[g]), gn = name('GEOM', g);
      if (!env.has(bn) || bn === 'puck_1' || nest.test(gn) || m.geom_type[g] === mj.mjtGeom.mjGEOM_PLANE.value) continue;
      const hit = aabbs(d, g).some(([lo, hi]) => {
        const xs = [], ys = [];                              // the box corners in the station frame (x right, y in)
        for (const X of [lo[0], hi[0]]) for (const Y of [lo[1], hi[1]]) { xs.push((X - f.x) * vx + (Y - f.y) * vy); ys.push((X - f.x) * ux + (Y - f.y) * uy); }
        return Math.min(...xs) < 80 && Math.max(...xs) > -80 && Math.min(...ys) < yMax && Math.max(...ys) > -300 && lo[2] < T + 300 && hi[2] > T + 1e-6;
      });
      if (hit) out.push(gn || `${bn}:${g}`);
    }
    return out;
  };
  try {
    for (const f of stationFrames(lab)) {
      assert.deepEqual(hits(f, 105), [], `${f.id} corridor`);
      assert.ok(hits(f, 200).includes(`st_${f.id}_body`), `${f.id}: the probe sees the instrument body past y 105`);
    }
  } finally { d.delete(); }
});

test.after(() => m.delete());
