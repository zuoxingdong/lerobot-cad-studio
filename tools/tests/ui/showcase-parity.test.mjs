/* node --test tools/tests/ui/showcase-parity.test.mjs   (run from studio/)
   The JS half of tools/tests/fixtures/photoreal-golden.json (written by tools/tests/render/test_parity.py):
   Player.camera is campath.basis, kelvinRgb is looks.kelvin_rgb, srgbToLin is looks.srgb_to_lin and
   Looks' emission strengths are looks.emission. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { Player } from '../../../src/ui/showcase-player.js';
import { Looks, kelvinRgb, srgbToLin } from '../../../src/ui/showcase-looks.js';

const G = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/photoreal-golden.json'), 'utf8'));
const close = (a, b, e, what) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= e, `${what}[${i}]: ${v} vs ${b[i]}`));

test('Player.camera is campath.basis', () => {
  for (const c of G.camera) {
    const row = [...c.row, 0, 0, 0];
    const P = new Player({ fps: 30, frames: 2, edit: { shots: [] }, camera_aspect: 16 / 9 },
      { pose: { n: 0 }, camera: { F: 2, C: 10, data: Float32Array.from([...row, ...row]) } }, [], 1);
    const cam = new THREE.PerspectiveCamera(40, 16 / 9, 0.03, 60);
    P.camera(0, cam);
    const q = cam.quaternion, v = (x, y, z) => new THREE.Vector3(x, y, z).applyQuaternion(q).toArray();
    const tag = 'row ' + c.row.join(',');
    close(cam.position.toArray(), c.eye, 1e-5, tag + ' eye');          // float32 track
    close(v(0, 0, -1), c.forward, 1e-5, tag + ' forward');
    close(v(0, 1, 0), c.up, 1e-5, tag + ' up');
    close(v(1, 0, 0), c.right, 1e-5, tag + ' right');
    assert.ok(Math.abs(cam.fov - c.row[6]) < 1e-4, tag + ' fovy');
  }
});

test('kelvinRgb and srgbToLin are looks.kelvin_rgb and looks.srgb_to_lin', () => {
  for (const k of G.kelvin) close(kelvinRgb(k.k), k.rgb, 1e-12, k.k + ' K');
  for (const [c, lin] of G.srgb) close([srgbToLin(c)], [lin], 1e-12, 'srgb ' + c);
});

test('Looks emission strengths are looks.emission', () => {
  for (const e of G.emission) {
    const L = new Looks({ x: e.spec }, { key_scale: e.key_scale, emit: e.emit });
    const m = L.make('x', [0.5, 0.5, 0.5, 1]);
    const tag = JSON.stringify(e.spec);
    assert.ok(Math.abs(m.emissiveIntensity - e.strength) < 1e-12, `${tag}: ${m.emissiveIntensity} vs ${e.strength}`);
    close([m.emissive.r, m.emissive.g, m.emissive.b], e.rgb, 1e-6, tag + ' rgb');
  }
});
