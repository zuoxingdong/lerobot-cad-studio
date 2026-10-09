/* `features/cameras.js` — the geometric half only: `evaluate()`'s ID pass needs WebGL, so
 * these drive the maths and check the renderer half degrades to `rendered:false` rather than
 * throwing. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { withCameras, freshCameras, round, near, cornerTopFrames } from './_harness.mjs';
import { createCameras, adoptAllSlotOptions, verdict, frameToMatrix, calibDefaultFor, hFovToV, vFovToH, CLASS_COLORS, CAMERA_DEFAULTS } from '../../../src/features/cameras.js';

const CORNER = { origin: [-75.3399, -18.5711, 504.8547], tilt_deg: 45 };  // the default top camera
import { cameraBuildFrame } from '../../../src/features/camera-frame.js';

test('the registry is manifest.cameras (the DEVICES); the FITTED OPTION poses each one', async () => {
  const { cameras: C, model } = await withCameras();
  assert.deepEqual(C.ids, ['front', 'wrist', 'top']);
  assert.equal(C.groundZ, -32.9);
  assert.deepEqual(C.reachDisc.centre, [0, 67.15]);
  assert.equal(C.reachDisc.radius, 304);
  const bare = createCameras(model);
  for (const id of bare.ids) {
    assert.equal(bare.getPose(id).ok, false, `${id} has no pose until an option gives it one`);
    assert.equal(model.cameraMatrix(id), null, `manifest.cameras.${id} carries no mount`);
  }
  for (const id of C.ids) assert.match(C.getPose(id).source || '', /^slot:/, `${id} is posed by its slot`);
  /* the front camera derivation, to the millimetre */
  const f = C.getPose('front');
  assert.ok(near(f.origin.y, 111.75, 0.01) && near(f.origin.z, 25.05, 0.01), 'front sensor (0, 111.75, 25.05)');
  assert.ok(near(f.tilt_deg, -10, 0.01), 'front looks 10° ABOVE the horizon');
  /* the corner mast at its shipped 45° index hole */
  const t = C.getPose('top');
  assert.deepEqual([round(t.origin.x, 1), round(t.origin.y, 1), round(t.origin.z, 1)],
                   [-75.3, -18.6, 504.9]);
  assert.ok(near(t.tilt_deg, 45, 0.01), 'top is 45° nose-down');
  /* and the wrist is the DF200 arch, 40° below the finger direction */
  assert.equal(C.get('wrist').hfov_deg, 87.3, 'every camera is the DF200');
});

test('hFOV ↔ vFOV, and the 4:3 conventions', async () => {
  const { cameras: C } = await withCameras();
  assert.ok(near(hFovToV(90, 4 / 3), 73.74, 0.01));
  assert.ok(near(vFovToH(hFovToV(81, 4 / 3), 4 / 3), 81, 1e-9), 'round trip');
  /* was 60° H = 46.8° V; the DF200 is 87.3 H = 71.16 V */
  assert.ok(near(C.get('top').vfov_deg, 71.16, 0.01), 'top 87.3° H = 71.16° V at 4:3');
  assert.equal(C.setHfov('top', 500), 120, 'clamped to the package range');
  assert.equal(C.get('top').user_hfov, true);
  C.reset('top');
  assert.equal(C.get('top').hfov_deg, 87.3);
  assert.equal(C.get('top').user_hfov, false);
  const j = C.toJSON();
  assert.equal(j.top.hfov_deg, 87.3);
  C.fromJSON({ top: { hfov_deg: 55, user_hfov: true } });
  assert.equal(C.get('top').hfov_deg, 55);
  C.reset('top');
});

