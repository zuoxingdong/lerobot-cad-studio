/* `features/part-ops.js`, `mount-frame.js` and `hinge.js` on the shipped packages: the mount a
 * part's ops are anchored to, the mirrored pair, the op-stack cache, the v6 tweak migration,
 * the store's op-stack undo steps, and the hinge knobs against the detents record.json
 * measured, and the jaw's finger-gap row. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as pkg from '../../../src/core/package.js';
import { buildSlots } from '../../../src/features/slots.js';
import { createCollisionWorld } from '../../../src/features/collide.js';
import { createStore, defaultDesign, memoryStorage } from '../../../src/core/store.js';
import { sanitiseDesign } from '../../../src/core/design-shape.js';
import { round } from './_harness.mjs';
import { createPartOps, migrateTweaks, opsOf, opsHash, editedCount } from '../../../src/features/part-ops.js';
import { mountFrame, mountOf } from '../../../src/features/mount-frame.js';
import { hingesOf, hingeValue, hingeTransforms, cameraAdjuster, partOf, isUsable, hingeLabel } from '../../../src/features/hinge.js';
import { opLabel, MOUNT_CLEAR_MM } from '../../../src/features/ops.js';
import { createCameras, adoptAllSlotOptions } from '../../../src/features/cameras.js';
import { motionJoints, hasArmJoints, applicablePresets, controlDisplay } from '../../../src/features/joints.js';
import { ROOT } from '../_root.mjs';

let _c = null;
const gripper = () => comp();
const G = (id) => 'pincopen/' + id;           // a PincOpen component on the composition
async function comp() {
  if (_c) return _c;
  const model = await pkg.loadEmbedded('lekiwi-pincopen');
  const slots = buildSlots(model);
  const design = slots.applyDefaults(defaultDesign('lekiwi-pincopen'));
  _c = { model, slots, design, P: createPartOps({ model, slots }) };
  return _c;
}
const bboxOf = (g) => { if (!g.boundingBox) g.computeBoundingBox(); return g.boundingBox; };
const extent = (g, i) => { const b = bboxOf(g); return b.max.getComponent(i) - b.min.getComponent(i); };

test('the mount: a part folder states it, a stock mesh takes the slot anchor', async () => {
  const { model, slots, P } = await gripper();
  const f = mountFrame(model, G('tip_support'), { slots });
  assert.equal(f.source, 'slot:fingertips');
  assert.deepEqual([f.ai, f.as, f.ci, f.cs], [0, 1, 1, 1]);
  assert.ok(Math.abs(f.origin[1] + 7.75) < 1e-6, 'origin on the mount face: ' + f.origin[1]);
  assert.ok(Math.abs(f.contact - 7.75) < 1e-6);
  assert.equal(f.plane, MOUNT_CLEAR_MM);
  const m = P.mount(G('tip_support'));
  assert.deepEqual(m.normal, [0, 1, 0]);
  assert.deepEqual(m.axis, [1, 0, 0]);
  /* the gripper body takes the gripper slot's anchor; no usable anchor: the bbox frame, no ops mount */
  assert.equal(mountFrame(model, G('top_plate'), { slots }).source, 'slot:gripper');
  assert.equal(mountFrame(model, G('removable_tip'), { slots }).source, 'bbox');
  assert.equal(mountOf(model, G('removable_tip'), { slots }), null);
  assert.equal(mountFrame(model, G('cam'), { slots: null }).source, 'bbox');

  const c = await comp();
  const spar = mountOf(c.model, 'corner_mast_printed_spar_lower', { slots: c.slots });
  assert.equal(spar.source, 'part:corner_mast_printed');
  assert.deepEqual(spar.normal, [0, 0, -1]);
  assert.equal(spar.point[2], 57);
  assert.equal(partOf(c.model, 'corner_mast_printed_head').id, 'corner_mast_printed');
  assert.equal(partOf(c.model, 'pincopen/tip_support'), null);
});

test('a mirrored pair is one key and one geometry; the cache keys on the stack hash', async () => {
  const { model, P } = await gripper();
  const g = P.group(G('tip_support_2'));
  assert.deepEqual(g.ids, [G('tip_support'), G('tip_support_2')]);
  assert.equal(P.designKey(G('tip_support_2')), G('tip_support'));
  const ops = [{ op: 'scale', factors: [1, 1.2, 1], about: 'mount' }];
  const a = P.build(G('tip_support'), ops), b = P.build(G('tip_support_2'), ops);
  assert.ok(a.ok && !a.refused);
  assert.ok(a.geometry === b.geometry, 'the same stack built twice');
  assert.ok(b.cached);
  assert.ok(P.build(G('tip_support'), []).geometry === P.original(G('tip_support')), 'an empty stack is the pristine mesh');
  assert.notEqual(opsHash(ops), opsHash([{ ...ops[0], factors: [1, 1.3, 1] }]));
  assert.ok(Math.abs(extent(a.geometry, 1) - 1.2 * extent(P.original(G('tip_support')), 1)) < 1e-3);
  void model;
});

