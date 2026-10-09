// Arm IK for the MuJoCo WASM build: damped least squares on mj_jacSite, joint clamps,
// collision reject, a seed bank and a torque-aware branch pick.
// Angles at the interface are degrees in `ix.arm` order; MuJoCo is metres and radians.

export const CONTACT_TOL_MM = 0.05;
export const USABLE_TORQUE_NM = 2.0;           // an assumption: 2/3 of the STS3215's 3 N.m stall
export const LIMIT_BAND_DEG = 0.5;             // a joint this close to a stop counts as a limit hit
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Run a generator to its return value. */
export function drain(g) {
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}

// Everything the controller looks up by name, resolved once. `meta` is scene.json.
export function indexModel(mj, m, meta) {
  const T = mj.mjtObj;
  const id = (t, n) => mj.mj_name2id(m, t.value, n);
  const need = (t, n) => {
    const i = id(t, n);
    if (i < 0) throw new Error(`model has no ${n}`);
    return i;
  };
  const arm = [...meta.arm_joints];
  const armJ = arm.map((n) => need(T.mjOBJ_JOINT, n));
  const jaw = meta.jaw_joints?.[0]?.replace('/', '_') ?? null;
  const jawJ = jaw ? need(T.mjOBJ_JOINT, jaw) : -1;
  const qadr = m.jnt_qposadr, dadr = m.jnt_dofadr, rng = m.jnt_range;
  const bodyName = Array.from({ length: m.nbody }, (_, b) => mj.mj_id2name(m, T.mjOBJ_BODY.value, b));
  const gb = m.geom_bodyid;
  const free = new Set();
  const jt = m.jnt_type, jb = m.jnt_bodyid;
  for (let j = 0; j < m.njnt; j++) if (jt[j] === mj.mjtJoint.mjJNT_FREE.value) free.add(bodyName[jb[j]]);
  const baseline = new Map(Object.entries(meta.model?.baseline ?? {}).map(([k, v]) => [k.split('|').sort().join('|'), +v]));
  const base = ['base_x', 'base_y', 'base_yaw'].map((n) => need(T.mjOBJ_JOINT, n));
  return {
    arm, armJ,
    armAdr: armJ.map((j) => qadr[j]),
    armDof: armJ.map((j) => dadr[j]),
    armAct: arm.map((n) => need(T.mjOBJ_ACTUATOR, `act_${n}`)),
    armRange: armJ.map((j) => [rng[2 * j], rng[2 * j + 1]]),
    jaw, jawAdr: jawJ >= 0 ? qadr[jawJ] : -1,
    jawAct: jaw ? need(T.mjOBJ_ACTUATOR, `act_${jaw}`) : -1,
    driveAct: ['drive_x', 'drive_y', 'drive_yaw'].map((n) => need(T.mjOBJ_ACTUATOR, n)),
    baseAdr: base.map((j) => qadr[j]),
    baseDof: base.map((j) => dadr[j]),
    site: Object.fromEntries(['grasp', 'pad_L', 'pad_R'].map((n) => [n, id(T.mjOBJ_SITE, n)]).filter(([, i]) => i >= 0)),
    body: (n) => id(T.mjOBJ_BODY, n),
    bodyName,
    geomBody: Array.from(gb, (b) => bodyName[b]),
    env: new Set(meta.env_bodies ?? ['world', 'table', 'ball']),
    free,
    baseline,
    fingerL: id(T.mjOBJ_BODY, 'pincopen_jaw_finger_L'),
  };
}

import { contacts } from './sim-engine.js';

