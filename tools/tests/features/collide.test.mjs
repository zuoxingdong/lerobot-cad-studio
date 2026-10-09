/* `features/collide.js` against the reference pair counts, which were cross-checked
 * pair-for-pair against python-fcl through trimesh.  The stock arm reproduces that table;
 * where the composed package's ACTIVE SET differs (PincOpen instead of the stock jaw) the
 * test says so and measures both. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { withCollide, studio, table, round, near } from './_harness.mjs';
import { createCollisionWorld } from '../../../src/features/collide.js';

/* the four presets shipped in v3, plus the two extra poses */
const V3_POSES = {
  'zero (parked CAD)': [{}, 0],
  'stowed (v3)': [{ arm_shoulder_pan: 0, arm_shoulder_lift: 40, arm_elbow_flex: 77, arm_wrist_flex: -54, arm_wrist_roll: 0, arm_gripper: 0 }, 6],
  'reach floor (v3)': [{ arm_shoulder_pan: 0, arm_shoulder_lift: 20, arm_elbow_flex: -76, arm_wrist_flex: 99, arm_wrist_roll: 0, arm_gripper: -30 }, 20],
  'reach table (v3)': [{ arm_shoulder_pan: 0, arm_shoulder_lift: 9, arm_elbow_flex: 35, arm_wrist_flex: 8, arm_wrist_roll: 0, arm_gripper: -30 }, 1],
  'raised max (v3)': [{ arm_shoulder_pan: 0, arm_shoulder_lift: -49, arm_elbow_flex: 100, arm_wrist_flex: 86, arm_wrist_roll: 0, arm_gripper: 0 }, 0],
};

test('the world builds off the RobotModel, with bodies from the arm chain', async () => {
  const { collide: W, model } = await withCollide();
  assert.deepEqual(W.armJoints, ['arm_shoulder_pan', 'arm_shoulder_lift', 'arm_elbow_flex', 'arm_wrist_flex', 'arm_wrist_roll', 'arm_gripper']);
  assert.equal(W.bodyOf[model.rootLink], 0);
  assert.equal(W.bodyOf['Rotation_Pitch_08i-v1'], 1, 'the first arm joint starts body 1');
  assert.equal(W.bodyOf['Wrist_Roll_08c-v1'], 5);
  assert.equal(W.bodyOf['Moving_Jaw_08d-v1'], 6);
  const s = W.stats();
  assert.ok(s.arm >= 10 && s.static >= 30);
  assert.ok(s.pairs > 400, `${s.pairs} pairs tested per pose`);
});

/** the v3 configuration: LeKiwi with the STOCK jaw and NO overhead mast, which is what
 *  python-fcl measured.  The corner mast that is fitted by default stands outside the arm's
 *  envelope by construction, so the top slot is emptied rather than swapped: nothing of ours
 *  is in the way, and the cross-check measures the stock robot python-fcl measured. */
async function stockWorld() {
  const { model, design, slots: S } = await studio();
  const W = createCollisionWorld({ model });
  let d = S.applyOption(design, 'gripper', 'stock_jaw').design;
  d = S.applyOption(d, 'top_camera_mount', 'none').design;
  W.setActiveFromDesign(d);
  W.checkPose({});
  return W;
}

test('the zero pose is clean, and whatever touches there is ignored for ever', async () => {
  const { collide: W } = await withCollide();
  const r = W.checkPose({}, { maxHits: 1000 });
  assert.equal(r.hits.length, 0, 'the URDF zero pose is collision-free — as a parked CAD pose should be');
  assert.equal(r.limitHits.length, 0, 'and inside every joint limit');
  const base = W.baselinePairs();
  assert.equal(base.size, 0, `${base.size} pairs still touch at the zero pose: ${[...base].join(', ')}`);
  const stock = await stockWorld();
  assert.deepEqual([...stock.baselinePairs()].sort(),
    ['Moving_Jaw_08d-v1::STS3215_03a-v1-4', 'Moving_Jaw_08d-v1::Wrist-Camera-Mount-v11'],
    'the stock jaw pivots inside its own bracket, which is a real modelling artifact');
});

