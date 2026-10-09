/* The workcell's instruments as a deterministic state machine, stepped after every mj_step from the
   sim state (the sidecar `lab` block, rps/lab@2).  Visual only: nothing here touches the model or
   the data.  `events` is the log the video replays and check.py re-derives natively. */

import { contacts } from './sim-engine.js';

export const INST = { radialTolMm: 0.5, floorTolMm: 2.5, tiltOkDeg: 5, leaveMm: 10, heldRelMmS: 12, armDwellS: 0.1, designDelayS: 1.5 };

const R2D = 180 / Math.PI, D2R = Math.PI / 180;
const smooth = (x) => { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t); };

/* the puck's offset from the nest centre along the square collar's sides (station frame), mm */
export function nestOffset(st, p) {
  const dx = p.bottom[0] - st.nest.xy[0], dy = p.bottom[1] - st.nest.xy[1], a = st.yaw * D2R;
  return Math.max(Math.abs(dx * Math.cos(a) + dy * Math.sin(a)), Math.abs(-dx * Math.sin(a) + dy * Math.cos(a)));
}

/** Is the puck seated in this station's nest?  `p` = {bottom: [x, y, z] mm, tilt_deg}.  The collar is
    square, so the clearance is per side: a puck resting in a corner is seated. */
export function seatedIn(st, p, d, C = INST) {
  const n = st.nest;
  return nestOffset(st, p) <= (n.inner - d) / 2 + C.radialTolMm && p.bottom[2] <= n.floor_z + C.floorTolMm && p.tilt_deg < C.tiltOkDeg;
}

/* the puck has left the nest: lifted or pushed out */
function left(st, p, C) {
  const n = st.nest;
  return p.bottom[2] > n.floor_z + C.leaveMm || Math.hypot(p.bottom[0] - n.xy[0], p.bottom[1] - n.xy[1]) > C.leaveMm;
}

/** One station's view at t, in `state` since t0: lid closure, run progress, the result bars.  The film's twin is
    tools/render/film/videopose.py Timeline (tools/tests/render/test_instruments_parity.py). */
export function stationView(S, state, t0, t) {
  const cy = S.cycle, dt = t - t0;
  const closure = !cy ? 0 : state === 'closing' ? smooth(dt / cy.close) : state === 'running' ? 1
    : state === 'opening' ? 1 - smooth(dt / cy.open) : 0;
  const progress = !cy ? 0 : state === 'running' ? Math.min(1, dt / cy.run) : ['opening', 'done'].includes(state) ? 1 : 0;
  const o = { state, closure: +closure.toFixed(4), progress: +progress.toFixed(4), since: +dt.toFixed(3) };
  if (cy && state === 'running') o.remaining = +Math.max(0, cy.run - dt).toFixed(2);
  if (S.result) {
    const k = state === 'running' ? smooth(progress) : ['opening', 'done'].includes(state) ? 1 : 0;
    o.bars = S.result.map((v) => +(v * k).toFixed(4));
  }
  return o;
}

/** The wall's design-build-test-learn lights at t, from the first incubator close, reader done and handler run. */
export function loopFlags(t, { testOn, readDone, buildOff }, C = INST) {
  const learn = readDone != null;
  return [learn && t - readDone >= C.designDelayS, buildOff == null, testOn != null && !learn, learn];
}

/**
 * `lab` = the sidecar lab block.  step(t, s) with s = {step, puck: {bottom, tilt_deg, pads, held}, grasp: [x, y, z]}
 * (mm); one transition per station per step.
 */
