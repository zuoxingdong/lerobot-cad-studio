/* features/part-folder.js: one good folder, the table of bad ones (each with the line the
   card shows), the id-clash suffix and the swap-list entry. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePartFolder, toSwapOption, MAX_FACES } from '../../../src/features/part-folder.js';
import { boxStl } from '../fixtures/agent/fake-fs.mjs';

const ROBOT = {
  id: 'lekiwi-pincopen',
  slots: { top_camera_mount: { label: 'Overhead camera mount', anchor: [0, -36.5, 57], provides: ['cameras.top'] } },
  partIds: ['corner_mast_printed', 'cam_retainer'],
};
const CAM = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -75, -18, 505, 1];
const HEAD = boxStl([-100, -57, 475], [-50, 5, 532]);

function good(over = {}) {
  return {
    schema: 'rps/part@1', id: 'short_mast', label: 'Short mast', robot: 'lekiwi-pincopen',
    slot: 'top_camera_mount', frame: 'robot', local: null,
    meshes: [
      { id: 'head', file: 'mesh/head.stl', print: 'print/head_PRINT.stl' },
      { id: 'retainer', file: 'mesh/retainer.stl', print: 'part:cam_retainer' },
      { id: 'df200', file: 'mesh/df200.stl', hardware: true },
    ],
    cameras: { top: { local: CAM, hfov_deg: 87.3 } }, params: {}, source: 'agent 2026-09-24', notes: '',
    ...over,
  };
}
function folder(json, files = {}, id = 'short_mast') {
  const m = new Map();
  if (json !== undefined) m.set('part.json', new Blob([typeof json === 'string' ? json : JSON.stringify(json)]));
  const base = { 'mesh/head.stl': HEAD, 'print/head_PRINT.stl': HEAD, 'mesh/retainer.stl': HEAD, 'mesh/df200.stl': HEAD };
  for (const [k, v] of Object.entries({ ...base, ...files })) if (v != null) m.set(k, new Blob([v]));
  return { id, files: m };
}

test('a complete folder passes with no warnings', async () => {
  const r = await validatePartFolder(folder(good()), ROBOT);
  assert.deepEqual([r.ok, r.errors, r.warnings], [true, [], []]);
  assert.equal(r.part.id, 'short_mast');
  assert.equal(r.part.meshes.length, 3);
  assert.equal(r.part.faces, 36);
  assert.deepEqual(r.part.bbox.min.map(Math.round), [-100, -57, 475]);
  assert.ok(r.part.meshes[0].geometry && r.part.meshes[0].printGeometry, 'geometries ride along for the preview');
});

const empty84 = new Uint8Array(84);
const huge = (() => { const n = MAX_FACES + 1, u8 = new Uint8Array(84 + n * 50); new DataView(u8.buffer).setUint32(80, n, true); return u8; })();

const BAD = [
  ['no part.json', folder(undefined), 'part.json missing'],
  ['old meta.json', (() => { const f = folder(undefined); f.files.set('meta.json', new Blob(['{}'])); return f; })(),
    'meta.json found: rename it part.json and use schema rps/part@1'],
  ['broken JSON', folder('{"schema": '), /^part\.json is not valid JSON \(/],
  ['wrong schema', folder(good({ schema: 'rps/alternative@1' })), 'schema is "rps/alternative@1", expected "rps/part@1"'],
  ['no id', folder(good({ id: '' })), 'id missing'],
  ['bad id', folder(good({ id: 'my part!' })), 'id "my part!" must be letters, digits, - or _ (≤ 64)'],
  ['no slot', folder(good({ slot: undefined })), 'slot missing'],
  ['unknown slot', folder(good({ slot: 'wheel' })), 'slot "wheel" is not on lekiwi-pincopen (top_camera_mount)'],
  ['unknown frame', folder(good({ frame: 'world' })), 'frame "world" unknown (robot, slot_anchor, attachment)'],
  ['bad local', folder(good({ local: [1, 2, 3] })), 'local must be null or 16 numbers'],
  ['no meshes', folder(good({ meshes: [] })), 'meshes[] is empty'],
  ['mesh without file', folder(good({ meshes: [{ id: 'head' }] })), 'meshes[0] (head) has no file'],
  ['mesh missing', folder(good(), { 'mesh/head.stl': null }), 'mesh/head.stl missing'],
  ['case mismatch', folder(good(), { 'mesh/head.stl': null, 'mesh/Head.stl': HEAD }),
    'mesh/head.stl missing (found mesh/Head.stl; names are case-sensitive)'],
  ['plate missing', folder(good(), { 'print/head_PRINT.stl': null }), 'print/head_PRINT.stl missing'],
  ['not an stl', folder(good({ meshes: [{ id: 'head', file: 'mesh/head.obj', print: 'print/head_PRINT.stl' }] }), { 'mesh/head.obj': 'o x' }),
    'mesh/head.obj is not an .stl file'],
  ['garbage stl', folder(good(), { 'mesh/head.stl': 'hello' }), /^mesh\/head\.stl (is not a readable STL|has no triangles)/],
  ['empty stl', folder(good(), { 'mesh/head.stl': empty84 }), /^mesh\/head\.stl has no triangles/],
  ['too many faces', folder(good(), { 'mesh/head.stl': huge }), 'mesh/head.stl has 500,001 faces; the limit is 500,000'],
  ['too far', folder(good(), { 'mesh/head.stl': boxStl([2000, 0, 0], [2010, 10, 10]) }),
    'mesh/head.stl reaches 2.0 m from the slot anchor; the limit is 1.5 m'],
  ['no plates', folder(good({ meshes: [{ id: 'head', file: 'mesh/head.stl' }] })),
    'no print plates: add meshes[].print (print/<id>.stl) for the printed meshes'],
  ['duplicate mesh id', folder(good({ meshes: [{ id: 'head', file: 'mesh/head.stl', print: 'print/head_PRINT.stl' }, { id: 'head', file: 'mesh/df200.stl', hardware: true }] })),
    'meshes[1] id "head" is used twice'],
  ['bad camera', folder(good({ cameras: { top: { local: [1, 0], hfov_deg: 87.3 } } })), 'cameras.top.local must be 16 numbers'],
  ['bad hfov', folder(good({ cameras: { top: { local: CAM, hfov_deg: 200 } } })), 'cameras.top.hfov_deg must be a number in (0, 180)'],
];

test('the bad-folder table: each case fails with its one-line reason', async () => {
  const rows = [];
  for (const [name, f, want] of BAD) {
    const r = await validatePartFolder(f, ROBOT);
    const hit = r.errors.find((e) => (want instanceof RegExp ? want.test(e) : e === want));
    rows.push({ case: name, ok: r.ok, error: hit || r.errors.join(' | ') });
    assert.equal(r.ok, false, name);
    assert.ok(hit, `${name}: got ${JSON.stringify(r.errors)}`);
  }
  console.table(rows);
  assert.ok(BAD.length >= 10);
});

test('an id clash gets a -2 (then -3) suffix, as a warning', async () => {
  const r = await validatePartFolder(folder(good({ id: 'corner_mast_printed' })), ROBOT, { taken: ['corner_mast_printed-2'] });
  assert.equal(r.ok, true);
  assert.equal(r.part.id, 'corner_mast_printed-3');
  assert.deepEqual(r.warnings, ['id "corner_mast_printed" is taken; shown as "corner_mast_printed-3"']);
  const r2 = await validatePartFolder(folder(good({ id: 'short_mast' })), ROBOT, { taken: ['short_mast'] });
  assert.equal(r2.part.id, 'short_mast-2');
});

test('warnings: other robot, no camera pose, no label, metres, unknown shared plate, no plate on one mesh', async () => {
  const tiny = boxStl([0, 0, 0], [0.05, 0.05, 0.05]);
  const r = await validatePartFolder(folder(good({
    robot: 'so101', cameras: {}, label: '',
    meshes: [
      { id: 'head', file: 'mesh/head.stl', print: 'print/head_PRINT.stl' },
      { id: 'tiny', file: 'mesh/tiny.stl' },
      { id: 'retainer', file: 'mesh/retainer.stl', print: 'part:nope' },
    ],
  }), { 'mesh/tiny.stl': tiny }), ROBOT);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.warnings, [
    'made for so101; the open robot is lekiwi-pincopen',
    'label missing; the id is shown',
    'mesh/tiny.stl is 0.050 mm across: metres instead of millimetres?',
    'tiny has no print plate; it prints as modelled',
    'retainer: print plate part:nope is not a known part',
    'no pose for camera "top"; it is hidden with this part',
  ]);
});

test('slot_anchor frame measures reach from the anchor-local origin', async () => {
  const near = boxStl([0, 0, 0], [10, 10, 10]);
  const r = await validatePartFolder(folder(good({ frame: 'slot_anchor' }), { 'mesh/head.stl': near }), ROBOT);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const moved = await validatePartFolder(folder(good({ frame: 'slot_anchor', local: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1600, 0, 0, 1] }), { 'mesh/head.stl': near }), ROBOT);
  assert.ok(moved.errors.some((e) => /reaches 1\.6 m/.test(e)), JSON.stringify(moved.errors));
});

test('toSwapOption: the slotOptions() entry shape plus a verdict', async () => {
  const ok = toSwapOption(await validatePartFolder(folder(good()), ROBOT), { isNew: true, mtime: 5 });
  assert.deepEqual(
    { key: ok.key, kind: ok.kind, id: ok.id, label: ok.label, group: ok.group, active: ok.active, verdict: ok.verdict, isNew: ok.isNew, disabled: ok.disabled },
    { key: 'o:alt:short_mast', kind: 'alternative', id: 'alt:short_mast', label: 'Short mast', group: 'agent', active: false, verdict: 'pass', isNew: true, disabled: false });
  assert.equal(ok.summary, '3 meshes · 50 × 62 × 57 mm · 36 faces');
  assert.equal(ok.source, 'agent 2026-09-24 · linked folder');
  assert.deepEqual(ok.raw.files, ['mesh/head.stl', 'mesh/retainer.stl', 'mesh/df200.stl']);
  assert.deepEqual(ok.raw.print_files, ['print/head_PRINT.stl']);
  assert.deepEqual([ok.raw.slot, ok.raw.path, ok.raw.mtime, ok.raw.printable], ['top_camera_mount', 'short_mast', 5, true]);

  const bad = toSwapOption(await validatePartFolder(folder(good(), { 'mesh/head.stl': null }), ROBOT));
  assert.deepEqual([bad.verdict, bad.disabled, bad.summary], ['fail', true, 'mesh/head.stl missing']);
  const none = toSwapOption(await validatePartFolder(folder(undefined, {}, 'wip'), ROBOT), { id: 'wip' });
  assert.deepEqual([none.id, none.verdict, none.summary], ['alt:wip', 'fail', 'part.json missing']);
});
