/* The reaction mix in the puck's four 2.0 mL screw-cap tubes, visual only.  Per tube the free
   surface's slope in the tube frame follows the effective gravity g - a (a = the acceleration of
   the surface centre, from its sampled poses) through a damped oscillator at the first
   antisymmetric slosh mode of an upright cylinder.  Reads poses, writes nothing to the sim. */

/* tube interior (mm, puck frame from the tube bottom): 9.0 mm bore, 1.5 mm floor, 6.5 mm cone,
   1 mm under the cap.  zeta: viscous boundary layer alone gives ~0.03 at R = 4.5 mm; the
   pinned, hysteretic contact line of a mm-scale meniscus (Bond number ~2.7) dominates. */
export const LIQUID = { fill_mL: 1.3, r: 4.5, floor: 1.5, cone: 6.5, neck: 1.0, xi: 1.8412, g: 9.81, zeta: 0.2, maxTiltDeg: 70, accelTauS: 0.01,
  /* ART-1..4 mixes: near clear, faintly tinted; ART-3 holds the dsDNA that the reader lights green */
  tints: [[0.88, 0.89, 0.7], [0.93, 0.83, 0.62], [0.8, 0.91, 0.74], [0.93, 0.8, 0.8]], glow: [0.35, 1, 0.5], hit: 2 };

const r6 = (x) => +x.toFixed(6) + 0;

/**
 * The liquid of a scene.json puck: {r_mm, z_low_mm, z_rest_mm, z_top_mm, h_mm, omega, zeta, s_max,
 * wells: [[x, y] mm], tints, glow, hit}.  z_low is where the cone ends (the column's bottom face);
 * h is the depth of the same volume in a flat-bottomed tube (the slosh depth).
 */
export function liquidSpec(p, L = LIQUID) {
  const W = p.wells, z0 = p.h - W.depth, A = Math.PI * L.r * L.r;
  const zLow = z0 + L.floor + L.cone, vol = L.fill_mL * 1000;
  const zRest = zLow + (vol - A * L.cone / 3) / A, zTop = z0 + W.tube[1] - L.neck, h = vol / A;
  const R = L.r / 1000, omega = Math.sqrt((L.g * L.xi / R) * Math.tanh(L.xi * h / L.r));
  const sMax = Math.min(Math.tan(L.maxTiltDeg * Math.PI / 180), (zTop - zRest) / L.r, (zRest - zLow) / L.r);
  const wells = Array.from({ length: W.n }, (_, k) => {
    const a = (W.phase_deg + k * 360 / W.n) * Math.PI / 180;
    return [r6(W.r * Math.cos(a)), r6(W.r * Math.sin(a))];
  });
  return { r_mm: L.r, z_low_mm: r6(zLow), z_rest_mm: r6(zRest), z_top_mm: r6(zTop), h_mm: r6(h), omega: r6(omega), zeta: L.zeta,
    s_max: r6(sMax), accel_tau_s: L.accelTauS, wells, tints: L.tints.slice(0, W.n), glow: L.glow, hit: L.hit };
}

/* e = s - s*, de/dt over dt for e'' + 2 zeta w e' + w^2 e = 0, exactly (underdamped) */
function decay(e, v, w, z, dt) {
  const wd = w * Math.sqrt(1 - z * z), k = Math.exp(-z * w * dt), c = Math.cos(wd * dt), s = Math.sin(wd * dt);
  const B = (v + z * w * e) / wd;
  return [k * (e * c + B * s), k * ((wd * B - z * w * e) * c - (wd * e + z * w * B) * s)];
}

/**
 * One puck's tubes.  sample(t, pos, R): the puck origin (m, world) and its rotation (row-major 3x3)
 * at sim time t; surfaces() -> [{slope: [sx, sy], tilt_deg, world_deg, normal: [x, y, z] world}].
 * The slope is dz/dx, dz/dy of the surface plane in the tube frame, pivoting about the rest-height
 * centre, so the volume stays constant.
 */