export { contacts };

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// Solve A x = b for a small SPD matrix (row-major n*n), in place; returns b.
function solveSPD(A, b, n) {
  for (let k = 0; k < n; k++) {
    let s = A[k * n + k];
    for (let j = 0; j < k; j++) s -= A[k * n + j] ** 2;
    const L = Math.sqrt(Math.max(s, 1e-30));
    A[k * n + k] = L;
    for (let i = k + 1; i < n; i++) {
      let t = A[i * n + k];
      for (let j = 0; j < k; j++) t -= A[i * n + j] * A[k * n + j];
      A[i * n + k] = t / L;
    }
  }
  for (let i = 0; i < n; i++) {
    let t = b[i];
    for (let j = 0; j < i; j++) t -= A[i * n + j] * b[j];
    b[i] = t / A[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let t = b[i];
    for (let j = i + 1; j < n; j++) t -= A[j * n + i] * b[j];
    b[i] = t / A[i * n + i];
  }
  return b;
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

export function createIK(mj, m, liveData, ix, opts = {}) {
  const P = { lambda: 0.06, wRot: 0.09, dqMax: 0.12, tolPosMm: 0.2, tolRotDeg: 0.4, marginDeg: 0.4, ...opts };
  const d = new mj.MjData(m);                  // scratch: allocating it detaches every old view
  const nv = m.nv, n = ix.arm.length;
  const sid = ix.site.grasp;
  const posIds = ['pad_L', 'pad_R'].map((k) => ix.site[k]).filter((i) => i !== undefined);
  if (!posIds.length) posIds.push(sid);
  const lo = ix.armRange.map(([a]) => a + P.marginDeg * D2R);
  const hi = ix.armRange.map(([, b]) => b - P.marginDeg * D2R);
  const jp = new mj.DoubleBuffer(3 * nv), jr = new mj.DoubleBuffer(3 * nv), ji = new mj.DoubleBuffer(3 * nv);

  const sync = () => {
    d.qpos.set(liveData.qpos);
    d.qvel.fill(0);
  };
  const fk = (q) => {
    const qp = d.qpos;
    for (let i = 0; i < n; i++) qp[ix.armAdr[i]] = q[i];
    mj.mj_kinematics(m, d);
    mj.mj_comPos(m, d);
  };
  const pose = () => {
    const sx = d.site_xpos, p = [0, 0, 0];
    for (const i of posIds) for (let k = 0; k < 3; k++) p[k] += sx[3 * i + k] / posIds.length;
    const R = d.site_xmat.slice(9 * sid, 9 * sid + 9);
    return [p, R];
  };
  const toRad = (qd) => Float64Array.from(qd, (v, i) => clamp(v * D2R, lo[i], hi[i]));
  const toDeg = (q) => Array.from(q, (v) => v * R2D);

  function err(target, axis, freeAzimuth, level) {
    const [p, R] = pose();
    const ePos = [target[0] - p[0], target[1] - p[1], target[2] - p[2]];
    const a = [R[0], R[3], R[6]];               // site +X, the finger direction
    let b = [...axis];
    let bn = Math.max(norm(b), 1e-12);
    b = b.map((v) => v / bn);
    if (freeAzimuth) {
      const an = Math.hypot(a[0], a[1]), bz = Math.hypot(b[0], b[1]);
      if (an > 1e-6 && bz > 1e-9) {
        b = [(a[0] / an) * bz, (a[1] / an) * bz, b[2]];
        bn = Math.max(norm(b), 1e-12);
        b = b.map((v) => v / bn);
      }
    }
    const w = cross(a, b), s = norm(w), c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let eRot = s > 1e-9 ? w.map((v) => (v / s) * Math.atan2(s, c)) : [0, 0, 0];
    if (level) {                                // keep the jaw axis horizontal
      const y = [R[1], R[4], R[7]];
      const den = cross(a, y)[2];
      if (Math.abs(den) > 1e-6) {
        const k = clamp(-y[2] / den, -0.5, 0.5);
        eRot = eRot.map((v, i) => v + a[i] * k);
      }
    }
    return [ePos, eRot];
  }

  // Non-excluded robot-on-robot contacts at the last FK: Map "a|b" -> penetration mm.
  function collisions(q) {
    if (q) fk(q);
    mj.mj_collision(m, d);
    const bad = new Map();
    for (const [g1, g2, dist] of contacts(d)) {
      const b1 = ix.geomBody[g1], b2 = ix.geomBody[g2];
      if (ix.env.has(b1) || ix.env.has(b2)) continue;
      const pen = -dist * 1000;
      if (pen < CONTACT_TOL_MM) continue;
      const k = pairKey(b1, b2);
      bad.set(k, Math.max(bad.get(k) ?? 0, pen));
    }
    return bad;
  }

  function solve(target, { axis = [0, 0, -1], q0, iters = 90, collide = true, freeAzimuth = true, level = true } = {}) {
    sync();
    let q = toRad(q0 ?? armDeg());
    const blocked = new Map();
    let rejects = 0, best = null;
    const J = new Float64Array(36), A = new Float64Array(36), e = new Float64Array(6);
    for (let it = 0; it < iters; it++) {
      fk(q);
      const [ePos, eRot] = err(target, axis, freeAzimuth, level);
      const posMm = norm(ePos) * 1000, rotDeg = norm(eRot) * R2D;
      if (!best || posMm + 2 * rotDeg < best.score) best = { score: posMm + 2 * rotDeg, q: q.slice(), posMm, rotDeg, it };
      if (posMm < P.tolPosMm && rotDeg < P.tolRotDeg) break;
      mj.mj_jacSite(m, d, null, jr, sid);
      const Jr = jr.GetView(), Jp = new Float64Array(3 * nv);
      for (const i of posIds) {
        mj.mj_jacSite(m, d, ji, null, i);
        const v = ji.GetView();
        for (let k = 0; k < 3 * nv; k++) Jp[k] += v[k] / posIds.length;
      }
      for (let r = 0; r < 3; r++) for (let c = 0; c < n; c++) {
        J[r * n + c] = Jp[r * nv + ix.armDof[c]];
        J[(r + 3) * n + c] = P.wRot * Jr[r * nv + ix.armDof[c]];
      }
      for (let k = 0; k < 3; k++) { e[k] = ePos[k]; e[k + 3] = P.wRot * eRot[k]; }
      for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) {
        let s = r === c ? P.lambda ** 2 : 0;
        for (let k = 0; k < n; k++) s += J[r * n + k] * J[c * n + k];
        A[r * 6 + c] = s;
      }
      const x = solveSPD(A, e.slice(), 6);
      const dq = new Float64Array(n);
      for (let c = 0; c < n; c++) for (let r = 0; r < 6; r++) dq[c] += J[r * n + c] * x[r];
      const mx = Math.max(...dq.map(Math.abs));
      if (mx > P.dqMax) for (let c = 0; c < n; c++) dq[c] *= P.dqMax / mx;
      let step = 1, cand = null, clean = !collide;
      for (let h = 0; h < 4; h++) {             // halve the step until the candidate is clean
        cand = q.map((v, i) => clamp(v + dq[i] * step, lo[i], hi[i]));
        if (!collide) break;
        const hit = collisions(cand);
        if (!hit.size) { clean = true; break; }
        for (const [k, v] of hit) blocked.set(k, Math.max(blocked.get(k) ?? 0, v));
        rejects++;
        step *= 0.5;
      }
      if (!clean) break;
      if (Math.max(...cand.map((v, i) => Math.abs(v - q[i]))) < 1e-7) break;
      q = cand;
    }
    fk(best.q);
    const hit = collide ? collisions() : new Map();
    const info = {
      pos_err_mm: +best.posMm.toFixed(4), rot_err_deg: +best.rotDeg.toFixed(4), iters: best.it + 1,
      rejected_steps: rejects, collisions: Object.fromEntries(hit), blocked_by: Object.fromEntries(blocked),
      at_limit: ix.arm.filter((_, i) => best.q[i] <= lo[i] + 1e-6 || best.q[i] >= hi[i] - 1e-6),
      ok: best.posMm < 1 && best.rotDeg < 2 && !hit.size,
    };
    return [toDeg(best.q), info];
  }

  // Gravity torque per arm joint at a pose, N.m: qfrc_bias at zero velocity.
  function staticTorque(qd) {
    sync();
    const qp = d.qpos;
    for (let i = 0; i < n; i++) qp[ix.armAdr[i]] = qd[i] * D2R;
    mj.mj_forward(m, d);
    const fb = d.qfrc_bias;
    return ix.armDof.map((k) => fb[k]);
  }

  // Contacts along the straight joint-space line between two poses (props left out).
  function pathHits(qFrom, qTo, steps = 12) {
    sync();
    const a = qFrom.map((v) => v * D2R), b = qTo.map((v) => v * D2R);
    const worst = new Map();
    for (let s = 1; s <= steps; s++) {
      fk(a.map((v, i) => v + (b[i] - v) * (s / steps)));
      mj.mj_collision(m, d);
      for (const [g1, g2, dist] of contacts(d)) {
        const b1 = ix.geomBody[g1], b2 = ix.geomBody[g2];
        if (ix.free.has(b1) || ix.free.has(b2)) continue;
        if (ix.env.has(b1) && ix.env.has(b2)) continue;
        const k = pairKey(b1, b2);
        worst.set(k, Math.max(worst.get(k) ?? 0, -dist * 1000));
      }
    }
    return new Map([...worst].filter(([, v]) => v > 0.02));
  }

  function seedBank(ref) {
    const out = ref ? { current: [...ref] } : {};
    for (const lift of [-140, -110, -80, -50, -20]) for (const elbow of [0, 60, 120, 175])
      out[`l${lift}_e${elbow}`] = [0, lift, elbow, 0, 0, 0];
    return out;
  }

  // Solve from every seed; keep a clean, holdable branch nearest `qRef`.  Yields after each seed.
  function* solveBestIter(target, { seeds, qRef, usable = USABLE_TORQUE_NM, checkPath = true, ...kw } = {}) {
    const ref = [...(qRef ?? armDeg())];
    const cands = [];
    for (const [name, seed] of Object.entries(seeds ?? seedBank(ref))) {
      const [q, info0] = solve(target, { ...kw, q0: seed });
      const tq = staticTorque(q);
      const mx = Math.max(...tq.map(Math.abs));
      const dist = Math.max(...q.map((v, i) => Math.abs(v - ref[i])));
      const path = checkPath ? pathHits(ref, q) : new Map();
      const info = { ...info0, branch: name, static_torque_max_Nm: +mx.toFixed(3), usable: mx <= usable,
        travel_deg: +dist.toFixed(1), path_hits: Object.fromEntries(path) };
      cands.push({ key: [!info.ok, path.size > 0, mx > usable, mx <= usable ? dist : mx], q, info });
      yield;
    }
    cands.sort((x, y) => { for (let i = 0; i < 4; i++) if (x.key[i] !== y.key[i]) return x.key[i] < y.key[i] ? -1 : 1; return 0; });
    const top = cands[0];
    return [top.q, { ...top.info, branches: cands.length, branches_clean: cands.filter((c) => !c.key[0] && !c.key[1] && !c.key[2]).length }];
  }
  const solveBest = (target, o) => drain(solveBestIter(target, o));

  // Where the pads' midpoint and the grasp frame would be at a pose: FK only.
  function siteAt(qd) {
    sync();
    fk(qd.map((v) => v * D2R));
    return pose();
  }

  function armDeg() {
    const qp = liveData.qpos;
    return ix.armAdr.map((a) => qp[a] * R2D);
  }

  const free = () => { jp.delete(); jr.delete(); ji.delete(); d.delete(); };
  return { solve, solveBest, solveBestIter, staticTorque, pathHits, seedBank, siteAt, collisions, armDeg, free, params: P };
}

// A rate-limited joint ramp (degrees): a move takes as long as its distance needs.
export class JointRamp {
  constructor(q0, rate = 60) { this.q = [...q0]; this.target = [...q0]; this.rate = rate; }
  to(t) { this.target = [...t]; }
  step(dt) {
    const lim = this.rate * dt;
    for (let i = 0; i < this.q.length; i++) this.q[i] += clamp(this.target[i] - this.q[i], -lim, lim);
    return this.q;
  }
  errorDeg() { return Math.max(0, ...this.q.map((v, i) => Math.abs(this.target[i] - v))); }
  done(tol = 0.05) { return this.errorDeg() <= tol; }
}

// The same for one scalar command (the jaw).
export class RateLimit {
  constructor(value = 0, rate = 60) { this.value = value; this.rate = rate; }
  step(want, dt) { this.value += clamp(want - this.value, -this.rate * dt, this.rate * dt); return this.value; }
}
