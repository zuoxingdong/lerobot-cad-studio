/* features/sim-traj.js: the jerk-limited profile lands exactly, rest to rest, inside its limits;
 * the spline passes through its knots; an arm move holds the joint limits; a via drive blends
 * the turn with no stop at the via. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { profile, spline, armTrajectory, baseTrajectory, ARM_LIMITS, BASE_LIMITS } from '../../../src/features/sim-traj.js';

const DT = 0.002;
const diff = (x) => x.slice(1).map((v, i) => (v - x[i]) / DT);
const peak = (x) => Math.max(...x.map(Math.abs));

test('profile: ends exactly at L, starts and ends at rest, velocity, acceleration and jerk inside the limits', () => {
  const u = Array.from(profile(90, [{ from: 0, to: 60, v: 60 }, { from: 60, to: 90, v: 15 }], 200, 0.15, DT));
  assert.equal(u[0], 0);
  assert.equal(u.at(-1), 90);
  const v = diff(u), a = diff(v), j = diff(a);
  assert.ok(peak(v) <= 60 + 1e-6, `v ${peak(v)}`);
  assert.ok(peak(a) <= 200 * 1.02, `a ${peak(a)}`);            // sampling; timed() rescales to the exact limit
  assert.ok(peak(j) <= (2 * 200 / 0.15) * 1.05, `j ${peak(j)}`);          // 2A/tj where the acceleration reverses
  assert.ok(v[0] < 0.5 && v.at(-1) < 0.5, 'rest to rest');
  assert.ok(v.every((x) => x >= -1e-9), 'monotone');
  const at = u.findIndex((x) => x > 70);
  assert.ok(v[at] <= 15 + 1e-6, `slow zone ${v[at]}`);
});

test('spline: through every knot, C2 inside', () => {
  const u = [0, 1, 2.5, 4], Y = [[0, 1], [2, 0], [1, -1], [3, 2]], S = spline(u, Y);
  u.forEach((x, i) => S(x).forEach((v, k) => assert.ok(Math.abs(v - Y[i][k]) < 1e-12)));
  const h = 1e-4, d2 = (x) => S(x + h).map((v, k) => (v - 2 * S(x)[k] + S(x - h)[k]) / (h * h));
  const l = d2(1 - 1e-3), r = d2(1 + 1e-3);
  l.forEach((v, k) => assert.ok(Math.abs(v - r[k]) < 0.05, `second derivative jumps at a knot: ${v} vs ${r[k]}`));
});

test('arm move: every joint under 60 deg/s and the acceleration limit, ends on the last knot', () => {
  const qs = [[0, 0, 0, 0, 0, 0], [10, -20, 30, 5, 0, 0], [25, -35, 40, 10, 0, 0], [30, -60, 70, 20, 0, 0]];
  const cart = [[0.3, 0, 0.4], [0.3, 0.02, 0.38], [0.3, 0.04, 0.36], [0.3, 0.06, 0.34]];
  const T = armTrajectory(qs, cart, { dt: DT });
  const q = Array.from({ length: T.n }, (_, k) => T.at(k));
  for (let i = 0; i < 6; i++) {
    const v = diff(q.map((x) => x[i])), a = diff(v);
    assert.ok(peak(v) <= ARM_LIMITS.vel * 1.002, `joint ${i} v ${peak(v)}`);
    assert.ok(peak(a) <= ARM_LIMITS.acc * 1.01, `joint ${i} a ${peak(a)}`);
  }
  assert.deepEqual(T.at(T.n + 5), qs.at(-1));
});

test('base: a via drive keeps moving through the via and turns on the way', () => {
  const T = baseTrajectory([[0.74, 0.49, -Math.PI / 2], [0, 0.49, 0], [-0.74, 0.49, Math.PI / 2]], { dt: DT });
  const P = Array.from({ length: T.n }, (_, k) => T.at(k));
  const k = P.findIndex((p) => p[0] < 0), v = Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]) / DT;
  assert.ok(v > 0.9 * BASE_LIMITS.vel, `speed at the via ${v}`);
  assert.ok(Math.abs(P[k][2]) < 0.01, `yaw at the via ${P[k][2]}`);
  const w = diff(P.map((p) => p[2]));
  assert.ok(peak(w) <= BASE_LIMITS.w * 1.002);
  assert.ok(Math.abs(P.at(-1)[2] - Math.PI / 2) < 1e-12);
});
