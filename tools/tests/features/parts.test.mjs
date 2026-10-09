/* features/parts.js: the parametric part library.  The table below is the one in the
 * header of each module; the test fails if a default build ever drifts from the CadQuery
 * reference it was matched against. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { table, round, studio } from './_harness.mjs';
import {
  PARTS, parametricFor, buildParametric, modelContext, COMPONENT_PARAMETRICS,
} from '../../../src/features/parts.js';
import { defaultsOf } from '../../../src/features/geometry-kit.js';

const allDefaults = () => Object.fromEntries(Object.keys(PARTS).map((k) => [k, defaultsOf(PARTS[k])]));

/** the header tables: preview cm³ and bbox mm, matched against the real STLs */
const PARTS_TABLE = {
  'pi_case/pi_case_cradle': { vol: 40.71, bbox: [87.50, 40.30, 97.00], ref: 38.15 },
  'pi_case/pi_case_panel': { vol: 14.69, bbox: [69.00, 8.00, 97.00], ref: 14.26 },
};

function volumeOf(geo) {
  const p = geo.attributes.position.array;
  const idx = geo.index ? geo.index.array : null;
  const n = idx ? idx.length : p.length / 3;
  let v = 0;
  for (let i = 0; i + 2 < n; i += 3) {
    const a = (idx ? idx[i] : i) * 3, b = (idx ? idx[i + 1] : i + 1) * 3, c = (idx ? idx[i + 2] : i + 2) * 3;
    v += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
        - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
        + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return Math.abs(v) / 1000;
}
function sizeOf(geo) {
  geo.computeBoundingBox();
  const s = geo.boundingBox.getSize(new THREE.Vector3());
  return [s.x, s.y, s.z];
}

test('every default build reproduces the volume table in the module header', () => {
  const defs = allDefaults();
  const ctx = { params: defs };
  const rows = [];
  for (const id of Object.keys(PARTS)) {
    const t0 = Date.now();
    const r = PARTS[id].build(defs[id], ctx);
    const ms = Date.now() - t0;
    assert.ok(r.meshes.length, `${id} builds at least one mesh`);
    assert.ok(r.stats && Number.isFinite(r.stats.volume_cm3), `${id} reports stats`);
    for (const m of r.meshes) {
      const key = `${id}/${m.name}`;
      const vol = volumeOf(m.geometry);
      const size = sizeOf(m.geometry);
      const want = PARTS_TABLE[key];
      rows.push({
        part: id, mesh: m.name.slice(0, 24), 'cm³': round(vol), ref: want ? want.ref : '-',
        'Δ%': want ? round(100 * (vol - want.ref) / want.ref, 1) : '-',
        bbox: size.map((v) => round(v)).join(' × '), ms,
      });
      if (!want) continue;
      assert.ok(Math.abs(vol - want.vol) < 0.02, `${key} volume ${vol} vs ${want.vol}`);
      for (let i = 0; i < 3; i++) assert.ok(Math.abs(size[i] - want.bbox[i]) < 0.02, `${key} bbox[${i}] ${size[i]} vs ${want.bbox[i]}`);
      assert.ok(Math.abs(vol - want.ref) / want.ref <= 0.10, `${key} within ±10 % of the CadQuery STL`);
      assert.ok(ms < 400, `${key} builds in ${ms} ms (< 400 ms)`);
    }
  }
});

test('the build() API shape holds for every part', () => {
  for (const [id, def] of Object.entries(PARTS)) {
    assert.equal(def.id, id);
    assert.ok(def.title && def.summary && def.group, `${id} has title/summary/group`);
    assert.ok(Array.isArray(def.params), `${id}.params`);
    for (const p of def.params) {
      assert.ok(p.key && p.label !== undefined, `${id}.${p.key}`);
      assert.ok(Number.isFinite(p.default), `${id}.${p.key}.default`);
      assert.ok(p.min <= p.default && p.default <= p.max, `${id}.${p.key} default inside [min,max]`);
      if (p.handle) assert.ok(typeof p.handle.anchor === 'function' && Number.isFinite(p.handle.perMm), `${id}.${p.key}.handle`);
    }
    for (const v of def.variants || []) assert.ok(v.name && v.params, `${id} variant "${v.name}"`);
    assert.equal(typeof def.build, 'function');
  }
});

test('every curated variant builds', () => {
  const defs = allDefaults();
  const rows = [];
  for (const [id, def] of Object.entries(PARTS)) {
    for (const v of def.variants || []) {
      const p = Object.assign({}, defs[id], v.params);
      const r = def.build(p, { params: defs });
      assert.ok(r.meshes.length, `${id}/${v.name} builds`);
      const f = r.frames && (r.frames.cam_top || r.frames.cam_wrist);
      rows.push({ part: id, variant: v.name.slice(0, 28), 'cm³': r.stats.volume_cm3, camera: f ? `tilt ${round(f.tilt_deg, 1)}°` : '-' });
    }
  }
  assert.deepEqual(Object.keys(PARTS), ['pi_case'], 'the pi case is the one parametric part');
});

test('parametricFor() maps package components onto parts', async () => {
  const { model } = await studio();
  const rows = [];
  for (const id of Object.keys(COMPONENT_PARAMETRICS)) {
    const p = parametricFor(id);
    assert.ok(p, `${id} resolves`);
    assert.ok(model.component(id), `${id} is a real component of ${model.id}`);
    rows.push({ component: id, part: p.id, mesh: p.mesh || '-', variant: p.variant || '-', params: JSON.stringify(p.params) });
  }
  assert.equal(parametricFor('pi_case_cradle').id, 'pi_case');
  assert.equal(parametricFor('pi_case_cradle').mesh, 'pi_case_cradle');
  assert.equal(parametricFor('pi_case_panel').mesh, 'pi_case_panel');
  /* a bare PART id resolves too, with `source: 'part'` */
  assert.equal(parametricFor('pi_case').id, 'pi_case');
  assert.equal(parametricFor('pi_case').source, 'part');
  assert.equal(parametricFor('mast_upper'), null, 'the retired rev-8 mast is gone');
  assert.equal(COMPONENT_PARAMETRICS.normacam_22, undefined);
  assert.equal(COMPONENT_PARAMETRICS.cam_retainer, undefined);
  assert.equal(parametricFor('base_plate_layer1-v5'), null, 'a stock mesh has no parametric twin');
  assert.equal(parametricFor('fingertips'), null, 'a slot id is not a part');
  assert.equal(Object.keys(COMPONENT_PARAMETRICS).length, 2);
});

test('buildParametric() resolves variant + overrides, and reports errors as sentences', async () => {
  const { model, design } = await studio();
  const ctx = modelContext(model, design.params);
  const key = PARTS.pi_case.params[0].key;
  const lo = PARTS.pi_case.params[0].min, hi = PARTS.pi_case.params[0].max;
  const a = buildParametric('pi_case_cradle', { [key]: lo }, ctx);
  assert.ok(a.ok, a.error);
  assert.equal(a.id, 'pi_case');
  assert.equal(a.params[key], lo);
  const b = buildParametric('pi_case_cradle', { [key]: hi }, ctx);
  assert.equal(b.params[key], hi, 'the caller overrides the default');
  assert.notEqual(a.result.stats.volume_cm3, b.result.stats.volume_cm3, `${key} changes the solid`);
  const bad = buildParametric('nope', null, ctx);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /no parametric part for "nope"/);
});
