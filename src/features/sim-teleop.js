/* Teleop for the Sim tab: held keys -> ctrl.  Base velocity is robot-frame, slew-limited and
   rotated into the world slides; arm joints ramp or jog at 60 deg/s inside their limits, and the
   arm command is a 0.25 s moving average of that (speed ramps in and out, every jog ends where it
   would have); the jaw is rate-limited at 40 deg/s.  Writes ctrl only. */

import { indexModel, JointRamp, RateLimit, clamp, LIMIT_BAND_DEG } from './sim-ik.js';
import { LAB } from './sim-lab.js';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
export const TELEOP = { slow: 2 / 3, jogDegS: 60, jogRampS: 0.25, jawDegS: 40, aMax: LAB.driveAMax, alphaMax: LAB.driveAlphaMax, limitMarginDeg: LIMIT_BAND_DEG };

/* The Sim tab's key table (physical codes; ui/sim-keys.js binds it, tools/sim/teleop.mjs scripts it).
   `hold`: a held input the teleop reads each step; otherwise `action` fires once per press. */
export const SIM_KEYS = [
  { id: 'sim.fwd', keys: 'W', code: 'KeyW', hold: 'fwd', label: 'forward', g: 'base' },
  { id: 'sim.left', keys: 'A', code: 'KeyA', hold: 'left', label: 'left', g: 'base' },
  { id: 'sim.back', keys: 'S', code: 'KeyS', hold: 'back', label: 'back', g: 'base' },
  { id: 'sim.right', keys: 'D', code: 'KeyD', hold: 'right', label: 'right', g: 'base' },
  { id: 'sim.turn-l', keys: 'Q', code: 'KeyQ', hold: 'turnL', label: 'turn left', g: 'base' },
  { id: 'sim.turn-r', keys: 'E', code: 'KeyE', hold: 'turnR', label: 'turn right', g: 'base' },
  { id: 'sim.fast', keys: 'Shift', code: ['ShiftLeft', 'ShiftRight'], display: true, label: 'fast', g: 'base' },
  { id: 'sim.joint-prev', keys: '←', code: 'ArrowLeft', action: 'joint', args: -1, label: 'joint', g: 'arm' },
  { id: 'sim.joint-next', keys: '→', code: 'ArrowRight', action: 'joint', args: 1, label: 'joint', g: 'arm', hideInHelp: true },
  { id: 'sim.jog-up', keys: '↑', code: 'ArrowUp', hold: 'up', label: 'jog', g: 'arm' },
  { id: 'sim.jog-down', keys: '↓', code: 'ArrowDown', hold: 'down', label: 'jog', g: 'arm', hideInHelp: true },
  { id: 'sim.recentre', keys: '0', code: ['Digit0', 'Numpad0'], action: 'recentre', label: 'recentre', g: 'arm' },
  { id: 'sim.gripper', keys: 'F', code: 'KeyF', action: 'gripper', label: 'grip', g: 'arm' },
  { id: 'sim.home', keys: 'H', code: 'KeyH', action: 'home', label: 'home', g: 'arm' },
  { id: 'sim.preset', keys: 'P', code: 'KeyP', action: 'preset', label: 'next pose', g: 'arm' },
  { id: 'sim.stop', keys: 'Space', code: 'Space', action: 'stop', label: 'stop', g: 'run' },
  { id: 'sim.reset', keys: 'R', code: 'KeyR', action: 'reset', label: 'reset', g: 'run' },
  { id: 'sim.release', keys: 'Esc', code: 'Escape', action: 'release', label: 'release keys', g: 'run' },
];