test('project(): u right, v DOWN, both ±1 over the frame', async () => {
  const { cameras: C } = await withCameras();
  const p = C.getPose('top');
  const centre = p.origin.clone().addScaledVector(p.dir, 300);
  const c = C.project('top', centre, p);
  assert.ok(c.in && Math.abs(c.u) < 1e-9 && Math.abs(c.v) < 1e-9, 'the axis lands at (0, 0)');
  const up = centre.clone().addScaledVector(p.up, 50);
  assert.ok(C.project('top', up, p).v < 0, 'higher in the image is v NEGATIVE');
  const right = centre.clone().addScaledVector(p.right, 50);
  assert.ok(C.project('top', right, p).u > 0, 'to the right is u POSITIVE');
  const behind = p.origin.clone().addScaledVector(p.dir, -300);
  assert.equal(C.project('top', behind, p).behind, true);
  /* the frame edge is exactly ±1 */
  const th = Math.tan(p.hfov_deg * Math.PI / 360);
  const edge = p.origin.clone().addScaledVector(p.dir, 300).addScaledVector(p.right, 300 * th);
  assert.ok(near(C.project('top', edge, p).u, 1, 1e-9));
});

test('groundFootprint(): four corners below the horizon, two above', async () => {
  const { cameras: C } = await withCameras();
  const front = C.groundFootprint('front');
  assert.equal(front.corner_count, 2, 'a camera aimed 10° UP only catches the floor in the bottom of the frame');
  assert.ok(front.horizon, 'and its top rays never meet the ground');
  assert.ok(near(front.near_mm, 232.8, 1), 'the floor appears from Y ≈ 233 mm');
  const top = C.groundFootprint('top');
  assert.equal(top.corner_count, 4);
  for (const c of top.corners) assert.ok(near(c.z, -32.9, 1e-9));
  assert.ok(near(top.near_mm, 90.8, 1) && near(top.far_mm, 3020, 5),
            `top footprint ${round(top.near_mm, 1)} → ${round(top.far_mm, 1)} mm`);
});

test('reach-disc coverage is deterministic; a tilt moves it; clearOverride unposes until a slot re-adopts', async () => {
  const { cameras: C } = await withCameras();
  const a = C.evaluate('top');
  const b = C.evaluate('top');
  assert.equal(a.reach_disc_pct, b.reach_disc_pct, 'no RNG: Node and the browser agree');
  assert.equal(a.rendered, false, 'no renderer injected → the geometric half only');
  /* the corner mast at 87.3° sees all of it */
  assert.ok(near(a.reach_disc_pct, 100, 0.01), 'the corner mast sees the whole reach disc');
  C.registerFrames(cornerTopFrames(20), { source: 'mast 20' });
  assert.notEqual(C.evaluate('top').reach_disc_pct, a.reach_disc_pct, 'the tilt did not move the coverage');
  C.clearOverride('top');
  assert.equal(C.getPose('top').ok, false, 'nothing poses the top camera once its slot pose is dropped');
  assert.equal(C.get('top').hfov_deg, 87.3, 'and the lens was never the part\'s to change');
  const { slots: S5, design: D5 } = await withCameras();
  adoptAllSlotOptions(C, S5, D5);
  assert.ok(near(C.evaluate('top').reach_disc_pct, 100, 0.01), 'the fitted option puts it back');
});

test('verdict() chips, and red is never used for a camera', async () => {
  const { cameras: C } = await withCameras();
  const ev = C.evaluate('top', { tip: [0, 250, -12.9], props: [{ id: 'ball', point: [0, 250, -12.9] }] });
  const v = verdict(ev);
  assert.equal(v.level, 'pass');
  assert.match(v.text, /gripper visible · ball visible/);
  assert.ok(v.chips.every((c) => c.level !== 'fail'), 'never a fail');
  const warn = verdict({ ok: true, tip: { in: false }, props: [], robot_pct: 61 });
  assert.equal(warn.level, 'warn');
  assert.match(warn.text, /gripper out of frame · robot fills 61 %/);
  assert.equal(verdict(null).text, 'no pose');
  /* the chip order is fixed: tip → props → robot % */
  assert.deepEqual(v.chips.map((c) => c.key), ['tip', 'prop:ball', 'reach']);
});

