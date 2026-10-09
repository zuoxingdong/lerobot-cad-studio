/* `features/slots.js` against `manifest.slots` of the real robot package and the
 * rps/design@1 state shape.  No embedded profile: everything comes from
 * `assets/robots/lekiwi-pincopen/robot.json`, resolved. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { studio } from './_harness.mjs';
import {
  buildSlots, slotOfComponent, describeComponent, options, registerAlternatives,
  applyOption, applyDefaults, activeOption, reconcile, slotSummary, importOption,
  anchorOf, SLOTS_SCHEMA, ALTERNATIVE_SCHEMA,
} from '../../../src/features/slots.js';
import { defaultDesign } from '../../../src/core/store.js';
import { parametricFor, buildParametric, modelContext } from '../../../src/features/parts.js';
import * as THREE from 'three';
import { RobotModel } from '../../../src/core/robot-model.js';

const EXPECT_ORDER = ['top_camera_mount', 'wrist_camera_mount', 'gripper', 'fingertips',
  'pi_case', 'front_camera'];
/* ONE DESIGN PER SLOT: the package ships the latest design, the stock part where
   there is one, `none` and `import` — nothing else.  The rev-8 mast, the tube corner mast,
   the three NormaCam heads, the six fingertip concepts and the never-fitted cable clip (with
   the whole `wrist_cable` slot) are retired. */
const EXPECT_DEFAULTS = {
  top_camera_mount: 'corner_mast_printed', wrist_camera_mount: 'df200_arch', gripper: 'pincopen',
  fingertips: 'original', pi_case: 'vertical_revI', front_camera: 'stock',
};
/* the whole swap list of every slot, in order — the user-visible promise of this package */
const EXPECT_OPTIONS = {
  top_camera_mount: ['corner_mast_printed', 'none', 'import'],
  wrist_camera_mount: ['df200_arch', 'pincopen_holder', 'stock', 'none', 'import'],
  gripper: ['pincopen', 'stock_jaw', 'none', 'import'],
  fingertips: ['original', 'none', 'import'],
  pi_case: ['vertical_revI', 'stock', 'none', 'import'],
  front_camera: ['stock', 'none', 'import'],
};

test('buildSlots(model) reads the package, with no warnings', async () => {
  const { slots: S, model } = await studio();
  assert.equal(S.schema, SLOTS_SCHEMA);
  assert.deepEqual(S.warnings, [], S.warnings.join('\n'));
  assert.deepEqual(S.order, EXPECT_ORDER);
  for (const id of EXPECT_ORDER) assert.ok(S.slots[id], `slot "${id}" exists`);
  assert.deepEqual(S.defaults(), EXPECT_DEFAULTS);
  for (const [sid, want] of Object.entries(EXPECT_OPTIONS)) {
    assert.deepEqual(S.slots[sid].options.map((o) => o.id), want, `swap list of ${sid}`);
  }
  assert.equal(S.robot, model.id);
});

test('every component belongs to at most one slot', async () => {
  const { slots: S, model } = await studio();
  const seen = new Map();
  let dup = 0;
  for (const sid of S.order) for (const id of S.slots[sid].owns) {
    if (seen.has(id)) dup++; else seen.set(id, sid);
  }
  assert.equal(dup, 0, 'no component is owned twice');
  assert.equal(seen.size, 42, `42 of the ${model.components.length} components sit in a slot`);
  /* the explicit claim beats the attachment:* expansion */
  assert.equal(S.owner.get('pincopen/tip_support'), 'fingertips');
  assert.equal(S.owner.get('pincopen/top_plate'), 'gripper');
  assert.equal(S.owner.get('pincopen/camera_basement'), 'wrist_camera_mount');
  assert.equal(S.owner.get('pincopen/camera_mobile_sup'), 'wrist_camera_mount');
  assert.equal(S.owner.get('pincopen/cam'), 'gripper');
  assert.equal(S.owner.get('Wrist_Roll_08c-v1'), 'gripper');
  assert.equal(S.owner.get('Wrist-Camera-Mount-v11'), 'wrist_camera_mount');
  assert.equal(S.owner.get('Camera-Model-v3-1'), 'wrist_camera_mount');
  for (const id of ['pincopen/tip_support', 'pincopen/tip_support_2',
    'pincopen/removable_tip', 'pincopen/removable_tip_2']) {
    assert.equal(S.owner.get(id), 'fingertips', id);
  }
  assert.equal(S.slots.fingertips.optionById.original.shows.length, 4,
    '"Original PincOpen tips" shows all four, so "none" has something to take off');
});

