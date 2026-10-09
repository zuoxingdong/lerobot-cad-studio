/* "Pose ▾" in the viewport header: the arm presets, and "Custom…" for the joint sliders (the
   jaw among them, in mm).  One persistent popover under its button; Esc or a click outside
   closes it.  Needs ui/dom.js, ui/icons.js, ui/track.js and features/joints.js. */

import { icon } from './icons.js';
import { el } from './dom.js';
import { makeTrack } from './track.js';
import { motionJoints, hasArmJoints, applicablePresets } from '../features/joints.js';

const cap = (s) => String(s || '').replace(/^\w/, (m) => m.toUpperCase());
const fmtVal = (v, unit) => {
  if (unit === 'mm') return (Math.abs(v) < 0.05 ? '0' : v.toFixed(1)) + ' mm';
  return (Math.abs(v) < 0.05 ? '0' : v.toFixed(Math.abs(v) < 10 ? 1 : 0)) + '°';
};

/**
 * @param {HTMLElement} head   the viewport header the button goes in
 * @param {object} ctx  {model, store, slots, presets(), activePreset(), presetPhysics(), on:{setJoint, preset, status}}
 */
export function mountPose(head, ctx) {
  const btn = el('button', 'btn sm ghost posebtn');
  btn.type = 'button';
  const btnText = el('span', 'tl', 'Pose');
  btn.append(btnText, icon('chevron-down', 'i14'));
  btn.setAttribute('aria-haspopup', 'dialog');
  const pop = el('div', 'posepop');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Pose');
  pop.hidden = true;
  head.append(btn);
  document.body.appendChild(pop);

  const presetsRow = el('div', 'presets');
  const custom = el('button', 'btn sm ghost custom');
  custom.type = 'button';
  custom.append(document.createTextNode('Custom…'));
  const joints = el('div', 'joints');
  joints.hidden = true;
  pop.append(presetsRow, custom, joints);
  custom.onclick = () => { joints.hidden = !joints.hidden; custom.classList.toggle('on', !joints.hidden); place(); };

  const tracks = new Map();
  let jointKeys = '';
  let defs = [];

  function build() {
    presetsRow.innerHTML = '';
    const arm = hasArmJoints(ctx.model, ctx.store.getState(), ctx.slots);
    if (arm) {
      for (const p of applicablePresets(ctx.model, ctx.presets())) {
        const id = p.name || p.id;
        const b = el('button', 'btn sm', cap(p.label || id));
        b.type = 'button';
        b.dataset.preset = id;
        b.onclick = () => { ctx.on.preset(id); render(); };
        presetsRow.appendChild(b);
      }
    }
    presetsRow.hidden = !presetsRow.children.length;
    joints.innerHTML = '';
    tracks.clear();
    defs = motionJoints(ctx.model, ctx.store.getState(), ctx.slots);
    for (const j of defs) {
      const row = el('div', 'jrow');
      const val = el('span', 'v', '0');
      const t = makeTrack({
        min: j.min, max: j.max, step: j.step, label: j.label,
        value: j.toDisplay(ctx.model.getJoints()[j.name] || 0),
        onInput: (v) => { val.textContent = fmtVal(v, j.unit); ctx.on.setJoint(j.name, j.fromDisplay(v), false); },
        onCommit: (v) => ctx.on.setJoint(j.name, j.fromDisplay(v), true),
      });
      const nm = el('span', 'n', j.label);
      nm.title = `${j.name} · ${+Number(j.min).toFixed(2)}…${+Number(j.max).toFixed(2)} ${j.unit}`;
      row.append(nm, t.el, val);
      joints.appendChild(row);
      tracks.set(j.name, { track: t, val, unit: j.unit, to: j.toDisplay });
    }
    custom.hidden = !defs.length;
    btn.hidden = !defs.length && presetsRow.hidden;
  }

  function render() {
    const want = motionJoints(ctx.model, ctx.store.getState(), ctx.slots).map((j) => j.name).join('|');
    if (want !== jointKeys) { jointKeys = want; build(); }
    const q = ctx.model.getJoints();
    for (const [j, rec] of tracks) {
      const v = rec.to(q[j] || 0);
      rec.track.set(v);
      rec.val.textContent = fmtVal(v, rec.unit);
    }
    const active = ctx.activePreset ? ctx.activePreset() : null;
    const p = ctx.presets().find((x) => (x.name || x.id) === active);
    btnText.textContent = 'Pose: ' + (p ? cap(p.label || active) : 'Custom');
    const verdicts = ctx.presetPhysics ? ctx.presetPhysics() : null;
    for (const b of presetsRow.querySelectorAll('[data-preset]')) {
      b.classList.toggle('on', b.dataset.preset === active);
      const row = verdicts && verdicts.get ? verdicts.get(b.dataset.preset) : null;
      const bad = !!(row && row.ok === false);
      const dot = b.querySelector('.dot');
      if (bad && !dot) b.appendChild(el('span', 'dot warn'));
      else if (!bad && dot) dot.remove();
      b.title = bad ? (row.tooltip || 'this pose collides') : '';
    }
  }

  function place() {
    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth || 300;
    pop.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
    pop.style.top = (r.bottom + 4) + 'px';
  }
  function open(on) {
    pop.hidden = !on;
    btn.classList.toggle('on', !!on);
    if (on) { render(); place(); }
  }
  btn.onclick = () => open(pop.hidden);
  const onDown = (e) => { if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) open(false); };
  document.addEventListener('mousedown', onDown, true);

  /** a blocked joint move: flash the track red and say what stopped it */
  function flashBlocked(joint, by) {
    const rec = tracks.get(joint);
    if (rec) { rec.track.setBad(true); setTimeout(() => rec.track.setBad(false), 500); }
    const d = defs.find((j) => j.name === joint);
    ctx.on.status(`blocked · ${d ? d.label : joint} hits ${by || 'the robot'}`, 'warn');
  }

  render();
  return {
    el: pop, button: btn, render, flashBlocked, open,
    get isOpen() { return !pop.hidden; },
    /** Esc closes the popover first */
    escape() { if (pop.hidden) return false; open(false); return true; },
    destroy() { document.removeEventListener('mousedown', onDown, true); pop.remove(); btn.remove(); },
  };
}
