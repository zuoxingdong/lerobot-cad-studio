/* features/ops.js — the generic tweak ops, measured on the shipped mounts (fixtures/ops/*.stl:
 * both corner-mast spars, the df200 arch plate, the Pi-case front panel) and on synthetic
 * box / holed box / cylinder / chamfer meshes.  Fixtures only: nothing under robots/ or assets/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { analyseGeometry } from '../../../src/features/printcheck.js';
import { signedVolume, boxG, polyG, tubeZ, circlePts } from '../../../src/features/geometry-kit.js';
import {
  applyOps, stretchGate, defaultAxis, suggestPlane, stretchAxes, opLabel, transformOps, transformMount, seedOf,
  mountFromFrame, mirroredPrintTransform, MOUNT_CLEAR_MM,
} from '../../../src/features/ops.js';

const round = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n;
function table(title, rows) {
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (cells) => '  ' + cells.map((v, i) => String(v ?? '').padEnd(w[i])).join('  ');
  console.log('\n  ' + title + '\n' + line(cols) + '\n  ' + w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(cols.map((c) => r[c])));
}

const FIX = new URL('../fixtures/ops/', import.meta.url);
const META = JSON.parse(fs.readFileSync(new URL('parts.json', FIX), 'utf8'));

function loadStl(name) {
  const b = fs.readFileSync(new URL(name, FIX));
  const n = b.readUInt32LE(80), p = new Float32Array(n * 9);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) p[t * 9 + k] = b.readFloatLE(84 + t * 50 + 12 + k * 4);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  return g;
}

/* independent measurements */

const Qw = 1e3;
/** closed / manifold / bodies (printcheck) plus Euler characteristic and same-direction edge pairs */
function topo(g) {
  const a = analyseGeometry(g);
  const pos = g.attributes.position, idx = g.index ? g.index.array : null;
  const key = new Map(), w = new Int32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const k = Math.round(pos.getX(i) * Qw) + ',' + Math.round(pos.getY(i) * Qw) + ',' + Math.round(pos.getZ(i) * Qw);
    if (!key.has(k)) key.set(k, key.size);
    w[i] = key.get(k);
  }
  const nt = (idx ? idx.length : pos.count) / 3, und = new Set(), dir = new Map();
  let zero = 0;
  for (let t = 0; t < nt; t++) {
    const v = [0, 1, 2].map((j) => w[idx ? idx[3 * t + j] : 3 * t + j]);
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) { zero++; continue; }
    for (let j = 0; j < 3; j++) {
      const u = v[j], x = v[(j + 1) % 3];
      und.add(u < x ? u + '_' + x : x + '_' + u);
      dir.set(u + '>' + x, (dir.get(u + '>' + x) || 0) + 1);
    }
  }
  let same = 0;
  for (const c of dir.values()) if (c > 1) same++;
  return { open: a.boundary, nm: a.nonManifold, bodies: a.bodies, chi: key.size - und.size + nt - zero, same, tris: nt };
}

const extent = (g, a) => {
  const p = g.attributes.position.array;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < p.length; i += 3) { const s = p[i] * a[0] + p[i + 1] * a[1] + p[i + 2] * a[2]; if (s < lo) lo = s; if (s > hi) hi = s; }
  return { lo, hi };
};

/** cross-section area at s = c, from the triangles that straddle it, oriented along a × n */
function sectionArea(g, a, c) {
  const p = g.attributes.position.array, V = (i) => new THREE.Vector3(p[3 * i], p[3 * i + 1], p[3 * i + 2]);
  const A = new THREE.Vector3(...a);
  let area = 0;
  for (let t = 0; t < p.length / 9; t++) {
    const v = [V(3 * t), V(3 * t + 1), V(3 * t + 2)], s = v.map((q) => q.dot(A) - c);
    const pts = [];
    for (let j = 0; j < 3; j++) {
      const k = (j + 1) % 3;
      if ((s[j] < 0) !== (s[k] < 0)) pts.push(v[j].clone().lerp(v[k], s[j] / (s[j] - s[k])));
    }
    if (pts.length !== 2) continue;
    const n = new THREE.Vector3().subVectors(v[1], v[0]).cross(new THREE.Vector3().subVectors(v[2], v[0]));
    let [P, R] = pts;
    if (new THREE.Vector3().subVectors(R, P).dot(new THREE.Vector3().crossVectors(A, n)) < 0) [P, R] = [R, P];
    area += new THREE.Vector3().crossVectors(P, R).dot(A) / 2;
  }
  return area;
}