test('slotOfComponent resolves ids, records and picked objects', async () => {
  const { slots: S } = await studio();
  assert.equal(slotOfComponent('corner_mast_printed_head', S), 'top_camera_mount');
  assert.equal(slotOfComponent('pincopen/tip_support', S), 'fingertips');
  assert.equal(slotOfComponent('Moving_Jaw_08d-v1', S), 'gripper');
  assert.equal(slotOfComponent('base_plate_layer1-v5', S), null, 'a component outside every slot');
  assert.equal(S.slotOfComponent({ userData: { componentId: 'df200_arch_arch' } }), 'wrist_camera_mount');
  assert.equal(S.slotOfComponent({ parent: { userData: { componentId: 'pi_case_panel' } }, userData: {} }), 'pi_case');
  const d = describeComponent('corner_mast_printed_spar_lower', S);
  assert.equal(d.label, 'Overhead camera mount');
  assert.equal(d.optionCount, S.slots.top_camera_mount.options.length);
  /* the Pi case is the one fitted design this package still generates parametrically */
  assert.equal(describeComponent('pi_case_cradle', S).parametric.id, 'pi_case');
});

test('within one slot, no component is shown by two options', async () => {
  const { slots: S } = await studio();
  for (const sid of S.order) {
    const seen = new Map();
    for (const o of S.slots[sid].options) for (const id of o.shows) {
      assert.ok(!seen.has(id), `${sid}: "${id}" is shown by "${seen.get(id)}" and "${o.id}"`);
      seen.set(id, o.id);
    }
  }
});

test('applying every option leaves exactly one active, and is inferable', async () => {
  const { slots: S, design } = await studio();
  let applied = 0;
  for (const sid of S.order) {
    for (const o of S.slots[sid].options) {
      if (o.kind === 'import') continue;
      const r = applyOption(design, sid, o.id, {}, S);
      applied++;
      assert.equal(r.design.slots[sid], o.id);
      /* every component the option shows is visible; every sibling is not */
      for (const id of S.slots[sid].owns) {
        assert.equal(r.design.components[id].visible, o.showSet.has(id), `${sid}/${o.id}: ${id}`);
      }
      /* and the option can be recovered from the components alone */
      assert.equal(activeOption({ components: r.design.components }, sid, S), o.id, `${sid}/${o.id} inferable`);
    }
  }
  assert.equal(applied, 16, `${applied} option applications`);
});

test('cross-slot rules cascade, and the origin slot is pinned', async () => {
  const { slots: S, design } = await studio();
  const seen = [];
  const r = applyOption(design, 'gripper', 'stock_jaw', { onCascade: (s, o, w) => seen.push(`${s}=${o} (${w})`) }, S);
  assert.equal(r.design.slots.gripper, 'stock_jaw');
  assert.equal(r.design.slots.wrist_camera_mount, 'stock', 'the stock jaw pushes the NormaCam out');
  assert.equal(r.design.components['Wrist-Camera-Mount-v11'].visible, true);
  assert.equal(r.design.components['pincopen/camera_basement'].visible, false,
    'and the PincOpen holder goes with the PincOpen');
  assert.equal(r.design.components['Moving_Jaw_08d-v1'].visible, true);
  assert.equal(r.design.components['Wrist_Roll_08c-v1'].visible, true,
    'the fixed jaw comes back with the moving one — a jaw needs something to close onto');
  assert.equal(r.design.components['pincopen/top_plate'].visible, false, 'the whole PincOpen goes');
  assert.equal(r.design.components['pincopen/tip_support'].visible, false, '…including the fingertips sub-slot');
  assert.equal(r.design.components.df200_arch_head.visible, false,
    'the whole wrist camera mount goes with the gripper it bolts to');
  assert.ok(seen.length >= 1, seen.join(' | '));
  /* and back */
  const back = applyOption(r.design, 'gripper', 'pincopen', {}, S);
  assert.equal(back.design.components['pincopen/top_plate'].visible, true);
  assert.equal(back.design.components['Moving_Jaw_08d-v1'].visible, false);
  assert.equal(back.design.components['Wrist_Roll_08c-v1'].visible, false,
    'and the fixed jaw goes off again — PincOpen bolts to the bare wrist-roll horn');
});

