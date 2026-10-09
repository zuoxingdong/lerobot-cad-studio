/* features/placement.js: the inspector's Placement section, as pure helpers. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { studio, round, near } from './_harness.mjs';
import * as P from '../../../src/features/placement.js';

const box = (w = 40, d = 30, h = 20) => { const g = new THREE.BoxGeometry(w, d, h); g.computeBoundingBox(); return g; };
const at = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);

test('parent-relative transforms round-trip through any parent', async () => {
  const { model } = await studio();
  const W = at(37, -70, 300).multiply(new THREE.Matrix4().makeRotationZ(0.6));
  for (const parent of ['world', 'Wrist_Roll_08c-v1', 'wrist_flange', 'deck_top_centre_rear', 'corner_mast_printed_head']) {
    const local = P.toLocal(model, parent, W);
    const back = P.toWorld(model, parent, local);
    const err = Math.max(...back.toArray().map((v, i) => Math.abs(v - W.toArray()[i])));
    assert.ok(err < 1e-9, `${parent}: ${err}`);
  }
  /* a wrist-parented part follows the arm */
  const wrist = P.toLocal(model, 'Wrist_Roll_08c-v1', W);
  const keep = model.getJoints();
  model.setJoints({ arm_shoulder_lift: -60 });
  const moved = P.toWorld(model, 'Wrist_Roll_08c-v1', wrist);
  model.setJoints(keep);
  assert.ok(moved.toArray().some((v, i) => Math.abs(v - W.toArray()[i]) > 10), 'it moved with the arm');
});

test('decompose / compose are the six mono fields', () => {
  const M = P.compose([10, 20, 30], [15, -30, 90]);
  const d = P.decompose(M);
  assert.deepEqual(d.position.map((v) => round(v, 6)), [10, 20, 30]);
  assert.deepEqual(d.rotation.map((v) => round(v, 4)), [15, -30, 90]);
  assert.deepEqual(d.scale.map((v) => round(v, 6)), [1, 1, 1]);
  assert.deepEqual(P.snap([3.4, -7.8, 22.1], 5), [5, -10, 20]);
  assert.deepEqual(P.snap([3.4, -7.8, 22.1], 0), [3.4, -7.8, 22.1], 'Shift = fine = no snap');
  assert.deepEqual(P.SNAP_MM, [1, 5, 20]);
  assert.deepEqual(P.SNAP_DEG, [5, 15, 90]);
});

test('drop to deck / ground, snap to grid, centre X', async () => {
  const { model } = await studio();
  const g = box();
  const start = at(37, -70, 300);

  const deck = P.dropToDeck(model, g, start);
  assert.ok(near(P.worldBox(g, deck.world).min.z, 57, 1e-9));

  const ground = P.dropToGround(model, g, start);
  assert.ok(near(P.worldBox(g, ground.world).min.z, -32.9, 1e-9));

  const grid = P.snapToGrid(model, g, start);
  assert.deepEqual(grid.hole, [40, -60], 'nearest 20 mm hole to (37, -70)');

  const far = P.snapToGrid(model, g, at(300, 0, 57));
  assert.ok(Math.hypot(...far.hole) <= 107);

  const cx = P.centreX(g, start);
  assert.ok(near(P.worldBox(g, cx.world).getCenter(new THREE.Vector3()).x, 0, 1e-9));

  /* a package with no deck grid says so rather than guessing */
  const bare = { frameData: () => null, groundZ: 0 };
  const none = P.snapToGrid(bare, g, start);
  assert.equal(none.ok, false);
  assert.match(none.why, /no deck grid/);
});

test('drop uses an injected support query', () => {
  const g = box();
  const r = P.dropTo({ geometry: g, world: at(0, 0, 500), supportAt: (x, y, z) => ({ z: 120, what: 'prop', id: 'crate' }) });
  assert.equal(r.support, 'prop:crate');
  assert.ok(near(P.worldBox(g, r.world).min.z, 120, 1e-9));
});

test('a loose mesh inside the robot lands beside it on the ground; one clear of it stays', async () => {
  const { model } = await studio();
  const body = P.bodyBox(model);
  const inside = box(60, 60, 45);
  const T = P.landing(model, [inside]);
  assert.ok(T, 'a box at the origin sits in the base');
  const b = P.worldBox(inside, T);
  console.log(`  body x ${round(body.min.x)}..${round(body.max.x)} · landed x ${round(b.min.x)}..${round(b.max.x)} z ${round(b.min.z, 2)}`);
  assert.ok(!b.intersectsBox(body), 'still inside');
  assert.ok(Math.abs(b.min.z - model.groundZ) < 1e-9, 'not on the ground');
  const away = box(60, 60, 45).translate(0, 400, 0);
  assert.equal(P.landing(model, [away]), null);
});
