/* node --test tools/tests/ui/cable-frustum.test.mjs   (run from studio/)
   The committed cables over the whole run: no lead or plug on a camera's own body (or one welded to it)
   enters that camera's view frustum within NEAR of its lens. A lead on another link (the arm a camera looks
   at) may. tools/tests/render/test_cables.py checks the offline film's leads the same way. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SITE } from '../_root.mjs';
import * as THREE from 'three';
import { decodeRun } from '../../../src/ui/showcase-assets.js';
import { Player } from '../../../src/ui/showcase-player.js';
import { createCables, ringSize, PER_SPAN } from '../../../src/ui/robot-cables.js';

const WEB = path.join(SITE, 'lab');
const M = JSON.parse(readFileSync(path.join(WEB, 'manifest.json'), 'utf8'));
const tracks = await decodeRun(new Uint8Array(readFileSync(path.join(WEB, M.run.file))), M.run);
const NEAR = 0.15, ASPECT = 4 / 3;
const CAM_BODY = { front: 'base', top: 'base', wrist: 'arm_wrist_roll' };

/** per vertex of the cable mesh: the bodies that shape it (the knots of its B-spline span, or the plug's) */
function vertexBodies(specs) {
  const out = [];
  for (const c of specs) {
    const K = c.knots.length, p = Math.min(3, K - 1), span = K - p, n = (K - 1) * PER_SPAN + 1;
    for (let s = 0; s < n; s++) {
      const k = Math.min(Math.floor(span * s / (n - 1)) + p, K - 1), b = new Set();
      for (let j = k - p; j <= k; j++) for (const x of c.bodies[j]) b.add(x);
      for (let r = 0; r < ringSize(c); r++) out.push(b);
    }
    for (const pl of c.plugs || []) for (let i = 0; i < 24; i++) out.push(new Set([pl.body]));
  }
  return out;
}

/** the bodies that move rigidly with `body` over the run */
function welded(P, body) {
  const A = new THREE.Matrix4(), B = new THREE.Matrix4(), out = new Set([body]);
  for (const b of Object.keys(M.run.bodies)) {
    let same = true;
    for (let t = 0; t < P.duration && same; t += P.duration / 40) {
      P.ride(body, t, A);
      P.ride(b, t, B);
      same = A.elements.every((v, i) => Math.abs(v - B.elements[i]) < 1e-4);
    }
    if (same) out.add(b);
  }
  return out;
}

test('no lead on a camera\'s own body enters its near frustum over the run', () => {
  const P = new Player(M.run, tracks, [], 1);
  const cab = createCables(M.cables, { get: () => new THREE.MeshBasicMaterial() });
  const pos = cab.mesh.geometry.attributes.position.array, vb = vertexBodies(M.cables);
  assert.equal(vb.length * 3, pos.length, 'the mesh layout is not ringSize rings per sample and 24 per plug');
  const cams = M.run.cameras.map((c, n) => ({ n, name: c.name, own: welded(P, CAM_BODY[c.name]),
    tv: Math.tan(c.fovy * Math.PI / 360), cam: new THREE.PerspectiveCamera(c.fovy, ASPECT, c.near, 50) }));
  const v = new THREE.Vector3(), inv = new THREE.Matrix4(), worst = {};
  let checked = 0;
  for (let f = 0; f < P.frames; f += 3) {
    const t = f / P.fps;
    cab.update((b, out) => P.ride(b, t, out));
    for (const C of cams) {
      P.robotCamera(C.n, t, C.cam);
      inv.copy(C.cam.matrixWorld).invert();
      const th = C.tv * ASPECT;
      for (let i = 0; i < vb.length; i++) {
        if (![...vb[i]].some((b) => C.own.has(b))) continue;
        v.fromArray(pos, 3 * i).applyMatrix4(inv);
        const dep = -v.z, d = v.length();
        checked++;
        if (dep > 0 && d <= NEAR && Math.abs(v.x) <= dep * th && Math.abs(v.y) <= dep * C.tv) {
          const w = worst[C.name] || (worst[C.name] = { frames: new Set(), mm: Infinity });
          w.frames.add(f);
          w.mm = Math.min(w.mm, d * 1000);
        }
      }
    }
  }
  assert.ok(checked > 1e5, 'too few samples on the cameras\' own bodies: ' + checked);
  const msg = Object.entries(worst).map(([k, w]) => `${k}: ${w.frames.size} frames, ${w.mm.toFixed(1)} mm from the lens`);
  assert.equal(msg.length, 0, 'a lead in its own camera\'s view: ' + msg.join('; '));
});
