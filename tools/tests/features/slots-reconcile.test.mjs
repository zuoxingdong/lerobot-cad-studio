/* What a design's slot state does over time: a swap keeps an unrelated tweak, the inbox
   watcher answers on mtime or count, a slot can be emptied, and `reconcile()` settles a
   loaded design into one mount per slot. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { studio } from './_harness.mjs';
import {
  slotOfComponent, options, registerAlternatives, applyOption, applyDefaults, activeOption,
  reconcile, ALTERNATIVE_SCHEMA,
} from '../../../src/features/slots.js';
import { defaultDesign } from '../../../src/core/store.js';
import { parametricFor, buildParametric, modelContext } from '../../../src/features/parts.js';

test('a user tweak survives a swap of an UNRELATED slot', async () => {
  const { model, slots: S } = await studio();
  const p = parametricFor('pi_case_cradle');
  assert.ok(p && p.id === 'pi_case', 'the component maps onto the pi_case part');

  let d = applyDefaults(defaultDesign(model.id), {}, S);
  assert.ok(d.params.pi_case_cradle, 'the default option seeds the part parameters');
  const knob = Object.keys(p.defaults)[0];
  const tweaked = p.defaults[knob] + 3;

  /* the user drags a Pi-case knob */
  d = { ...d, params: { ...d.params, pi_case_cradle: { ...d.params.pi_case_cradle, [knob]: tweaked } } };

  /* …then swaps a completely different slot */
  const other = S.order.find((sid) => sid !== 'pi_case' && S.slots[sid].options.length > 1);
  const r = applyOption(d, other, S.slots[other].options[0].id, {}, S);
  assert.equal(r.design.params.pi_case_cradle[knob], tweaked,
    'the variant params were merged AFTER the user\'s and every slot was re-applied');
  assert.ok(!r.patch.params || !r.patch.params.pi_case_cradle,
    'and the patch does not even mention a component this slot does not own');

  /* the same precedence buildParametric uses, so the design and the mesh agree */
  const built = buildParametric('pi_case_cradle', r.design.params.pi_case_cradle,
    modelContext(model, r.design.params));
  assert.ok(built.ok, built.error);
  assert.equal(built.params[knob], tweaked);

  /* re-applying the SLOT THAT OWNS IT also keeps the tweak … */
  const same = applyOption(r.design, 'pi_case', 'vertical_revI', {}, S);
  assert.equal(same.design.params.pi_case_cradle[knob], tweaked);
  /* … while the defaults below it still land */
  for (const k of Object.keys(p.defaults)) {
    if (k !== knob) assert.equal(same.design.params.pi_case_cradle[k], p.defaults[k], k);
  }
});

test('applyOption only re-applies the parametrics of the slot it touched and its cascades', async () => {
  const { model, slots: S } = await studio();
  const d = applyDefaults(defaultDesign(model.id), {}, S);

  const sid = 'pi_case';
  const r = applyOption(d, sid, 'vertical_revI', {}, S);
  const touched = new Set([sid, ...r.cascades.map((c) => c.slot)]);

  const rewritten = Object.keys(r.design.params).filter((id) => r.design.params[id] !== d.params[id]);
  for (const id of rewritten) {
    const owner = S.slotOfComponent(id);
    assert.ok(owner && touched.has(owner),
      `params of "${id}" (slot ${owner}) were rewritten by a swap of ${sid}`);
  }
  assert.ok(rewritten.length >= 1, 'the slot that WAS touched still gets its parametrics applied');
  const other = applyOption(d, 'top_camera_mount', 'corner_mast_printed', {}, S);
  assert.deepEqual(Object.keys(other.design.params).filter((id) => other.design.params[id] !== d.params[id]),
    [], 'a swap of a non-parametric slot rewrote a parameter');

  /* a cascade still counts as touched: switching the gripper off moves `fingertips` */
  const withCascade = applyOption(d, 'gripper', 'stock_jaw', {}, S);
  assert.ok(withCascade.cascades.length, 'this swap really does cascade');
  for (const c of withCascade.cascades) {
    const opt = S.option(c.slot, c.option);
    for (const id of (opt && opt.shows) || []) {
      if (!parametricFor(id)) continue;
      assert.ok(withCascade.design.params[id], `the cascaded slot ${c.slot} still gets ${id}'s params`);
    }
  }
});