test('v6 tweaks migrate: the scale maps exactly, what the gate refuses is dropped and named', async () => {
  const { P } = await gripper();
  const tip = G('tip_support');
  const v6 = { [tip]: { length_mm: 5, width_scale: 1.1, height_scale: 1.2, pad_mm: 1 }, nope: { length_mm: 2 } };
  const raw = migrateTweaks(v6, P.frameOf);
  assert.deepEqual(raw.dropped, ['nope']);
  assert.deepEqual(raw.parts[tip].ops.map((o) => o.op), ['stretch', 'scale', 'offset_face']);
  const r = P.migrate(v6);
  assert.deepEqual(r.parts[tip].ops.map((o) => o.op), ['scale']);
  assert.ok(r.dropped.includes(tip + '.length_mm') && r.dropped.includes(tip + '.pad_mm'), r.dropped.join(','));
  const built = P.build(tip, r.parts[tip].ops);
  assert.ok(built.ok && !built.refused, JSON.stringify(built.refused));
  const base = P.original(tip);
  assert.ok(Math.abs(extent(built.geometry, 1) - 1.2 * extent(base, 1)) < 1e-3, 'thickness');
  assert.ok(Math.abs(extent(built.geometry, 2) - 1.1 * extent(base, 2)) < 1e-3, 'width');
  assert.ok(Math.abs(extent(built.geometry, 0) - extent(base, 0)) < 1e-6, 'length untouched');
  /* a length on a part that HAS a clean plane maps to a stretch of exactly that length */
  const c = await comp();
  const m = c.P.migrate({ corner_mast_printed_spar_lower: { length_mm: -20 } });
  const st = m.parts.corner_mast_printed_spar_lower;
  if (st) {
    const g = c.P.build('corner_mast_printed_spar_lower', st.ops).geometry;
    const d = extent(g, 2) - extent(c.P.original('corner_mast_printed_spar_lower'), 2);
    assert.ok(Math.abs(d + 20) < 1e-3, 'shortened ' + d);
  }
});

test('the store: one applied op is one named undo step, and ops survive JSON', async () => {
  const store = createStore(defaultDesign('lekiwi-pincopen'), { storage: memoryStorage(), coalesceMs: 0 });
  const op = { op: 'stretch', axis: [0, 0, 1], at: 150, by: -20 };
  const label = opLabel(op, 'Lower spar');
  assert.equal(label, 'Shorten · Lower spar · −20 mm');
  store.pushOps([{ key: 'spar', op }], label);
  assert.deepEqual(store.history().past, [label]);
  assert.equal(opsOf(store.getState(), 'spar').length, 1);
  store.pushOps([{ key: 'spar', op: { op: 'mirror', plane: { point: [0, 0, 0], normal: [1, 0, 0] } } }, { key: 'arch', op }], 'two');
  assert.equal(store.history().past.length, 2, 'a multi-part apply is ONE step');
  assert.equal(editedCount(store.getState()), 2);
  store.undo();
  assert.equal(opsOf(store.getState(), 'spar').length, 1);
  assert.equal(opsOf(store.getState(), 'arch').length, 0);
  store.redo();
  store.dropOp('spar', 0, 'remove');
  assert.deepEqual(opsOf(store.getState(), 'spar').map((o) => o.op), ['mirror'], 'removing one op keeps the rest');
  store.clearOps(['spar', 'arch'], 'reset');
  assert.deepEqual(store.getState().parts, {});
  store.undo();
  const json = store.exportJSON();
  const back = createStore(null, { storage: memoryStorage() });
  assert.ok(back.importJSON(json).ok);
  assert.deepEqual(back.getState().parts, store.getState().parts);
  const bad = sanitiseDesign({ parts: { a: { ops: [{ op: 'stretch' }, 3, null] }, b: 7 } });
  assert.deepEqual(bad.design.parts, { a: { ops: [{ op: 'stretch' }] } });
  assert.equal(bad.warnings.length, 2);
});

