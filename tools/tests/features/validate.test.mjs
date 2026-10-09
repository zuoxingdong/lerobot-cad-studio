/* features/validate.js — the live-chip orchestrator.
 * This is the test that proves the chip row is real:
 *   [✓ print ok] [✓ clear] [✓ top cam 94 %]   →  after a bad drag  →
 *   [✗ 288 mm — too tall for Bambu Lab] […] */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { withCollide, withCameras, studio, table, round, cornerTopFrames } from './_harness.mjs';
import { defaultDesign } from '../../../src/core/store.js';
import { RobotModel, ROBOT_SCHEMA } from '../../../src/core/robot-model.js';
import { createValidator, presetsFor, DEFAULT_PRESETS } from '../../../src/features/validate.js';

let V = null;
async function validator() {
  const s = await withCollide();
  await withCameras();
  if (!V) V = createValidator({ model: s.model, slots: s.slots, cameras: s.cameras, collide: s.collide });
  return { ...s, V };
}
const tweak = (design, id, params) => ({ ...design, params: { ...design.params, [id]: { ...design.params[id], ...params } } });

test('the presets come from the package, with the defaults only as a fallback', async () => {
  const { model } = await studio();
  const p = presetsFor(model);
  assert.equal(p.length, 4);
  assert.equal(p[0].source, `${model.id}.presets`, 'robot.json now carries them');
  assert.deepEqual(p.map((x) => x.id), ['stowed', 'reach_floor', 'reach_table', 'raised_max']);
  assert.deepEqual(p.map((x) => x.label), ['Stowed', 'Reach floor', 'Reach table', 'Raised max']);
  assert.equal(p[1].q.arm_wrist_flex, 170.5, 'the limit, not the 171 the source table rounds to');
  assert.deepEqual(p.map((x) => x.q), DEFAULT_PRESETS.map((x) => x.q), 'and they agree with the built-in fallback');
  /* a package that declares none but HAS the arm falls back, and says so */
  const armJoints = Object.keys(DEFAULT_PRESETS[0].q);
  const bare = presetsFor({ id: 'bare', manifest: {}, controlJoints: () => armJoints });
  assert.match(bare[0].source, /DEFAULT_PRESETS/);
  assert.equal(bare.length, 4);
  assert.deepEqual(presetsFor({ id: 'box', manifest: {}, controlJoints: () => [] }), [],
    'an assembly-only import is not offered "reach floor"');
  assert.deepEqual(presetsFor({ id: 'bare', manifest: {} }), [], 'nor is a model with no joints at all');
  /* the map form works too */
  const map = presetsFor({ id: 'x', manifest: { presets: { parked: { arm_shoulder_pan: 0 } } } });
  assert.equal(map[0].source, 'x.presets');
  assert.equal(map[0].id, 'parked');
});

test('validateComponent at the package defaults is all green', async () => {
  const { V: v, design } = await validator();
  const gen = v.validateComponent(design, 'pi_case_cradle');
  assert.equal(gen.verdict, 'pass');
  assert.equal(gen.chips[0].key, 'print');
  assert.equal(gen.chips[1].key, 'clear');
  assert.equal(gen.chips[0].text, 'print ok');
  assert.equal(gen.print.chips.find((c) => c.key === 'bed').level, 'pass');
  assert.equal(gen.print.preview, null, 'untouched knobs measure the package plate, not the CSG preview');
  assert.equal(gen.print.orientation, 'declared');
  assert.ok(gen.print.chips.filter((c) => ['closed', 'bodies'].includes(c.key)).every((c) => c.level === 'pass'), 'the plate is one closed body');
  assert.equal(gen.chips[1].text, 'clear');
  assert.equal(gen.slot, 'pi_case');

  const mast = v.validateComponent(design, 'corner_mast_printed_spar_lower');
  assert.equal(mast.verdict, 'pass');
  assert.deepEqual(mast.chips.map((c) => c.key), ['print', 'clear', 'cam:top']);
  assert.equal(mast.print.preview, null, 'a shipped plate is not a CSG preview');
  assert.equal(mast.chips[1].text, 'clear');
  assert.match(mast.chips[2].text, /^top 100%$/);
  assert.equal(mast.slot, 'top_camera_mount');
  /* the shape the brief specifies */
  assert.ok(mast.print && mast.physics && mast.cameras);
  assert.ok(mast.physics.currentPose.ok);
  assert.equal(mast.physics.presets.length, 4);
  for (const p of mast.physics.presets) assert.ok(p.ok, `${p.name} is clear`);
  assert.deepEqual(mast.cameras.map((c) => c.id), ['top'], 'the slot `provides: cameras.top`');
});

