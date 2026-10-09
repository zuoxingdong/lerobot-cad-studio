/* features/sim-liquid.js on the lab puck: the tube interior and fill, the surface under a steady
 * acceleration, the free slosh (frequency and damping), the clamp, a sim reset, the reader glow. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIQUID, liquidSpec, createLiquid, glowLevel } from '../../../src/features/sim-liquid.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const puck = JSON.parse(fs.readFileSync(path.join(HERE, '../../../assets/scenes/lab/scene.json'), 'utf8')).props[0];
const spec = liquidSpec(puck);
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1], D2R = Math.PI / 180;
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

/* drive one puck along x with acceleration a(t); returns [t, slope_x of tube 1] */
function drive(a, secs, dt = 0.002, L = createLiquid(spec)) {
  let x = 0, v = 0;
  const out = [];
  for (let k = 0; k <= secs / dt; k++) {
    const t = k * dt;
    L.sample(t, [x, 0, 0], I);
    out.push([t, L.surfaces()[0].slope[0]]);
    v += a(t) * dt;
    x += v * dt;
  }
  return out;
}

test('1.3 mL in a 9.0 mm bore over a 6.5 mm cone: the surface 18.3 mm over the cone, inside the tube', () => {
  const A = Math.PI * spec.r_mm ** 2;
  near(A * LIQUID.cone / 3 + A * (spec.z_rest_mm - spec.z_low_mm), LIQUID.fill_mL * 1000, 1e-3, 'volume, mm^3');
  near(spec.z_rest_mm - spec.z_low_mm, 18.268, 0.001, 'column over the cone');
  const top = puck.h - puck.wells.depth + puck.wells.tube[1];
  assert.ok(spec.z_rest_mm > puck.h && spec.z_rest_mm < top - 10, `the surface ${spec.z_rest_mm} shows over the puck body and under the cap`);
  near(spec.omega, Math.sqrt(9.81 * 1.8412 / 0.0045 * Math.tanh(1.8412 * spec.h_mm / 4.5)), 1e-5, 'omega');
  near(spec.omega / 2 / Math.PI, 10.08, 0.01, 'first slosh mode, Hz');
  assert.equal(spec.wells.length, 4);
});

test('at rest the surface is level; a steady 0.6 m/s^2 leans it atan(a/g) = 3.5 deg, the back side up', () => {
  near(drive(() => 0, 1).at(-1)[1], 0, 1e-12, 'rest');
  const s = drive(() => 0.6, 1.5).at(-1)[1];
  near(Math.atan(-s) / D2R, Math.atan(0.6 / 9.81) / D2R, 0.01, 'steady lean, deg');
});

test('the free slosh: the damped mode at omega sqrt(1 - zeta^2), the decrement of zeta', () => {
  const r = drive((t) => (t < 1 ? 0.6 : 0), 2);
  const peaks = [];
  for (let i = 1; i < r.length - 1; i++) if (r[i][0] > 1.02 && Math.abs(r[i][1]) > Math.abs(r[i - 1][1]) && Math.abs(r[i][1]) >= Math.abs(r[i + 1][1])) peaks.push(r[i]);
  const T = 2 * (peaks[2][0] - peaks[1][0]);
  near(2 * Math.PI / T, spec.omega * Math.sqrt(1 - spec.zeta ** 2), 2, 'damped rad/s');
  const dec = Math.log(Math.abs(peaks[1][1] / peaks[3][1]));      // one period apart
  near(dec / Math.sqrt(4 * Math.PI ** 2 + dec ** 2), spec.zeta, 0.01, 'zeta from the decrement');
  const settle = r.find(([t, v]) => t > 1 && r.filter(([u]) => u >= t).every(([, w]) => Math.abs(w) < 0.02 * 0.0612));
  assert.ok(settle[0] < 1.5, `settles in ${(settle[0] - 1).toFixed(2)} s`);
});

test('the lean stops at s_max (70 deg): the surface never reaches the cap or the cone', () => {
  const s = drive(() => 60, 0.5).at(-1)[1];
  near(Math.abs(s), spec.s_max, 1e-9, 'clamped');
  assert.ok(spec.z_rest_mm + spec.s_max * spec.r_mm <= spec.z_top_mm && spec.z_rest_mm - spec.s_max * spec.r_mm >= spec.z_low_mm);
});

test('a tilted, still tube: the surface stays level in the world', () => {
  const L = createLiquid(spec), a = 8 * D2R, c = Math.cos(a), s = Math.sin(a);
  const R = [1, 0, 0, 0, c, -s, 0, s, c];                          // 8 deg about x
  for (let k = 0; k < 1000; k++) L.sample(k * 0.002, [0, 0, 0], R);
  const f = L.surfaces()[0];
  near(f.world_deg, 0, 0.01, 'vs the world');
  near(f.tilt_deg, 8, 0.01, 'vs the tube');
});

test('the sim time going back resets the state; the same samples give the same surface', () => {
  const L = createLiquid(spec);
  drive(() => 0.6, 0.5, 0.002, L);
  L.sample(0, [0, 0, 0], I);
  near(L.surfaces()[0].slope[0], 0, 0, 'reset');
  assert.deepEqual(drive((t) => Math.sin(9 * t), 1), drive((t) => Math.sin(9 * t), 1));
});

test('the hit tube glows with the reader hood; faint after the read, dark otherwise', () => {
  assert.equal(glowLevel(null), 0);
  assert.equal(glowLevel({ state: 'idle', closure: 0 }), 0);
  assert.equal(glowLevel({ state: 'running', closure: 1 }), 1);
  assert.equal(glowLevel({ state: 'closing', closure: 0.4 }), 0.4);
  assert.equal(glowLevel({ state: 'done', closure: 0 }), 0.3);
  assert.equal(spec.hit, 2, 'ART-3');
});
