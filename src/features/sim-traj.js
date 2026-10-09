/* Smooth, time-parameterised motion for the lab controller.  A C2 natural cubic spline through
   knots (IK waypoints in joint space, or base poses), timed by a jerk-limited profile: a
   trapezoid in velocity with look-ahead braking into slower zones, then a box filter of width
   `tj` (jerk = A / tj, distance kept).  Sampled once per physics step.  Pure; needs nothing. */

/* STS3215: the ACC register tops out near 2200 deg/s², and 3 N.m stall over the arm's reflected
   inertia allows more; 200 deg/s² with 0.15 s jerk ramps keeps the grip under ~0.1 g at 0.3 m. */
export const ARM_LIMITS = { vel: 60, acc: 200, tj: 0.15, cartAcc: 0.8 };   // deg/s, deg/s², s, m/s²
/* The base plans below its 0.24 m/s servo clamp so the tracking term has headroom. */
export const BASE_LIMITS = { vel: 0.22, acc: 0.4, w: 1.2, alpha: 1.2, tj: 0.25 };  // m/s, m/s², rad/s, rad/s², s

/** Natural cubic spline through (u[i], Y[i]) (Y: vectors); eval(uq) -> vector. */
export function spline(u, Y) {
  const n = u.length - 1, dims = Y[0].length;
  const M = Array.from({ length: n + 1 }, () => new Float64Array(dims));
  if (n >= 2) {
    const h = Array.from({ length: n }, (_, i) => u[i + 1] - u[i]);
    for (let k = 0; k < dims; k++) {            // Thomas algorithm on the interior second derivatives
      const c = new Float64Array(n), r = new Float64Array(n);
      for (let i = 1; i < n; i++) {
        const a = h[i - 1], b = 2 * (h[i - 1] + h[i]), cc = h[i];
        const rhs = 6 * ((Y[i + 1][k] - Y[i][k]) / h[i] - (Y[i][k] - Y[i - 1][k]) / h[i - 1]);
        const den = b - a * c[i - 1];
        c[i] = cc / den;
        r[i] = (rhs - a * r[i - 1]) / den;
      }
      for (let i = n - 1; i >= 1; i--) M[i][k] = r[i] - c[i] * M[i + 1][k];
    }
  }
  let j = 0;
  return function evaluate(uq) {
    if (uq <= u[0]) return [...Y[0]];
    if (uq >= u[n]) return [...Y[n]];
    while (j > 0 && uq < u[j]) j--;
    while (j < n - 1 && uq > u[j + 1]) j++;
    const h = u[j + 1] - u[j], a = (u[j + 1] - uq) / h, b = (uq - u[j]) / h, out = new Array(dims);
    for (let k = 0; k < dims; k++)
      out[k] = a * Y[j][k] + b * Y[j + 1][k] + ((a * a * a - a) * M[j][k] + (b * b * b - b) * M[j + 1][k]) * h * h / 6;
    return out;
  };
}

/**
 * Path parameter samples u[k] (k = 0..n-1, one per dt) from 0 to L, rest to rest.  `zones` =
 * [{from, to, v}] cover [0, L] in order.  The trapezoid is exact on a grid in u (forward and
 * backward passes at A, constant acceleration per cell); the box filter then bounds the jerk by
 * A / tj, or 2A / tj where the acceleration reverses.
 */
export function profile(L, zones, A, tj, dt, cells = 2000) {
  if (!(L > 0)) return Float64Array.of(0);
  const h = L / cells, cap = new Float64Array(cells + 1);
  for (let i = 0; i <= cells; i++) {
    const lo = (i - 1) * h, hi = (i + 1) * h;
    cap[i] = Math.min(...zones.filter((z) => z.to > lo && z.from < hi).map((z) => z.v), Infinity);
  }
  const v = new Float64Array(cells + 1);
  for (let i = 1; i < cells; i++) v[i] = Math.min(cap[i], Math.sqrt(v[i - 1] ** 2 + 2 * A * h));
  for (let i = cells - 1; i > 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * A * h));
  const du = [];
  let t = 0, prev = 0, k = 1;
  for (let i = 0; i < cells; i++) {
    const T = 2 * h / (v[i] + v[i + 1]), a = (v[i + 1] ** 2 - v[i] ** 2) / (2 * h);
    // every sample time inside this cell: u = u_i + v_i tau + a tau^2 / 2
    for (; k * dt < t + T; k++) {
      const tau = k * dt - t, u = i * h + v[i] * tau + 0.5 * a * tau * tau;
      du.push(u - prev);
      prev = u;
    }
    t += T;
  }
  du.push(L - prev);
  const w = Math.max(1, Math.round(tj / dt)), out = new Float64Array(du.length + w);
  let acc = 0, run = 0;
  for (let k = 0; k < du.length + w - 1; k++) {
    run += (du[k] ?? 0) - (du[k - w] ?? 0);
    acc += run / w;
    out[k + 1] = acc;
  }
  const sc = L / out[out.length - 1];
  for (let k = 0; k < out.length; k++) out[k] *= sc;
  out[out.length - 1] = L;
  return out;
}

