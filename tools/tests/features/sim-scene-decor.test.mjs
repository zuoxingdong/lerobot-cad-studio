/* features/sim-scene-decor.js: decor.json validates, its plan keeps the task surfaces where
 * scene.json puts them, the decorated MJCF compiles, adds no mass and no collision geom, moves
 * nothing a contact can feel (a driven replay is bit-identical), and the packed
 * site/vendor/lab-scene.js matches its sources. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { studio } from './_harness.mjs';
import { buildMjcf } from '../../../src/features/sim-mjcf.js';
import { compileDesign } from '../../../src/features/sim-excludes.js';
import { loadEngine } from '../../../src/features/sim-engine.js';
import { sceneDoc, loadLabScene } from '../../../src/features/sim-scene.js';
import { validateDecor, decorPlan, meshFiles, zOf } from '../../../src/features/sim-scene-decor.js';
import { labSceneFiles } from '../../sim/lib.mjs';

const s = await studio();
const mj = await loadEngine();
const files = labSceneFiles();
const input = { model: s.model, slots: s.slots, design: s.design, scene: await sceneDoc('lab') };
const plain = compileDesign(mj, buildMjcf(input));
const deco = compileDesign(mj, buildMjcf({ ...input, labScene: files }));
const lab = deco.sidecar.lab;
const name = (m, t, i) => mj.mj_id2name(m, mj.mjtObj[`mjOBJ_${t}`].value, i) || '';

test('decor.json is a valid rps/decor@1 document and every prop mesh exists', () => {
  assert.deepEqual(validateDecor(files.decor, new Set(files.meshes.keys()), lab), []);
  const bad = structuredClone(files.decor);
  bad.items.push({ box: [1, 1], xy: [0, 0], z: [0, 'X'], mat: 'nope' }, { mesh: 'ghost', at: 'puck_1', xyz: [0, 0, 'T'], mat: 'alu' }, { cyl: 3, box: [1, 1], mat: 'alu' },
    { box: [1, 1], xy: [0, 0], z: [0, 1], at: 'bench_a', mat: 'alu' }, { box: [1, 1], xy: [0, 0], z: [0, 1], mat: 'alu', anim: 'inc.lid', name: 'anim_inc_lid_0' });
  bad.materials.alu.rgba = [2, 0, 0, 1];
  const err = validateDecor(bad, new Set(files.meshes.keys()), lab).join('\n');
  for (const w of ['material alu: rgba', 'unknown material "nope"', ': z', 'no prop mesh "ghost"', 'exactly one of', 'unknown frame "bench_a"', 'unique,']) assert.ok(err.includes(w), `missing "${w}" in\n${err}`);
  assert.equal(zOf('T-18', 277), 259);
  assert.throws(() => zOf('T*2', 1));
});

test('the plan: deck slabs exactly on the plinth tops, the puck visuals on the puck body, named animated geoms', () => {
  const plan = decorPlan(files.decor, lab);
  for (const st of lab.stations) {
    const slabs = plan.filter((p) => p.at === st.id && p.kind === 'box' && p.mat === 'slab_white');
    assert.ok(slabs.length >= 1, st.id);
    for (const p of slabs) assert.ok(Math.abs(p.pos[2] + p.size[2] / 2 - lab.T_mm) < 1e-9, `${st.id}: the slab surface is the deck T`);
  }
  assert.deepEqual([...new Set(plan.filter((p) => p.body).map((p) => p.body))], ['puck_1']);
  const names = plan.filter((p) => p.anim).map((p) => p.name);
  assert.equal(new Set(names).size, names.length);
});

test('the decorated MJCF compiles; decor is group 1, no contact, no mass; scenery collision is group 3', () => {
  const m = deco.model, body = mj.mjtObj.mjOBJ_BODY.value;
  const decorBody = mj.mj_name2id(m, body, 'decor');
  assert.ok(decorBody > 0 && decorBody === m.nbody - 1, 'decor is the last body');
  assert.equal(plain.model.nbody + 1, m.nbody);
  let visual = 0;
  for (let g = 0; g < m.ngeom; g++) {
    const b = name(m, 'BODY', m.geom_bodyid[g]), col = m.geom_contype[g] || m.geom_conaffinity[g];
    if (!col) {
      if (b === 'decor' || b === 'puck_1') { visual++; assert.equal(m.geom_group[g], 1); }
    } else if (/^st_|^puck_1$/.test(b)) assert.equal(m.geom_group[g], 3, name(m, 'GEOM', g));
  }
  assert.equal(visual, decorPlan(files.decor, lab).length);
  const sum = (x) => Array.from(x.body_mass).reduce((a, v) => a + v, 0);
  assert.equal(sum(m), sum(plain.model), 'total mass');
  for (let b = 0; b < plain.model.nbody; b++) {
    assert.equal(m.body_mass[b], plain.model.body_mass[b]);
    for (let k = 0; k < 3; k++) assert.equal(m.body_inertia[3 * b + k], plain.model.body_inertia[3 * b + k]);
  }
  assert.ok(deco.sidecar.env_bodies.includes('decor') && deco.sidecar.decor);
});

test('the collision geoms are the same set: names, type, size, pose, friction, solver params', () => {
  const rows = (m) => {
    const out = [];
    for (let g = 0; g < m.ngeom; g++) {
      if (!m.geom_contype[g] && !m.geom_conaffinity[g]) continue;
      const v = (a, n) => Array.from(a.subarray(n * g, n * g + n));
      out.push(JSON.stringify([name(m, 'GEOM', g), name(m, 'BODY', m.geom_bodyid[g]), m.geom_type[g], m.geom_contype[g], m.geom_conaffinity[g], m.geom_condim[g],
        v(m.geom_size, 3), v(m.geom_pos, 3), v(m.geom_quat, 4), v(m.geom_friction, 3), v(m.geom_solref, 2), v(m.geom_solimp, 5)]));
    }
    return out;
  };
  const a = rows(plain.model), b = rows(deco.model);
  assert.equal(a.length, 66 + 3 * 10 + 12, 'the robot, its 2 pad covers and the floor, 3 stations of 10, the puck');
  assert.deepEqual(b, a);
});

test('a driven replay into the liquid handler plinth is bit-identical with and without the decor', () => {
  const run = (m) => {
    const d = new mj.MjData(m);
    try {
      mj.mj_resetData(m, d);
      let contacts = 0;
      for (let k = 0; k < 3000; k++) {
        const c = d.ctrl;
        c[1] = 0.2; c[2] = 0.3 * Math.sin(k / 400);
        for (let j = 3; j < m.nu; j++) c[j] = 0.3 * Math.sin(k / (150 + 20 * j));
        mj.mj_step(m, d);
        contacts = Math.max(contacts, d.ncon);
      }
      return { q: Array.from(d.qpos), contacts };
    } finally { d.delete(); }
  };
  const a = run(plain.model), b = run(deco.model);
  assert.ok(a.contacts > 4, `${a.contacts} contacts`);
  assert.deepEqual(b.q, a.q);
});

test('site/vendor/lab-scene.js is the build of decor.json + props/*.obj (rebuild if this fails)', async () => {
  const packed = await loadLabScene();
  assert.deepEqual(packed.decor, files.decor);
  const x = meshFiles(packed, lab), y = meshFiles(files, lab);
  assert.deepEqual([...x.keys()], [...y.keys()]);
  for (const [f, bytes] of y) assert.ok(Buffer.from(bytes).equals(Buffer.from(x.get(f))), f);
  assert.equal(typeof packed.lib.decorXml, 'function');
  assert.equal(typeof packed.lib.createRoom, 'function');
  let tris = 0;
  for (const g of files.meshes.values()) tris += g.index.length / 3;
  assert.ok(tris <= 60000, `${tris} triangles`);
});

test.after(() => { plain.model.delete(); deco.model.delete(); });