/** every input vertex with s < lim appears bit-exact in the output */
function fixedKept(g0, g1, a, lim) {
  const set = new Set(), p1 = g1.attributes.position.array, p0 = g0.attributes.position.array;
  for (let i = 0; i < p1.length; i += 3) set.add(p1[i] + ',' + p1[i + 1] + ',' + p1[i + 2]);
  let n = 0, miss = 0;
  for (let i = 0; i < p0.length; i += 3) {
    if (p0[i] * a[0] + p0[i + 1] * a[1] + p0[i + 2] * a[2] >= lim) continue;
    n++; if (!set.has(p0[i] + ',' + p0[i + 1] + ',' + p0[i + 2])) miss++;
  }
  return { n, miss };
}

const hash = (g) => createHash('sha1').update(Buffer.from(g.attributes.position.array.buffer)).digest('hex').slice(0, 12);

/* the fixtures: shipped parts (mount = the min face along the stretch axis) and synthetic meshes */

/* the axis each shipped part is stretched along: the spars along their length from the deck /
   spigot face (the mount); the arch across its fork (Y is its only axis with clean planes); the
   Pi panel along Z from its bottom edge (ribs and vents leave no 10 mm prismatic slab there) */
const AXES = { spar_lower: [0, 0, 1], spar_upper: [0, 0, 1], arch: [0, 1, 0], pi_panel: [0, 0, 1] };

function shipped() {
  const out = [];
  for (const [id, file] of [['spar_lower', 'spar_lower.stl'], ['spar_upper', 'spar_upper.stl'], ['arch', 'arch.stl'], ['pi_panel', 'pi_panel.stl']]) {
    const g = loadStl(file), [lo, hi] = META[id].bounds, axis = AXES[id];
    const point = [0, 1, 2].map((k) => (axis[k] ? lo[k] : (lo[k] + hi[k]) / 2));
    const mount = id === 'arch' ? null : { point, normal: axis.slice() };
    out.push({ id, label: META[id].label, g, axis, mount, T: META[id].print_transform });
  }
  return out;
}

function synthetic() {
  const box = boxG(0, 40, 0, 20, 0, 10);
  const sq = [[-15, -15], [15, -15], [15, 15], [-15, 15]];
  const holed = polyG(sq, [circlePts(0, 0, 5, 24, false)], 0, 50);       // hole along Z
  const cyl = tubeZ(0, 0, 8, 0, 0, 60, 32);
  const plate = polyG([[-30, -10], [30, -10], [30, 10], [-30, 10]], [circlePts(0, 0, 4, 24, false)], 0, 8);   // hole across X
  const chamfer = polyG([[0, 0], [20, 0], [25, 5], [25, 15], [0, 15]], [], 0, 6);
  return { box, holed, cyl, plate, chamfer };
}

const PARTS = shipped();
const SYN = synthetic();
const rows = [];

/* 1. stretch ±10 / ±20 */

