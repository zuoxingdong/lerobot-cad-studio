// The enzyme-screen task (sim-lab-plan.js) as a phase state machine, one mj_step per `step()`.
// Writes ctrl only; IK runs at phase starts, and every move is a timed spline (sim-traj.js)
// sampled once per step.  `sliceMs` spreads a phase's planning over several
// step() calls (no mj_step until it is done); the result is the same either way.  The instruments
// (sim-instruments.js) and the watches (sim-lab-watch.js) are stepped after every mj_step.
import { createIK, indexModel, contacts, clamp, RateLimit, CONTACT_TOL_MM, USABLE_TORQUE_NM } from './sim-ik.js';
import { armTrajectory, baseTrajectory } from './sim-traj.js';
import { LAB, labGeometry, labPlan, phaseName } from './sim-lab-plan.js';
import { createInstruments, puckProbe, seatedIn, nestOffset } from './sim-instruments.js';
import { createWatch } from './sim-lab-watch.js';
import { summarize } from './sim-lab-report.js';

export { LAB };
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const r = (v, k = 3) => +v.toFixed(k);

export function jawDegForGap(gap, L) {
  const s = Math.sin(L.closed_crank_deg * D2R) - gap / (2 * L.link_length_mm);
  return L.closed_crank_deg - Math.asin(clamp(s, -1, 1)) * R2D;
}

