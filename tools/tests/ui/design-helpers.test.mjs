/* ui/design-helpers.js: export file names, and camClassOf (the ID-pass class comes from the
   component group and the slot that owns it, never from a component id). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pkg from '../../../src/core/package.js';
import { buildSlots } from '../../../src/features/slots.js';
import { slotOwnerOf } from '../../../src/features/slot-options.js';
import { camClassOf, letterbox, safeName, stlName, uniqueName } from '../../../src/ui/design-helpers.js';

test('export names: letters, digits, dot, underscore and hyphen; one separator; unique in a zip', () => {
  const cases = [
    ['Base plate, lower (layer 1)', 'Base_plate_lower_layer_1.stl'],
    ['Stock SO-101 fixed jaw (Wrist Roll 08c)', 'Stock_SO-101_fixed_jaw_Wrist_Roll_08c.stl'],
    ['Vertical Pi case - cradle', 'Vertical_Pi_case_cradle.stl'],
    ['corner_mast_printed_head_PRINT.stl', 'corner_mast_printed_head_PRINT.stl'],
    ['bracket.stl', 'bracket.stl'], ['..hidden', 'hidden.stl'], ['Café', 'Cafe.stl'], ['브래킷', 'part.stl'],
    ['a -- b__c', 'a_b_c.stl'],
  ];
  for (const [label, want] of cases) assert.equal(stlName(label), want, label);
  assert.ok(/^[A-Za-z0-9._-]{1,64}$/.test(safeName('x'.repeat(80) + ' (y)')));
  const used = new Map();
  assert.deepEqual(['Tip Support', 'tip_support', '브래킷', '부품'].map((l) => uniqueName(used, l)),
    ['Tip_Support', 'tip_support-2', 'part', 'part-2']);
});

test('camClassOf: arm and gripper by group, camera mounts by slot, the rest robot', async () => {
  const model = await pkg.loadEmbedded('lekiwi-pincopen');
  const S = buildSlots(model);
  const cls = (id) => camClassOf(model.component(id), S.slots[slotOwnerOf(model, S, id)]);
  const count = {};
  for (const c of model.components) {
    const k = cls(c.id);
    count[k] = (count[k] || 0) + 1;
  }
  for (const id of ['corner_mast_printed_head', 'corner_mast_printed_spar_lower', 'df200_arch_arch']) {
    assert.equal(cls(id), 'mast', id + ' sits in a camera-mount slot');
  }
  assert.equal(cls('pi_case_cradle'), 'robot', 'the Pi case slot provides no camera');
  assert.equal(cls('base_plate_layer1-v5'), 'robot');
  assert.ok(model.components.filter((c) => c.group === 'arm').every((c) => cls(c.id) === 'arm'));
  /* a gripper part the wrist-mount slot covers is still gripper: the group wins */
  assert.ok(model.components.filter((c) => ['finger', 'fingertip', 'linkage', 'body'].includes(c.group))
    .every((c) => cls(c.id) === 'gripper'));
  assert.equal(camClassOf({ id: 'mast_upper', group: 'upgrade' }), 'robot', 'no id is special');
  assert.ok(count.mast >= 9, JSON.stringify(count));
});

test('letterbox fits a camera frame inside a box without cropping it', () => {
  for (const [w, h, a] of [[400, 300, 4 / 3], [400, 200, 4 / 3], [200, 400, 4 / 3], [400, 300, 16 / 9]]) {
    const L = letterbox(w, h, a);
    assert.ok(L.w <= w + 1 && L.h <= h + 1, 'inside the box');
    assert.ok(Math.abs(L.w / L.h - a) < 0.02, `${w}×${h} keeps its aspect`);
    assert.ok(L.x >= 0 && L.y >= 0, 'centred');
  }
  assert.deepEqual(letterbox(400, 300, 4 / 3), { w: 400, h: 300, x: 0, y: 0 });
});
