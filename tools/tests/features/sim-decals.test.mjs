/* The lab decor has no depth fighting: two faces of different decor items and materials that
 * face the same way and overlap are either flush (0, a hidden contact) or at least 1 mm apart,
 * and every floor decal stands at least 1 mm proud of the floor.  World mm from decorPlan. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { studio } from './_harness.mjs';
import { buildMjcf } from '../../../src/features/sim-mjcf.js';
import { sceneDoc } from '../../../src/features/sim-scene.js';
import { decorPlan } from '../../../src/features/sim-scene-decor.js';
import { labSceneFiles } from '../../sim/lib.mjs';

const GAP = 1.0;
const s = await studio();
const files = labSceneFiles();
const lab = buildMjcf({ model: s.model, slots: s.slots, design: s.design, scene: await sceneDoc('lab'), labScene: files }).sidecar.lab;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const BOX = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];

/* every static box and mesh item as world triangles with unit normals */
function triangles() {
  const out = [];
  decorPlan(files.decor, lab).forEach((p, item) => {
    if (p.body || (p.kind !== 'box' && p.kind !== 'mesh')) return;
    let V = [], F = BOX;
    if (p.kind === 'box') {
      const [x, y, z] = p.size.map((v) => v / 2);
      V = [[-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z], [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]];
    } else {
      const g = files.meshes.get(p.mesh);
      for (let i = 0; i < g.position.length; i += 3) V.push([g.position[i], g.position[i + 1], g.position[i + 2]]);
      F = [];
      for (let i = 0; i < g.index.length; i += 3) F.push([g.index[i], g.index[i + 1], g.index[i + 2]]);
    }
    const a = (p.yaw || 0) * Math.PI / 180, c = Math.cos(a), si = Math.sin(a);
    const W = V.map(([x, y, z]) => [x * c - y * si + p.pos[0], x * si + y * c + p.pos[1], z + p.pos[2]]);
    for (const f of F) {
      const P = f.map((i) => W[i]), n = cross(sub(P[1], P[0]), sub(P[2], P[0])), L = Math.hypot(...n);
      if (L > 1e-6) out.push({ P, n: n.map((v) => v / L), item, mat: p.mat, what: p.mesh || p.name || `${p.kind} ${p.mat} @${p.at}` });
    }
  });
  return out;
}

/* do two triangles overlap, projected on the plane with normal n (separating axes, 0.05 slack) */
function overlap(n, A3, B3) {
  const e1 = cross(n, Math.abs(n[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0]), L = Math.hypot(...e1), u = e1.map((v) => v / L), w = cross(n, u);
  const A = A3.map((p) => [dot(p, u), dot(p, w)]), B = B3.map((p) => [dot(p, u), dot(p, w)]);
  for (const T of [A, B]) for (let i = 0; i < 3; i++) {
    const p = T[i], q = T[(i + 1) % 3], ax = [q[1] - p[1], p[0] - q[0]], k = 0.05 * Math.hypot(...ax);
    const ra = A.map((v) => v[0] * ax[0] + v[1] * ax[1]), rb = B.map((v) => v[0] * ax[0] + v[1] * ax[1]);
    if (Math.min(...ra) >= Math.max(...rb) - k || Math.min(...rb) >= Math.max(...ra) - k) return false;
  }
  return true;
}

test(`same-facing decor faces are flush or >= ${GAP} mm apart; floor decals >= ${GAP} mm proud`, () => {
  const T = triangles(), groups = new Map(), bad = [];
  for (const t of T) {
    t.d = dot(t.n, t.P[0]);
    const k = t.n.map((v) => Math.round(v * 50)).join();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
    if (t.n[2] > 0.99 && t.d > -1e-6 && t.d < GAP - 1e-6) bad.push(`${t.what}: an up face ${t.d.toFixed(2)} mm over the floor`);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => a.d - b.d);
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length && g[j].d - g[i].d < GAP + 0.1; j++) {
      const a = g[i], b = g[j];
      if (a.item === b.item || a.mat === b.mat) continue;
      const c = [0, 1, 2].map((k) => (b.P[0][k] + b.P[1][k] + b.P[2][k]) / 3), gap = Math.abs(dot(a.n, c) - a.d);
      if (gap > 1e-3 && gap < GAP - 1e-3 && overlap(a.n, a.P, b.P)) bad.push(`${a.what} / ${b.what}: ${gap.toFixed(3)} mm`);
    }
  }
  assert.deepEqual([...new Set(bad)], []);
});