export function createInstruments(lab, opts = {}) {
  const C = { ...INST, ...opts };
  const d = lab.props[0].d;
  const st = lab.stations.map((s) => ({ s, state: s.start || 'idle', t0: 0, clearSince: null, armSince: null }));
  const events = [];
  let t = 0, testOn = null, readDone = null, buildOff = null;

  function go(x, state, now, k) {
    x.state = state;
    x.t0 = now;
    x.clearSince = null;
    x.armSince = null;
    events.push({ station: x.s.id, state, t: +now.toFixed(3), step: k });
    if (x.s.id === 'inc' && state === 'closing' && testOn == null) testOn = now;
    if (x.s.kind === 'reader' && state === 'done' && readDone == null) readDone = now;
  }

  function stepOne(x, now, s) {
    const { puck, grasp } = s, S = x.s, cy = S.cycle;
    if (!cy) {                                   // the liquid handler: done until the puck leaves, then busy
      if (x.state === 'done' && left(S, puck, C)) { if (buildOff == null) buildOff = now; go(x, 'running', now, s.step); }
      return;
    }
    const seated = seatedIn(S, puck, d, C), dt = now - x.t0;
    switch (x.state) {
      case 'idle':                               // seated and let go for a short dwell: `held` flickers at touch-down
        if (seated && !puck.held) {
          if (x.armSince == null) x.armSince = now;
          if (now - x.armSince >= C.armDwellS) go(x, 'armed', now, s.step);
        } else x.armSince = null;
        break;
      case 'armed': {
        if (!seated) { go(x, 'idle', now, s.step); break; }
        const far = Math.hypot(grasp[0] - S.nest.xy[0], grasp[1] - S.nest.xy[1]) >= cy.clear;
        if (puck.pads === 0 && far) {
          if (x.clearSince == null) x.clearSince = now;
          if (now - x.clearSince >= cy.dwell) go(x, 'closing', now, s.step);
        } else x.clearSince = null;
        break;
      }
      case 'closing': if (dt >= cy.close) go(x, 'running', now, s.step); break;
      case 'running': if (dt >= cy.run) go(x, 'opening', now, s.step); break;
      case 'opening': if (dt >= cy.open) go(x, 'done', now, s.step); break;
      case 'done': if (left(S, puck, C)) go(x, 'idle', now, s.step); break;
      default: break;
    }
  }

  function step(now, s) {
    t = now;
    for (const x of st) stepOne(x, now, s);
  }

  /** {t, stations: {id: {state, closure, progress, since, remaining?, bars?}}, loop: [design, build, test, learn]} */
  function snapshot() {
    return {
      t: +t.toFixed(3),
      stations: Object.fromEntries(st.map((x) => [x.s.id, stationView(x.s, x.state, x.t0, t)])),
      loop: loopFlags(t, { testOn, readDone, buildOff }, C),
    };
  }

  return {
    step, snapshot, events,
    state: (id) => st.find((x) => x.s.id === id)?.state ?? null,
    stations: st.map((x) => x.s.id),
  };
}

/**
 * The instruments' view of the sim after an mj_step: the puck's bottom centre (its body origin) and
 * tilt, the pads touching it, held (both pads, slow against the finger), the grasp site.  mm.
 */
export function puckProbe(mj, m, ix, lab, C = INST) {
  const P = lab.props[0], b = ix.body(P.body), finger = ix.fingerL, site = ix.site.grasp;
  if (b < 0) throw new Error(`model has no ${P.body}`);
  return (d, cs = contacts(d)) => {
    const sides = new Set();
    for (const [g1, g2] of cs) {
      const b1 = ix.geomBody[g1], b2 = ix.geomBody[g2];
      if (b1 !== P.body && b2 !== P.body) continue;
      const o = b1 === P.body ? b2 : b1;
      if (o.includes('finger_L')) sides.add('L');
      if (o.includes('finger_R')) sides.add('R');
    }
    const cv = d.cvel, X = d.xpos, R = d.xmat, sx = d.site_xpos;
    const rel = 1000 * Math.hypot(cv[6 * b + 3] - cv[6 * finger + 3], cv[6 * b + 4] - cv[6 * finger + 4], cv[6 * b + 5] - cv[6 * finger + 5]);
    const up = R[9 * b + 8];
    return {
      step: 0,
      puck: { bottom: [X[3 * b] * 1000, X[3 * b + 1] * 1000, X[3 * b + 2] * 1000], tilt_deg: Math.acos(up > 1 ? 1 : up < -1 ? -1 : up) * R2D,
        pads: sides.size, held: sides.size === 2 && rel < C.heldRelMmS, rel_mm_s: rel },
      grasp: [sx[3 * site] * 1000, sx[3 * site + 1] * 1000, sx[3 * site + 2] * 1000],
    };
  };
}