/* The escalation rule, measured on the shipped parametric pi case grown past a small bed. */
test('a bad drag turns the print chip red, with the reason and the number', async () => {
  const { V: v, design } = await validator();
  const tiny = { id: 'tiny', name: 'Tiny 110', size: [120, 120, 110] };
  const rows = [];
  v.setPrinter(tiny);
  try {
    for (const h of [80, 97, 115, 130]) {
      const d = tweak(design, 'pi_case_cradle', { height: h });
      const r = v.validateComponent(d, 'pi_case_cradle', { stages: ['print'] });
      const bed = r.print.chips.find((c) => c.key === 'bed');
      rows.push({ 'height mm': h, verdict: r.verdict, chip: r.chips[0].text, bed: bed.level, tip: bed.detail,
        'print z mm': round(r.print.analysis.size.z, 1) });
    }
  } finally { v.setPrinter('bambu'); }
  assert.equal(rows[1].verdict, 'pass', 'the default height prints the package plate');
  assert.equal(rows[0].verdict, 'fail', 'an edited CSG preview is exported as is, so its loose shells fail');
  assert.equal(rows[0].chip, 'loose shells');
  assert.deepEqual(rows.map((r) => r.bed), ['pass', 'pass', 'fail', 'fail'], 'the bed chip says where the boundary is');
  assert.match(rows.at(-1).tip, /\d+ × \d+ × 130 mm — too tall for Tiny 110/);
  /* …and a different printer profile moves the boundary */
  const tall = tweak(design, 'pi_case_cradle', { height: 130 });
  assert.equal(v.printOf(tall, 'pi_case_cradle').chips.find((c) => c.key === 'bed').level, 'pass', '130 mm fits the Bambu bed');
  assert.equal(v.printOf(tall, 'pi_case_cradle', { printer: tiny }).chips.find((c) => c.key === 'bed').level, 'fail');
  assert.equal(v.printer(), 'bambu');
});