function stretchCase(name, g, mount, by, axis) {
  const a = axis || defaultAxis(g, mount);
  const at = suggestPlane(g, a, { mount, by });
  assert.ok(at !== null, `${name}: no clean plane for by=${by}`);
  const t0 = topo(g), e0 = extent(g, a);
  const r = applyOps(g, [{ op: 'stretch', axis: a, at, by }], { mount });
  assert.ok(!r.refused, `${name} by=${by}: refused ${JSON.stringify(r.refused)}`);
  assert.deepEqual(r.warnings.map((w) => w.code), [], `${name} by=${by}: warnings`);
  const t1 = topo(r.geometry), e1 = extent(r.geometry, a);
  assert.equal(t1.open, 0, `${name} by=${by}: open edges`);
  assert.equal(t1.nm, 0, `${name} by=${by}: non-manifold edges`);
  assert.equal(t1.bodies, 1, `${name} by=${by}: bodies`);
  assert.equal(t1.same, 0, `${name} by=${by}: inconsistent winding`);
  assert.equal(t1.chi, t0.chi, `${name} by=${by}: Euler characteristic`);
  assert.equal(e1.lo, e0.lo, `${name}: the fixed end moved`);
  assert.ok(Math.abs(e1.hi - Math.fround(e0.hi + by)) <= 1e-6, `${name} by=${by}: length ${e1.hi - e0.hi}`);
  const kept = fixedKept(g, r.geometry, a, at - 1e-3);
  assert.equal(kept.miss, 0, `${name}: ${kept.miss}/${kept.n} fixed-side vertices moved`);
  const face = fixedKept(g, r.geometry, a, e0.lo + 0.25);
  assert.ok(face.n > 0 && face.miss === 0, `${name}: mount face vertices moved`);
  const v0 = signedVolume(g), v1 = signedVolume(r.geometry);
  assert.ok(v0 > 0 && v1 > 0, `${name}: volume sign`);
  const A0 = sectionArea(g, a, at), A1 = sectionArea(g, a, at - Math.min(0, by));
  const pred = by > 0 ? by * A0 : by * (A0 + A1) / 2;
  const err = Math.abs(v1 - v0 - pred) / Math.abs(pred);
  assert.ok(err < 0.005, `${name} by=${by}: dV ${round(v1 - v0)} vs ${round(pred)} (${round(err * 100, 3)} %)`);
  rows.push({ part: name, by, at: round(at, 2), 'from mount': round(at - e0.lo, 2), tris: `${t0.tris}→${t1.tris}`, chi: t1.chi, 'dV err %': round(err * 100, 4), sha: hash(r.geometry) });
  return r;
}

test('stretch ±10 / ±20 keeps the part closed, single, holes and mount face intact', () => {
  /* the arch's pockets at Y ±4.5 / ±7 and the panel's vents leave no 10 mm prismatic slab:
     the gate says so (no nearest plane) and the longest slab they do have is used instead */
  const SHORT = { arch: [-5, -8], pi_panel: [] };
  for (const P of PARTS) {
    for (const by of [10, 20, -10, -20]) {
      if (by < 0 && SHORT[P.id]) {
        const e = extent(P.g, P.axis), g = stretchGate(P.g, P.axis, (e.lo + e.hi) / 2, { mount: P.mount, by });
        assert.ok(!g.ok && g.nearest === null, `${P.id} has no prismatic slab of ${-by} mm`);
        continue;
      }
      stretchCase(P.id, P.g, P.mount, by, P.axis);
    }
    for (const by of SHORT[P.id] || []) stretchCase(P.id, P.g, P.mount, by, P.axis);
  }
  const panel = PARTS[3];
  for (const by of [2, -2]) stretchCase('pi_panel Y', panel.g, null, by, [0, 1, 0]);
  for (const [id, g] of Object.entries({ box: SYN.box, holed: SYN.holed, cyl: SYN.cyl })) for (const by of [10, 20, -10, -20]) stretchCase(id, g, null, by);
  table('stretch at the gate-approved plane nearest the middle', rows);
  assert.equal(topo(SYN.holed).chi, 0, 'the holed box is genus 1');
  assert.equal(defaultAxis(PARTS[0].g, PARTS[0].mount)[2], 1, 'the mount normal is the default axis');
  const arch = stretchAxes(PARTS[2].g, { by: -5 });
  assert.deepEqual(arch.map((x) => x.axis), [[0, 1, 0]], 'the arch shortens across its fork only');
});

/* 2. the gate */

