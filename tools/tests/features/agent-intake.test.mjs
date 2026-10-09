/* features/agent-intake.js and agent-context.js decimatedStl: a folder becomes a card with a
   print verdict and an alternative record; an rps/alternative@1 meta.json is upgraded, any
   other meta.json is refused; a failing folder carries its first error. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { checkFolder, upgradeMeta, withPartJson, isPartFolder } from '../../../src/features/agent-intake.js';
import { decimatedStl } from '../../../src/features/agent-context.js';
import { boxStl } from '../fixtures/agent/fake-fs.mjs';

const ROBOT = {
  id: 'lekiwi-pincopen',
  slots: { top_camera_mount: { label: 'Overhead camera mount', anchor: [0, -36.5, 57], provides: ['cameras.top'] } },
  partIds: ['corner_mast_printed'],
};
const CAM = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -75, -18, 505, 1];
const BOX = boxStl([-100, -57, 60], [-50, 5, 120]);
const PLATE = boxStl([0, 0, 0], [50, 62, 60]);

function folder(files, id = 'short_mast') {
  return { id, files: new Map(Object.entries(files).map(([k, v]) => [k, new Blob([v])])) };
}
const PART = {
  schema: 'rps/part@1', id: 'short_mast', label: 'Short mast', robot: 'lekiwi-pincopen', slot: 'top_camera_mount',
  frame: 'robot', local: null, cameras: { top: { local: CAM, hfov_deg: 87.3 } },
  meshes: [{ id: 'spar', file: 'mesh/spar.stl', print: 'print/spar_PRINT.stl' }, { id: 'cam', file: 'mesh/cam.stl', hardware: true }],
};

test('a good folder: card, verdict from the plates, record with bytes named for the pairing', async () => {
  const f = folder({ 'part.json': JSON.stringify(PART), 'mesh/spar.stl': BOX, 'print/spar_PRINT.stl': PLATE, 'mesh/cam.stl': BOX });
  assert.ok(isPartFolder(f));
  const c = await checkFolder(f, ROBOT, { printer: 'bambu' });
  assert.equal(c.ok, true, c.errors.join('; '));
  assert.equal(c.slot, 'top_camera_mount');
  assert.equal(c.verdict, 'pass', c.reason);
  assert.deepEqual(c.record.files.map((x) => x.name), ['spar.stl', 'cam.stl']);
  assert.deepEqual(c.record.print_files.map((x) => x.name), ['print/spar_PRINT.stl']);
  assert.equal(c.record.files[0].bytes.length, BOX.length);
  assert.deepEqual(c.record.params, {});
  assert.equal(c.record.cameras.top.hfov_deg, 87.3);
});

test('a plate too tall for the bed fails the card, validation still passes', async () => {
  const tall = boxStl([0, 0, 0], [20, 20, 300]);
  const f = folder({ 'part.json': JSON.stringify(PART), 'mesh/spar.stl': BOX, 'print/spar_PRINT.stl': tall, 'mesh/cam.stl': BOX });
  const c = await checkFolder(f, ROBOT, { printer: 'bambu' });
  assert.equal(c.ok, true);
  assert.equal(c.verdict, 'fail');
  assert.match(c.reason, /^spar: /);
});

test('an rps/alternative@1 meta.json is read as part.json', async () => {
  const meta = { schema: 'rps/alternative@1', slot: 'top_camera_mount', label: 'Spar mast', frame: 'robot', local: null,
    cameras: { top: { local: CAM, hfov_deg: 87.3 } }, params: { tilt_deg: 45 } };
  const f = folder({ 'meta.json': JSON.stringify(meta), 'spar.stl': BOX, 'print/spar_PRINT.stl': PLATE, 'df200.stl': BOX }, 'corner_mast_meta');
  const doc = upgradeMeta(meta, f);
  assert.deepEqual(doc.meshes, [{ id: 'spar', file: 'spar.stl', print: 'print/spar_PRINT.stl' }, { id: 'df200', file: 'df200.stl', hardware: true }]);
  assert.equal((await withPartJson(f)).files.has('part.json'), true);
  const c = await checkFolder(f, ROBOT, {});
  assert.equal(c.ok, true, c.errors.join('; '));
  assert.equal(c.id, 'corner_mast_meta');
  assert.equal(c.fromMeta, true);
});

test('a meta.json that is not rps/alternative@1 is refused: rename it part.json', async () => {
  const f = folder({ 'meta.json': JSON.stringify(PART), 'mesh/spar.stl': BOX, 'print/spar_PRINT.stl': PLATE, 'mesh/cam.stl': BOX });
  assert.ok(isPartFolder(f));
  const c = await checkFolder(f, ROBOT, {});
  assert.equal(c.ok, false);
  assert.equal(c.reason, 'meta.json found: rename it part.json and use schema rps/part@1');
});

test('a broken part.json is a failed card with its error line', async () => {
  const c = await checkFolder(folder({ 'part.json': '{"schema": ' }), ROBOT, {});
  assert.equal(c.ok, false);
  assert.equal(c.verdict, 'fail');
  assert.match(c.reason, /^part\.json is not valid JSON/);
  assert.equal(c.record, null);
});

test('decimatedStl keeps every k-th triangle under the budget, transformed', () => {
  const g = new THREE.BoxGeometry(10, 10, 10, 10, 10, 10);
  const n = g.index.count / 3;
  const d = decimatedStl([{ geometry: g, matrix: new THREE.Matrix4().makeTranslation(100, 0, 0) }], 100);
  assert.equal(d.of, n);
  assert.ok(d.triangles <= 100 && d.triangles >= 90, String(d.triangles));
  const dv = new DataView(d.bytes.buffer, d.bytes.byteOffset, d.bytes.byteLength);
  assert.equal(dv.getUint32(80, true), d.triangles);
  assert.equal(d.bytes.length, 84 + d.triangles * 50);
  assert.ok(dv.getFloat32(84 + 12, true) >= 95, 'the matrix is applied');
});
