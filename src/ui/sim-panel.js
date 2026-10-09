/* The Sim tab's right rail: the lab task (task line, phase dots, progress, planning) and the
   metrics with one verdict dot each, the instruments as station chips.  The camera feeds are
   ui/sim-cams.js. */

import { el } from './dom.js';
import { USABLE_TORQUE_NM } from '../features/sim-ik.js';
import { STALL_TORQUE_NM } from '../features/sim-metrics.js';
import { phaseName } from '../features/sim-lab-plan.js';

const DOT = { pass: 'ok', warn: 'warn', fail: 'err', unknown: '', active: 'acc' };
const HONEST = 'kinematic base · convex collision · estimated masses';

function section(title, extra) {
  const s = el('section', 'sim-sec');
  const h = el('div', 'sim-h');
  h.append(el('span', 'micro', title));
  if (extra) h.append(el('span', 'sp'), extra);
  s.append(h);
  return s;
}

function row(label) {
  const r = el('div', 'sim-row');
  const dot = el('span', 'dot');
  const v = el('span', 'v');
  r.append(dot, el('span', 'k', label), v);
  return { r, dot, v };
}

const STATE_WORD = { idle: 'idle', armed: 'armed', closing: 'closing', running: 'running', opening: 'opening', done: 'done' };
const STATE_DOT = { idle: '', armed: 'warn', closing: 'acc', running: 'acc', opening: 'acc', done: 'ok' };
const CHIPS = [['lh', 'LH'], ['inc', 'INC'], ['reader', 'READER']];
export const TASK_BUDGET_S = 75;