/** Held inputs: fwd back left right turnL turnR up down, plus `fast`. */
export function createTeleop(mj, m, d, sidecar, opts = {}) {
  const C = { ...TELEOP, ...opts };
  const ix = indexModel(mj, m, sidecar);
  const n = ix.arm.length;
  const range = ix.armRange.map(([a, b]) => [a * R2D, b * R2D]);
  const presets = Object.keys(sidecar.presets || {});
  const jawMax = sidecar.jaw_max_deg || 0;
  const hasBase = ix.driveAct.every((a) => a >= 0);
  const stockGrip = ix.jawAct < 0 ? ix.arm.findIndex((a) => /gripper/.test(a)) : -1;   // an arm servo is the gripper
  const held = new Set();
  let fast = false, sel = Math.max(0, Math.min(1, n - 1)), presetAt = -1;
  let ramp = new JointRamp(new Array(n).fill(0), C.jogDegS);
  const jaw = new RateLimit(0, C.jawDegS);
  let jawGoal = 0, drive = [0, 0, 0], armCmd = new Array(n).fill(0);
  /* the last N raw arm commands; their mean is sent */
  const N = Math.max(1, Math.round(C.jogRampS / m.opt.timestep));
  let hist = [], head = 0;
  const fill = (q) => { hist = Array.from({ length: N }, () => [...q]); head = 0; };
  const smooth = () => hist[0].map((_, i) => { let a = 0; for (const h of hist) a += h[i]; return a / N; });
  fill(new Array(n).fill(0));

  const armNow = () => { const q = d.qpos; return ix.armAdr.map((a) => q[a] * R2D); };
  const clampJ = (i, v) => clamp(v, range[i][0], range[i][1]);

  /** Take the current MuJoCo state as the command (after a reset or a pose write). */
  function sync() {
    ramp = new JointRamp(armNow(), C.jogDegS);
    fill(ramp.q);
    const j = ix.jawAdr >= 0 ? d.qpos[ix.jawAdr] * R2D : 0;
    jaw.value = j;
    jawGoal = j;
    drive = [0, 0, 0];
  }

  function goTo(q) { ramp.to(q.map((v, i) => clampJ(i, v))); }
  function preset(name) {
    const p = sidecar.presets[name];
    if (!p) return null;
    goTo(ix.arm.map((a, i) => (a in p ? p[a] : ramp.target[i])));
    presetAt = presets.indexOf(name);
    return name;
  }

  function step(dt) {
    const v = sidecar.drive.v_max_mps * (fast ? 1 : C.slow), w = sidecar.drive.w_max_radps * (fast ? 1 : C.slow);
    const ax = (a, b) => (held.has(a) ? 1 : 0) - (held.has(b) ? 1 : 0);
    const vx = ax('right', 'left') * v, vy = ax('fwd', 'back') * v, wz = ax('turnL', 'turnR') * w;
    const yaw = hasBase ? d.qpos[ix.baseAdr[2]] : 0, c = Math.cos(yaw), s = Math.sin(yaw);
    const want = [c * vx - s * vy, s * vx + c * vy, wz];
    const dv = C.aMax * dt, dw = C.alphaMax * dt;
    drive = drive.map((p, i) => p + clamp(want[i] - p, i < 2 ? -dv : -dw, i < 2 ? dv : dw));

    const jog = n ? ax('up', 'down') : 0;
    if (jog) {
      const q = clampJ(sel, ramp.q[sel] + jog * C.jogDegS * dt);
      ramp.q[sel] = q;
      ramp.target[sel] = q;
    }
    const raw = ramp.step(dt);
    if (dt > 0) { hist[head] = [...raw]; head = (head + 1) % N; }
    const q = smooth();
    armCmd = q;
    const u = d.ctrl;
    for (let i = 0; i < n; i++) u[ix.armAct[i]] = q[i] * D2R;
    if (ix.jawAct >= 0) u[ix.jawAct] = jaw.step(jawGoal, dt) * D2R;
    if (hasBase) for (let i = 0; i < 3; i++) u[ix.driveAct[i]] = drive[i];
  }

  return {
    ix, hasBase, joints: ix.arm, presets,
    held, step, sync,
    set fast(v) { fast = !!v; },
    get fast() { return fast; },
    get selected() { return sel; },
    get jawOpen() { return stockGrip >= 0 ? ramp.target[stockGrip] < (range[stockGrip][0] + range[stockGrip][1]) / 2 : jawGoal > jawMax / 2; },
    select(delta) { if (n) sel = (sel + delta + n) % n; return ix.arm[sel] || null; },
    recentre() { if (!n) return; const t = [...ramp.target]; t[sel] = clampJ(sel, 0); ramp.to(t); },
    gripper() {
      if (stockGrip >= 0) {                       // the stock servo: less is open
        const [lo, hi] = range[stockGrip], t = [...ramp.target], open = t[stockGrip] > (lo + hi) / 2;
        t[stockGrip] = open ? lo : hi;
        ramp.to(t);
        return open;
      }
      jawGoal = jawGoal > jawMax / 2 ? 0 : jawMax;
      return jawGoal > 0;
    },
    home() { return preset(presets.includes('stowed') ? 'stowed' : presets[0]); },
    nextPreset() { return presets.length ? preset(presets[(presetAt + 1) % presets.length]) : null; },
    stop() { drive = [0, 0, 0]; ramp.to(ramp.q); held.clear(); },
    command: () => ({ arm: [...armCmd], jaw: jaw.value, drive: [...drive] }),
    limits: () => range.map((r) => [...r]),
  };
}
