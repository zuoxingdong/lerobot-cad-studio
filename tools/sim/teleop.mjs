// Scripted teleop: a JSON timeline of key presses played into the Sim tab's teleop
// (features/sim-teleop.js) through the Sim tab's own key table (SIM_KEYS there).  Writes ctrl only.
//   {"timeline": [{"label": "drive", "keys": ["ShiftLeft", "KeyW"], "hold": 2.5}, {"keys": ["KeyF"], "wait": 0.8}]}
// An entry presses `keys` together, releases them after `hold` s (none: a tap), then waits `wait` s;
// the next entry starts after that, or at `at` s.  `label` names the caption from there on.
import { SIM_KEYS, createTeleop } from '../../src/features/sim-teleop.js';
import { contacts } from '../../src/features/sim-engine.js';
import { indexModel } from '../../src/features/sim-ik.js';
import { createInstruments, puckProbe, seatedIn } from '../../src/features/sim-instruments.js';

export const DT = 0.002;
const NOT_SCRIPTABLE = { reset: 'R resets the scene: a ctrl log cannot replay a state reset' };

/** The Sim tab's binding for a physical key code, or null. */
export function bindingOf(code) {
  return SIM_KEYS.find((b) => [].concat(b.code).includes(code)) || null;
}

/** timeline -> {events: [{step, code, down}], labels: [{step, label}], keys: [{step_start, step_end, codes}], steps} */
export function compileScript(doc, dt = DT) {
  const tl = Array.isArray(doc) ? doc : doc && doc.timeline;
  if (!Array.isArray(tl) || !tl.length) throw new Error('teleop script: no "timeline" array');
  const S = (s) => Math.round(s / dt);
  const events = [], labels = [], keys = [];
  let t = 0, seq = 0;
  tl.forEach((e, i) => {
    const where = `timeline[${i}]`;
    const num = (k) => { const v = e[k] ?? 0; if (!Number.isFinite(v) || v < 0) throw new Error(`${where}.${k}: want seconds >= 0`); return v; };
    const hold = num('hold'), wait = num('wait');
    if (e.at != null) t = num('at');
    const codes = [].concat(e.keys || []);
    for (const c of codes) {
      const b = bindingOf(c);
      if (!b) throw new Error(`${where}: "${c}" is not a Sim tab key (KeyboardEvent.code, e.g. KeyW, ArrowUp, ShiftLeft)`);
      if (NOT_SCRIPTABLE[b.action]) throw new Error(`${where}: ${NOT_SCRIPTABLE[b.action]}`);
      if ((b.hold || b.display) && !hold) throw new Error(`${where}: "${c}" is a held key: give it a "hold"`);
    }
    const s0 = S(t), s1 = S(t + hold);
    if (e.label) labels.push({ step: s0, label: String(e.label) });
    for (const code of codes) events.push({ step: s0, code, down: true, rank: 1, seq: seq++ });
    for (const code of codes) events.push({ step: s1, code, down: false, rank: s1 === s0 ? 2 : 0, seq: seq++ });
    if (codes.length) keys.push({ step_start: s0, step_end: s1, codes });
    t += hold + wait;
  });
  /* per step: releases, then presses, then the releases of taps, each in file order */
  events.sort((a, b) => a.step - b.step || a.rank - b.rank || a.seq - b.seq);
  labels.sort((a, b) => a.step - b.step);
  return { events: events.map(({ step, code, down }) => ({ step, code, down })), labels, keys, steps: Math.max(1, S(t)) };
}

/** Key presses -> teleop calls, as ui/sim-keys.js + ui/sim-page.js do them in the browser. */
export function keyDriver(tele) {
  const down = new Map(), shift = new Set();
  const releaseAll = () => { down.clear(); shift.clear(); tele.held.clear(); tele.fast = false; };
  const actions = {
    joint: (d) => tele.select(d),
    recentre: () => tele.recentre(),
    gripper: () => tele.gripper(),
    home: () => tele.home(),
    preset: () => tele.nextPreset(),
    stop: () => tele.stop(),
    release: releaseAll,
  };
  function keyDown(code) {
    const b = bindingOf(code);
    if (b.display) { shift.add(code); tele.fast = true; return; }           // Shift: e.shiftKey
    if (b.hold) {
      if (!down.has(code)) { down.set(code, b.hold); tele.held.add(b.hold); }
      return;
    }
    actions[b.action](b.args);
  }
  function keyUp(code) {
    const b = bindingOf(code);
    if (b.display) { shift.delete(code); tele.fast = shift.size > 0; return; }
    const h = down.get(code);
    if (!h) return;
    down.delete(code);
    if (![...down.values()].includes(h)) tele.held.delete(h);
  }
  return { keyDown, keyUp, actions };
}