test('the gate refuses planes through a hole or a chamfer and offers one that works', () => {
  const cases = [
    { name: 'plate hole', g: SYN.plate, axis: [1, 0, 0], at: 1 },
    { name: 'chamfer', g: SYN.chamfer, axis: [1, 0, 0], at: 22 },
  ];
  /* on the shipped parts: the first plane in 2 mm steps the gate refuses */
  for (const P of PARTS) {
    const a = P.axis, e = extent(P.g, a);
    for (let at = e.lo + MOUNT_CLEAR_MM + 1; at < e.hi - 1; at += 2) {
      const g = stretchGate(P.g, a, at, { mount: P.mount });
      if (!g.ok && g.reason === 'crosses') { cases.push({ name: P.id, g: P.g, axis: a, at, mount: P.mount }); break; }
    }
  }
  assert.ok(cases.length >= 5, 'every shipped part has a refused plane');
  const out = [];
  for (const c of cases) {
    const g = stretchGate(c.g, c.axis, c.at, { mount: c.mount });
    assert.equal(g.ok, false, `${c.name}: gate passed a bad plane`);
    assert.equal(g.reason, 'crosses');
    assert.ok(g.crossing.length > 0 && g.nearest, `${c.name}: no crossing list / nearest`);
    const r0 = applyOps(c.g, [{ op: 'stretch', axis: c.axis, at: c.at, by: 10 }], { mount: c.mount });
    assert.equal(r0.refused && r0.refused.reason, 'crosses', `${c.name}: applyOps did not refuse`);
    assert.equal(r0.geometry, c.g, 'a refused first op returns the input');
    const g2 = stretchGate(c.g, c.axis, g.nearest.at, { mount: c.mount });
    assert.ok(g2.ok, `${c.name}: nearest plane is not clean`);
    for (const by of [10, -10]) {
      const gg = stretchGate(c.g, c.axis, g.nearest.at, { mount: c.mount, by });
      if (!gg.ok && !gg.nearest) continue;
      const at = gg.ok ? g.nearest.at : gg.nearest.at;
      const r = applyOps(c.g, [{ op: 'stretch', axis: c.axis, at, by }], { mount: c.mount });
      assert.ok(!r.refused, `${c.name} by=${by}: nearest refused`);
      const t = topo(r.geometry);
      assert.ok(t.open === 0 && t.bodies === 1 && t.chi === topo(c.g).chi, `${c.name} by=${by}: ${JSON.stringify(t)}`);
    }
    out.push({ case: c.name, at: round(c.at, 2), crossing: g.crossing.length, nearest: round(g.nearest.at, 2) });
  }
  const box = stretchGate(SYN.box, [1, 0, 0], 1, { mount: { point: [0, 10, 5], normal: [1, 0, 0] } });
  assert.equal(box.reason, 'mount', 'a plane inside the mount clearance');
  assert.ok(box.nearest.at >= MOUNT_CLEAR_MM);
  assert.equal(stretchGate(SYN.box, [1, 0, 0], 50).reason, 'outside');
  const flip = stretchGate(SYN.box, [-1, 0, 0], -20, { mount: { point: [0, 10, 5], normal: [1, 0, 0] } });
  assert.ok(flip.ok, 'an axis pointing at the mount is flipped, not refused');
  table('gate refusals and the nearest clean plane', out);
});

/* 3. shorten never folds */

test('shorten keeps the volume sign and removes exactly the prismatic slab', () => {
  const out = [];
  const list = [PARTS[0], PARTS[1], { ...PARTS[2], bys: [-5, -8] }, { id: 'pi_panel Y', g: PARTS[3].g, axis: [0, 1, 0], mount: null, bys: [-1, -2] },
    { id: 'holed', g: SYN.holed, mount: null }, { id: 'cyl', g: SYN.cyl, mount: null }];
  for (const P of list) {
    for (const by of P.bys || [-5, -20]) {
      const a = P.axis || defaultAxis(P.g, P.mount), at = suggestPlane(P.g, a, { mount: P.mount, by });
      const r = applyOps(P.g, [{ op: 'stretch', axis: a, at, by }], { mount: P.mount });
      assert.ok(!r.refused, `${P.id} by=${by}: ${JSON.stringify(r.refused)}`);
      const t = topo(r.geometry);
      assert.equal(t.same, 0, `${P.id}: a folded triangle`);
      assert.equal(t.open, 0);
      const v0 = signedVolume(P.g), v1 = signedVolume(r.geometry);
      assert.ok(v1 > 0 && v1 < v0, `${P.id}: volume ${v0} → ${v1}`);
      const A = (sectionArea(P.g, a, at) + sectionArea(P.g, a, at - by)) / 2;
      const err = Math.abs((v0 - v1) - (-by) * A) / ((-by) * A);
      assert.ok(err < 0.005, `${P.id}: ${round(err * 100, 3)} %`);
      out.push({ part: P.id, by, 'V0 cm3': round(v0 / 1000, 3), 'V1 cm3': round(v1 / 1000, 3), 'pred cm3': round((v0 + by * A) / 1000, 3), 'err %': round(err * 100, 4) });
    }
  }
  table('shorten: volume against the prismatic prediction', out);
});