test('a tweak moves the camera chip, with a delta against the previous value', async () => {
  const { V: v, design, cameras: C } = await validator();
  const rows = [];
  let prev = null;
  for (const tilt of [45, 30, 20, 10]) {
    C.registerFrames(cornerTopFrames(tilt), { source: 'mast tilt ' + tilt });
    const r = v.validateComponent(design, 'corner_mast_printed_head',
      { stages: ['cameras'], previous: prev });
    rows.push({ 'tilt°': tilt, chip: r.chips[0].text, 'reach %': r.cameras[0].reach_disc_pct, level: r.cameras[0].level });
    prev = r;
  }
  C.clearOverride('top');
  assert.match(rows[1].chip, /\(-/, 'the chip carries the delta since the last change');
  assert.equal(rows[0]['reach %'], 100, 'at the DF200 lens the 45 deg design sees the whole disc');
  assert.ok(rows[0]['reach %'] > rows.at(-1)['reach %'], 'tilting the mast up loses the floor');
});

test('physics: current pose is live, presets are the debounced stage', async () => {
  const { V: v, design } = await validator();
  const t0 = performance.now();
  const live = v.physicsOf(design, { stage: 'current' });
  const liveMs = performance.now() - t0;
  const t1 = performance.now();
  const all = v.physicsOf(design);
  const allMs = performance.now() - t1;
  assert.equal(live.presets.length, 0, 'stage "current" skips the expensive pass');
  assert.equal(all.presets.length, 4);
  assert.deepEqual(all.presets.map((x) => x.id), ['stowed', 'reach_floor', 'reach_table', 'raised_max']);
  assert.deepEqual(all.presets.map((x) => x.name), ['Stowed', 'Reach floor', 'Reach table', 'Raised max']);
  assert.ok(allMs > liveMs, 'which is why it is debounced');
  /* a pose that really does collide names the offender, for the tooltip */
  const bad = { ...design, joints: { arm_shoulder_lift: 40, arm_elbow_flex: 77, arm_wrist_flex: -54 } };
  const r = v.physicsOf(bad, { stage: 'current' });
  assert.equal(r.currentPose.ok, false);
  assert.match(r.currentPose.tooltip, /^hits .+ at current pose$/);
  assert.ok(r.currentPose.limits.length, 'and the joint-limit violations come back too');
});

test('swapping a slot option re-validates the new component', async () => {
  const { V: v, design, slots: S, collide: W } = await validator();
  const rows = [];
  for (const [opt, cid] of [['df200_arch', 'df200_arch_arch'],
    ['pincopen_holder', 'pincopen/camera_basement'],
    ['stock', 'Wrist-Camera-Mount-v11']]) {
    const d = S.applyOption(design, 'wrist_camera_mount', opt).design;
    W.setActiveFromDesign(d);
    const r = v.validateComponent(d, cid, { stages: ['print', 'cameras'] });
    rows.push({ option: opt, component: cid, verdict: r.verdict,
      print: r.chips[0].text.slice(0, 46), camera: r.chips.at(-1).text });
  }
  W.setActiveFromDesign(design);
  assert.equal(rows.length, 3);
  assert.ok(rows[0].camera.startsWith('wrist '), rows[0].camera);
  assert.ok(rows[2].camera.startsWith('wrist '), rows[2].camera);
  assert.ok(/off|no camera|—/i.test(rows[1].camera) || rows[1].camera.startsWith('wrist '),
    'the holder row says something about the wrist camera: ' + rows[1].camera);
});

test('validateDesign is the top bar\'s Print check dialog', async () => {
  const { V: v, design, model } = await validator();
  const w = v.validateDesign(design);
  assert.ok(w.components.length > 10);
  assert.ok(['pass', 'warn', 'fail'].includes(w.worst));
  const bad = w.components.filter((c) => c.verdict !== 'pass');
  for (const c of w.components) assert.ok(model.component(c.component), `${c.component} is a real component`);
  assert.ok(w.components.every((c) => ['csg', 'display', null].includes(c.preview ?? null)),
    'every row says which mesh it measured');
  const shipped = w.components.filter((c) => (c.preview ?? null) === null).map((c) => c.component);
  assert.ok(shipped.some((id) => id.startsWith('corner_mast_printed_')) && shipped.some((id) => id.startsWith('df200_arch_')),
    'the fitted sets are measured on the plates they ship: ' + shipped.join(', '));
});

test('a stock component has no clearance chip (it is bolted to its neighbours)', async () => {
  const { V: v, design } = await validator();
  assert.equal(v.clearanceOf(design, 'base_plate_layer1-v5'), undefined, 'no slot → no opinion');
  assert.ok(Array.isArray(v.clearanceOf(design, 'corner_mast_printed_spar_lower')),
    'a slot component is checked');
  const r = v.validateComponent(design, 'base_plate_layer1-v5', { stages: ['print'] });
  assert.ok(!r.print.chips.some((c) => c.key === 'clearance'));
  assert.equal(r.print.preview, null, 'the chips are measured on the exported geometry');
  assert.equal(r.print.orientation, 'declared');
  assert.equal(r.print.orientationLabel, 'from package');
  assert.equal(r.print.orientationSource, 'base_plate_layer1.stl');
});


test('a clearance check that throws leaves no phantom part behind', async () => {
  const { model, slots: S, collide: W } = await validator();
  const id = 'corner_mast_printed_spar_lower';
  assert.ok(S.slotOfComponent(id), id + ' sits in a slot, so it gets a clearance chip');

  const before = W.parts.size;
  const real = W.checkTransform;
  let calls = 0;
  W.checkTransform = () => { calls += 1; throw new Error('BVH exploded'); };
  const v = createValidator({ model, slots: S, cameras: null, collide: W });
  const hits = v.clearanceOf(defaultDesign(model.id), id);
  W.checkTransform = real;

  assert.equal(calls, 1, 'the throw really happened');
  assert.deepEqual(hits, [], 'and is swallowed into "no hits", as before');
  assert.equal(W.parts.size, before,
    'col.remove(tmp) was skipped, so __validate__<id> stayed registered and active for the session');
  assert.equal(W.parts.has('__validate__' + id), false);
  assert.ok(!W.activeIds().some((x) => x.startsWith('__validate__')));

  /* and the world still answers honestly afterwards */
  assert.ok(W.checkPose(model.getJoints(), { maxHits: 4 }).hits.every((h) => !String(h.a + h.b).includes('__validate__')));
});

test('`presets` is a getter, so setPresets() is visible to a caller holding the object', async () => {
  const { model, slots: S, collide: W } = await validator();
  const v = createValidator({ model, slots: S, collide: W });
  assert.equal(v.presets.length, 4);
  const mine = [{ id: 'parked', name: 'parked', label: 'parked', q: { arm_shoulder_pan: 0 } }];
  v.setPresets(mine);
  assert.deepEqual(v.presets, mine, '`presets` was captured at creation and never changed');
  assert.equal(v.physicsOf({ joints: {} }, { stage: 'presets' }).presets.length, 1,
    'and physicsOf uses the new list too');
  v.setPresets(null);
  assert.deepEqual(v.presets, []);
});

test('the clearance chip does not depend on whether the presets ran first', async () => {
  const { V: v, design } = await validator();
  const id = 'corner_mast_printed_spar_lower';
  const names = (hits) => hits.map((h) => h.a + ' × ' + h.b).sort();

  const first = names(v.clearanceOf(design, id));
  v.physicsOf(design);                      // parks the world in the LAST preset
  const afterPresets = names(v.clearanceOf(design, id));
  assert.deepEqual(afterPresets, first,
    'printOf → clearanceOf ran before physicsOf, so the chip was always one pose behind');

  /* and a component whose clearance really does depend on the pose says so */
  const raised = { ...design, joints: { arm_shoulder_lift: -49, arm_elbow_flex: 99, arm_wrist_flex: 86 } };
  v.clearanceOf(raised, id);
  assert.deepEqual(names(v.clearanceOf(design, id)), first, 'the design pose is what it measures');
});

test('an imported mesh is checked as ITSELF, and its defects reach the export gate', async () => {
  /* two loose triangles: 6 open edges, 2 shells */
  const tris = () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      0, 0, 0, 30, 0, 0, 0, 30, 0,
      0, 0, 30, 30, 0, 30, 0, 30, 30,
    ]), 3));
    return g;
  };
  const build = (extra) => {
    const manifest = {
      schema: ROBOT_SCHEMA, id: 'imp', name: 'imp', links: ['root'],
      components: [{ id: 'bracket', label: 'bracket.stl', link: 'root', mesh: 'm', printable: true, ...extra }],
    };
    const m = RobotModel.fromPackage(manifest, () => tris());
    return m;
  };

  const imported = build({ group: 'imported', source: 'import:bracket.stl' });
  await imported.loadGeometries();
  const vi = createValidator({ model: imported });
  const design = defaultDesign('imp');
  const gi = vi.geometryOf(design, 'bracket');
  assert.equal(gi.ownMesh, true, 'the validator knows this file is the user\'s own');
  const pi = vi.printOf(design, 'bracket');
  assert.equal(pi.preview, null, 'preview "display" — a decimated mesh that does not exist');
  const closed = pi.chips.find((c) => c.key === 'closed');
  const bodies = pi.chips.find((c) => c.key === 'bodies');
  assert.equal(closed.level, 'fail', 'warn, and filtered out of the gate');
  assert.equal(closed.value, 6, '6 open edges');
  assert.equal(bodies.level, 'fail');
  assert.equal(bodies.value, 2, '2 separate shells');
  assert.ok(!/display mesh/.test(closed.detail), 'and it does not blame a preview: ' + closed.detail);
  assert.match(closed.detail, /file you imported/);
  assert.equal(pi.actionable, 'fail', 'the gate fires — "Export anyway" is the only way past');
  assert.equal(pi.verdict, 'fail');

  /* the same geometry as a PACKAGE component is measured on a display mesh: unknown */
  const shipped = build({ group: 'arm' });
  await shipped.loadGeometries();
  const ps = createValidator({ model: shipped }).printOf(defaultDesign('imp'), 'bracket');
  assert.equal(ps.preview, 'display');
  assert.equal(ps.chips.find((c) => c.key === 'closed').level, 'unknown');
  assert.equal(ps.actionable, 'pass', 'a package part is not gated on its display mesh');
});