test('the PincOpen fingertips need the PincOpen gripper, and the rule is in the package', async () => {
  const { slots: S, design } = await studio();
  const tips = S.slots.fingertips.optionById.original;
  assert.deepEqual(tips.requires, { gripper: { any: ['pincopen'], else: 'pincopen' } },
    'the tips declare the gripper they bolt to');
  for (const off of ['stock_jaw', 'none', 'import']) {
    const rule = S.slots.gripper.optionById[off].requires.fingertips;
    assert.deepEqual(rule, { any: ['none', 'import'], else: 'none' }, off);
    const r = applyOption(design, 'gripper', off, {}, S);
    assert.equal(r.design.slots.fingertips, 'none', `${off} takes the tips off`);
    for (const id of ['pincopen/tip_support', 'pincopen/tip_support_2',
      'pincopen/removable_tip', 'pincopen/removable_tip_2']) {
      assert.equal(r.design.components[id].visible, false, `${off}: ${id}`);
    }
  }
  /* and a stored design that names BOTH is repaired, not obeyed */
  const both = applyOption({ ...design, slots: { ...design.slots, fingertips: 'original' } },
    'gripper', 'stock_jaw', {}, S);
  assert.equal(both.design.slots.fingertips, 'none');
  const back = applyOption(both.design, 'gripper', 'pincopen', {}, S);
  assert.equal(back.design.slots.fingertips, 'none', 'an emptied slot stays empty');
  /* asking for the tips is what brings the gripper they bolt to */
  const tipsOn = applyOption(both.design, 'fingertips', 'original', {}, S);
  assert.equal(tipsOn.design.slots.gripper, 'pincopen', 'the tips bring their gripper');
  assert.equal(tipsOn.design.components['pincopen/tip_support'].visible, true);
});

test('the default configuration is idempotent and is what the package declares', async () => {
  const { slots: S, model } = await studio();
  const D1 = applyDefaults(defaultDesign(model.id), {}, S);
  const D2 = applyDefaults(D1, {}, S);
  assert.deepEqual(D2.slots, D1.slots);
  assert.deepEqual(D2.components, D1.components);
  assert.deepEqual(D1.slots, model.manifest.default_design, 'matches robot.json default_design');
  const visible = Object.entries(D1.components).filter(([, v]) => v.visible).map(([k]) => k);
  assert.equal(visible.length, 33, 'the startup design shows 33 slot-managed components');
  assert.ok(!visible.includes('pincopen/camera_basement') && !visible.includes('pincopen/camera_mobile_sup'),
    'the stock PincOpen camera holder is not on the robot when the DF200 arch is');
  assert.ok(visible.includes('pincopen/cam'), 'but the gripper cam disc is — it is not a camera part');
  assert.ok(!visible.includes('Wrist-Camera-Mount-v11') && !visible.includes('Camera-Model-v3-1')
            && !visible.includes('cable_clip_F'),
    'and nothing is left over as a loose hidden component');
  assert.ok(visible.includes('corner_mast_printed_head') && visible.includes('df200_arch_head')
            && visible.includes('pi_case_cradle'));
  assert.ok(visible.includes('corner_mast_printed_df200') && visible.includes('df200_arch_df200'),
    'each head has its camera module in it');
  assert.ok(!visible.includes('mast_upper') && !visible.includes('normacam_22'),
    'the superseded mounts are options now, not the default fit');
  assert.ok(!visible.includes('Moving_Jaw_08d-v1') && !visible.includes('Bottom-V2-v3'));
  assert.ok(!visible.includes('Wrist_Roll_08c-v1'),
    'the stock fixed jaw is not on the robot when PincOpen is');
  assert.deepEqual(Object.keys(D1.params).sort(), ['pi_case_cradle', 'pi_case_panel']);
  /* every slot reports itself at its default */
  for (const r of slotSummary(D1, S)) assert.ok(r.isDefault, `${r.slot} is at its default`);
});

test('applyOption never touches its input', async () => {
  const { slots: S, design } = await studio();
  const before = JSON.stringify(design);
  const out = applyOption(design, 'top_camera_mount', 'none', {}, S);
  assert.equal(JSON.stringify(design), before, 'the input design is unchanged');
  assert.notEqual(out.design, design);
  assert.notEqual(out.design.components, design.components);
  assert.notEqual(out.design.params, design.params);
  /* the patch is minimal and feeds store.patch() */
  assert.deepEqual(Object.keys(out.patch).sort(), ['components', 'slots']);
  assert.deepEqual(out.patch.slots, { top_camera_mount: 'none' });
});

test('inbox alternatives join the option list and apply', async () => {
  const { slots: S, design } = await studio();
  const res = registerAlternatives([{
    schema: ALTERNATIVE_SCHEMA, slot: 'top_camera_mount', id: 'mast-50-short',
    label: 'mast tilt 50 short', frame: 'robot', local: new THREE.Matrix4().toArray(),
    printable: true, params: { tilt_deg: 50 }, source: 'inbox 2026-09-13',
    files: ['part.stl'], path: 'alternatives/lekiwi-pincopen/top_camera_mount/mast-50-short',
  }], S);
  assert.equal(res.added, 1);
  const list = options('top_camera_mount', S);
  const groups = list.map((o) => o.group);
  assert.deepEqual([...new Set(groups)], ['package', 'agent', 'import'], 'PACKAGE, FROM AGENT, IMPORT — in that order');
  const alt = list.find((o) => o.group === 'agent');
  assert.equal(alt.id, 'alt:mast-50-short');
  const r = applyOption(design, 'top_camera_mount', 'alt:mast-50-short', {}, S);
  assert.equal(r.design.slots.top_camera_mount, 'alt:mast-50-short');
  assert.equal(r.design.components['alt:mast-50-short'].visible, true);
  assert.equal(r.design.components.corner_mast_printed_spar_lower.visible, false,
    'the package option steps aside');
  assert.equal(r.design.params['alt:mast-50-short'].tilt_deg, 50);
  S.clearAlternatives('top_camera_mount');
  assert.equal(options('top_camera_mount', S).filter((o) => o.group === 'agent').length, 0);
});

