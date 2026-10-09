/* node --test tools/tests/ui/sim-finish.test.mjs   (run from studio/)
   The Sim tab's robot finish: RULES and LOOKS match tools/render/looks.json, every LeKiwi part
   resolves to a look, materials are shared, the wheel is split at the roller radius, and the
   palette swap in scene/materials.js puts every Design material back. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { RULES, LOOKS, WHEEL, keyOf, createSimFinish } from '../../../src/ui/sim-finish.js';
import { fabric, coverPress } from '../../../src/ui/robot-look.js';
import { createMaterials } from '../../../src/scene/materials.js';
import * as pkg from '../../../src/core/package.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const L = JSON.parse(readFileSync(path.join(ROOT, 'tools/render/looks.json'), 'utf8'));
/* the fields showcase-looks.js draws; objects compare by identity (no deep inspection on failure) */
const DRAWN = ['base', 'rough', 'metal', 'sheen', 'sheen_rough', 'coat', 'coat_rough', 'transmission', 'ior', 'volume', 'thin_film_nm'];

test('RULES are the robot rules of looks.json, in order', () => {
  const want = L.rules.filter((r) => r.match && /^(\(\?i\))?\^vis_/.test(r.match)).map((r) => [r.match, r.key]);
  const got = RULES.map(([re, k]) => [(re.flags.includes('i') ? '(?i)' : '') + re.source, k]);
  assert.deepEqual(got, want);
});

test('LOOKS carry the drawn fields of the library, and the filament lots', () => {
  for (const [k, s] of Object.entries(LOOKS)) {
    const lib = L.library[k];
    assert.ok(lib, k + ' is not in the library');
    for (const f of DRAWN) assert.deepEqual(s[f], lib[f], `${k}.${f}`);
    assert.deepEqual(s.lot, lib.lot && lib.lot.base, `${k}.lot`);
    for (const f of ['pitch_mm', 'band_mm', 'band_albedo', 'layer_albedo', 'rough_amp']) assert.equal((s.layer || {})[f], (lib.layer || {})[f], `${k}.layer.${f}`);
  }
  assert.equal(WHEEL.roller_from, L.library.wheel.wheel.roller_from);
});

test('every LeKiwi part resolves to a look; servos, plates, wheels, standoffs, cameras by rule', async () => {
  const model = await pkg.loadEmbedded('lekiwi-pincopen');
  const keys = new Map(model.components.filter((c) => c.geometry).map((c) => [c.id, keyOf(c.id)]));
  for (const [id, k] of keys) assert.ok(LOOKS[k] || k === 'wheel', `${id} -> ${k}`);
  const of = (re) => [...keys].filter(([id]) => re.test(id)).map(([, k]) => k);
  assert.ok(of(/ST3215|STS3215|sts3215/).every((k) => k === 'servo'));
  assert.deepEqual(of(/^base_plate/), ['acrylic_clear', 'acrylic_clear']);
  assert.deepEqual(of(/Omni-Directional-Wheel/), ['wheel', 'wheel', 'wheel']);
  assert.ok(of(/Standoff/).every((k) => k === 'brass'));
  assert.ok(of(/^Camera-Model|_df200$/).every((k) => k === 'camera_module'));
  assert.ok(of(/^(corner_mast_printed_(spar|head|retainer)|df200_arch_(arch|head|retainer)|pi_case)/).every((k) => k.startsWith('pla_')));
  assert.equal(keyOf('pincopen/removable_tip'), L.rules.find((r) => /removable_tip/.test(r.match || '')).key);
});

function meshes() {
  const box = new THREE.BoxGeometry(10, 10, 10), wheel = new THREE.CylinderGeometry(51, 51, 39, 24).rotateX(Math.PI / 2);
  const design = new THREE.MeshStandardMaterial();
  const tinted = new THREE.MeshStandardMaterial();
  tinted.userData.tinted = { role: 'imported', hex: '#d08a3c' };
  return new Map([
    ['STS3215_03a-v1', new THREE.Mesh(box, design)], ['STS3215_03a-v1-1', new THREE.Mesh(box, design)],
    ['base_plate_layer1-v5', new THREE.Mesh(box, design)], ['pi_case_panel', new THREE.Mesh(box, design)],
    ['pi_case_cradle', new THREE.Mesh(box, design)], ['4-Omni-Directional-Wheel_Single_Body-v1', new THREE.Mesh(wheel, design)],
    ['4-Omni-Directional-Wheel_Single_Body-v1-1', new THREE.Mesh(wheel.clone(), design)], ['my_part', new THREE.Mesh(box, tinted)],
  ]);
}