test('Fit uses live transforms: a Move or a hinge detent into a neighbour warns, naming it', async () => {
  const { designParts } = await import('../../../src/features/sim-design.js');
  const { model, slots, design, V } = await validator();
  const fitOf = (d, id) => V.printOf(d, id).chips.find((c) => c.key === 'clearance');
  const live = (d, fn) => { const undo = designParts(model, slots, d); try { return fn(); } finally { undo(); } };
  const ids = ['corner_mast_printed_spar_lower', 'df200_arch_head', 'df200_arch_retainer'];
  for (const id of ids) assert.equal(fitOf(design, id).level, 'pass', id + ' clean by default');

  const spar = 'corner_mast_printed_spar_lower';
  const L = model.component(spar).local.clone().premultiply(new THREE.Matrix4().makeTranslation(0, 0, -30));
  const moved = { ...design, components: { ...design.components, [spar]: { ...(design.components || {})[spar], transform: L.toArray() } } };
  const m = live(moved, () => fitOf(moved, spar));
  assert.equal(m.level, 'warn');
  assert.match(m.detail, /^hits .*Top deck plate/, m.detail);

  /* no shipped detent collides, so one is added: 100° past the design swings into the drive servo */
  const def = model.manifest.parts.df200_arch.params.tilt_deg;
  const keep = def.values;
  def.values = [...keep, 135];
  try {
    const tilted = { ...design, parts: { ...design.parts, df200_arch: { params: { tilt_deg: 135 } } } };
    const h = live(tilted, () => fitOf(tilted, 'df200_arch_head'));
    assert.equal(h.level, 'warn');
    assert.match(h.detail, /^hits .*STS3215|servo/i, h.detail);
  } finally { def.values = keep; }
  for (const id of ids) assert.equal(fitOf(design, id).level, 'pass', id + ' clean again');
});