// Peak |d/dt|, |d²/dt²| of each dim over sampled vectors.
function peaks(qs, dt) {
  const dims = qs[0].length, v = new Float64Array(dims), a = new Float64Array(dims);
  for (let k = 1; k < qs.length; k++) for (let i = 0; i < dims; i++) {
    v[i] = Math.max(v[i], Math.abs(qs[k][i] - qs[k - 1][i]) / dt);
    if (k > 1) a[i] = Math.max(a[i], Math.abs(qs[k][i] - 2 * qs[k - 1][i] + qs[k - 2][i]) / (dt * dt));
  }
  return { v, a };
}

/**
 * A timed spline through `knots` (vectors).  `metric(a, b)` spaces the knots; `zones(u, L)`
 * (with the merged `extra` knots) gives the velocity zones in u units; `lim` = [{vel, acc}] per dim (Infinity to skip), checked
 * on the samples, and the whole profile is slowed uniformly until they hold.
 * Returns {n, at(k), T, kappa, u}.
 */
export function timed(knots0, { metric, zones, A, tj, dt, lim, extra }) {
  // knots closer than 1e-6 (metric units) are merged: they would give an unbounded spline
  const keep = [0];
  for (let i = 1; i < knots0.length; i++) if (metric(knots0[keep.at(-1)], knots0[i]) > 1e-6) keep.push(i);
  if (keep.length === 1) keep.push(knots0.length - 1);
  const knots = keep.map((i) => knots0[i]);
  if (extra) extra = { ...extra, knots: keep.map((i) => extra.knots[i]) };
  const u = [0];
  for (let i = 1; i < knots.length; i++) u.push(u[i - 1] + Math.max(1e-9, metric(knots[i - 1], knots[i])));
  const L = u.at(-1), S = spline(u, knots), X = extra ? spline(u, extra.knots) : null;
  let kappa = 1, prof = null, qs = null;
  for (let it = 0; it < 5; it++) {
    prof = profile(L, zones(u, L, extra?.knots).map((z) => ({ ...z, v: z.v / kappa })), A / (kappa * kappa), tj * kappa, dt);
    qs = Array.from(prof, (x) => S(x));
    const p = peaks(qs, dt);
    let worst = 1;
    lim.forEach((l, i) => { worst = Math.max(worst, p.v[i] / l.vel, Math.sqrt(p.a[i] / l.acc)); });
    if (X) {
      const px = peaks(Array.from(prof, (x) => X(x)), dt);
      const ax = Math.hypot(...px.a);
      worst = Math.max(worst, Math.sqrt(ax / extra.acc));
    }
    if (worst <= 1.001) break;
    kappa *= worst * 1.002;
  }
  return { n: qs.length, at: (k) => qs[Math.min(Math.max(k, 0), qs.length - 1)], T: (qs.length - 1) * dt, kappa, u, L };
}

/** Joint-space move through IK waypoints (degrees); `cart` = the matching site targets (m) or null. */
export function armTrajectory(qs, cart, { dt, lim = ARM_LIMITS, speeds = null } = {}) {
  const cd = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const inf = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  const zones = (u, L, cart) => {
    if (!cart) return [{ from: 0, to: L, v: lim.vel }];
    const out = [];
    let c = 0;
    const total = cart.slice(1).reduce((s, p, i) => s + cd(cart[i], p), 0);
    for (let i = 1; i < u.length; i++) {
      const dc = cd(cart[i - 1], cart[i]) * 1000, dU = u[i] - u[i - 1], mid = c + dc / 2;
      let v = lim.vel;
      if (speeds && dc > 1e-6) {
        const slow = mid < (speeds.slowStartMm ?? 0) || mid > total * 1000 - (speeds.slowEndMm ?? 0);
        v = Math.min(v, (slow ? speeds.slow : speeds.fast) * dU / dc);
      }
      out.push({ from: u[i - 1], to: u[i], v });
      c += dc;
    }
    return out;
  };
  return timed(qs, { metric: inf, zones, A: lim.acc, tj: lim.tj, dt,
    lim: qs[0].map(() => ({ vel: lim.vel, acc: lim.acc })), extra: cart ? { knots: cart, acc: lim.cartAcc } : null });
}

/** Base move through poses [x, y, yaw] (m, rad; yaw unwrapped here), world frame. */
export function baseTrajectory(poses, { dt, lim = BASE_LIMITS } = {}) {
  const P = [poses[0]];
  for (let i = 1; i < poses.length; i++) {
    const prev = P[i - 1][2], y = poses[i][2];
    P.push([poses[i][0], poses[i][1], prev + Math.atan2(Math.sin(y - prev), Math.cos(y - prev))]);
  }
  const ratio = lim.vel / lim.w;
  const metric = (a, b) => Math.max(Math.hypot(a[0] - b[0], a[1] - b[1]), Math.abs(a[2] - b[2]) * ratio);
  return timed(P, { metric, zones: (u, L) => [{ from: 0, to: L, v: lim.vel }], A: lim.acc, tj: lim.tj, dt,
    lim: [{ vel: lim.vel, acc: lim.acc }, { vel: lim.vel, acc: lim.acc }, { vel: lim.w, acc: lim.alpha }] });
}