test('evaluate() with an injected renderer that throws still returns a result', async () => {
  const { cameras: C } = await withCameras();
  const ev = C.evaluate('top', {
    renderer: { getRenderTarget: () => { throw new Error('no WebGL in Node'); } },
    scene: new THREE.Scene(), tag: () => 'robot',
  });
  assert.equal(ev.rendered, false);
  assert.match(ev.error, /no WebGL in Node/);
  assert.ok(ev.reach_disc_pct > 0, 'the geometric half survives');
  assert.ok(Object.keys(CLASS_COLORS).includes('floor'));
});

test('frameToMatrix accepts every frame shape the model does', () => {
  const tilt = frameToMatrix({ origin: [0, 25, 387.1], tilt_deg: 65 });
  const dir = new THREE.Vector3(); tilt.extractBasis(new THREE.Vector3(), new THREE.Vector3(), dir);
  dir.negate();
  assert.ok(near(dir.y, Math.cos(65 * Math.PI / 180), 1e-9) && near(dir.z, -Math.sin(65 * Math.PI / 180), 1e-9));
  assert.ok(frameToMatrix({ matrix: new THREE.Matrix4().toArray() }).equals(new THREE.Matrix4()));
  assert.ok(frameToMatrix(new THREE.Matrix4()).equals(new THREE.Matrix4()));
  assert.equal(frameToMatrix(null), null);
});

test('a package with no cameras yields an empty, harmless registry', async () => {
  const { model } = await withCameras();
  const bare = Object.create(Object.getPrototypeOf(model));
  Object.assign(bare, model, { cameras: [], manifest: { ...model.manifest, cameras: [] } });
  const C2 = createCameras(bare);
  assert.deepEqual(C2.ids, []);
  assert.equal(C2.getPose('top'), null);
  assert.deepEqual(C2.registerFrames({ cam_top: { origin: [0, 0, 0] } }), [], 'nothing to move');
});


test('every ID-pass class has its OWN colour, or it can never be reported', async () => {
  const seen = new Map();
  for (const [cls, c] of Object.entries(CLASS_COLORS)) {
    const key = c.join(',');
    assert.equal(seen.has(key), false, `"${cls}" and "${seen.get(key)}" share the colour ${key}`);
    seen.set(key, cls);
  }

  /* and they are far enough apart for the nearest-entry classifier's 60-unit radius */
  const names = Object.keys(CLASS_COLORS);
  let worst = Infinity, pair = '';
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = CLASS_COLORS[names[i]], b = CLASS_COLORS[names[j]];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (d < worst) { worst = d; pair = `${names[i]} / ${names[j]}`; }
    }
  }
  assert.ok(worst > 60, `closest pair ${pair} is ${worst.toFixed(1)} apart — inside the classifier radius`);

  /* every class the defaults count as "robot" must be nameable */
  for (const cls of CAMERA_DEFAULTS.robot_classes) {
    assert.ok(CLASS_COLORS[cls], `robot_classes lists "${cls}" but the palette has no colour for it`);
  }
});