test('registerAlternatives clears a slot the watcher answered for with nothing', async () => {
  const { slots: S } = await studio();
  const alt = (id) => ({
    schema: ALTERNATIVE_SCHEMA, slot: 'top_camera_mount', id, label: id,
    frame: 'robot', local: new THREE.Matrix4().toArray(), files: ['part.stl'], mtime: 1,
  });
  assert.equal(registerAlternatives([alt('a'), alt('b')], S).added, 2);
  assert.equal(options('top_camera_mount', S).filter((o) => o.group === 'agent').length, 2);

  const r = registerAlternatives([], S, { slot: 'top_camera_mount' });
  assert.equal(r.added, 0);
  assert.deepEqual(r.cleared, ['top_camera_mount']);
  assert.equal(options('top_camera_mount', S).filter((o) => o.group === 'agent').length, 0);

  /* a REPLACED alternative (same count, new content) lands too */
  registerAlternatives([alt('a')], S, { slot: 'top_camera_mount' });
  registerAlternatives([{ ...alt('a'), label: 'renamed', mtime: 2 }], S, { slot: 'top_camera_mount' });
  const now = options('top_camera_mount', S).filter((o) => o.group === 'agent');
  assert.equal(now.length, 1);
  assert.equal(now[0].label, 'renamed');
  assert.equal(now[0].mtime, 2);

  /* a whole-robot answer clears every slot it did not mention */
  registerAlternatives([], S, { replaceAll: true });
  for (const sid of S.order) assert.equal(options(sid, S).filter((o) => o.group === 'agent').length, 0);

  /* an unknown slot is a warning, not a throw */
  assert.match(registerAlternatives([], S, { slot: 'nope' }).warnings[0], /unknown slot "nope"/);
});

test('every slot can be emptied, and a deleted component stays deleted through a swap', async () => {
  const { slots: S } = await studio();

  /* 1. Remove needs somewhere to go: every slot carries an option that shows nothing. */
  const empties = {};
  for (const sid of S.order) {
    const empty = S.slots[sid].options.find((o) => o.kind === 'none')
      || S.slots[sid].options.find((o) => o.id === 'none')
      || S.slots[sid].options.find((o) => o.kind !== 'import' && !(o.shows || []).length);
    assert.ok(empty, `slot "${sid}" has no empty option — "Remove" would be dead`);
    empties[sid] = empty.id;
  }
  assert.equal(empties.fingertips, 'none', 'the fingertips slot gained its own empty option');

  /* 2. Removing a slot hides every component the option owned. */
  const base = applyDefaults(defaultDesign('lekiwi-pincopen'), {}, S);
  const wrist = S.slots.wrist_camera_mount.owns;
  assert.ok(wrist.includes('df200_arch_arch'));
  const emptied = applyOption(base, 'wrist_camera_mount', empties.wrist_camera_mount, {}, S).design;
  for (const id of wrist) assert.equal(emptied.components[id].visible, false, id + ' is gone');
  assert.equal(activeOption(emptied, 'wrist_camera_mount', S), empties.wrist_camera_mount);

  const deleted = { ...base, removed: { corner_mast_printed_head: true, 'Camera-Mount-v8': true } };
  const after = applyOption(deleted, 'top_camera_mount', 'corner_mast_printed', {}, S).design;
  assert.equal(after.components.corner_mast_printed_head.visible, false,
    'the option shows the head, but the user deleted it');
  assert.equal(after.components.corner_mast_printed_spar_lower.visible, true, 'its sibling is untouched');
  assert.deepEqual(after.removed, deleted.removed, 'applyOption never rewrites `removed`');

  /* 4. and Restore is exactly "drop the flag": the option derives the visibility again. */
  const restored = applyOption({ ...after, removed: {} }, 'top_camera_mount', 'corner_mast_printed', {}, S).design;
  assert.equal(restored.components.corner_mast_printed_head.visible, true);

});

