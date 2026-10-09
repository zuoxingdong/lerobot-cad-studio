/* The Sim tab's live numbers from one MjData: peak actuator torque, robot-on-robot contact over
   the loop-closure baseline, joint-limit hits, the puck (held by both pads, tilt, the nest it sits
   in), nav clearance, robot-on-scenery contact, the instruments' states, real-time factor and ms
   per step.  Read-only on the data. */

import { indexModel, contacts, CONTACT_TOL_MM, USABLE_TORQUE_NM, LIMIT_BAND_DEG } from './sim-ik.js';
import { puckProbe, seatedIn } from './sim-instruments.js';
import { navClearance } from './sim-lab-watch.js';

export const STALL_TORQUE_NM = 3.0;
const R2D = 180 / Math.PI;

/** `opts.instruments()` returns the live instrument machine (or null). */
export function createMetrics(mj, m, sidecar, opts = {}) {
  const ix = indexModel(mj, m, sidecar);
  const nu = m.nu;
  const actName = Array.from({ length: nu }, (_, i) => mj.mj_id2name(m, mj.mjtObj.mjOBJ_ACTUATOR.value, i));
  const torqueActs = actName.map((n, i) => (n.startsWith('drive_') ? -1 : i)).filter((i) => i >= 0);
  const lab = sidecar.lab && sidecar.lab.schema === 'rps/lab@2' && sidecar.lab.props.length ? sidecar.lab : null;
  const probe = lab ? puckProbe(mj, m, ix, lab) : null;
  const puck = lab ? lab.props[0] : null;
  const scenery = new Set([...ix.env].filter((b) => b !== 'world'));
  const margin = opts.limitMarginDeg ?? LIMIT_BAND_DEG;
  let s;

  function reset() {
    s = { peak: 0, peakBy: null, limitHits: 0, atLimit: new Array(ix.arm.length).fill(false), self: 0, selfPairs: [],
      held: false, tilt: null, seatedAt: null, nav: null, navTo: null, scenery: 0, sceneryPairs: [], stations: null,
      steps: 0, rtf: null, msPerStep: null, win: { steps: 0, ms: 0, sim: 0, wall: 0 } };
  }
  reset();

  /** after every mj_step */
  function afterStep(d) {
    const f = d.actuator_force;
    for (const i of torqueActs) {
      const v = Math.abs(f[i]);
      if (v > s.peak) { s.peak = v; s.peakBy = actName[i]; }
    }
    if (lab) {
      const q = d.qpos, c = navClearance(lab, q[ix.baseAdr[0]] * 1000, q[ix.baseAdr[1]] * 1000);
      if (s.nav == null || c.mm < s.nav) { s.nav = c.mm; s.navTo = c.to; }
    }
    s.steps++;
  }

  function limits(d) {
    const q = d.qpos;
    ix.armAdr.forEach((a, i) => {
      const v = q[a] * R2D, [lo, hi] = ix.armRange[i];
      const at = v <= lo * R2D + margin || v >= hi * R2D - margin;
      if (at && !s.atLimit[i]) s.limitHits++;
      s.atLimit[i] = at;
    });
  }

  /** once per frame: contacts, limits, the puck, timing.  `wallMs` = time spent stepping. */
  function sample(d, { steps = 0, wallMs = 0, simDt = 0, frameMs = 0 } = {}) {
    limits(d);
    const cs = contacts(d);
    const pairs = new Map(), scen = new Set();
    for (const [g1, g2, dist] of cs) {
      const b1 = ix.geomBody[g1], b2 = ix.geomBody[g2];
      const e1 = ix.env.has(b1), e2 = ix.env.has(b2);
      if (e1 !== e2) {                                             // robot on scenery; the pads on the puck are the grasp
        const rb = e1 ? b2 : b1, eb = e1 ? b1 : b2;
        if (scenery.has(eb) && !(puck && eb === puck.body && /finger_[LR]$/.test(rb))) scen.add(`${rb}|${eb}`);
        continue;
      }
      if (b1 === b2 || e1 || ix.free.has(b1) || ix.free.has(b2)) continue;
      const k = b1 < b2 ? `${b1}|${b2}` : `${b2}|${b1}`;
      const pen = -dist * 1000 - (ix.baseline.get(k) ?? 0);
      if (pen >= CONTACT_TOL_MM) pairs.set(k, Math.max(pairs.get(k) ?? 0, pen));
    }
    s.self = pairs.size;
    s.selfPairs = [...pairs.keys()];
    s.scenery = scen.size;
    s.sceneryPairs = [...scen];
    if (probe) {
      const p = probe(d, cs).puck;
      s.held = p.held;
      s.tilt = p.tilt_deg;
      s.seatedAt = lab.stations.find((S) => seatedIn(S, p, puck.d))?.id ?? null;
    }
    const inst = opts.instruments?.();
    s.stations = inst ? inst.snapshot().stations : null;
    const w = s.win;
    w.steps += steps; w.ms += wallMs; w.sim += simDt; w.wall += frameMs;
    if (w.wall >= 500) {
      s.rtf = w.sim / (w.wall / 1000);
      s.msPerStep = w.steps ? w.ms / w.steps : null;
      s.win = { steps: 0, ms: 0, sim: 0, wall: 0 };
    }
  }

  function levels(v = s) {
    const t = v.peak, min = lab ? lab.clearance.min : 0;
    return {
      held: v.held ? 'pass' : 'unknown',
      seated: v.seatedAt ? 'pass' : 'unknown',
      torque: t >= STALL_TORQUE_NM ? 'fail' : t > USABLE_TORQUE_NM ? 'warn' : 'pass',
      self: v.self ? 'warn' : 'pass',
      limits: v.limitHits ? 'warn' : 'pass',
      nav: v.nav == null ? 'unknown' : v.nav >= min ? 'pass' : 'warn',
      scenery: v.scenery ? 'fail' : 'pass',
      rtf: v.rtf == null ? 'unknown' : v.rtf >= 0.9 * (opts.speed?.() ?? 1) ? 'pass' : 'warn',
      step: v.msPerStep == null ? 'unknown' : v.msPerStep <= 0.6 ? 'pass' : 'warn',
    };
  }

  return {
    reset, afterStep, sample, levels, props: puck ? 1 : 0,
    get value() { const { win, ...v } = s; void win; return { ...v, atLimit: [...s.atLimit], propsN: puck ? 1 : 0, lab: !!lab }; },
  };
}