test('the v3 / python-fcl pose table reproduces', async () => {
  const W = await stockWorld();
  const { collide: P } = await withCollide();
  for (const [name, [q, want]] of Object.entries(V3_POSES)) {
    const r = W.checkPose(q, { maxHits: 1000, count: false });
    assert.equal(r.hits.some((h) => /mast|corner_mast/.test(h.a + h.b)), false,
      `${name}: a mast is back inside the arm envelope`);
    const rp = P.checkPose(q, { maxHits: 1000, count: false });
    assert.equal(r.hits.length, want, `${name}: ${r.hits.length} pairs, python-fcl found ${want}`);
  }
  const floor = P.checkPose(V3_POSES['reach floor (v3)'][0], { maxHits: 1000, count: false });
  assert.equal(floor.hits.length, 21);
  assert.ok(floor.hits.some((h) => /pincopen\//.test(h.a + h.b)),
    'the extra pair must be a PincOpen one: ' + floor.hits.map((h) => `${h.a}×${h.b}`).join(', '));

  /* three of the four v3 presets are ALSO outside the joint limits */
  assert.deepEqual(W.outOfLimits(V3_POSES['stowed (v3)'][0]).map((l) => l.joint), ['arm_shoulder_lift', 'arm_wrist_flex']);
  assert.deepEqual(W.outOfLimits(V3_POSES['reach floor (v3)'][0]).map((l) => l.joint), ['arm_shoulder_lift', 'arm_elbow_flex']);
  assert.deepEqual(W.outOfLimits(V3_POSES['reach table (v3)'][0]).map((l) => l.joint), ['arm_shoulder_lift']);
  assert.deepEqual(W.outOfLimits(V3_POSES['raised max (v3)'][0]), [], 'only "raised max" was legal');
});

test('the verified pose finds the folded wrist inside the arm base', async () => {
  const q = { arm_shoulder_pan: 30, arm_shoulder_lift: -90 };
  const { collide: W } = await withCollide();
  const r = W.checkPose(q, { maxHits: 1000 });
  const stock = (await stockWorld()).checkPose(q, { maxHits: 1000 });
  assert.equal(stock.hits.length, 22, 'stock jaw + stock wrist camera: v3 + fcl found 22');
  assert.equal(r.hits.length, 57, 'PincOpen + the DF200 arch fitted');
  assert.equal(r.hits.filter((h) => /Wrist_Roll_08c/.test(h.a + h.b)).length, 0,
    'the stock fixed jaw is not on the robot, so it collides with nothing');
  assert.equal(stock.hits.filter((h) => /Wrist_Roll_08c/.test(h.a + h.b)).length, 5,
    '…and it is back, with its 5 pairs, the moment the stock jaw is fitted');
  assert.equal(r.hits.filter((h) => /pincopen\//.test(h.a + h.b)).length, 34);
  assert.equal(r.hits.filter((h) => /camera_basement|camera_mobile_sup/.test(h.a + h.b)).length, 0,
    'the stock PincOpen camera holder is not on the robot, so it collides with nothing');
  assert.equal(r.hits.filter((h) => /df200_arch/.test(h.a + h.b)).length, 17);
  assert.equal(r.hits.filter((h) => /corner_mast/.test(h.a + h.b)).length, 0,
    'the corner mast is clear even of a pose that folds the arm into the chassis');
  assert.equal(r.limitHits.length, 0, 'it is a legal pose — it is just impossible');
});

test('a joint sweep finds the first blocked angle, and bisection agrees', async () => {
  const W = await stockWorld();
  const sw = W.sweepJoint({ arm_elbow_flex: 0 }, 'arm_shoulder_lift', 0, -180, 1);
  assert.equal(sw.blockedAt, -12, 'v3 + python-fcl both report -12° (-11° is clear in both)');
  const clear = W.checkPose({ arm_shoulder_lift: -11, arm_elbow_flex: 0 }, { firstOnly: true });
  assert.equal(clear.hits.length, 0, '-11° is clear');
  const c6 = W.clampJoint({ arm_elbow_flex: 0 }, 'arm_shoulder_lift', -180);
  assert.equal(c6.blocked, true);
  assert.equal(W.checkPose({ arm_shoulder_lift: c6.q, arm_elbow_flex: 0 }, { firstOnly: true }).hits.length, 0,
    'the 6-probe answer is always a LEGAL pose (it under-shoots, it never over-shoots)');
  assert.ok(c6.blockedBy.length, 'and names what it hit: ' + c6.blockedBy.map((h) => W.label(h.b)).join(', '));
  /* 6 probes over a 180° move resolve to ±2.8°; more probes converge on the sweep */
  const c14 = W.clampJoint({ arm_elbow_flex: 0 }, 'arm_shoulder_lift', -180, { steps: 14 });
  assert.ok(c14.q > -12 && c14.q < -11, `14 probes stop at ${round(c14.q, 2)}°, between -11 and -12`);

  /* the default design, beside it: the same sweep with the real gripper on the wrist */
  const { collide: P } = await withCollide();
  const psw = P.sweepJoint({ arm_elbow_flex: 0 }, 'arm_shoulder_lift', 0, -180, 1);
  assert.equal(psw.blockedAt, -23, 'PincOpen reaches -23° before its own fingertip hits');
  assert.equal(P.checkPose({ arm_shoulder_lift: -22, arm_elbow_flex: 0 }, { firstOnly: true }).hits.length, 0,
    '-22° is clear with PincOpen fitted');
  assert.ok(!psw.hits.some((h) => /Wrist_Roll_08c/.test(h.a + h.b)),
    'the stock fixed jaw is off the robot, so it cannot be what stops the arm');
});

test('joint limits are the package\'s, and clamping respects them', async () => {
  const { collide: W } = await withCollide();
  assert.deepEqual(W.limitsOf('arm_shoulder_lift'), [-194.8, 5.2]);
  assert.deepEqual(W.limitsOf('arm_elbow_flex'), [-12.03, 181.63]);
  assert.deepEqual(W.limitsOf('arm_gripper'), [-100, 10]);
  const c = W.clampToLimits({ arm_shoulder_lift: -300, arm_elbow_flex: 400 });
  assert.equal(c.arm_shoulder_lift, -194.8);
  assert.equal(c.arm_elbow_flex, 181.63);
  const lc = W.clampJoint({}, 'arm_shoulder_lift', -300);
  assert.equal(lc.limited, true, 'the limit is applied before any mesh test');
});

test('the finger-tip gap is the PADS, and a shut stock jaw reads 0 mm', async () => {
  const { model, design, slots: S } = await studio();
  const stock = S.applyOption(design, 'gripper', 'stock_jaw').design;
  const W2 = createCollisionWorld({ model });
  W2.setActiveFromDesign(stock);
  W2.checkPose({});
  W2.setTips('Moving_Jaw_08d-v1', 'Wrist_Roll_08c-v1');
  const r = 82.787, closed = 10;
  const chord = (deg) => 2 * r * Math.sin(((closed - deg) / 2) * Math.PI / 180);
  let last = Infinity;
  for (const a of [-100, -60, -45, -30, -20, -15, -10, -5, 0, 5, 10]) {
    const g = W2.gripOpening({ arm_gripper: a });
    assert.ok(Math.abs(g - chord(a)) < 0.02, `gap at ${a}°: ${round(g, 2)} vs the chord ${round(chord(a), 2)}`);
    assert.ok(g < last, 'monotonic: negative arm_gripper OPENS');
    last = g;
  }
  assert.ok(near(W2.gripOpening({ arm_gripper: 10 }), 0, 1e-6), 'the closing stop IS zero opening');
  const t = W2.gripTips({ arm_gripper: 10 });
  assert.ok(t.moving.distanceTo(t.fixed) < 1e-6, 'the two pads coincide when the jaw is shut');
  assert.equal(t.joint, 'arm_gripper', 'the driving joint is measured, not assumed');
  assert.equal(t.movingLink, 'Moving_Jaw_08d-v1');
  assert.equal(t.fixedLink, 'Wrist_Roll_08c-v1');
});

test('the PincOpen pads come from the fingertips slot and reproduce the four-bar gap', async () => {
  const { collide: W } = await withCollide();
  const t = W.gripTips({});
  assert.match(t.source, /slot pincopen\/fingertips/, 'the pads are named by the package, not guessed');
  assert.equal(t.joint, 'pincopen/jaw');
  const L = 39.9991, TH0 = 30.0007 * Math.PI / 180;
  const want = (q) => 2 * L * (Math.sin(TH0) - Math.sin(TH0 - q * Math.PI / 180));
  for (const v of [0, 7.5, 15, 22.5, 30.0007]) {
    const got = W.gripOpening({ 'pincopen/jaw': v });
    assert.ok(Math.abs(got - want(v)) < 1e-3, `jaw ${v}°: ${got} vs ${want(v)}`);
  }
});

test('checkTransform + addDynamic place one body against the rest', async () => {
  const { collide: W, model } = await withCollide();
  const g = new THREE.BoxGeometry(60, 60, 60);
  W.addDynamic('probe', g, new THREE.Matrix4().makeTranslation(0, 0, 2000), { label: 'probe' });
  const far = W.checkTransform('probe', new THREE.Matrix4().makeTranslation(0, 0, 2000));
  assert.equal(far.ok, true, 'a box 2 m above the robot is clear');
  const deep = W.checkTransform('probe', new THREE.Matrix4().makeTranslation(0, 0, 40));
  assert.equal(deep.ok, false, 'a box inside the base is not');
  assert.ok(deep.hits.length >= 1, deep.hits.map((h) => W.label(h.b)).join(', '));
  W.remove('probe');
  assert.equal(W.worldMatrix('probe'), null);
});

test('timing is inside the budget (< 8 ms per checkPose)', async () => {
  const { collide: W } = await withCollide();
  let s = 0x2f6e2b1;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const poses = [];
  for (let i = 0; i < 120; i++) {
    const q = {};
    for (const j of W.armJoints) { const L = W.limitsOf(j) || [-90, 90]; q[j] = L[0] + rnd() * (L[1] - L[0]); }
    poses.push(q);
  }
  const stat = (fn) => {
    const t = poses.map((q) => { const a = performance.now(); fn(q); return performance.now() - a; }).sort((x, y) => x - y);
    return { mean: round(t.reduce((p, c) => p + c, 0) / t.length), p50: round(t[t.length >> 1]), p95: round(t[Math.floor(t.length * 0.95)]), max: round(t[t.length - 1]) };
  };
  const a = stat((q) => W.checkPose(q));
  const b = stat((q) => W.checkPose(q, { firstOnly: true, count: false }));
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) W.clampJoint({}, 'arm_shoulder_lift', -180);
  const clampMs = round((performance.now() - t0) / 10);
  assert.ok(a.mean < 8, `checkPose mean ${a.mean} ms < 8 ms`);
});

test('setActiveFromDesign follows the slots', async () => {
  const { model, design, slots: S } = await studio();
  const W2 = createCollisionWorld({ model });
  W2.setActiveFromDesign(design);
  const withPinc = W2.activeIds().length;
  const none = S.applyOption(design, 'gripper', 'none').design;
  W2.setActiveFromDesign(none);
  const without = W2.activeIds().length;
  assert.ok(without < withPinc, `${withPinc} active with the PincOpen, ${without} without`);
  assert.ok(!W2.activeIds().some((id) => id.startsWith('pincopen/')));
});

/* regressions */

test('checkTransform poses the world for the joints it is given, and puts it back', async () => {
  const { model } = await studio();
  const W = createCollisionWorld({ model });
  W.setActiveFromDesign(null);

  const id = model.components.find((c) => c.geometry && c.group === 'arm').id;
  const zero = model.zeroPose();
  const M = model.worldMatrix(id);

  const cold = W.checkTransform(id, M, null, { maxHits: 8, pose: zero });
  W.checkPose(zero, { maxHits: 1 });                    // this is what fills part.world
  const warm = W.checkTransform(id, M, null, { maxHits: 8, pose: zero });
  assert.equal(cold.hits.length, warm.hits.length,
    `clearance must not depend on whether a pose was applied first (${cold.hits.length} vs ${warm.hits.length})`);
  assert.ok(warm.hits.length > 0, 'the zero pose really does touch things without the ignore list');

  const floor = { arm_shoulder_pan: 0, arm_shoulder_lift: -163, arm_elbow_flex: 35, arm_wrist_flex: 170.5, arm_wrist_roll: 0, arm_gripper: -30 };
  W.checkPose(floor, { maxHits: 1 });
  const after = W.checkTransform(id, M, null, { maxHits: 8, pose: zero });
  assert.deepEqual(after.hits.map((h) => h.b).sort(), warm.hits.map((h) => h.b).sort(),
    'the same question gets the same answer whatever pose ran last');

  /* …and the world is left exactly where it was, so the caller is not surprised */
  assert.deepEqual(W.currentPose(), { ...model.zeroPose(), ...floor });
  const boxBefore = W.worldBox(id);
  W.checkTransform(id, M, null, { maxHits: 8, pose: zero });
  assert.ok(W.worldBox(id).min.distanceTo(boxBefore.min) < 1e-9, 'part.world restored');

  const armTip = model.components.filter((c) => c.geometry && c.group === 'arm').pop().id;
  const keep = model.getJoints();
  model.setJoints(floor);
  const atFloor = model.worldMatrix(armTip);
  model.setJoints(keep);
  const probe = new THREE.BoxGeometry(30, 30, 30);
  W.addDynamic('__probe__', probe, atFloor, { label: 'probe' });
  const hitAtFloor = W.checkTransform('__probe__', atFloor, null, { maxHits: 4, pose: floor }).hits.length;
  const hitAtZero = W.checkTransform('__probe__', atFloor, null, { maxHits: 4, pose: zero }).hits.length;
  W.remove('__probe__');
  assert.notEqual(hitAtFloor, hitAtZero,
    `the same probe at the same matrix must answer differently at a different pose `
    + `("reach floor" ${hitAtFloor} hits, zero ${hitAtZero}) — the pose argument is not decorative`);
});

test('updateDynamic() re-BVHs a part whose geometry was rebuilt', async () => {
  const { model, design, slots: S } = await studio();
  const W = createCollisionWorld({ model });
  W.setActiveFromDesign(S.applyOption(design, 'pi_case', 'vertical_revI').design);
  W.checkPose(model.getJoints(), { maxHits: 1 });

  const id = 'pi_case_cradle';
  const c = model.component(id);
  assert.ok(c && c.geometry, 'the Pi case is a parametric component of this package');
  const before = W.parts.get(id).localBox.getSize(new THREE.Vector3()).toArray().map((n) => round(n));

  const fresh = new THREE.BoxGeometry(400, 400, 400);
  c.geometry = fresh;
  W.checkPose({ arm_shoulder_lift: -5 }, { maxHits: 1 });          // a re-index is not enough
  assert.notEqual(W.parts.get(id).geom, fresh, 'nothing notices on its own');

  assert.equal(W.updateDynamic(id, fresh), true);
  W.checkPose(model.getJoints(), { maxHits: 1 });
  const rec = W.parts.get(id);
  assert.equal(rec.geom, fresh);
  assert.deepEqual(rec.localBox.getSize(new THREE.Vector3()).toArray().map(Math.round), [400, 400, 400]);
  assert.notDeepEqual(before, [400, 400, 400]);

  assert.ok(W.checkPose(model.getJoints(), { maxHits: 8, ignoreBaseline: false }).hits.length > 0,
    'the new silhouette is what is tested');

  /* refreshGeometry(id) re-reads whatever the component now carries */
  const back = new THREE.BoxGeometry(10, 10, 10);
  c.geometry = back;
  assert.equal(W.refreshGeometry(id), true);
  assert.equal(W.parts.get(id).geom, back);
  assert.equal(W.updateDynamic('no-such-part'), false);

  /* it works for a dynamic part too (an imported STL, a CSG preview) */
  const g1 = new THREE.BoxGeometry(5, 5, 5);
  W.addDynamic('probe', g1, new THREE.Matrix4(), { label: 'probe' });
  const g2 = new THREE.BoxGeometry(50, 50, 50);
  W.updateDynamic('probe', g2);
  assert.equal(W.parts.get('probe').geom, g2);
  assert.deepEqual(W.parts.get('probe').localBox.getSize(new THREE.Vector3()).toArray().map(Math.round), [50, 50, 50]);
  W.remove('probe');
});

test('the lazy zero-pose ignore list does not steal the pose it was asked about', async () => {
  const { model } = await studio();
  const pose = { arm_shoulder_pan: 0, arm_shoulder_lift: -163, arm_elbow_flex: 35, arm_wrist_flex: 170.5, arm_wrist_roll: 0, arm_gripper: -30 };

  const cold = createCollisionWorld({ model });
  cold.setActiveFromDesign(null);
  const coldHits = cold.checkPose(pose, { maxHits: 24 }).hits.map((h) => h.a + ' × ' + h.b).sort();

  const warm = createCollisionWorld({ model });
  warm.setActiveFromDesign(null);
  warm.baselinePairs();                                   // build the ignore list FIRST
  const warmHits = warm.checkPose(pose, { maxHits: 24 }).hits.map((h) => h.a + ' × ' + h.b).sort();

  assert.deepEqual(coldHits, warmHits,
    'the first call on a fresh world must answer the same as the second');
  assert.deepEqual(cold.currentPose(), { ...model.zeroPose(), ...pose },
    'and the world is left in the pose that was asked about');
});

test('an imported part joins the world, is checked, and rides the link it is bolted to', async () => {
  const { model } = await studio();
  const world = createCollisionWorld({ model });
  world.setActiveFromDesign(null);
  world.baselinePairs();

  /* a 60 mm box, parked out of everyone's way */
  const box = new THREE.BoxGeometry(60, 60, 60);
  const away = new THREE.Matrix4().makeTranslation(0, -600, 400);
  world.addDynamic('imported/box', box, away, { label: 'imported box', group: 'imported' });
  assert.ok(world.activeIds().includes('imported/box'), 'the import never joined the active set');
  assert.equal(world.checkPose({}, { maxHits: 8 }).hits.length, 0, 'a parked import already hits something');

  /* …now put it where the arm swings.  The tip of `reach floor` is (−4.8, 323.9, −5.3). */
  const pose = { arm_shoulder_pan: 0, arm_shoulder_lift: -163, arm_elbow_flex: 35, arm_wrist_flex: 170.5, arm_wrist_roll: 0, arm_gripper: -30 };
  const clearBefore = world.checkPose(pose, { maxHits: 24 }).hits.filter((h) => h.a === 'imported/box' || h.b === 'imported/box');
  assert.equal(clearBefore.length, 0, 'the parked box is already in the way');

  world.setDynamicMatrix('imported/box', new THREE.Matrix4().makeTranslation(-4.8, 323.9, -5.3));
  const hits = world.checkPose(pose, { maxHits: 24 }).hits.filter((h) => h.a === 'imported/box' || h.b === 'imported/box');
  assert.ok(hits.length > 0, 'the box sits on the tool tip and nothing noticed');
  const names = hits.map((h) => (h.a === 'imported/box' ? h.b : h.a));

  world.setDynamicMatrix('imported/box', new THREE.Matrix4(), { link: 'Wrist_Roll_08c-v1' });
  world.checkPose({}, { maxHits: 1 });
  const home = world.worldMatrix('imported/box').elements.slice(12, 15);
  world.checkPose(pose, { maxHits: 1 });
  const moved = world.worldMatrix('imported/box').elements.slice(12, 15);
  const travel = Math.hypot(moved[0] - home[0], moved[1] - home[1], moved[2] - home[2]);
  assert.ok(travel > 50, `a wrist-parented import travelled ${travel.toFixed(1)} mm when the arm moved`);

  world.remove('imported/box');
  assert.ok(!world.activeIds().includes('imported/box'), 'remove() left the part behind');
  box.dispose();

});
