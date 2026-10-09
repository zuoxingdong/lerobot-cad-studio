/* The parametric knobs of a generated part (the Pi case), in the inspector's Shape section:
   one row per parameter, a toggle for a 0/1 one, number + slider for the rest.
   Needs features/ and the shared record ui/inspector.js hands in. */

import { icon } from './icons.js';
import { makeTrack } from './track.js';
import { el } from './dom.js';
import { paramDefs, paramValues, isModified } from '../features/parts.js';

/** how long an out-of-range entry stays red before the clamped value clears it */
const FLASH_MS = 1200;

export function makeTweak(ctx, S) {
  /** Shape (parametric): the knobs, grouped, and Reset */
  function paramSection(c, st, host) {
    const defs = paramDefs(c.id);
    if (!defs.length || ctx.selection().length > 1) return false;
    const values = paramValues(st, c.id);
    let group = null;
    for (const d of defs) {
      if ((d.group || '') !== group && d.group) host.appendChild(el('div', 'sub', d.group));
      group = d.group || '';
      host.appendChild(isToggle(d) ? toggleRow(c, d, values) : knobRow(c, d, values));
    }
    const tail = el('div', 'propchips');
    const reset = el('button', 'btn sm', 'Reset');
    reset.disabled = !isModified(st, c.id);
    reset.title = 'every knob back to the package value';
    reset.onclick = () => ctx.on.resetParams(c.id);
    S.resetBtn = reset;
    tail.append(reset);
    host.appendChild(tail);
    return true;
  }

  const isToggle = (d) => d.min === 0 && d.max === 1 && (d.step || 1) === 1;
  function toggleRow(c, d, values) {
    const row = el('label', 'chk knobt');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!values[d.key];
    cb.onchange = () => { ctx.on.setParam(c.id, d.key, cb.checked ? 1 : 0, true); S.schedule(c, true); };
    const box = document.createElement('i');
    box.appendChild(icon('check', 'i12'));
    row.append(cb, box, document.createTextNode(d.label));
    row.title = d.title || d.label;
    return row;
  }

  function knobRow(c, d, values, apply) {
    const k = el('div', 'knob');
    const top = el('div', 'top');
    const name = el('span', 'n', d.label);
    name.title = (d.title || d.label) + ' · ↑↓ nudge, ⇧ ×10';
    const num = document.createElement('input');
    num.className = 'num-in';
    num.type = 'text';
    num.inputMode = 'decimal';
    num.value = S.fmt(values[d.key], d.step);
    num.setAttribute('aria-label', d.label);
    const unit = el('span', 'unit', d.unit || '');
    top.append(name, num, unit);

    const set = apply || ((key, v, commit) => ctx.on.setParam(c.id, key, v, commit));
    let last = values[d.key];
    let flash = null;                      // the "that was out of range" timer

    const t = makeTrack({
      min: d.min, max: d.max, step: d.step || 1, value: values[d.key], label: d.label,
      onInput: (v) => { last = v; num.value = S.fmt(v, d.step); num.classList.remove('bad'); set(d.key, v, false); S.schedule(c); },
      onCommit: (v) => { last = v; set(d.key, v, true); S.schedule(c, true); }
    });
    num.oninput = () => { if (Number.isFinite(parseNum(num.value))) num.classList.remove('bad'); };
    num.onchange = () => {
      const v = parseNum(num.value);
      if (!Number.isFinite(v)) {
        /* garbage stays on screen in red so it can be corrected; the value does not move */
        num.classList.add('bad');
        t.setBad(true);
        num.title = 'not a number — use 12.5 or 12,5';
        return;
      }
      num.title = '';
      /* OUT OF RANGE IS A FLASH, NOT A STATE.  The clamp writes a legal number into the
         field, so leaving `bad` on marks a valid value invalid until the next edit; show the
         rejection, then clear it once the clamped number is what is on screen. */
      const bad = v < d.min || v > d.max;
      const cl = Math.max(d.min, Math.min(d.max, v));
      num.classList.toggle('bad', bad);
      t.setBad(bad);
      if (bad) {
        num.title = `${S.fmt(v, d.step)} is outside ${S.fmt(d.min, d.step)} … ${S.fmt(d.max, d.step)} — clamped`;
        clearTimeout(flash);
        flash = setTimeout(() => {
          if (!num.isConnected || parseNum(num.value) !== cl) return;
          num.classList.remove('bad');
          t.setBad(false);
        }, FLASH_MS);
      }
      last = cl;
      num.value = S.fmt(cl, d.step);
      t.set(cl);
      set(d.key, cl, true);
      S.schedule(c, true);
    };
    num.onkeydown = (e) => {
      const big = e.shiftKey ? 10 : 1;
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const from = parseNum(num.value);
      const base = Number.isFinite(from) ? from : last;
      const v = Math.max(d.min, Math.min(d.max, base + (e.key === 'ArrowUp' ? 1 : -1) * (d.step || 1) * big));
      last = v;
      num.classList.remove('bad');
      num.value = S.fmt(v, d.step);
      t.set(v);
      set(d.key, v, true);
      S.schedule(c, true);
    };
    k.append(top, t.el);
    return k;
  }

  /**
   * A number out of one of the panel's `type="text"` fields.
   *
   * `parseFloat` reads "12,5" as 12 — silently, and wrong by half a millimetre — in every
   * comma-decimal locale, so both separators are accepted here: a single comma is the
   * decimal point, several commas are thousands separators, and the two mixed spellings
   * ("1,234.5" and "1.234,5") are resolved by whichever comes last.  Anything else is
   * `NaN`, and the caller paints the field red instead of guessing.
   */
  function parseNum(text) {
    let t = String(text == null ? '' : text).trim().replace(/[\s\u00a0']/g, '');
    if (!t) return NaN;
    const comma = t.lastIndexOf(','), dot = t.lastIndexOf('.');
    if (comma >= 0 && dot >= 0) {
      t = comma > dot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
    } else if (comma >= 0) {
      t = (t.match(/,/g) || []).length > 1 ? t.replace(/,/g, '') : t.replace(',', '.');
    }
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(t)) return NaN;
    return parseFloat(t);
  }

  return { paramSection };
}