test('the finish shares materials: one per look, lot and colour; the wheel split at the roller radius', () => {
  const ms = meshes(), f = createSimFinish(ms), m = (id) => f.map.get(ms.get(id));
  assert.ok(m('STS3215_03a-v1') === m('STS3215_03a-v1-1'), 'one servo material');
  assert.equal(m('STS3215_03a-v1').name, 'servo');
  assert.ok(m('base_plate_layer1-v5').transparent && !m('base_plate_layer1-v5').depthWrite, 'acrylic is a clear medium');
  assert.match(m('pi_case_panel').name, /^pla_cyan\.\d$/);
  assert.ok(m('pi_case_panel').userData.print, 'the print on a printed part');
  const w = m('4-Omni-Directional-Wheel_Single_Body-v1');
  assert.ok(w === m('4-Omni-Directional-Wheel_Single_Body-v1-1'), 'one wheel material for the same frame');
  assert.deepEqual(w.userData.wheel, { axis: 2, r_mm: +(WHEEL.roller_from * 51).toFixed(2) });
  const t = m('my_part');
  assert.equal(t.name, 'pla_object');
  assert.ok(Math.abs(t.color.r - new THREE.Color('#d08a3c').r) < 1e-6, 'an imported part keeps its colour');
  assert.ok(new Set(f.map.values()).size < ms.size);
  f.dispose();
});

test('setPalette swaps the robot to the real finish and back, exactly; assign() waits under it', () => {
  const mats = createMaterials(), ms = meshes();
  const before = new Map([...ms].map(([id, x]) => [id, x.material]));
  const f = createSimFinish(ms);
  mats.setPalette('real', f.map);
  assert.equal(mats.palette, 'real');
  for (const [id, x] of ms) assert.ok(x.material === f.map.get(x), id);
  const up = mats.get('upgrade'), one = ms.get('pi_case_panel');
  mats.assign(one, up);                                   // the Design scene repaints while the Sim is open
  assert.ok(one.material === f.map.get(one), 'assign() changed a swapped mesh');
  mats.setPalette('design');
  assert.equal(mats.palette, 'design');
  for (const [id, x] of ms) assert.ok(x.material === (id === 'pi_case_panel' ? up : before.get(id)), id);
  mats.assign(one, before.get('pi_case_panel'));
  assert.ok(one.material === before.get('pi_case_panel'), 'assign() in design');
  mats.setPalette('real', f.map);
  mats.dispose();
  for (const [id, x] of ms) assert.ok(x.material === before.get(id), 'dispose puts ' + id + ' back');
  f.dispose();
});

test('the covers\' faces: sand on nitrile_coat, the knit on the blue back; each patch finds its chunk', () => {
  const lib = L.library, rest = new THREE.Matrix4();
  assert.equal(fabric(new THREE.MeshPhysicalMaterial(), lib.pla_cyan, rest), null);
  for (const [k, kind] of [['nitrile_coat', 'sand'], ['fabric_knit_blue', 'knit']]) {
    const m = fabric(new THREE.MeshPhysicalMaterial(), lib[k], rest);
    assert.equal(m.userData.fabric, kind, k);
    assert.equal(m.side, THREE.DoubleSide, k + ' is an open shell');
    const P = THREE.ShaderLib.physical, sh = { uniforms: {}, vertexShader: P.vertexShader, fragmentShader: P.fragmentShader };
    m.onBeforeCompile(sh);
    assert.match(sh.vertexShader, /vRpsG = /, k);
    assert.match(sh.fragmentShader, kind === 'sand' ? /mix\(0\.74000, 0\.90000/ : /cos\(6\.2832/, k);
    assert.match(sh.fragmentShader, /normal = normalize\(normal \+/, k);
  }
});

test('coverPress: two covers closed past their touch flatten at the mid-plane, apart again when open', () => {
  const lib = L.library, box = (x) => {
    const g = new THREE.BoxGeometry(0.02, 0.03, 0.02);
    g.translate(x, 0, 0);
    return g;
  };
  const mk = (k, x) => new THREE.Mesh(box(x), fabric(new THREE.MeshPhysicalMaterial(), lib[k], new THREE.Matrix4()));
  const A = [mk('nitrile_coat', -0.009), mk('fabric_knit_blue', -0.009)], B = [mk('nitrile_coat', 0.009), mk('fabric_knit_blue', 0.009)];
  const S = new THREE.Matrix4().makeScale(1000, 1000, 1000);
  for (const o of [...A, ...B]) { o.matrixAutoUpdate = false; o.matrix.copy(S); }
  const press = coverPress([...A.map((mesh) => ({ mesh, key: 'a' })), ...B.map((mesh) => ({ mesh, key: 'b' }))], 5e-5);
  assert.ok(press, 'the pair');
  press();
  const plane = (o) => { const sh = { uniforms: {}, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
    o.material.onBeforeCompile(sh); return sh.uniforms.rpsPress.value; };
  const a = plane(A[0]), b = plane(B[1]);
  // object space: A's faces reach x = 0.001 m, B's from -0.001 m (2 mm into each other); each stops 0.05 mm short of x = 0
  assert.ok(Math.abs(a.x - 1) < 1e-9 && Math.abs(a.w - -5e-5) < 1e-9, JSON.stringify(a));
  assert.ok(Math.abs(b.x + 1) < 1e-9 && Math.abs(b.w - -5e-5) < 1e-9, JSON.stringify(b));
  for (const o of B) o.matrix.copy(S).premultiply(new THREE.Matrix4().makeTranslation(30, 0, 0));
  press();
  assert.equal(plane(A[1]).w, 1e9, 'open: no press');
});