/* 4. mirror */

test('mirror stays closed and outward; mirror∘mirror is the identity', () => {
  for (const P of [...PARTS, { id: 'holed', g: SYN.holed }]) {
    for (const plane of [{ point: [0, 0, 0], normal: [1, 0, 0] }, { point: [3, -2, 7], normal: [1, 2, 0.5] }]) {
      const m1 = applyOps(P.g, [{ op: 'mirror', plane }]);
      const t = topo(m1.geometry);
      assert.ok(t.open === 0 && t.bodies === 1 && t.same === 0, `${P.id}: ${JSON.stringify(t)}`);
      assert.ok(signedVolume(m1.geometry) > 0, `${P.id}: inside out`);
      assert.ok(Math.abs(signedVolume(m1.geometry) - signedVolume(P.g)) < 1e-6 * signedVolume(P.g));
      const m2 = applyOps(P.g, [{ op: 'mirror', plane }, { op: 'mirror', plane }]);
      const a = P.g.attributes.position.array, b = m2.geometry.attributes.position.array;
      assert.equal(a.length, b.length);
      let worst = 0;
      for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
      if (plane.normal[1] === 0) assert.equal(worst, 0, `${P.id}: x-mirror twice is not exact`);
      else assert.ok(worst < 1e-4, `${P.id}: mirror∘mirror off by ${worst}`);
    }
  }
});

/* 5. scale about the mount */

test('scale about the mount keeps the face planar and in place; in-plane scale warns', () => {
  const P = PARTS[0], g = P.g, z0 = P.mount.point[2];
  const faceVerts = (geo) => {
    const p = geo.attributes.position.array, out = [];
    for (let i = 0; i < p.length; i += 3) if (Math.abs(p[i + 2] - z0) < 0.25) out.push(p[i], p[i + 1], p[i + 2]);
    return out;
  };
  const f0 = faceVerts(g);
  const along = applyOps(g, [{ op: 'scale', factors: [1, 1, 1.2], about: 'mount' }], { mount: P.mount });
  assert.deepEqual(along.warnings.map((w) => w.code), []);
  const f1 = faceVerts(along.geometry);
  assert.equal(f1.length, f0.length);
  for (let i = 0; i < f0.length; i++) assert.ok(Math.abs(f0[i] - f1[i]) < 1e-4, 'the mount face moved');
  const e = extent(along.geometry, [0, 0, 1]), e0 = extent(g, [0, 0, 1]);
  assert.ok(Math.abs((e.hi - e.lo) - 1.2 * (e0.hi - e0.lo)) < 1e-3);
  for (const op of [{ op: 'scale', factors: [1.1, 1, 1], about: 'mount' }, { op: 'scale', s: 1.1 }]) {
    const r = applyOps(g, [op], { mount: P.mount });
    assert.ok(r.warnings.some((w) => w.code === 'bolt_pattern'), 'no bolt-pattern warning');
    for (const z of faceVerts(r.geometry).filter((_, i) => i % 3 === 2)) assert.ok(Math.abs(z - z0) < 1e-4, 'the mount face left its plane');
  }
  const c = applyOps(g, [{ op: 'scale', factors: [1, 1, 1.2], about: 'center' }], { mount: P.mount });
  assert.ok(c.warnings.some((w) => w.code === 'mount_moves'));
  assert.ok(topo(along.geometry).open === 0);
});

/* 6. offset_face */