test('the mast hinge turns the camera onto every detent record.json measured', async () => {
  const { model, slots, design } = await comp();
  const [{ key, def }] = hingesOf(model, 'corner_mast_printed');
  assert.equal(key, 'tilt_deg');
  assert.equal(hingeValue(design, 'corner_mast_printed', key, def), 45);
  const rec = JSON.parse(readFileSync(`${ROOT}/assets/parts/corner_mast_printed/record.json`, 'utf8'));
  const want = rec.params.detent_cam_mm;
  const rows = [];
  let worst = 0;
  for (const v of def.values) {
    const d = { ...design, parts: { corner_mast_printed: { params: { tilt_deg: v } } } };
    const cams = createCameras(model);
    adoptAllSlotOptions(cams, slots, d, cameraAdjuster(model, d));
    const o = cams.getPose('top', {}).origin.toArray();
    const w = want[String(v)];
    const err = Math.hypot(o[0] - w[0], o[1] - w[1], o[2] - w[2]);
    worst = Math.max(worst, err);
    rows.push({ detent: v, usable: isUsable(def, v) ? 'yes' : 'no', origin: o.map((x) => round(x, 3)).join(', '), err_mm: round(err, 5) });
  }
  assert.ok(worst < 1e-3, 'worst ' + worst);
  /* the moving meshes only, and only off the design detent */
  const d55 = { ...design, parts: { corner_mast_printed: { params: { tilt_deg: 55 } } } };
  const H = hingeTransforms(model, d55);
  assert.deepEqual([...H.keys()].sort(), ['corner_mast_printed_df200', 'corner_mast_printed_head', 'corner_mast_printed_retainer']);
  assert.equal(hingeTransforms(model, design).size, 0);
  const p = H.get('corner_mast_printed_head').elements;
  const o = def.origin;
  const fixed = [0, 1, 2].map((i) => p[i] * o[0] + p[4 + i] * o[1] + p[8 + i] * o[2] + p[12 + i]);
  assert.ok(Math.hypot(...fixed.map((x, i) => x - o[i])) < 1e-9, 'the hinge axis is fixed');
  assert.equal(hingeValue({ parts: { corner_mast_printed: { params: { tilt_deg: 57 } } } }, 'corner_mast_printed', key, def), 55, 'snaps to a detent');
  assert.equal(hingeLabel(key, 'Corner mast', 55), 'Tilt · Corner mast · 55°');
});

test('the arch hinge carries the wrist camera and leaves the arch plate alone', async () => {
  const { model, slots, design } = await comp();
  const [{ def }] = hingesOf(model, 'df200_arch');
  assert.equal(def.camera, 'wrist');
  const pose = (v) => {
    const d = { ...design, parts: { df200_arch: { params: { tilt_deg: v } } } };
    const cams = createCameras(model);
    adoptAllSlotOptions(cams, slots, d, cameraAdjuster(model, d));
    return { cam: cams.getPose('wrist', {}), H: hingeTransforms(model, d) };
  };
  const a = pose(35), b = pose(45);
  assert.ok(Math.abs(Math.abs(a.cam.tilt_deg - b.cam.tilt_deg) - 10) < 1e-6, `${a.cam.tilt_deg} -> ${b.cam.tilt_deg}`);
  assert.ok(!b.H.has('df200_arch_arch'), 'the printed arch never turns');
  assert.ok(b.H.has('df200_arch_head'));
});

/* the PincOpen jaw on the composition */

test('the gripper rides the wrist in the collision world: one body with Wrist_Roll', async () => {
  const c = await pkg.loadEmbedded('lekiwi-pincopen');
  const w = createCollisionWorld({ model: c });
  assert.equal(w.bodyIndex('pincopen/internal_rod'), w.bodyIndex('Wrist_Roll_08c-v1'));
  assert.equal(w.bodyIndex('pincopen/top_plate'), w.bodyIndex('Wrist_Roll_08c-v1'));
});

test('the pose popover shows the jaw as a finger gap in mm', async () => {
  const c = await comp();
  assert.equal(hasArmJoints(c.model, c.design, c.slots), true);
  const jaw = motionJoints(c.model, c.design, c.slots).find((j) => j.gripper);
  assert.deepEqual({ name: jaw.name, unit: jaw.unit, min: jaw.min, max: jaw.max }, { name: 'pincopen/jaw', unit: 'mm', min: 0, max: 40 });
  assert.equal(jaw.jointUnit, '°');
  assert.ok(Math.abs(jaw.toDisplay(30.0007) - 40) < 1e-3);
  assert.ok(Math.abs(jaw.fromDisplay(8.5) - 6.8122) < 1e-3);
  assert.ok(Math.abs(jaw.toDisplay(jaw.fromDisplay(8.5)) - 8.5) < 1e-9);
  assert.equal(controlDisplay(c.model, 'pincopen/jaw').unit, 'mm');
  assert.equal(controlDisplay(c.model, 'nope'), null);
  assert.equal(applicablePresets(c.model, [{ id: 'stowed', q: { arm_shoulder_lift: 0 } }, { id: 'bad', q: { nope: 0 } }]).length, 1);
});
