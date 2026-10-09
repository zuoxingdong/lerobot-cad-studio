/* node --test tools/tests/ui/robot-shade.test.mjs   (run from studio/)
   The robot's soft shading and cables on the pages: crease-angle normals (a cylinder's side smooth, its
   rim sharp), the ambient occlusion (a cavity darker than an open face, the floor counted), the cables'
   B-spline (ends on the end knots, a straight lead stays straight), a rigid ride carrying a lead, a camera's lead end split off,
   and a ribbon lead's wires. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { weld, voxelGrid, occlusion, cornersOf, shade } from '../../../src/ui/robot-shade.js';
import { bspline, createCables } from '../../../src/ui/robot-cables.js';
import { Looks } from '../../../src/ui/showcase-looks.js';

const I = new THREE.Matrix4();
const flat = (g) => (g.index ? g.toNonIndexed() : g);

test('crease normals: a cylinder side is smooth, its rim stays sharp', async () => {
  const g = flat(new THREE.CylinderGeometry(10, 10, 20, 24));
  const res = await shade([{ geometry: g, matrix: I }], {});
  const N = res.get(g).normal, P = g.attributes.position.array;
  let side = 0, capSharp = 0, capN = 0;
  for (let c = 0; c < P.length / 3; c++) {
    const nx = N[3 * c] / 127, ny = N[3 * c + 1] / 127, nz = N[3 * c + 2] / 127;
    const r = Math.hypot(P[3 * c], P[3 * c + 2]);
    if (Math.abs(ny) > 0.99) { capN++; if (Math.abs(ny) > 0.999) capSharp++; }
    else if (r > 9.9) side = Math.max(side, Math.abs(Math.hypot(nx, nz) * 10 - r) + Math.abs(ny));
  }
  assert.ok(side < 0.2, `side normals are not radial (${side.toFixed(3)})`);
  assert.ok(capN > 0 && capSharp === capN, 'a cap normal was bent over the rim');
});

test('occlusion: a cavity floor is darker than a free face, and the floor under a part counts', () => {
  const box = (w, h, d, x, y, z) => { const g = flat(new THREE.BoxGeometry(w, h, d)); g.translate(x, y, z); return g; };
  const cup = [box(40, 2, 40, 0, 0, 0), box(2, 30, 40, -20, 15, 0), box(2, 30, 40, 20, 15, 0), box(40, 30, 2, 0, 15, -20), box(40, 30, 2, 0, 15, 20)];
  const lone = box(40, 2, 40, 200, 0, 0);
  const sets = [...cup, lone].map((g) => cornersOf(g.rotateX(Math.PI / 2), I.elements));    // y up -> z up
  const G = voxelGrid(sets);
  const mean = (P, floor, up) => {                     // the mean AO of the faces facing up (or down)
    const wv = weld(P), fn = [];
    for (let o = 0; o < P.length; o += 9) {
      const e1 = new THREE.Vector3(P[o + 3] - P[o], P[o + 4] - P[o + 1], P[o + 5] - P[o + 2]);
      fn.push(...e1.cross(new THREE.Vector3(P[o + 6] - P[o], P[o + 7] - P[o + 1], P[o + 8] - P[o + 2])).toArray());
    }
    const ao = occlusion(P, Float32Array.from(fn), wv, G, floor);
    let s = 0, n = 0;
    for (let c = 0; c < P.length / 3; c++) {
      const z = fn[3 * ((c / 3) | 0) + 2];
      if (up ? z > 0 && P[3 * c + 2] > 0.5 : z < 0 && P[3 * c + 2] < -0.5) { s += ao[wv.vid[c]]; n++; }
    }
    return s / n;
  };
  const inCup = mean(sets[0], null, true), open = mean(sets[5], null, true);
  assert.ok(inCup < open - 0.15, `cup floor ${inCup.toFixed(2)} vs open ${open.toFixed(2)}`);
  assert.ok(open > 0.95, 'a free top face is occluded: ' + open.toFixed(2));
  assert.ok(mean(sets[5], -3, false) < mean(sets[5], null, false) - 0.1, 'the floor under a part does not count');
});

test('bspline: ends on the end knots, a straight lead stays straight', () => {
  const K = [[0, 0, 0], [1, 2, 0], [3, 2, 1], [4, 0, 1], [6, 1, 0]], out = new Float32Array(3 * 33);
  bspline(K, 33, out);
  assert.deepEqual([...out.slice(0, 3)], [0, 0, 0]);
  assert.deepEqual([...out.slice(96, 99)], [6, 1, 0]);
  const L = [[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]];
  bspline(L, 9, out);
  for (let s = 0; s < 9; s++) assert.ok(Math.abs(out[3 * s] - out[3 * s + 1]) < 1e-5 && Math.abs(out[3 * s] - out[3 * s + 2]) < 1e-5);
});

test('cables: a rigid ride carries the lead and its plugs', () => {
  const spec = [{ key: 'cable_jacket', plug: 'connector_k', d_mm: 2, knots: [[0, 0, 0], [0.1, 0, 0], [0.2, 0.05, 0], [0.3, 0, 0]],
    bodies: [['base', 'base'], ['base', 'base'], ['base', 'arm'], ['arm', 'arm']],
    plugs: [{ c: [0.005, 0, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], half: [0.005, 0.002, 0.001], body: 'base' }] }];
  const c = createCables(spec, new Looks({ cable_jacket: { base: [0.03, 0.03, 0.03] } }, {}), { scale: 1000 });
  const move = new THREE.Matrix4().makeTranslation(0.5, 0, 0);
  c.update((b, out) => { out.makeScale(1000, 1000, 1000).multiply(move); return true; });
  const P = c.mesh.geometry.attributes.position.array, lead = P.length - 24 * 3;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < lead; i += 3) { lo = Math.min(lo, P[i]); hi = Math.max(hi, P[i]); }
  assert.ok(Math.abs(lo - 500) < 1.5 && Math.abs(hi - 800) < 1.5, `lead x ${lo.toFixed(1)}..${hi.toFixed(1)} mm`);
  let px = 0;
  for (let i = lead; i < P.length; i += 3) px += P[i] / 24;
  assert.ok(Math.abs(px - 505) < 1e-3, 'the plug did not ride: ' + px);
  assert.equal(c.group.children.length, 1, 'one draw call');
  assert.ok(c.tris > 0 && c.tris < 1000);
  c.dispose();
});

test('cables: tail() moves a lead\'s end and its end plug to a mesh of their own, on the same attributes', () => {
  const box = (x) => ({ c: [x, 0, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], half: [0.005, 0.002, 0.001], body: 'base' });
  const spec = [{ key: 'cable_jacket', plug: 'connector_k', d_mm: 2, knots: [[0, 0, 0], [0.1, 0, 0], [0.2, 0, 0], [0.3, 0, 0]],
    bodies: [['base', 'base'], ['base', 'base'], ['base', 'base'], ['base', 'base']], plugs: [box(0.005), box(0.295)] }];
  const c = createCables(spec, new Looks({ cable_jacket: { base: [0.03, 0.03, 0.03] } }, {}), { scale: 1000 });
  c.update((b, out) => { out.makeScale(1000, 1000, 1000); return true; });
  const n0 = c.mesh.geometry.index.count;
  assert.equal(c.tail(new THREE.Vector3(0, 500, 0), 60), null, 'a tail far from every end');
  const t = c.tail(new THREE.Vector3(300, 0, 0), 60);
  assert.ok(t && t.geometry.attributes.position === c.mesh.geometry.attributes.position, 'the tail shares the positions');
  const I = t.geometry.index.array, P = t.geometry.attributes.position.array;
  assert.equal(I.length + c.mesh.geometry.index.count, n0, 'every triangle drawn once');
  let lo = Infinity;
  for (const i of I) lo = Math.min(lo, P[3 * i]);
  assert.ok(lo > 220 && lo < 245, `the tail starts at x ${lo.toFixed(1)} mm`);
  assert.equal(c.tail(new THREE.Vector3(300, 0, 0), 60), null, 'a lead gives one tail');
  assert.equal(c.group.children.length, 2);
  c.dispose();
});

test('cables: a ribbon lead lays its wires on the start plug\'s wide axis, square to the lead, one colour each', () => {
  const looks = new Looks({ cable_jacket: { base: [0.03, 0.03, 0.03] }, wire_black: { base: [0.03, 0.028, 0.03] },
    wire_red: { base: [0.6, 0.07, 0.08] }, wire_white: { base: [0.75, 0.74, 0.72] }, connector_k: { base: [0.03, 0.03, 0.03] } }, {});
  const spec = [{ key: 'cable_jacket', plug: 'connector_k', d_mm: 2.6, ribbon: { keys: ['wire_black', 'wire_red', 'wire_white'], d_mm: 1.1 },
    knots: [[0, 0, 0], [0.02, 0, 0], [0.06, 0.02, 0.01], [0.1, 0.02, 0.03], [0.12, 0.02, 0.05]],
    bodies: Array(5).fill(['base', 'base']),
    plugs: [{ c: [0.005, 0, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], half: [0.005, 0.002, 0.001], body: 'base' }] }];
  const c = createCables(spec, looks, { scale: 1000 });
  c.update((b, out) => { out.makeScale(1000, 1000, 1000); return true; });
  const W = c.wires(0), K = spec[0].knots.map((k) => k.map((v) => v * 1000));
  assert.equal(W.length, 3);
  for (let j = 0; j < K.length; j++) {
    const s = [0, 1, 2].map((i) => W[2][j][i] - W[0][j][i]), a = K[Math.max(j - 1, 0)], b = K[Math.min(j + 1, K.length - 1)];
    const t = [0, 1, 2].map((i) => b[i] - a[i]), tl = Math.hypot(...t);
    assert.ok(Math.abs(Math.hypot(...s) - 2.2) < 1e-4, 'pitch');
    assert.ok(Math.abs(s[0] * t[0] + s[1] * t[1] + s[2] * t[2]) / tl < 1e-4, 'square to the lead');
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(W[1][j][i] - K[j][i]) < 1e-6, 'the red wire on the knots');
  }
  assert.ok(W[2][0][1] - W[0][0][1] > 2.19, 'the first side is the plug\'s u');
  const col = c.mesh.geometry.attributes.color.array, seen = new Set();
  for (let v = 0; v < 16; v++) seen.add(col[3 * v].toFixed(2));
  assert.deepEqual([...seen].sort(), ['0.03', '0.60', '0.75']);
  const n0 = c.mesh.geometry.index.count;
  assert.ok(c.tail(new THREE.Vector3(120, 20, 50), 30));
  assert.ok(c.mesh.geometry.index.count < n0);
  c.dispose();
});