test('offset_face thickens a box by exactly 2 mm and keeps a spar closed', () => {
  const g = SYN.box, seed = { point: [20, 10, 10], normal: [0, 0, 1] };
  const r = applyOps(g, [{ op: 'offset_face', seed, by: 2 }]);
  assert.ok(!r.refused);
  const e = extent(r.geometry, [0, 0, 1]);
  assert.equal(e.hi - e.lo, 12);
  assert.ok(Math.abs(signedVolume(r.geometry) - 40 * 20 * 12) < 1e-6);
  const thin = applyOps(g, [{ op: 'offset_face', seed, by: -2 }]);
  assert.ok(Math.abs(signedVolume(thin.geometry) - 40 * 20 * 8) < 1e-6);
  assert.equal(topo(thin.geometry).open, 0);
  const tri = applyOps(g, [{ op: 'offset_face', seed: 0, by: 2 }]);
  assert.ok(!tri.refused && topo(tri.geometry).open === 0, 'a triangle-index seed works too');

  const out = [];
  for (const P of PARTS.slice(0, 2)) {
    const pos = P.g.attributes.position.array, cand = [];
    for (let t = 0; t < pos.length / 9; t++) {
      const v = [0, 1, 2].map((j) => new THREE.Vector3(pos[9 * t + 3 * j], pos[9 * t + 3 * j + 1], pos[9 * t + 3 * j + 2]));
      const n = new THREE.Vector3().subVectors(v[1], v[0]).cross(new THREE.Vector3().subVectors(v[2], v[0]));
      cand.push([n.length() / 2 + (Math.abs(n.z) > 0.999 * n.length() ? 1e6 : 0), t]);
    }
    cand.sort((x, y) => y[0] - x[0] || x[1] - y[1]);
    let done = null;
    for (const [, t] of cand.slice(0, 300)) {
      const s = seedOf(P.g, t);
      const r2 = applyOps(P.g, [{ op: 'offset_face', seed: s, by: 2 }], { mount: P.mount });
      if (r2.refused) continue;
      const tp = topo(r2.geometry);
      assert.ok(tp.open === 0 && tp.bodies === 1 && tp.chi === topo(P.g).chi && tp.same === 0, `${P.id} tri ${t}: ${JSON.stringify(tp)}`);
      done = { part: P.id, tri: t, normal: s.normal.map((x) => round(x, 3)).join(','), dV: round(signedVolume(r2.geometry) - signedVolume(P.g), 1), warn: r2.warnings.map((w) => w.code).join(' ') };
      break;
    }
    assert.ok(done, `${P.id}: no face among the 300 tried could be offset`);
    out.push(done);
  }
  table('offset_face +2 mm on a spar face', out);
});

/* 7. determinism, runtime, print frame, labels */

/* 24 000 triangles, every wall crossing every plane: the worst case for the split */
function bigTube() { return tubeZ(0, 0, 30, 26, 0, 120, 3000); }