test('a camera the package declares in the ROBOT frame is never carried twice', async () => {
  const { model } = await withCameras();
  const C = await freshCameras();
  const cam0 = C.getPose('top');
  assert.ok(near(cam0.origin.x, CORNER.origin[0], 1e-3) && near(cam0.origin.z, CORNER.origin[2], 1e-3));

  const frames = { cam_top: { origin: CORNER.origin, tilt_deg: 45, hfov_deg: 87.3 } };
  /* an unmoved component: the robot frame either way */
  assert.equal(cameraBuildFrame(model, C, 'corner_mast_printed_head', frames), 'robot');

  const retainer = model.component('corner_mast_printed_retainer');
  assert.ok(retainer, 'the package ships the corner mast\'s retainer as a component');
  const place = new THREE.Matrix4().makeRotationX(Math.PI).setPosition(-205, -0.63, 418.4);
  retainer.local.copy(place);
  assert.equal(cameraBuildFrame(model, C, 'corner_mast_printed_retainer', frames), 'robot',
    'a robot-frame camera stays in the robot frame however the part got off the print bed');

  C.registerFrames(frames, { frame: cameraBuildFrame(model, C, 'corner_mast_printed_retainer', frames), source: 'retainer' });
  const p = C.getPose('top');
  assert.equal(p.source, 'retainer');
  assert.deepEqual([round(p.origin.x, 3), round(p.origin.y, 3), round(p.origin.z, 3)], CORNER.origin.map((v) => round(v, 3)));
  assert.ok(near(p.tilt_deg, 45, 1e-6), 'still 45° nose-down, not 90°');
  const z0 = (v) => round(v, 3) + 0;                      // -0 is 0 here
  assert.deepEqual([z0(p.up.x), z0(p.up.y), z0(p.up.z)], [0, 0.707, 0.707], 'upright');
  assert.deepEqual([z0(p.right.x), z0(p.right.y), z0(p.right.z)], [1, 0, 0], 'image right is robot +X');

  /* and the wrist, which DOES declare a mount frame, is untouched by the new rule */
  assert.equal(cameraBuildFrame(model, C, 'df200_arch_head', { cam_wrist: { origin: [0, 0, 0] } }), 'wrist_flange');
});

/*
   THE OPTION POSES THE CAMERA (slot-consistency hunt class A).
   `adoptSlotOption()` is the one implementation the page, the tests and every other
   caller share; these are its three rules. */

test('the fitted option poses the camera, and `null` switches it off', async () => {
  const { model, slots: S, design } = await withCameras();
  const rows = [];
  const fit = (sid, oid) => {
    const d = S.applyOption(design, sid, oid, {}).design;
    const C = createCameras(model);
    const r = adoptAllSlotOptions(C, S, d);
    return { d, C, r };
  };
  /* every option of every camera-providing slot, on the composition */
  for (const [sid, cid] of [['top_camera_mount', 'top'], ['wrist_camera_mount', 'wrist'],
    ['front_camera', 'front']]) {
    for (const o of S.slots[sid].options) {
      if (o.kind === 'import') continue;
      const { d, C, r } = fit(sid, o.id);
      const active = S.activeOption(d, sid);
      const block = ((S.option(sid, active) || {}).cameras || {})[cid];
      const p = C.getPose(cid, {});
      if (block === null || block === undefined) {
        assert.equal(p.ok, false, `${sid}=${active}: publishes no ${cid} camera, so it must be OFF`);
        assert.ok(r.off.includes(cid), `${sid}=${active}: ${cid} is reported off`);
      } else {
        assert.equal(p.ok, true, `${sid}=${active}: publishes a pose`);
        assert.match(p.source, new RegExp('slot:' + sid));
        const opt = S.option(sid, active);
        if (!block.carrier && (opt.frame || 'robot') === 'robot') {
          assert.ok(Math.abs(p.tilt_deg - block.tilt_deg) < 0.01,
            `${sid}=${active}: tilt ${round(p.tilt_deg, 2)} vs the block's ${block.tilt_deg}`);
        }
      }
      rows.push({ slot: sid, asked: o.id, fitted: active, camera: cid,
        pose: p.ok ? [p.origin.x, p.origin.y, p.origin.z].map((v) => round(v, 1)).join(', ') : 'OFF',
        'tilt°': p.ok ? round(p.tilt_deg, 1) : '—', hFOV: C.get(cid).hfov_deg });
    }
  }
  assert.ok(rows.some((x) => x.pose === 'OFF'), 'the empty options really do switch it off');
  assert.ok(rows.every((x) => x.hFOV === 87.3), 'and not one of them changed the lens');
});