test('reconcile(): a loaded design can never draw two mounts on one slot', async () => {
  const { slots: S } = await studio();
  const base = defaultDesign('lekiwi-pincopen');
  const stale = { ...base, slots: { wrist_camera_mount: 'normacam_22', top_camera_mount: 'mast_rev8_65' },
    components: { normacam_22: { visible: true }, mast_upper: { visible: true },
      tip_K_combined: { visible: true }, 'pincopen/camera_mobile_sup': { visible: true } } };
  const a = reconcile(stale, S);
  assert.equal(a.changed, true);
  assert.equal(activeOption(a.design, 'wrist_camera_mount', S), 'df200_arch',
    'a retired option falls back to the package default');
  assert.equal(activeOption(a.design, 'top_camera_mount', S), 'corner_mast_printed');
  for (const id of ['df200_arch_arch', 'df200_arch_head', 'df200_arch_retainer', 'df200_arch_df200'])
    assert.equal(a.design.components[id].visible, true, id + ' drawn: the slot fell back to the arch');
  /* the upstream PincOpen holder is one of the mounts on this seat, so the arch takes it off */
  for (const id of ['pincopen/camera_basement', 'pincopen/camera_mobile_sup'])
    assert.equal(a.design.components[id].visible, false, id + ' hidden: one mount per seat');
  /* and no ghost: a retired id is not a component, so it can never be drawn */
  for (const id of ['normacam_22', 'mast_upper', 'tip_K_combined'])
    assert.equal(S.slots.wrist_camera_mount.owns.includes(id)
      || S.slots.top_camera_mount.owns.includes(id)
      || S.slots.fingertips.owns.includes(id), false, id + ' is not a component any more');
  const eye = { ...base, slots: { wrist_camera_mount: 'df200_arch' },
    components: { normacam_22: { visible: true }, 'pincopen/camera_basement': { visible: true },
      'pincopen/camera_mobile_sup': { visible: true } } };
  const b = reconcile(eye, S);
  assert.equal(b.changed, true);
  assert.equal(b.design.components['pincopen/camera_basement'].visible, false,
    'the holder was the gripper\'s, so nothing here could turn it off');
  assert.equal(b.design.components['pincopen/camera_mobile_sup'].visible, false);
  assert.equal(b.design.components['pincopen/cam'].visible, true, 'the gripper cam disc stays on');
  assert.equal(b.design.components.df200_arch_arch.visible, true);
  /* (c) a slot naming an option the package does not have falls back to the default */
  const gone = { ...base, slots: { wrist_camera_mount: 'normacam_99' } };
  const c = reconcile(gone, S);
  assert.equal(c.design.slots.wrist_camera_mount, 'df200_arch');
  /* (d) the user's own hide of a FITTED part survives; a removed part stays removed */
  const hid = applyDefaults(base, {}, S);
  hid.components.df200_arch_head = { visible: false };
  hid.removed = { df200_arch_retainer: true };
  const d = reconcile(hid, S);
  assert.equal(d.design.components.df200_arch_head.visible, false, 'user hide kept');
  assert.equal(d.design.components.df200_arch_retainer.visible, false, 'removed stays gone');
  /* (e) idempotent on a clean default design */
  const e = reconcile(applyDefaults(base, {}, S), S);
  assert.equal(e.changed, false);
  const older = { ...base,
    slots: { wrist_camera_mount: 'normacam_22', top_camera_mount: 'mast_rev8_65',
      fingertips: 'tip_K_combined', wrist_cable: 'clip_F' },
    components: { normacam_22: { visible: true }, mast_upper: { visible: true },
      mast_lower: { visible: true }, cable_clip_F: { visible: true },
      tip_K_combined: { visible: true } } };
  const f = reconcile(older, S);
  assert.equal(activeOption(f.design, 'wrist_camera_mount', S), 'df200_arch');
  assert.equal(activeOption(f.design, 'top_camera_mount', S), 'corner_mast_printed');
  assert.equal(activeOption(f.design, 'fingertips', S), 'original');
  assert.equal(S.slots.wrist_cable, undefined, 'the wrist_cable slot is retired');
  for (const id of ['normacam_22', 'mast_upper', 'mast_lower', 'cable_clip_F', 'tip_K_combined']) {
    assert.equal(S.owner.get(id), undefined, id + ' belongs to no slot any more');
  }
  /* and the design that comes out draws the current default fit, whole */
  for (const id of ['df200_arch_arch', 'df200_arch_head', 'corner_mast_printed_spar_lower',
    'pincopen/tip_support']) {
    assert.equal(f.design.components[id].visible, true, id);
  }
});

/*
   THE SETTLE RULES (slot-consistency hunt classes B and C). Three holes let
   a design that does not name every slot mean three different things at once; these pin
   the one meaning: AN ABSENT SLOT ENTRY IS THE PACKAGE DEFAULT. */

test('an absent slot entry is the package DEFAULT, never "no option"', async () => {
  const { slots: S, model } = await studio();
  const base = defaultDesign(model.id);
  const blanked = { ...base, slots: {}, components: {}, params: {} };
  const r = applyOption(blanked, 'pi_case', 'none', {}, S);
  const vis = r.design.components;
  assert.equal(vis.pi_case_cradle.visible, false, 'the slot the user touched really is empty');
  assert.equal(vis.df200_arch_head.visible, true, 'the wrist arch is untouched by a Pi-case swap');
  assert.equal(vis.corner_mast_printed_head.visible, true, 'and so is the mast');
  assert.equal(vis['pincopen/top_plate'].visible, true, 'the gripper attachment is still on the robot');
  const holes = Object.keys(S.slots).filter((sid) => {
    const o = S.option(sid, r.design.slots[sid] || S.slots[sid].default);
    return !o || !(o.shows || []).length;
  });
  assert.deepEqual(holes.sort(), ['pi_case'], 'exactly one empty slot — the one just emptied');
});