test('Fit runs on a mirrored copy: its source\'s own contacts are expected, a hit on the source is not', async () => {
  const { copyFrame } = await import('../../../src/features/part-ops.js');
  const { applyOps } = await import('../../../src/features/ops.js');
  const { model, design, collide, V } = await validator();
  const src = model.component('pincopen/removable_tip');
  const g0 = (src.geometry.userData && src.geometry.userData.opsBase) || src.geometry;
  g0.computeBoundingBox();
  const W = model.worldMatrix(src.id).clone().invert();
  const plane = { point: g0.boundingBox.getCenter(new THREE.Vector3()).toArray(), normal: new THREE.Vector3(1, 0, 0).transformDirection(W).toArray() };
  const geometry = applyOps(g0, [{ op: 'mirror', plane }]).geometry;
  geometry.userData = { copyOf: src.id };
  const key = 'imported/tip-mirror-1', at = copyFrame(model, src);
  model.ownComponents.push({ id: key, localId: key, label: 'Removable Tip (mirror copy)', link: at.link, frame: at.frame,
    local: at.local, group: 'imported', geometry, owner: model, visible: true, imported: true, printable: true });
  model._flatten();
  collide.addDynamic(key, geometry, at.local, { link: at.link, frame: 'robot', group: 'imported', label: 'Removable Tip (mirror copy)' });
  try {
    const fit = V.printOf(design, key).chips.find((c) => c.key === 'clearance');
    console.log(`  copy in place: ${fit && fit.level} · ${fit && fit.detail}`);
    assert.ok(fit, 'no Fit chip on the copy');
    assert.equal(fit.level, 'warn');
    assert.match(fit.detail, /Removable Tip/);
  } finally {
    collide.remove(key);
    model.ownComponents.splice(model.ownComponents.findIndex((c) => c.id === key), 1);
    model._flatten();
  }
});