/* the puck and the instruments, stepped after every mj_step as the Sim tab does */
function labWatch(mj, m, d, sidecar) {
  const lab = sidecar.lab;
  if (!lab || lab.schema !== 'rps/lab@2' || !lab.props.length) return null;
  const ix = indexModel(mj, m, sidecar), probe = puckProbe(mj, m, ix, lab), inst = createInstruments(lab);
  const z0 = lab.props[0].start_bottom[2], d0 = lab.props[0].d;
  let last = probe(d);
  return {
    inst,
    step(k) { last = probe(d, contacts(d)); last.step = k; inst.step(d.time, last); },
    state() {
      const p = last.puck;
      return { puck: { bottom_mm: p.bottom.map((v) => +v.toFixed(2)), lifted_mm: +(p.bottom[2] - z0).toFixed(2), tilt_deg: +p.tilt_deg.toFixed(2),
        both_pads: p.pads === 2, held: p.held, seated_at: lab.stations.find((S) => seatedIn(S, p, d0))?.id ?? null },
      instruments: Object.fromEntries(inst.stations.map((id) => [id, inst.state(id)])) };
    },
  };
}

/**
 * Play a compiled script from mj_resetData + mj_forward.  `onRow(ctrl)` gets each float32 ctrl row
 * before its mj_step (the run-lab.mjs log format).  Returns the phases (one per label, with the
 * puck and instrument states at its end), the key intervals (an arrow's with the joint it jogged)
 * and the instrument events.
 */
export function playScript(mj, m, d, sidecar, script, { onRow = () => {}, onStep = () => {} } = {}) {
  mj.mj_resetData(m, d);
  mj.mj_forward(m, d);
  const tele = createTeleop(mj, m, d, sidecar);
  tele.sync();
  tele.step(0);
  const drv = keyDriver(tele), watch = labWatch(mj, m, d, sidecar);
  const ev = script.events, marks = script.labels.length && script.labels[0].step === 0 ? script.labels : [{ step: 0, label: 'start' }, ...script.labels];
  const phases = [];
  const jogs = new Map();                                      // step -> the joint an arrow jogs
  let e = 0, li = 0, cur = null;
  const close = (k) => { if (cur) phases.push({ ...cur, step_end: k, t_end: +(k * DT).toFixed(3), ...(watch ? watch.state() : {}) }); };
  for (let k = 0; k < script.steps; k++) {
    while (li < marks.length && marks[li].step <= k) {
      close(k);
      cur = { phase: marks[li].label, label: marks[li].label, step_start: k, t_start: +(k * DT).toFixed(3) };
      li++;
    }
    for (; e < ev.length && ev[e].step <= k; e++) {
      const { code, down } = ev[e];
      if (down && /^Arrow(Up|Down)$/.test(code)) jogs.set(k, tele.joints[tele.selected]);
      (down ? drv.keyDown : drv.keyUp)(code);
    }
    tele.step(DT);
    const u = d.ctrl;
    for (let i = 0; i < m.nu; i++) u[i] = Math.fround(u[i]);     // the log holds exactly what the plant sees
    onRow(u);
    mj.mj_step(m, d);
    if (watch) watch.step(k + 1);
    onStep(k, tele, watch);
  }
  close(script.steps);
  const keys = script.keys.map((x) => (jogs.has(x.step_start) ? { ...x, joint: jogs.get(x.step_start) } : x));
  return { phases, keys, tele, events: watch ? watch.inst.events : [], snapshot: watch ? watch.inst.snapshot() : null };
}
