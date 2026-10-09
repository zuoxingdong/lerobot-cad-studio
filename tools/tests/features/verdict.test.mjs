/* features/verdict.js: four levels, unknown never escalates, and the untouched default robot
   rolls up to pass (not a wall of amber). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worstLevel, family, chipItem, partFamilies, rollUp, rowVerdict } from '../../../src/features/verdict.js';
import { createValidator } from '../../../src/features/validate.js';
import { withCollide, withCameras } from './_harness.mjs';

test('unknown never escalates; fail > warn > pass', () => {
  assert.equal(worstLevel(['pass', 'unknown']), 'pass');
  assert.equal(worstLevel(['unknown', 'unknown']), 'unknown');
  assert.equal(worstLevel([]), 'unknown');
  assert.equal(worstLevel(['pass', 'warn', 'unknown']), 'warn');
  assert.equal(worstLevel(['warn', 'fail']), 'fail');
});

test('a family reads one dot and the worst reason', () => {
  const f = family([{ key: 'a', level: 'pass', label: 'fits bed' }, { key: 'b', level: 'warn', label: 'overhang 26 %' },
    { key: 'c', level: 'unknown', label: 'print pose not set' }]);
  assert.equal(f.level, 'warn');
  assert.equal(f.reason, 'overhang 26 %');
  assert.equal(family([{ key: 'a', level: 'pass', label: 'x' }]).reason, 'ok');
  assert.equal(chipItem({ key: 'closed', level: 'pass', value: 0 }).label, 'closed', '"0 open edges" is a pass');
  assert.equal(chipItem({ key: 'orientation', level: 'unknown' }).fix, 'Lay flat');
});

test('rollUp: counts per level, the worst row names the reason', () => {
  const rows = [
    { id: 'a', label: 'A', print: { level: 'pass', reason: 'ok' } },
    { id: 'b', label: 'B', print: { level: 'unknown', reason: 'print pose not set' } },
    { id: 'c', label: 'C', fit: { level: 'warn', reason: 'hits deck' } },
  ];
  const r = rollUp(rows);
  assert.equal(r.level, 'warn');
  assert.deepEqual(r.counts, { pass: 1, warn: 1, fail: 0, unknown: 1 });
  assert.equal(r.reason, 'C: hits deck');
  assert.equal(rowVerdict(rows[1]).level, 'unknown');
  assert.equal(rollUp(rows.slice(0, 2)).level, 'pass', 'pass + unknown is pass');
});

test('the untouched default robot: every printed part is pass or unknown', async () => {
  const s = await withCollide();
  await withCameras();
  const V = createValidator({ model: s.model, slots: s.slots, cameras: s.cameras, collide: s.collide });
  const report = V.validateDesign(s.design);
  const rows = report.components.map((c) => ({ id: c.component, label: c.label, ...partFamilies(c) }));
  const bad = rows.map((r) => [r.id, rowVerdict(r)]).filter(([, v]) => v.level === 'warn' || v.level === 'fail');
  assert.deepEqual(bad, [], 'no warn or fail on the stock design');
  assert.equal(rollUp(rows).level, 'pass');
  assert.ok(rows.length >= 30, rows.length + ' printed parts');
});
