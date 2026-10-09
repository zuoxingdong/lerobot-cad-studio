/* The slider every joint and knob uses.  Needs ui/dom.js. */

import { el } from './dom.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** The one slider: `.track > i + b`, pointer and keyboard, `role="slider"` with live aria values. */
export function makeTrack({ min, max, step = 1, value = 0, onInput, onCommit, label }) {
  const track = el('span', 'track');
  const fill = document.createElement('i');
  const knob = document.createElement('b');
  track.append(fill, knob);
  track.tabIndex = 0;
  track.setAttribute('role', 'slider');
  track.setAttribute('aria-label', label || '');
  let v = value;
  let dragging = false;

  function paint() {
    const t = max === min ? 0 : (v - min) / (max - min);
    const pct = (clamp(t, 0, 1) * 100).toFixed(2) + '%';
    fill.style.width = pct;
    knob.style.left = pct;
    track.setAttribute('aria-valuemin', String(min));
    track.setAttribute('aria-valuemax', String(max));
    track.setAttribute('aria-valuenow', String(v));
  }
  function snap(x) {
    const r = track.getBoundingClientRect();
    const t = r.width ? clamp((x - r.left) / r.width, 0, 1) : 0;
    const raw = min + t * (max - min);
    return +(Math.round(raw / step) * step).toFixed(6);
  }
  track.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    track.setPointerCapture(e.pointerId);
    dragging = true;
    v = snap(e.clientX); paint(); if (onInput) onInput(v);
  });
  track.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    v = snap(e.clientX); paint(); if (onInput) onInput(v);
  });
  const end = () => { if (!dragging) return; dragging = false; if (onCommit) onCommit(v); };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
  track.addEventListener('keydown', (e) => {
    const big = e.shiftKey ? 10 : 1;
    let d = 0;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') d = step * big;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') d = -step * big;
    else if (e.key === 'Home') { v = min; d = 0; }
    else if (e.key === 'End') { v = max; d = 0; }
    else return;
    e.preventDefault();
    e.stopPropagation();
    v = clamp(+(v + d).toFixed(6), min, max);
    paint(); if (onInput) onInput(v); if (onCommit) onCommit(v);
  });
  paint();
  return {
    el: track,
    set(next, opts = {}) { v = clamp(next, min, max); paint(); if (opts.bad !== undefined) track.classList.toggle('err', !!opts.bad); },
    get value() { return v; },
    setBad(bad) { track.classList.toggle('err', !!bad); }
  };
}