test('activeOption infers from visibility ONLY for a design with no slots map', async () => {
  const { slots: S, model } = await studio();
  const base = defaultDesign(model.id);
  const stale = { ...base, slots: { wrist_camera_mount: 'df200_arch' },
                  components: { 'pincopen/camera_basement': { visible: true } } };
  assert.equal(activeOption(stale, 'wrist_camera_mount', S), 'df200_arch',
    'a stale true may not invent a fit');
  assert.equal(reconcile(stale, S).design.components['pincopen/camera_basement'].visible, false);
  /* the same flags on a design that carries NO slots map at all are the only answer there is */
  const preSlots = { ...base, slots: {},
    components: { 'pincopen/camera_basement': { visible: true },
      'pincopen/camera_mobile_sup': { visible: true },
      df200_arch_arch: { visible: false }, df200_arch_head: { visible: false },
      df200_arch_retainer: { visible: false }, df200_arch_df200: { visible: false } } };
  assert.equal(activeOption(preSlots, 'wrist_camera_mount', S), 'pincopen_holder',
    'a pre-slots design is inferred');
  /* and an entry naming an option the package dropped still falls back to the default */
  const gone = { ...base, slots: { wrist_camera_mount: 'normacam_22' } };
  assert.equal(activeOption(gone, 'wrist_camera_mount', S), 'df200_arch');
  assert.equal(activeOption({ ...base, slots: { top_camera_mount: 'mast_rev8_65' } },
    'top_camera_mount', S), 'corner_mast_printed');
  assert.equal(activeOption({ ...base, slots: { fingertips: 'tip_K_combined' } },
    'fingertips', S), 'original');
});

test('reconcile() settles slots, visibility AND parameters — the one settle', async () => {
  const { slots: S, model } = await studio();
  const base = defaultDesign(model.id);
  const viaDefaults = applyDefaults({ ...base, slots: {}, components: {}, params: {} }, {}, S);
  const viaReconcile = reconcile({ ...base, slots: {}, components: {}, params: {} }, S).design;
  assert.deepEqual(viaReconcile.slots, viaDefaults.slots, 'the same slot map');
  assert.deepEqual(viaReconcile.components, viaDefaults.components, 'the same visibility');
  assert.deepEqual(Object.keys(viaReconcile.params).sort(), Object.keys(viaDefaults.params).sort(),
    'and the same parametric components');
  for (const k of Object.keys(viaDefaults.params)) {
    assert.deepEqual(viaReconcile.params[k], viaDefaults.params[k], k);
  }
  /* C2: a design with NO slots map but the user's own hides keeps the user's answer */
  const hides = { ...base, slots: {},
    components: { 'pincopen/camera_basement': { visible: false }, cable_clip_F: { visible: false } } };
  const r = reconcile(hides, S);
  assert.equal(r.design.slots.wrist_camera_mount, 'df200_arch');
  assert.equal(r.design.components['pincopen/camera_basement'].visible, false);
  const rows = Object.entries(r.design.slots).map(([k, v]) => `${k}=${v}`);
});

test('reconcile() keeps an "alt:" choice the alternatives list has not registered yet', async () => {
  const { slots: S, model } = await studio();
  const base = defaultDesign(model.id);
  const SLOT = 'top_camera_mount';
  const ALT = 'alt:corner-mast-shorter';
  const fitted = { ...base, slots: { [SLOT]: ALT } };
  const a = reconcile(fitted, S);
  assert.equal(a.design.slots[SLOT], ALT, 'the alternative survives a reconcile that cannot see it');

  /* once the list arrives the option resolves, and the slot is unchanged again */
  registerAlternatives([{
    schema: ALTERNATIVE_SCHEMA, slot: SLOT, id: 'corner-mast-shorter', label: 'corner mast, 20 mm shorter',
    frame: 'robot', local: new THREE.Matrix4().toArray(), printable: true, files: ['part.stl'],
    path: 'alternatives/lekiwi-pincopen/top_camera_mount/corner-mast-shorter',
  }], S);
  const b = reconcile(a.design, S);
  assert.equal(b.design.slots[SLOT], ALT, 'and it is still the choice once the card is registered');
  assert.equal(b.design.components[ALT].visible, true, 'the alternative is now on the robot');
  S.clearAlternatives(SLOT);

  /* an id the package simply does not have is still a fallback — only "alt:" is deferred */
  const gone = { ...base, slots: { [SLOT]: 'mast_rev8_65' } };
  assert.equal(reconcile(gone, S).design.slots[SLOT], 'corner_mast_printed');
});
