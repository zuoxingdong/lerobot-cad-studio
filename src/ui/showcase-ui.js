/* The showcase's DOM: title and end cards with the load progress, the lower-third captions, the run
   clock, inset labels, and the control bar (play, scrubber with chapter marks, free camera, robot
   cameras, quality, back to the studio). No three.js here. */

const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const fmt = (t) => t.toFixed(1) + ' s';
const QUALITY = ['auto', 'high', 'medium', 'low'];

/**
 * @param {HTMLElement} root @param {object} edit the run's edit block @param {object} on handlers:
 *   play(), seek(t), chapter(dir), free(), cams(), quality(name)
 */
export function buildUi(root, edit, duration, on) {
  root.classList.add('sc');
  const canvas = h('canvas', 'sc-canvas');
  const fade = h('div', 'sc-fade');
  const labels = h('div', 'sc-labels');
  const scrim = h('div', 'sc-scrim');                   // the film's caption scrim, a little taller over the bar
  const cap = h('div', 'sc-cap');
  const capK = h('div', 'sc-cap-k'), capT = h('div', 'sc-cap-t'), capL = h('div', 'sc-cap-l');
  cap.append(capK, capT, capL);
  const top = h('div', 'sc-top');
  const back = h('a', 'sc-back', '← Studio');
  back.href = 'index.html';
  const title = h('div', 'sc-title');
  title.append(h('b', null, (edit.cards.title || {}).title || 'Showcase'), h('span', null, 'photoreal showcase'));
  const clock = h('div', 'sc-clock', '0.00 s · 1×');
  top.append(back, title, clock);

  const bar = h('div', 'sc-bar');
  const bPlay = h('button', 'sc-btn sc-play', '▶');
  bPlay.title = 'Play / pause (Space)';
  bPlay.setAttribute('aria-label', 'Play');
  const time = h('div', 'sc-time', '0.0 s');
  const scrub = h('div', 'sc-scrub');
  const rail = h('div', 'sc-rail'), fill = h('div', 'sc-fill'), knob = h('div', 'sc-knob');
  rail.append(fill);
  scrub.append(rail, knob);
  const marks = [];
  for (const p of edit.phases) {
    const m = h('i', 'sc-phase');
    m.style.left = (100 * p.t / duration) + '%';
    m.title = p.id.replace(/_/g, ' ');
    scrub.append(m);
  }
  edit.shots.forEach((s, k) => {
    const m = h('button', 'sc-mark');
    m.style.left = (100 * s.t / duration) + '%';
    m.dataset.k = String(k);
    m.append(h('span', null, s.label));
    m.title = `${s.label} · ${fmt(s.t)} · ${s.lens_mm} mm`;
    m.onclick = (e) => { e.stopPropagation(); on.seek(s.t + 0.001); };
    marks.push(m);
    scrub.append(m);
  });
  const chap = h('div', 'sc-chap', edit.shots[0] ? edit.shots[0].label : '');
  const bFree = h('button', 'sc-btn sc-tog', 'Free camera');
  bFree.title = 'Orbit freely (F)';
  const bCams = h('button', 'sc-btn sc-tog', 'Robot cameras');
  bCams.title = 'The three robot camera views (C)';
  const qual = h('select', 'sc-q');
  qual.title = 'Quality';
  for (const q of QUALITY) {
    const o = h('option', null, q === 'auto' ? 'Auto' : q[0].toUpperCase() + q.slice(1));
    o.value = q;
    qual.append(o);
  }
  bar.append(bPlay, time, scrub, chap, bFree, bCams, qual);

  const card = h('div', 'sc-card');
  const cT = h('div', 'sc-card-t', (edit.cards.title || {}).title || '');
  const cS = h('div', 'sc-card-s', (edit.cards.title || {}).sub || '');
  const cN = h('div', 'sc-card-n');
  const prog = h('div', 'sc-prog'), progF = h('div', 'sc-prog-f'), progL = h('div', 'sc-prog-l', 'Loading');
  prog.append(progF);
  const cGo = h('button', 'sc-btn sc-go', 'Play');
  cGo.hidden = true;
  card.append(cT, cS, cN, prog, progL, cGo);
  root.append(canvas, fade, scrim, labels, cap, top, bar, card);

  bPlay.onclick = () => on.play();
  cGo.onclick = () => on.play(true);
  bFree.onclick = () => on.free();
  bCams.onclick = () => on.cams();
  qual.onchange = () => on.quality(qual.value);
  const seekAt = (e) => {
    const r = rail.getBoundingClientRect();
    on.seek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * duration);
  };
  let drag = false;
  scrub.addEventListener('pointerdown', (e) => { drag = true; scrub.setPointerCapture(e.pointerId); seekAt(e); });
  scrub.addEventListener('pointermove', (e) => { if (drag) seekAt(e); });
  scrub.addEventListener('pointerup', () => { drag = false; });

  let idleT = 0;
  const wake = () => { root.classList.remove('idle'); idleT = performance.now(); };
  root.addEventListener('pointermove', wake);
  root.addEventListener('pointerdown', wake);
  window.addEventListener('keydown', (e) => {
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    wake();
    if (e.code === 'Space') { e.preventDefault(); on.play(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); on.chapter(-1, e.shiftKey); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); on.chapter(1, e.shiftKey); }
    else if (e.key === 'f' || e.key === 'F') on.free();
    else if (e.key === 'c' || e.key === 'C') on.cams();
  });

  let last = {};
  return {
    canvas,
    progress(f, label) {
      progF.style.width = (100 * Math.min(1, f)) + '%';
      if (label) progL.textContent = label;
    },
    ready() {
      prog.hidden = true;
      progL.hidden = true;
      card.classList.add('gone');
      root.classList.add('ready');
    },
    fail(msg) { progL.textContent = msg; progL.classList.add('err'); },
    /** a message over the frame (a lost GPU context); `reload` adds a Reload button; null hides it */
    notice(msg, reload = false) {
      last.end = undefined;
      if (!msg) { card.classList.add('gone'); card.classList.remove('end'); cGo.onclick = () => on.play(true); return; }
      cT.textContent = '';
      cS.textContent = msg;
      cN.replaceChildren();
      cGo.textContent = 'Reload';
      cGo.hidden = !reload;
      cGo.onclick = () => location.reload();
      card.classList.remove('gone');
      card.classList.add('end');
    },
    /** the end card at the run's end; hidden again on seek */
    end(show) {
      if (show === last.end) return;
      last.end = show;
      const c = edit.cards.end || edit.cards.title || {};
      cT.textContent = c.title || '';
      cS.textContent = c.sub || '';
      cN.replaceChildren(...(c.notes || []).map((n) => h('div', null, n)));
      cGo.textContent = 'Replay';
      cGo.hidden = !show;
      card.classList.toggle('gone', !show);
      card.classList.toggle('end', show);
    },
    update(s) {
      const f = s.t / duration;
      fill.style.width = (100 * f) + '%';
      knob.style.left = (100 * f) + '%';
      time.textContent = `${fmt(s.t)} / ${fmt(duration)}`;
      clock.textContent = `${s.t.toFixed(2)} s · 1×`;
      if (s.playing !== last.playing) {
        bPlay.textContent = s.playing ? '❚❚' : '▶';
        bPlay.setAttribute('aria-label', s.playing ? 'Pause' : 'Play');
        last.playing = s.playing;
      }
      if (s.chapter !== last.chapter) {
        marks.forEach((m, k) => m.classList.toggle('on', k === s.chapter));
        chap.textContent = edit.shots[s.chapter].label;
        last.chapter = s.chapter;
      }
      bFree.classList.toggle('on', s.free);
      bCams.classList.toggle('on', s.cams);
      if (qual.value !== s.quality) qual.value = s.quality;
      fade.style.opacity = String(1 - s.fade);
      const c = s.captions[0];
      cap.style.opacity = c ? String(c.alpha) : '0';
      scrim.style.opacity = c ? String(c.alpha) : '0';
      if (c && c.text !== last.cap) { capK.textContent = c.kicker; capT.textContent = c.text; last.cap = c.text; }
      capL.textContent = c ? c.line2 : '';
      const key = s.labels.map((l) => l.name + l.rect.join(',')).join('|');
      if (key !== last.labels) {
        labels.replaceChildren(...s.labels.map((l) => {
          const e = h('div', 'sc-inset', l.name.toUpperCase());
          Object.assign(e.style, { left: l.rect[0] + 'px', top: l.rect[1] + 'px', width: l.rect[2] + 'px', height: l.rect[3] + 'px' });
          return e;
        }));
        last.labels = key;
      }
      if (s.playing && performance.now() - idleT > 2600) root.classList.add('idle');
      if (!s.playing) root.classList.remove('idle');
    },
    /** the bar's top edge in CSS px (insets sit above it) */
    barTop: () => bar.getBoundingClientRect().top,
  };
}
