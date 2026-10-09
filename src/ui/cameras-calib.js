/* The camera ⋯ dialogs: Lens… (the package's lens alternatives and the hFOV) and Calibrate
   tilt… (a 3-step guide and the measured offset).  A measured offset is DESIGN state
   (`design.cameras.<id>.calib`) and never touches a part parameter.  Needs ui/dialogs.js. */

import { openDialog } from './dialogs.js';
import { el } from './dom.js';

const DEG = '°';
/** beyond ±90° the number stops being a tilt */
export const CALIB_LIMIT_DEG = 90;
const fmtDeg = (v) => (v > 0 ? '+' : '') + (Math.round(v * 10) / 10) + DEG;
const REJECTED = 'not a number: the last measurement is kept';

/** Lens…: pick a lens the package lists, or type the horizontal field of view. */
export function openLensDialog({ cams, store, model, id, done }) {
  const cam = cams.get(id);
  const raw = ((model.manifest || {}).cameras || []).find((c) => c.id === id) || {};
  const range = raw.hfov_range || [30, 140];
  const d = openDialog({ title: `${(cam && cam.label) || id} lens` });
  const set = (deg) => {
    const v = Math.max(range[0], Math.min(range[1], deg));
    cams.setHfov(id, v);
    store.set('cameras.' + id + '.hfov_deg', v, { label: 'hFOV ' + id, coalesce: true });
    input.value = String(Math.round(v * 10) / 10);
    if (done) done();
  };
  const list = el('div', 'lenslist');
  for (const a of raw.alternatives || []) {
    const b = el('button', 'btn sm', `${a.label} · ${a.hfov_deg}${DEG}`);
    b.type = 'button';
    b.title = a.note || '';
    b.onclick = () => set(a.hfov_deg);
    list.appendChild(b);
  }
  const row = el('label', 'calin');
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'v';
  input.step = '0.1';
  input.min = String(range[0]);
  input.max = String(range[1]);
  input.value = String(Math.round((cam ? cam.hfov_deg : 0) * 10) / 10);
  input.setAttribute('aria-label', 'Horizontal field of view, degrees');
  input.onchange = () => { const v = Number(input.value); if (Number.isFinite(v)) set(v); };
  row.append(el('span', 'k', 'Horizontal FOV'), input, el('span', 'u', DEG));
  if (list.children.length) d.body.append(list);
  d.body.append(row);
  const ok = el('button', 'btn accent', 'Done');
  ok.onclick = d.close;
  d.footer.append(el('div', 'sp'), ok);
  input.focus();
  return d;
}

/**
 * Calibrate tilt…: the measured tilt minus the design tilt.  A typed number moves the camera
 * this page draws; blank forgets it; text that is not a number keeps the last value.
 */
export function openCalibDialog(h) {
  const d = openDialog({ title: `Calibrate ${h.label} tilt` });
  const steps = el('ol', 'steps');
  for (const s of ['Put an inclinometer on the camera head.', 'Read its tilt at the stowed pose.',
    'Type the reading minus the design tilt.']) steps.appendChild(el('li', null, s));
  const row = el('div', 'calin');
  const input = document.createElement('input');
  input.type = 'number';
  input.step = '0.1';
  input.min = String(-CALIB_LIMIT_DEG);
  input.max = String(CALIB_LIMIT_DEG);
  input.className = 'v';
  input.placeholder = '0.0';
  input.title = `degrees, ±${CALIB_LIMIT_DEG}; positive tips the lens down`;
  input.setAttribute('aria-label', h.label + ' measured tilt offset, degrees');
  const cal = h.cams.getCalib(h.id);
  input.value = cal && cal.tilt_deg ? String(Math.round(cal.tilt_deg * 10) / 10) : '';
  const clearBtn = el('button', 'btn sm ghost', 'Clear');
  clearBtn.type = 'button';
  clearBtn.onclick = () => clear();
  row.append(el('span', 'k', 'Offset'), input, el('span', 'u', DEG), clearBtn);
  d.body.append(steps, row);
  const ok = el('button', 'btn accent', 'Done');
  ok.onclick = () => { if (commit()) d.close(); };
  d.footer.append(el('div', 'sp'), ok);

  const bad = () => { const b = !!(input.validity && input.validity.badInput); input.classList.toggle('bad', b); return b; };
  input.oninput = bad;
  input.onchange = () => commit();
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (commit()) d.close(); } };

  function say(msg, level) { if (h.status) h.status(msg, level); }
  function commit() {
    if (bad()) { say(REJECTED, 'warn'); return false; }
    const txt = String(input.value == null ? '' : input.value).trim().replace(',', '.');
    if (!txt) { clear(); return true; }
    let v = Number(txt);
    if (!Number.isFinite(v)) { input.classList.add('bad'); say(REJECTED, 'warn'); return false; }
    input.classList.remove('bad');
    if (Math.abs(v) > CALIB_LIMIT_DEG) {
      v = Math.max(-CALIB_LIMIT_DEG, Math.min(CALIB_LIMIT_DEG, v));
      input.value = String(v);
      say(`the offset is limited to ±${CALIB_LIMIT_DEG}${DEG}: kept ${fmtDeg(v)}`, 'warn');
    }
    h.setValue(h.id, { tilt_deg: v });
    if (v && h.mode() !== 'installed') h.setMode('installed');
    if (h.refresh) h.refresh();
    return true;
  }
  function clear() {
    h.cams.resetCalib(h.id);
    h.store.remove(['cameras', h.id, 'calib'], { label: 'camera calibration' });
    input.value = '';
    input.classList.remove('bad');
    if (!h.ids.some((x) => h.cams.hasCalib(x)) && h.mode() !== 'design') h.setMode('design', { force: true });
    if (h.refresh) h.refresh();
  }
  input.focus();
  return { dialog: d, input, commit, clear };
}