export function mountSimPanel(host) {
  const rail = el('aside', 'sim-rail');
  rail.setAttribute('aria-label', 'Simulation');

  /* lab task */
  const lab = section('Lab task');
  lab.classList.add('sim-labsec');
  const labTitle = el('div', 'sim-title', 'Enzyme screen: LH → incubator → reader');
  const task = el('div', 'sim-task');
  const labLine = el('div', 'sim-line');
  const planning = el('span', 'sim-plan', 'Planning…');
  planning.hidden = true;
  const bar = el('div', 'sim-bar');
  const barFill = el('i');
  bar.append(barFill);
  const phaseList = el('ol', 'sim-phases');
  const summary = el('div', 'sim-summary');
  summary.hidden = true;
  const lrow = el('div', 'sim-lrow');
  lrow.append(labLine, planning);
  lab.append(labTitle, task, lrow, bar, phaseList, summary);
  lab.hidden = true;
  let phaseEls = [];

  /* metrics */
  const info = el('span', 'sim-info', 'ⓘ');
  info.title = HONEST;
  info.setAttribute('aria-label', HONEST);
  const met = section('Metrics', info);
  const R = {
    stations: row('stations'), puck: row('puck'), torque: row('peak torque'), nav: row('nav clearance'),
    scenery: row('scenery contact'), self: row('self-contact'), limits: row('limit hits'), rtf: row('real time'), step: row('ms / step'),
  };
  const chips = el('span', 'sim-chips');
  const chipEls = Object.fromEntries(CHIPS.map(([id, label]) => {
    const c = el('span', 'sim-chip');
    c.dataset.station = id;
    c.append(el('span', 'dot'), el('span', null, label));
    chips.append(c);
    return [id, c];
  }));
  R.stations.r.classList.add('sim-strow');
  R.stations.r.insertBefore(chips, R.stations.v);
  const tq = el('span', 'sim-tq');
  const tqFill = el('i');
  tq.append(tqFill);
  tq.title = `usable ${USABLE_TORQUE_NM} N·m · stall ${STALL_TORQUE_NM} N·m`;
  R.torque.r.insertBefore(tq, R.torque.v);
  for (const x of Object.values(R)) met.append(x.r);

  rail.append(lab, met);
  host.append(rail);

  function setPhases(names) {
    phaseList.innerHTML = '';
    phaseEls = names.map((n) => {
      const li = el('li');
      const d = el('span', 'dot');
      li.append(d, el('span', null, phaseName(n)));
      li.title = n;
      phaseList.append(li);
      return { li, d };
    });
  }

  function phaseLevel(p) {
    if (p.grasp) return p.grasp.verified ? 'pass' : 'fail';
    if (p.insertion) return p.insertion.success ? 'pass' : 'fail';
    if (p.carry_held === false) return 'fail';
    if (p.wait && !p.wait.reached) return 'fail';
    if (p.ik && !p.ik.ok) return 'warn';
    if (Object.keys(p.self_collisions || {}).length) return 'warn';
    return 'pass';
  }

  function renderLab(s, running) {
    lab.hidden = !s;
    if (!s) return;
    if (phaseEls.length !== s.phases.length) setPhases(s.phases);
    const k = s.records.length;
    phaseEls.forEach((p, i) => {
      const lvl = i < k ? phaseLevel(s.records[i]) : i === k && !s.done ? 'active' : 'unknown';
      p.d.className = 'dot ' + DOT[lvl];
      p.li.classList.toggle('on', i === k && !s.done);
    });
    const on = phaseEls[k];
    if (on && running && on.li.offsetParent) on.li.scrollIntoView({ block: 'nearest' });
    task.textContent = `Transfers ${s.transfers}/${s.transfersPlanned} · Stations ${s.stations}/${s.stationsPlanned} · ${s.t.toFixed(1)} / ${TASK_BUDGET_S} s`;
    labLine.textContent = s.done ? 'task complete' : `phase ${Math.min(k + 1, s.phases.length)} / ${s.phases.length} · ${s.caption || phaseName(s.phase)}`;
    planning.hidden = !s.planning;
    barFill.style.width = `${Math.round((100 * k) / Math.max(1, s.phases.length))}%`;
    summary.hidden = !s.done;
    if (s.done && s.outcome) {
      const o = s.outcome;
      summary.textContent = `${o.complete ? 'ART-3 hit' : 'Incomplete'} · ${o.transfers}/${o.transfers_planned} transfers · peak ${o.peak_torque_max_Nm.toFixed(2)} N·m · ${o.sim_seconds.toFixed(1)} s`;
      summary.className = 'sim-summary ' + (o.complete ? 'ok' : 'err');
    }
  }

  function renderMetrics(v, lv) {
    const set = (x, level, text, title) => { x.dot.className = 'dot ' + DOT[level]; x.v.textContent = text; x.r.title = title || ''; };
    const st = v.stations;
    R.stations.r.hidden = !st;
    if (st) {
      for (const [id, c] of Object.entries(chipEls)) {
        const x = st[id];
        c.hidden = !x;
        if (!x) continue;
        c.querySelector('.dot').className = 'dot ' + (STATE_DOT[x.state] ?? '');
        c.title = `${id}: ${STATE_WORD[x.state] ?? x.state}${x.remaining != null ? ` · ${x.remaining.toFixed(1)} s left` : ''}`;
        c.dataset.state = x.state;
      }
      const busy = Object.entries(st).find(([id, x]) => id !== 'lh' && x.remaining != null);
      set(R.stations, busy ? 'active' : 'pass', busy ? `${busy[1].remaining.toFixed(1)} s` : '', Object.values(chipEls).map((c) => c.title).join('\n'));
    }
    R.puck.r.hidden = !v.lab;
    const where = v.seatedAt ? `in ${v.seatedAt}` : v.held ? 'held' : 'loose';
    set(R.puck, v.held || v.seatedAt ? 'pass' : 'unknown', `${where}${v.tilt != null ? ` · ${v.tilt.toFixed(1)}°` : ''}`, v.held ? 'held by both pads' : '');
    set(R.torque, lv.torque, `${v.peak.toFixed(2)} N·m`, v.peakBy || '');
    tqFill.style.width = `${Math.min(100, (100 * v.peak) / STALL_TORQUE_NM).toFixed(0)}%`;
    tqFill.className = DOT[lv.torque];
    R.nav.r.hidden = !v.lab;
    set(R.nav, lv.nav, v.nav == null ? '—' : `${v.nav.toFixed(0)} mm`, v.navTo ? `closest: ${v.navTo}` : '');
    R.scenery.r.hidden = !v.lab;
    set(R.scenery, lv.scenery, String(v.scenery), v.sceneryPairs.join('\n'));
    set(R.self, lv.self, String(v.self), v.selfPairs.join('\n'));
    set(R.limits, lv.limits, String(v.limitHits));
    set(R.rtf, lv.rtf, v.rtf == null ? '—' : `× ${v.rtf.toFixed(2)}`);
    set(R.step, lv.step, v.msPerStep == null ? '—' : v.msPerStep.toFixed(3));
  }

  return { el: rail, renderLab, renderMetrics, destroy() { rail.remove(); } };
}