test('deterministic bytes, runtime, the print frame and labels', () => {
  const P = PARTS[0], a = P.axis, at = suggestPlane(P.g, a, { mount: P.mount, by: -20 });
  const ops = [{ op: 'stretch', axis: a, at, by: -20 }, { op: 'scale', factors: [1, 1, 1.05] }, { op: 'mirror', plane: { point: [0, 0, 0], normal: [1, 0, 0] } }];
  const x = applyOps(loadStl('spar_lower.stl'), ops, { mount: P.mount }).geometry.attributes.position.array;
  const y = applyOps(loadStl('spar_lower.stl'), ops, { mount: P.mount }).geometry.attributes.position.array;
  assert.equal(Buffer.compare(Buffer.from(x.buffer), Buffer.from(y.buffer)), 0, 'two runs differ');

  const timing = [];
  for (const [name, make, ax] of [['pi_panel', () => loadStl('pi_panel.stl'), [0, 0, 1]], ['spar_lower', () => loadStl('spar_lower.stl'), [0, 0, 1]], ['tube', bigTube, [0, 0, 1]]]) {
    const g = make(), e = extent(g, ax), mid = (e.lo + e.hi) / 2;
    const clean = suggestPlane(g, ax, { by: 10 });
    let t0 = performance.now();
    const r = applyOps(g, [{ op: 'stretch', axis: ax, at: clean, by: 10 }]);
    const cold = performance.now() - t0;
    t0 = performance.now();
    const r2 = applyOps(g, [{ op: 'stretch', axis: ax, at: suggestPlane(g, ax, { by: -2 }), by: -2 }]);
    const warm = performance.now() - t0;
    t0 = performance.now();
    const gs = stretchGate(g, ax, name === 'tube' ? e.hi + 5 : name === 'spar_lower' ? e.lo + 10 : mid + 0.25, { by: -10 });
    const gate = performance.now() - t0;
    assert.ok(!r.refused && !r2.refused && !gs.ok, `${name}: timing setup`);
    timing.push({ mesh: name, tris: g.attributes.position.count / 3, 'stretch cold ms': round(cold, 1), 'shorten warm ms': round(warm, 1), 'gate + scan ms': round(gate, 1) });
    /* the shipped parts are the gate; the 24k-triangle tube is the headroom check */
    const cap = name === 'tube' ? 3 : 1;
    assert.ok(cold < 50 * cap && warm < 50 * cap, `${name}: stretch ${cold} ms, shorten ${warm} ms`);
    assert.ok(gate < 100, `${name}: gate ${gate} ms`);
  }
  table('runtime (node, one core)', timing);

  /* the same stack on the print plate: transformOps + transformMount through print_transform */
  for (const Q of [PARTS[1], PARTS[3]]) {
    const T = new THREE.Matrix4().fromArray(Q.T), ax = Q.axis;
    const st = [{ op: 'stretch', axis: ax, at: suggestPlane(Q.g, ax, { mount: Q.mount, by: 15 }), by: 15 }];
    const part = applyOps(Q.g, st, { mount: Q.mount }).geometry.clone().applyMatrix4(T);
    const plate = Q.g.clone().applyMatrix4(T);
    const onPlate = applyOps(plate, transformOps(st, T), { mount: transformMount(Q.mount, T) });
    assert.ok(!onPlate.refused, `${Q.id}: refused on the plate`);
    part.computeBoundingBox();
    const b1 = part.boundingBox, b2 = onPlate.geometry.boundingBox;
    assert.ok(b1.min.distanceTo(b2.min) < 1e-3 && b1.max.distanceTo(b2.max) < 1e-3, `${Q.id}: plate bbox differs`);
    assert.ok(Math.abs(signedVolume(part) - signedVolume(onPlate.geometry)) < 1e-3 * signedVolume(part));
  }
  /* a mirrored copy keeps its plate on the bed, in the same footprint */
  for (const Q of [PARTS[0], PARTS[3]]) {
    const T = new THREE.Matrix4().fromArray(Q.T), plane = { point: [0, 0, 0], normal: [1, 0, 0] };
    const plate = Q.g.clone().applyMatrix4(T);
    plate.computeBoundingBox();
    const cx = (plate.boundingBox.min.x + plate.boundingBox.max.x) / 2;
    const Pm = mirroredPrintTransform(T, plane, cx);
    assert.ok(Math.abs(Pm.determinant() - 1) < 1e-6, 'the mirrored print transform is rigid');
    const mp = applyOps(Q.g, [{ op: 'mirror', plane }]).geometry.clone().applyMatrix4(Pm);
    mp.computeBoundingBox();
    assert.ok(mp.boundingBox.min.distanceTo(plate.boundingBox.min) < 1e-3 && mp.boundingBox.max.distanceTo(plate.boundingBox.max) < 1e-3, `${Q.id}: mirrored plate footprint`);
    assert.ok(signedVolume(mp) > 0);
  }
  const fr = mountFromFrame({ origin: [1, 2, 3], ai: 0, as: 1, ci: 1, cs: -1 });
  assert.deepEqual(fr, { point: [1, 2, 3], normal: [0, -1, 0], axis: [1, 0, 0] });

  assert.equal(opLabel({ op: 'stretch', by: -20 }, 'Corner mast'), 'Shorten · Corner mast · −20 mm');
  assert.equal(opLabel({ op: 'stretch', by: 12.5 }, 'Corner mast'), 'Stretch · Corner mast · +12.5 mm');
  assert.equal(opLabel({ op: 'scale', s: 1.1 }, 'Arch'), 'Scale · Arch · 110 %');
  assert.equal(opLabel({ op: 'offset_face', by: 2 }, 'Arch'), 'Thicken · Arch · +2 mm');
  assert.equal(opLabel({ op: 'mirror' }, 'Arch'), 'Mirror · Arch');
  assert.equal(opLabel({ op: 'scale', factors: [1, 1, 1.2] }, 'Arch'), 'Scale · Arch · 100/100/120 %');
  assert.equal(opLabel({ op: 'offset_face', by: -1.5 }, 'Arch'), 'Thin · Arch · −1.5 mm');
  const pass = applyOps(P.g, [{ op: 'move', matrix: new THREE.Matrix4().toArray() }]);
  assert.equal(pass.geometry, P.g, 'move is recorded, not applied');
  const bad = applyOps(P.g, [{ op: 'stretch', axis: [0, 0, 0], at: 1, by: 1 }]);
  assert.equal(bad.refused.reason, 'invalid');
});