export function createLab(mj, m, d, scene, opts = {}) {
  const C = { ...LAB, ...opts };
  const ix = indexModel(mj, m, scene);
  const lab = scene.lab;
  if (!lab || lab.schema !== 'rps/lab@2') throw new Error('scene.json has no rps/lab@2 block');
  const G = labGeometry(lab, C), prop = G.prop, puckId = ix.body(prop.body);
  const dt = m.opt.timestep, nu = m.nu;
  const groundZ = scene.ground_z_mm / 1000;
  const forceHi = Array.from({ length: nu }, (_, i) => m.actuator_forcerange[2 * i + 1]);
  const actName = Array.from({ length: nu }, (_, i) => mj.mj_id2name(m, mj.mjtObj.mjOBJ_ACTUATOR.value, i));

  mj.mj_resetData(m, d);
  mj.mj_forward(m, d);
  const ik = createIK(mj, m, d, ix, { tolPosMm: 0.05, tolRotDeg: 0.2, marginDeg: C.ikMarginDeg });
  const inst = createInstruments(lab, { heldRelMmS: C.heldRelMmS });
  const probe = puckProbe(mj, m, ix, lab);
  const watch = createWatch(mj, m, ix, lab);
  let last = probe(d);

  // state queries (views are re-read on every call: any allocation can detach them)
  const basePose = () => { const q = d.qpos; return ix.baseAdr.map((a) => q[a]); };
  const armDeg = () => ik.armDeg();
  const sitePos = (s) => Array.from(d.site_xpos.subarray(3 * ix.site[s], 3 * ix.site[s] + 3));
  const jawGapMm = () => { const a = sitePos('pad_L'), b = sitePos('pad_R'); return 1000 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); };
  const robotToWorld = (p) => {
    const [x, y, yaw] = basePose(), c = Math.cos(yaw), s = Math.sin(yaw);
    return [(c * p[0] - s * p[1]) / 1000 + x, (s * p[0] + c * p[1]) / 1000 + y, p[2] / 1000 - groundZ];
  };
  function puckState() {
    const s = probe(d);
    return { bottom_mm: s.puck.bottom.map((v) => r(v, 2)), tilt_deg: r(s.puck.tilt_deg, 2), held: s.puck.held,
      both_pads: s.puck.pads === 2, rel_speed_mm_s: r(s.puck.rel_mm_s, 2) };
  }
  function insertion(id) {
    const s = puckState(), N = G.nest(id), [bx, by, bz] = s.bottom_mm;
    const radial = Math.hypot(bx - N.xy[0], by - N.xy[1]), side = nestOffset(G.station(id), { bottom: s.bottom_mm });
    const inNest = side <= (N.inner - prop.d) / 2 + C.inNestTolMm;
    const seated = bz <= N.floor_z + C.seatedTolMm;
    return { station: id, in_nest: inNest, seated, offset_mm: r(radial, 2), side_offset_mm: r(side, 2), above_floor_mm: r(bz - N.floor_z, 2), tilt_deg: s.tilt_deg,
      success: inNest && seated && s.tilt_deg < C.tiltOkDeg && seatedIn(G.station(id), { bottom: s.bottom_mm, tilt_deg: s.tilt_deg }, prop.d) };
  }

  // arm targets: the post where the puck is now (read at the approach); the nest plus the hold offset
  // measured in the carry along the finger (the pads' one-point contact lets it sit off-centre), and
  // vertical, again above the nest
  const gripXY = {}, slotXY = {}, panBody = ix.body(ix.arm[0]);
  let holdOffset = prop.grip_z, holdAlong = 0;
  const padMid = () => { const a = sitePos('pad_L'), b = sitePos('pad_R'); return a.map((v, i) => (v + b[i]) / 2); };
  const pt = {
    grip(id, dz) {
      if (!gripXY[id]) { const b = probe(d).puck.bottom; gripXY[id] = [b[0] / 1000, b[1] / 1000]; }
      return [...gripXY[id], (G.nest(id).floor_z + prop.grip_z) / 1000 + dz];
    },
    slot(id, dz) {
      const N = G.nest(id);
      if (!slotXY[id]) {                      // the fingers will point from the pan axis at the nest
        const nx = N.xy[0] / 1000, ny = N.xy[1] / 1000, px = d.xpos[3 * panBody], py = d.xpos[3 * panBody + 1];
        const L = Math.hypot(nx - px, ny - py);
        slotXY[id] = [nx - (holdAlong / 1000) * (nx - px) / L, ny - (holdAlong / 1000) * (ny - py) / L];
      }
      return [...slotXY[id], (N.floor_z + holdOffset) / 1000 + C.insertAir + dz];
    },
  };
  const axis = [0, Math.sin((90 - C.gripPitchDeg) * D2R), -Math.cos((90 - C.gripPitchDeg) * D2R)];
  const stowed = ix.arm.map((n) => scene.presets.stowed[n] ?? 0);

  // controller state
  let armCmd = armDeg(), armTraj = null, armK = 0, baseTraj = null, baseK = 0;
  const jaw = new RateLimit(0, C.jawDegS);
  let jawTarget = 0, driveTarget = [0, 0, 0], driveCmd = [0, 0, 0];
  const phases = labPlan(G, C, pt, stowed, inst), records = [];
  let k = -1, cur = null, nSteps = 0, done = false, outcome = null;

  // base: the planned velocity plus a P term on the error to the planned pose (or to driveTarget)
  function servo() {
    const p = basePose(), v = scene.drive.v_max_mps, w = scene.drive.w_max_radps, g = C.driveGain;
    let ref = driveTarget, ff = [0, 0, 0];
    if (baseTraj) {
      const a = baseTraj.at(baseK), b = baseTraj.at(++baseK);
      ref = a;
      ff = b.map((x, i) => (x - a[i]) / dt);
    }
    const want = [clamp(ff[0] + (ref[0] - p[0]) * g, -v, v), clamp(ff[1] + (ref[1] - p[1]) * g, -v, v),
      clamp(ff[2] + wrap(ref[2] - p[2]) * g, -w, w)];
    const dv = C.driveAMax * dt, dw = C.driveAlphaMax * dt;
    driveCmd = driveCmd.map((p, i) => p + clamp(want[i] - p, i < 2 ? -dv : -dw, i < 2 ? dv : dw));
    return driveCmd;
  }
  // float32 on the way in, so the logged ctrl is exactly what the plant saw
  function apply(armCmd, jawCmd, drive) {
    const u = d.ctrl;
    for (let i = 0; i < ix.arm.length; i++) u[ix.armAct[i]] = Math.fround(armCmd[i] * D2R);
    if (ix.jawAct >= 0) u[ix.jawAct] = Math.fround(jawCmd * D2R);
    for (let i = 0; i < 3; i++) u[ix.driveAct[i]] = Math.fround(drive[i]);
  }

  // one IK waypoint of a straight Cartesian line (every viaMm, or lineViaMm near contact)
  function* stepSolve(p, seed, branch) {
    let [q, info] = ik.solve(p, { axis, q0: seed, iters: 120 });
    const mx = Math.max(...ik.staticTorque(q).map(Math.abs));
    const hits = ik.pathHits(seed, q);
    info = { ...info, branch: 'continuous', static_torque_max_Nm: r(mx), usable: mx <= USABLE_TORQUE_NM,
      travel_deg: r(Math.max(...q.map((v, i) => Math.abs(v - seed[i]))), 1), path_hits: Object.fromEntries(hits) };
    if ((info.ok && info.usable && !hits.size) || !branch) return [q, info];
    yield;
    return yield* ik.solveBestIter(p, { axis, qRef: seed, iters: 120 });
  }
  function* planMove(ph) {
    const target = ph.robot ? robotToWorld(ph.robot) : ph.point();
    const q0 = [...armCmd];
    let seed = q0;
    const [p0] = ik.siteAt(seed);
    const dist = 1000 * Math.hypot(...target.map((v, i) => v - p0[i]));
    const n = Math.max(1, Math.ceil(dist / (ph.line ? C.lineViaMm : C.viaMm)));
    const qs = [], infos = [], cart = [];
    for (let s = 1; s <= n; s++) {
      const p = target.map((v, i) => p0[i] + (v - p0[i]) * (s / n));
      const [q, info] = yield* stepSolve(p, seed, ph.branch || n === 1);
      infos.push({ ...info, target_mm: p.map((v) => r(v * 1000, 2)) });
      qs.push(q);
      cart.push(p);
      seed = q;
      yield;
    }
    const worst = infos.reduce((a, b) => (b.pos_err_mm + 2 * b.rot_err_deg > a.pos_err_mm + 2 * a.rot_err_deg ? b : a));
    // a free move whose line is off the reachable set (e.g. out of the stow) goes straight in joint space
    const direct = !ph.line && worst.pos_err_mm > 1 && !ik.pathHits(q0, qs.at(-1), 24).size;
    const traj = direct ? armTrajectory([q0, qs.at(-1)], null, { dt })
      : armTrajectory([q0, ...qs], [p0, ...cart], { dt, speeds: ph.line ?? null });
    // the spline leaves the checked joint lines between waypoints: check it every 40 ms
    const curveHits = new Set();
    for (let j = 20, prev = traj.at(0); j < traj.n - 1 + 20; j += 20) {
      const q = traj.at(j);
      for (const key of ik.pathHits(prev, q, 1).keys()) curveHits.add(key);
      prev = q;
      if (j % 100 === 0) yield;
    }
    const lastI = infos.at(-1);
    return [traj, { pos_err_mm: lastI.pos_err_mm, rot_err_deg: lastI.rot_err_deg, ok: lastI.ok, branch: lastI.branch,
      via: n, worst_pos_err_mm: worst.pos_err_mm, worst_rot_err_deg: worst.rot_err_deg,
      rejected_steps: infos.reduce((s, i) => s + i.rejected_steps, 0),
      via_over_usable: infos.filter((i) => !i.usable).length,
      path_hits: [...new Set([...infos.flatMap((i) => Object.keys(i.path_hits ?? {})), ...curveHits])],
      travel_deg: r(infos.reduce((s, i) => s + (i.travel_deg ?? 0), 0), 1), target_mm: lastI.target_mm,
      move_s: r(traj.T), slowed: r(traj.kappa), direct }];
  }

  function begin(ph) {
    const st = { ph, t0: d.time, limit: ph.max, tSettled: null, contactGap: null,
      rec: { phase: ph.name, label: phaseName(ph.name), kind: ph.kind, station: ph.station ?? null, t_start: r(d.time), step_start: nSteps, ik: null },
      peak: new Float64Array(nu), pairs: new Map(), ending: false };
    if (ph.kind === 'hold') {
      armTraj = armTrajectory([armCmd, ph.arm], null, { dt });
      armK = 0;
      jawTarget = ph.jaw;
      st.limit = ph.dur + armTraj.T;
    } else if (ph.kind === 'drive') {
      if (!baseTraj || baseTraj.goal !== ph.pose) {       // a via drive plans through into the next leg
        const next = phases[k + 1], poses = [basePose(), ph.pose];
        if (ph.via && next?.kind === 'drive') poses.push(next.pose);
        baseTraj = baseTrajectory(poses, { dt });
        baseTraj.goal = poses.at(-1);
        baseK = 0;
      }
      driveTarget = ph.pose;
    } else if (ph.kind === 'arm') {
      st.plan = planMove(ph);
      st.planMs = 0;
      if (!C.sliceMs) planned(st, Infinity);
    }
    return st;
  }

  // advance the phase's plan for up to `budget` ms; true once it is applied
  function planned(st, budget) {
    const t = performance.now();
    let res;
    do res = st.plan.next(); while (!res.done && performance.now() - t < budget);
    st.planMs += performance.now() - t;
    if (!res.done) return false;
    const [traj, info] = res.value, { ph } = st;
    st.plan = null;
    st.rec.ik = { ...info, ms: r(st.planMs, 1) };
    armTraj = traj;
    armK = 0;
    if (ph.jaw != null) jawTarget = jawDegForGap(ph.jaw, scene.linkage);
    st.limit = Math.min(ph.max, traj.T + 1.5);
    return true;
  }

  function sample(st, cs) {
    const f = d.actuator_force;
    for (let i = 0; i < nu; i++) st.peak[i] = Math.max(st.peak[i], Math.abs(f[i]));
    for (const [g1, g2, dist] of cs) {
      const b1 = ix.geomBody[g1], b2 = ix.geomBody[g2];
      if (ix.env.has(b1) || ix.env.has(b2)) continue;           // robot-on-robot only
      const key = b1 < b2 ? `${b1}|${b2}` : `${b2}|${b1}`;
      st.pairs.set(key, Math.max(st.pairs.get(key) ?? 0, -dist * 1000));
    }
  }

  function finish(st) {
    const { ph, rec } = st;
    mj.mj_forward(m, d);                  // xpos after mj_step is one step behind qpos
    if (ph.kind === 'drive' && !ph.via) { baseTraj = null; driveTarget = basePose(); }
    const self = [...st.pairs].map(([key, v]) => [key, v - (ix.baseline.get(key) ?? 0)]).filter(([, v]) => v >= CONTACT_TOL_MM);
    const torque = {};
    for (let i = 0; i < nu; i++) if (!actName[i].startsWith('drive_') && st.peak[i] > 1e-4)
      torque[actName[i]] = { peak_Nm: r(st.peak[i]), saturated: st.peak[i] >= C.saturatedFrac * forceHi[i], over_usable: st.peak[i] > USABLE_TORQUE_NM };
    const [bx, by, byaw] = basePose(), ps = puckState();
    Object.assign(rec, { t_end: r(d.time), step_end: nSteps, base: { x_mm: r(bx * 1000, 2), y_mm: r(by * 1000, 2), yaw_deg: r(wrap(byaw) * R2D, 2) },
      jaw_gap_mm: r(jawGapMm()), torque, self_collisions: Object.fromEntries(self.map(([key, v]) => [key, r(v)])),
      puck: ps, instruments: Object.fromEntries(inst.stations.map((id) => [id, inst.state(id)])) });
    if (ph.kind === 'grasp') rec.grasp = { contact_gap_mm: st.contactGap == null ? null : r(st.contactGap), verified: ps.held };
    if (ph.measure) {
      if (ps.held) {
        holdOffset = sitePos('grasp')[2] * 1000 - ps.bottom_mm[2];
        const mid = padMid(), X = d.site_xmat, sid = ix.site.grasp;
        holdAlong = [0, 1, 2].reduce((acc, k) => acc + (ps.bottom_mm[k] - mid[k] * 1000) * X[9 * sid + 3 * k], 0);
      }
      rec.hold_offset_mm = r(holdOffset, 2);
      rec.hold_along_mm = r(holdAlong, 2);
      rec.carry_held = ps.held;
    }
    if (ph.rehold) {                      // the soft grip creeps down on the drive: the insertion depth from here
      if (ps.held) holdOffset = sitePos('grasp')[2] * 1000 - ps.bottom_mm[2];
      rec.hold_offset_mm = r(holdOffset, 2);
    }
    if (ph.kind === 'release') rec.insertion = insertion(ph.station);
    if (ph.kind === 'wait') rec.wait = { station: ph.station, state: inst.state(ph.station), reached: ph.until() };
    records.push(rec);
    opts.onPhase?.(rec);
  }

  // pre-step: the grasp and release checks; returns false to end the phase without stepping
  function before(st, t) {
    const { ph } = st;
    if (ph.kind === 'grasp') {
      if (st.contactGap == null) {
        if (last.puck.pads === 2) {
          st.contactGap = jawGapMm();
          jawTarget = jawDegForGap(Math.max(0, st.contactGap - C.squeezeMm), scene.linkage);
          st.tSettled = t;
        } else jawTarget = Math.max(0, jawTarget - C.closeDegS * dt);
      } else if (t - st.tSettled > 0.8) return false;
    } else if (ph.kind === 'release') {
      jawTarget = jawDegForGap(C.jawOpenMm, scene.linkage);
      if (st.tSettled == null && jawGapMm() > prop.post_d) st.tSettled = t;
      else if (st.tSettled != null && t - st.tSettled > C.releaseSettleS) return false;
    }
    return true;
  }

  // post-step: the settle checks
  function after(st, t) {
    const { ph } = st;
    if (ph.kind === 'drive') {
      const [x, y, yaw] = basePose(), [tx, ty, tyaw] = driveTarget;
      const mm = ph.via ? C.viaSettleMm : C.settleMm, deg = ph.via ? C.viaSettleDeg : C.settleDeg;
      if (Math.hypot(tx - x, ty - y) * 1000 < mm && Math.abs(wrap(tyaw - yaw)) * R2D < deg) {
        if (ph.via) st.ending = true;                           // a via point: no dwell
        else if (st.tSettled == null) st.tSettled = t;
        else if (t - st.tSettled > C.driveDwellS) st.ending = true;
      }
    } else if (ph.kind === 'arm' && armK >= armTraj.n - 1) {
      const a = armDeg();
      if (Math.max(...a.map((v, i) => Math.abs(v - armCmd[i]))) < C.armSettledDeg) {
        if (st.tSettled == null) st.tSettled = t;
        else if (t - st.tSettled > C.armDwellS) st.ending = true;
      }
    } else if (ph.kind === 'wait' && ph.until()) {
      if (st.tSettled == null) st.tSettled = t;
      if (t - st.tSettled >= (ph.beat ?? 0)) st.ending = true;
    }
  }

  // Advance by exactly one mj_step (phase transitions happen between steps), or by one planning
  // slice with no mj_step while `planning`. Returns false when done.
  function step() {
    if (done) return false;
    for (;;) {
      if (!cur) {
        if (++k >= phases.length) {
          done = true;
          outcome = summarize({ records, d, nSteps, inst, watch, prop });
          return false;
        }
        cur = begin(phases[k]);
      }
      if (cur.plan && !planned(cur, C.sliceMs)) return true;
      const t = d.time - cur.t0;
      if (!cur.ending && t < cur.limit && before(cur, t)) break;
      finish(cur);
      cur = null;
    }
    const t = d.time - cur.t0;
    if (armTraj && armK < armTraj.n - 1) armCmd = armTraj.at(++armK);
    apply(armCmd, jaw.step(jawTarget, dt), servo());
    opts.onCtrl?.(d.ctrl);
    mj.mj_step(m, d);
    nSteps++;
    const cs = contacts(d);
    last = probe(d, cs);
    last.step = nSteps;
    inst.step(d.time, last);
    const snap = {};
    for (const id of inst.stations) snap[id] = inst.state(id);
    watch.step(d, d.time, last, cs, snap);
    sample(cur, cs);
    after(cur, t);
    return true;
  }

  return {
    step,
    get phase() { return cur?.ph.name ?? (done ? 'done' : 'idle'); },
    get planning() { return !!cur?.plan; },
    get done() { return done; },
    get outcome() { return outcome; },
    get puck() { return last.puck; },
    get seatedAt() { return watch.seatedAt; },
    records, ix, ik, phases, instruments: inst, watch,
    free: () => ik.free(),
    puckBody: puckId,
  };
}