test('a camera does not count its OWN mount as robot', async () => {
  const { model, slots: S, design } = await withCameras();
  const C = createCameras(model);
  adoptAllSlotOptions(C, S, design);
  assert.deepEqual(C.selfParts('wrist').sort(),
    ['df200_arch_arch', 'df200_arch_df200', 'df200_arch_head', 'df200_arch_retainer']);
  assert.deepEqual(C.selfParts('front').sort(), ['Camera-Model-v3', 'Camera-Mount-v8']);
  assert.equal(C.selfParts('top').length, 5, 'the corner mast is the top camera\'s own');
  /* it is the FITTED option's parts, so a swap moves it */
  const stock = S.applyOption(design, 'wrist_camera_mount', 'stock', {}).design;
  const C2 = createCameras(model);
  adoptAllSlotOptions(C2, S, stock);
  assert.deepEqual(C2.selfParts('wrist').sort(), ['Camera-Model-v3-1', 'Wrist-Camera-Mount-v11']);
  /* and an option that switches the camera off leaves no housing behind */
  const off = S.applyOption(design, 'top_camera_mount', 'none', {}).design;
  const C3 = createCameras(model);
  adoptAllSlotOptions(C3, S, off);
  assert.deepEqual(C3.selfParts('top'), []);
  /* nothing else is excluded: the arm, the gripper and the OTHER mounts still count */
  for (const id of ['pincopen/top_plate', 'corner_mast_printed_head', 'Base_08q-v1']) {
    assert.ok(!C.selfParts('wrist').includes(id), id);
  }
});

test('AN OPTION MAY NOT CHANGE THE LENS', async () => {
  const { model, slots: S, design } = await withCameras();
  const C = createCameras(model);
  S.registerAlternatives([{ id: 'lens_probe', slot: 'wrist_camera_mount', label: 'lens probe',
    frame: 'attachment', local: null, source: 'test',
    cameras: { wrist: { origin: [-36.2, 0, 94.758], tilt_deg: 47, hfov_deg: 42 } } }],
  { slot: 'wrist_camera_mount' });
  const d = { ...design, slots: { ...design.slots, wrist_camera_mount: 'alt:lens_probe' } };
  adoptAllSlotOptions(C, S, d);
  assert.equal(C.getPose('wrist').ok, true, 'the alternative still poses the camera');
  assert.equal(C.get('wrist').hfov_deg, 87.3, 'but its 42° lens was dropped');
  assert.equal(C.get('wrist').hfov_from_part, false);
  /* the user may still change it — that is the panel's ⌄ menu, not the mount */
  C.setHfov('wrist', 60);
  adoptAllSlotOptions(C, S, d);
  assert.equal(C.get('wrist').hfov_deg, 60, "the user's own lens survives a re-adopt");
  S.clearAlternatives('wrist_camera_mount');
});

test('a block\'s `carrier` names what carries it, live', async () => {
  const { model, slots: S, design } = await withCameras();
  const d = S.applyOption(design, 'wrist_camera_mount', 'stock', {}).design;
  const C = createCameras(model);
  adoptAllSlotOptions(C, S, d);
  const block = S.option('wrist_camera_mount', 'stock').cameras.wrist;
  assert.equal(block.carrier, 'Camera-Model-v3-1');
  const keep = model.getJoints();
  const p0 = C.getPose('wrist').origin.clone();
  model.setJoints({ arm_shoulder_lift: -60 });
  const p1 = C.getPose('wrist').origin.clone();
  model.setJoints(keep);
  const p2 = C.getPose('wrist').origin.clone();
  assert.ok(p0.distanceTo(p1) > 50, `a carried camera rides the arm (${round(p0.distanceTo(p1), 1)} mm)`);
  assert.ok(p0.distanceTo(p2) < 1e-9, 'and comes back');
  /* and it is EXACTLY where the stock `lekiwi` package puts the same bracket */
});
