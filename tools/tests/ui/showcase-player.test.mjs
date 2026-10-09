/* node --test tools/tests/ui/showcase-player.test.mjs   (run from studio/)
   The committed showcase run: run.bin decodes to the manifest's blocks, the pose and robot-camera
   quaternions are unit, and the Player's camera is MuJoCo's free camera (eye = lookat - d f, +Z up)
   with no in-between frame across a cut. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SITE } from '../_root.mjs';
import * as THREE from 'three';
import { decodeRun } from '../../../src/ui/showcase-assets.js';
import { Player } from '../../../src/ui/showcase-player.js';

const WEB = path.join(SITE, 'lab');
const M = JSON.parse(readFileSync(path.join(WEB, 'manifest.json'), 'utf8'));
const tracks = await decodeRun(new Uint8Array(readFileSync(path.join(WEB, M.run.file))), M.run);

test('run.bin decodes to every block of the manifest', () => {
  for (const b of M.run.blocks) {
    const t = tracks[b.name];
    assert.equal(t.data.length, b.n * b.frames * b.comps, b.name);
    assert.ok(t.data.every(Number.isFinite), b.name + ' has a non-finite value');
  }
  assert.equal(tracks.pose.F, M.run.frames);
});

test('pose and robot-camera quaternions are unit', () => {
  let worst = 0;
  for (const [name, n] of [['pose', tracks.pose.n], ['rcams', tracks.rcams.n]]) {
    const { F, data } = tracks[name];
    for (let k = 0; k < n; k++) for (let f = 0; f < F; f += 7) {
      const o = (k * F + f) * 7;
      worst = Math.max(worst, Math.abs(Math.hypot(data[o + 3], data[o + 4], data[o + 5], data[o + 6]) - 1));
    }
  }
  assert.ok(worst < 2e-4, 'worst |q| - 1 = ' + worst);
});

test('the camera is the free camera of the track, and cuts do not blend', () => {
  const P = new Player(M.run, tracks, [], 1);
  const cam = new THREE.PerspectiveCamera(40, 16 / 9, 0.03, 60);
  const C = tracks.camera;
  for (const f of [0, 300, 900, 1500]) {
    P.camera(f / M.run.fps, cam);
    const r = C.data.subarray(f * C.C, f * C.C + C.C);
    const az = r[3] * Math.PI / 180, el = r[4] * Math.PI / 180;
    const eye = [r[0] - r[5] * Math.cos(el) * Math.cos(az), r[1] - r[5] * Math.cos(el) * Math.sin(az), r[2] - r[5] * Math.sin(el)];
    assert.ok(cam.position.toArray().every((v, i) => Math.abs(v - eye[i]) < 1e-6), 'frame ' + f);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    assert.ok(Math.abs(fwd.z - Math.sin(el)) < 1e-5, 'elevation at frame ' + f);
    assert.ok(Math.abs(cam.fov - r[6]) < 1e-4, 'fovy at 16:9, frame ' + f);
  }
  const cut = M.run.edit.shots[2].t;
  P.camera(cut - 1e-4, cam);
  const a = cam.position.clone();
  P.camera(cut + 1e-4, cam);
  assert.ok(a.distanceTo(cam.position) > 0.2, 'no jump at the cut into ' + M.run.edit.shots[2].id);
});

test('chapters and captions follow the edit', () => {
  const P = new Player(M.run, tracks, [], 1);
  M.run.edit.shots.forEach((s, k) => assert.equal(P.chapter(s.t + 1e-3), k, s.id));
  const inc = M.run.edit.captions.find((c) => c.clock === 'incubation');
  const mid = (inc.t[0] + inc.t[1]) / 2;
  assert.match(P.captions(mid)[0].line2, /^modelled time \d\d:\d\d \/ 30:00$/);
  assert.equal(P.captions(-1).length, 0);
});