export function createLiquid(spec) {
  const n = spec.wells.length, w = spec.omega, z = spec.zeta, g = LIQUID.g;
  const S = Array.from({ length: n }, () => [0, 0]), V = Array.from({ length: n }, () => [0, 0]);
  const F1 = Array.from({ length: n }, () => [0, 0, 0]), F2 = Array.from({ length: n }, () => [0, 0, 0]);
  const hist = [];                                  // the last three samples: {t, P: [[x, y, z] per tube]}
  let Rn = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const local = spec.wells.map(([x, y]) => [x / 1000, y / 1000, spec.z_rest_mm / 1000]);

  function sample(t, pos, R) {
    const P = local.map((q) => [0, 1, 2].map((i) => pos[i] + R[3 * i] * q[0] + R[3 * i + 1] * q[1] + R[3 * i + 2] * q[2]));
    if (hist.length && t < hist.at(-1).t) reset();          // the sim was reset
    if (hist.length && !(t > hist.at(-1).t)) return;
    hist.push({ t, P });
    if (hist.length > 3) hist.shift();
    Rn = Array.from(R);
    if (hist.length < 3) return;
    const [a, b, c] = hist, dt = c.t - b.t, al = 1 - Math.exp(-dt / spec.accel_tau_s);
    for (let k = 0; k < n; k++) {
      /* two poles (10 ms) on the acceleration: the pads chatter on the puck at 120-250 Hz in the sim */
      for (let i = 0; i < 3; i++) {
        F1[k][i] += al * (2 * ((c.P[k][i] - b.P[k][i]) / (c.t - b.t) - (b.P[k][i] - a.P[k][i]) / (b.t - a.t)) / (c.t - a.t) - F1[k][i]);
        F2[k][i] += al * (F1[k][i] - F2[k][i]);
      }
      const acc = F2[k];
      /* surface normal along -(g - a), into the tube frame: n_t = R^T n */
      const ge = [-acc[0], -acc[1], -g - acc[2]];
      const nt = [0, 1, 2].map((j) => -(R[j] * ge[0] + R[3 + j] * ge[1] + R[6 + j] * ge[2]));
      const nz = Math.max(nt[2], 0.2 * Math.hypot(...nt));
      const want = [-nt[0] / nz, -nt[1] / nz];
      for (let i = 0; i < 2; i++) [S[k][i], V[k][i]] = decay(S[k][i] - want[i], V[k][i], w, z, dt).map((x, j) => (j ? x : x + want[i]));
      const m = Math.hypot(S[k][0], S[k][1]);
      if (m > spec.s_max) {                         // the surface stops at the cap or the cone: no outward speed
        const u = [S[k][0] / m, S[k][1] / m], out = V[k][0] * u[0] + V[k][1] * u[1];
        S[k] = [u[0] * spec.s_max, u[1] * spec.s_max];
        if (out > 0) V[k] = [V[k][0] - out * u[0], V[k][1] - out * u[1]];
      }
    }
  }

  function surfaces() {
    const R = Rn;
    return S.map(([sx, sy]) => {
      const l = Math.hypot(sx, sy, 1), nt = [-sx / l, -sy / l, 1 / l];
      const nw = [0, 1, 2].map((i) => R[3 * i] * nt[0] + R[3 * i + 1] * nt[1] + R[3 * i + 2] * nt[2]);
      return { slope: [sx, sy], tilt_deg: Math.atan(Math.hypot(sx, sy)) * 180 / Math.PI,
        world_deg: Math.acos(Math.min(1, nw[2])) * 180 / Math.PI, normal: nw };
    });
  }

  function reset() { for (let k = 0; k < n; k++) { S[k] = [0, 0]; V[k] = [0, 0]; F1[k] = [0, 0, 0]; F2[k] = [0, 0, 0]; } hist.length = 0; }

  return { spec, sample, surfaces, reset };
}

/** The reader's excitation on the hit tube, 0..1: up with the hood, full while it reads, 0.3 after. */
export function glowLevel(reader) {
  if (!reader) return 0;
  const s = reader.state;
  if (s === 'closing' || s === 'running' || s === 'opening') return reader.closure;
  return s === 'done' ? 0.3 : 0;
}
