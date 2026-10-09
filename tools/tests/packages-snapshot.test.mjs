/* The shipped packages as the studio resolves them, held to a committed snapshot: per slot
 * combination the visible components and the camera poses; per component its world matrix at
 * zero and at every preset, its print data and a hash of its decoded mesh.
 *
 *   node --test tools/tests/packages-snapshot.test.mjs
 *   node tools/tests/packages-snapshot.test.mjs --write      regenerate the snapshot */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './_root.mjs';
import * as pkg from '../../src/core/package.js';
import { buildSlots } from '../../src/features/slots.js';
import { visibilityFor } from '../../src/features/slot-options.js';
import { createCameras, adoptAllSlotOptions } from '../../src/features/cameras.js';
import { defaultDesign } from '../../src/core/store.js';

const SNAP = join(ROOT, 'tools', 'tests', 'fixtures', 'packages-snapshot.json');
/* the robots a user opens; the PincOpen attachment is held through lekiwi-pincopen */
const ROBOTS = ['lekiwi', 'lekiwi-pincopen'];
const TOL = 1e-6;
const MAX_PRODUCT = 400;           // above this, single-slot swaps from the default only
/* intentional renames: old id -> new id (none) */
const RENAME = {};

const r6 = (v) => Math.round(v * 1e7) / 1e7;
const mat = (m) => (m ? Array.from(m.elements, r6) : null);

function sha1Positions(g) {
  const a = g && g.attributes && g.attributes.position;
  if (!a) return { verts: 0, sha1: null };
  const f = a.array instanceof Float32Array ? a.array : Float32Array.from(a.array);
  return { verts: a.count, sha1: createHash('sha1').update(Buffer.from(f.buffer, f.byteOffset, f.byteLength)).digest('hex') };
}

function combos(S) {
  const lists = S.order.map((sid) => S.slots[sid].options.filter((o) => o.kind !== 'import').map((o) => o.id));
  const n = lists.reduce((a, l) => a * l.length, 1);
  if (n <= MAX_PRODUCT) {
    let out = [{}];
    S.order.forEach((sid, i) => { out = out.flatMap((c) => lists[i].map((o) => ({ ...c, [sid]: o }))); });
    return out;
  }
  const def = S.defaults();
  const out = [def];
  S.order.forEach((sid, i) => { for (const o of lists[i]) if (o !== def[sid]) out.push({ ...def, [sid]: o }); });
  return out;
}

async function capture(robotId) {
  const model = await pkg.loadEmbedded(robotId, { loadGeometry: true });
  const S = buildSlots(model);
  const base = S.applyDefaults(defaultDesign(robotId));
  const components = {};
  for (const c of model.components) {
    const g = await model.geometryFor(c.id);
    components[c.id] = {
      label: c.label, group: c.group, slot: c.slot || null, color: c.color, printable: c.printable,
      print_name: c.printName, print_transform: mat(c.printTransform), link: c.link,
      default_visible: c.defaultVisible, world: mat(model.worldMatrix(c.id)), ...sha1Positions(g),
    };
  }
  const presets = {};
  for (const p of model.manifest.presets || []) {
    model.setJoints(p.q);
    presets[p.id] = Object.fromEntries(model.components.map((c) => [c.id, mat(model.worldMatrix(c.id))]));
    model.setJoints(model.zeroPose());
  }
  const slots = Object.fromEntries(S.order.map((sid) => [sid, {
    default: S.slots[sid].default, owns: S.slots[sid].owns.slice(),
    options: S.slots[sid].options.map((o) => ({ id: o.id, kind: o.kind, label: o.label, shows: o.shows.slice().sort(), requires: o.requires })),
  }]));
  const sets = [];
  const setIdx = new Map();
  const poses = [];
  const poseIdx = new Map();
  const rows = [];
  const cams = createCameras(model);
  for (const want of combos(S)) {
    let d = base;
    for (const sid of S.order) d = S.applyOption(d, sid, want[sid], { cascade: false }).design;
    const vis = visibilityFor(model, S, d);
    const shown = [...vis].filter(([, v]) => v).map(([k]) => k).sort().join(',');
    if (!setIdx.has(shown)) { setIdx.set(shown, sets.length); sets.push(shown); }
    adoptAllSlotOptions(cams, S, d);
    const cam = {};
    for (const c of model.cameras) {
      const p = cams.getPose(c.id);
      const key = JSON.stringify(p && p.ok ? { m: mat(p.matrix), hfov: r6(p.hfov_deg) } : null);
      if (!poseIdx.has(key)) { poseIdx.set(key, poses.length); poses.push(JSON.parse(key)); }
      cam[c.id] = poseIdx.get(key);
    }
    let cascaded = null;
    const changed = S.order.filter((sid) => want[sid] !== S.slots[sid].default);
    if (changed.length === 1) cascaded = S.applyOption(base, changed[0], want[changed[0]]).design.slots;
    rows.push({ slots: want, visible: setIdx.get(shown), cameras: cam, cascaded });
  }
  cams.dispose();
  return { robot: robotId, n_components: model.components.length, components, presets, slots,
    visible_sets: sets.map((s) => (s ? s.split(',') : [])), camera_poses: poses, combos: rows };
}

function diff(a, b, path, out) {
  if (out.length > 40) return;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Math.abs(a - b) > TOL) out.push(`${path}: ${a} != ${b}`);
    return;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}: ${JSON.stringify(a)?.slice(0, 120)} != ${JSON.stringify(b)?.slice(0, 120)}`);
    return;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a)) out.push(`${path}.${k}: missing in snapshot`);
    else if (!(k in b)) out.push(`${path}.${k}: missing now`);
    else diff(a[k], b[k], `${path}.${k}`, out);
  }
}

function renamed(snap) {
  if (!Object.keys(RENAME).length) return snap;
  const s = JSON.stringify(snap);
  return JSON.parse(Object.entries(RENAME).reduce((t, [o, n]) => t.split(`"${o}"`).join(`"${n}"`), s));
}

if (process.argv.includes('--write')) {
  const out = {};
  for (const id of ROBOTS) out[id] = await capture(id);
  writeFileSync(SNAP, JSON.stringify(out) + '\n');
  console.log('wrote', SNAP, ROBOTS.map((id) => `${id}: ${out[id].combos.length} combos`).join(', '));
} else {
  const snap = JSON.parse(readFileSync(SNAP, 'utf8'));
  for (const id of ROBOTS) {
    test(`${id}: resolved package matches the snapshot`, async () => {
      const now = await capture(id);
      const out = [];
      diff(renamed(snap[id]), now, id, out);
      assert.deepEqual(out, []);
      console.log(`  ${id}: ${now.n_components} components, ${now.combos.length} slot combos, `
        + `${now.visible_sets.length} visible sets, ${now.camera_poses.length} camera poses`);
    });
  }
}
