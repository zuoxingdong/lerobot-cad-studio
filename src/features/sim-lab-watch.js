/* Per-step watches over a lab run, read-only on the data: nav clearance (the r_low circle against
   the plinths and the dock tower), robot-on-scenery contacts, the lid interlock (grasp site and
   wrist camera vs a nest whose lid is not open), and where the puck is seated over time.  mm. */

import { seatedIn } from './sim-instruments.js';

/* the charger tower behind the dock (visual only; the route keeps clear of it) */
export const DOCK_TOWER = { x: [-60, 60], y: [-310, -250] };
const LID_MOVING = new Set(['closing', 'running', 'opening']);

const rectDist = (x, y, R) => Math.hypot(Math.max(R.x[0] - x, 0, x - R.x[1]), Math.max(R.y[0] - y, 0, y - R.y[1]));

/** Clearance of the base footprint circle to every obstacle rect, mm: {mm, to}. */
export function navClearance(lab, x, y) {
  const r = lab.clearance.r_low;
  const rects = [...lab.stations.map((s) => [s.id, s.plinth_rect]), ['dock_tower', lab.dock_tower || DOCK_TOWER]];
  let best = { mm: Infinity, to: null };
  for (const [id, R] of rects) {
    const v = rectDist(x, y, R) - r;
    if (v < best.mm) best = { mm: v, to: id };
  }
  return best;
}

export function createWatch(mj, m, ix, lab) {
  const env = [...ix.env].filter((b) => b !== 'world');
  const puck = lab.props[0].body, d0 = lab.props[0].d;
  const cam = mj.mj_name2id(m, mj.mjtObj.mjOBJ_CAMERA.value, 'wrist');
  const lids = lab.stations.filter((s) => s.cycle);
  const w = { nav: { mm: Infinity, to: null, t: 0 }, interlock: { mm: Infinity, station: null, t: null }, scenery: new Map(),
    path: [], maxHeldTilt: 0 };
  let seatedAt = null;

  /** after each mj_step: `s` = the instruments' probe, `cs` the contacts, `snap` the instruments' states */
  function step(d, t, s, cs, states) {
    const q = d.qpos, x = q[ix.baseAdr[0]] * 1000, y = q[ix.baseAdr[1]] * 1000;
    const nv = navClearance(lab, x, y);
    if (nv.mm < w.nav.mm) w.nav = { mm: nv.mm, to: nv.to, t };
    for (const [g1, g2, dist] of cs) {
      const b1 = ix.geomBody[g1], b2 = ix.geomBody[g2];
      const e1 = ix.env.has(b1), e2 = ix.env.has(b2);
      if (e1 === e2) continue;                                     // robot-robot or scenery-scenery
      const rb = e1 ? b2 : b1, eb = e1 ? b1 : b2;
      if (eb === 'world' || !env.includes(eb)) continue;
      if (eb === puck && /finger_[LR]$/.test(rb)) continue;        // the pads on the puck are the grasp
      const k = `${rb}|${eb}`, pen = -dist * 1000;
      const o = w.scenery.get(k);
      if (!o) w.scenery.set(k, { pair: k, t: +t.toFixed(3), max_pen_mm: +pen.toFixed(3) });
      else o.max_pen_mm = Math.max(o.max_pen_mm, +pen.toFixed(3));
    }
    for (const L of lids) {
      if (!LID_MOVING.has(states[L.id])) continue;
      const [nx, ny] = L.nest.xy;
      let v = Math.hypot(s.grasp[0] - nx, s.grasp[1] - ny);
      if (cam >= 0) { const c = d.cam_xpos; v = Math.min(v, Math.hypot(c[3 * cam] * 1000 - nx, c[3 * cam + 1] * 1000 - ny)); }
      if (v < w.interlock.mm) w.interlock = { mm: v, station: L.id, t };
    }
    const at = lab.stations.find((S) => seatedIn(S, s.puck, d0))?.id ?? null;
    if (at !== seatedAt) {
      seatedAt = at;
      if (at && w.path.at(-1) !== at) w.path.push(at);
    }
    if (s.puck.held) w.maxHeldTilt = Math.max(w.maxHeldTilt, s.puck.tilt_deg);
  }

  return {
    step,
    get seatedAt() { return seatedAt; },
    summary: () => ({
      nav_clearance_min_mm: +w.nav.mm.toFixed(1), nav_clearance_to: w.nav.to, nav_clearance_t: +w.nav.t.toFixed(3),
      interlock_min_mm: Number.isFinite(w.interlock.mm) ? +w.interlock.mm.toFixed(1) : null, interlock_station: w.interlock.station,
      scenery_contacts: [...w.scenery.values()],
      puck_path: [...w.path], puck_seated_at: seatedAt,
      worst_held_tilt_deg: +w.maxHeldTilt.toFixed(2),
    }),
  };
}