test('anchors resolve, and importOption places geometry there', async () => {
  const { slots: S } = await studio();
  const rows = S.order.map((sid) => {
    const a = anchorOf(sid, S);
    return { slot: sid, anchor: a.name, resolved: a.source, parent: a.parent, matrix: a.matrix ? 'yes' : 'no' };
  });
  for (const r of rows) assert.notEqual(r.resolved, 'identity', `${r.slot} anchor resolves`);

  const g = new THREE.BoxGeometry(20, 30, 10);
  const rec = importOption('pi_case', g, 'my_case.stl', { id: 'my_part' }, S);
  assert.equal(rec.schema, 'rps/assembly@1#part');
  assert.equal(rec.id, 'my_part');
  assert.equal(rec.slot, 'pi_case');
  assert.equal(rec.transform.length, 16);
  /* deck anchors are base-centred: the box lands centred on the anchor, resting on Z 57 */
  assert.ok(Math.abs(rec.transform[12] - 0) < 1e-9);
  assert.ok(Math.abs(rec.transform[13] - -71.65) < 1e-9);
  assert.ok(Math.abs(rec.transform[14] - (57 + 5)) < 1e-9, 'base centre puts the box bottom on the deck');
  assert.equal(rec.meta.placement.fit, 'base_centre');
  assert.equal(rec.meta.faces, 12);

  /* a wrist anchor is a link frame: the geometry is assumed to be in it already */
  const wrist = importOption('wrist_camera_mount', g, 'cam.stl', {}, S);
  assert.equal(wrist.parent, 'Wrist_Roll_08c-v1', 'so an imported wrist part follows the arm');
  assert.equal(wrist.meta.placement.fit, 'origin');
});

test('it is generic: a package with no slots, and one with its own', async () => {
  /* no slots at all -> an empty, harmless slot set (an imported STL robot) */
  const bare = RobotModel.fromPackage({
    schema: 'rps/robot@1', id: 'bare', name: 'Bare', units: 'mm', up: 'z',
    components: [{ id: 'lump', label: 'Lump', frame: 'robot', group: 'other' }],
  }, null, { strict: false });
  const S2 = buildSlots(bare);
  assert.deepEqual(S2.order, []);
  assert.equal(S2.slotOfComponent('lump'), null);
  assert.deepEqual(S2.defaults(), {});
  assert.deepEqual(slotSummary({}, S2), []);

  /* a different package, with slots of its own, needs no code change here */
  const { pkg: P } = await studio();
  const lekiwi = await P.loadEmbedded('lekiwi');
  const S3 = buildSlots(lekiwi);
  assert.deepEqual(S3.warnings, [], S3.warnings.join('\n'));
  assert.deepEqual(S3.order.sort(), ['front_camera', 'gripper', 'pi_case', 'wrist_camera_mount']);
  assert.equal(S3.slotOfComponent('Moving_Jaw_08d-v1'), 'gripper');
  const D = applyDefaults(defaultDesign('lekiwi'), {}, S3);
  assert.equal(D.components['Moving_Jaw_08d-v1'].visible, true, 'stock LeKiwi keeps its own jaw');
  assert.equal(S3.slotOfComponent('Wrist_Roll_08c-v1'), 'gripper', 'the fixed jaw is a gripper part');
  assert.equal(S3.slotOfComponent('STS3215_03a-v1-4'), 'gripper', 'and so is the jaw servo');
  assert.equal(D.components['Wrist_Roll_08c-v1'].visible, true, 'stock_jaw keeps it drawn');
  assert.equal(lekiwi.manifest.components.find((c) => c.id === 'Wrist_Roll_08c-v1').hidden_by_default,
    undefined, 'and the stock package does not hide it');
  const none = applyOption(D, 'gripper', 'none', {}, S3).design;
  for (const id of ['Wrist_Roll_08c-v1', 'Moving_Jaw_08d-v1', 'STS3215_03a-v1-4']) {
    assert.equal(none.components[id].visible, false, `"No gripper" leaves ${id} drawn`);
  }
});
