/* The inspector's Checks section: one line per family (Print · Fit · Limits · Cameras) for the
   selection, one dot and the worst reason, chips on expand; and the debounced passes behind
   it (print + cameras 120 ms after an input, collisions at the presets 400 ms after a drag).
   Needs features/ and the shared record ui/inspector.js hands in. */

import { chipEl } from './dialogs.js';
import { el } from './dom.js';
import { DEBOUNCE } from '../features/validate.js';
import { partFamilies, cameraFamily, family, worstLevel, DOT, FAMILIES } from '../features/verdict.js';

export function makeChecks(ctx, S) {
  const lastPrint = (id) => S.printCache.get(id) || null;
  const open = new Set();

  function schedule(c, ended) {
    clearTimeout(S.chipTimer);
    S.chipTimer = setTimeout(() => { runValidate(c, ['print', 'cameras']); paintChecks(c); }, DEBOUNCE.print_ms);
    if (ended) {
      clearTimeout(S.physicsTimer);
      S.physicsTimer = setTimeout(() => { runValidate(c, ['print', 'physics', 'cameras']); paintChecks(c); }, DEBOUNCE.presets_ms);
    }
  }

  function runValidate(c, stages, opts = {}) {
    const st = ctx.store.getState();
    let r;
    try {
      r = ctx.validator().validateComponent(st, c.id, { stages, ctx: ctx.camCtx(), stage: opts.stage,
        previous: S.lastResult && S.lastResult.component === c.id ? S.lastResult : null });
    } catch (e) { return null; }
    if (S.lastResult && S.lastResult.component === c.id) {
      r = { ...S.lastResult, ...Object.fromEntries(['print', 'physics', 'cameras'].filter((k) => stages.includes(k)).map((k) => [k, r[k]])) };
    }
    S.lastResult = r;
    if (r.print) S.printCache.set(c.id, r.print);
    return r;
  }

  /** the families of one part, from the last validation */
  function familiesOf(c, r) {
    const out = {};
    const pf = partFamilies(r.print);
    out.print = pf.print;
    const P = r.physics;
    const pose = P && P.currentPose;
    const fitItems = [...((pf.fit && pf.fit.items) || [])];
    if (pose && !pose.ok) fitItems.push({ key: 'pose', level: 'warn', label: 'hits ' + String(pose.names[0] || 'the robot').split(' × ')[0], why: pose.tooltip || '' });
    out.fit = family(fitItems);
    if (c.link && P && (P.presets || []).length && ctx.model.controlJoints().length) {
      const lim = (P.presets || []).filter((p) => (p.limits || []).length);
      out.limits = family([{ key: 'limits', level: lim.length ? 'warn' : 'pass',
        label: lim.length ? `${lim[0].limits[0].joint} at limit` : 'in range', why: lim.length ? lim[0].tooltip || '' : '' }]);
    }
    const cams = (r.cameras || []).map((x) => cameraFamily(x)).filter(Boolean);
    if (cams.length && S.slotIdOf(c)) {
      const slot = ctx.slots.slots[S.slotIdOf(c)] || {};
      if ((slot.provides || []).some((p) => String(p).startsWith('cameras.'))) {
        const items = cams.flatMap((f, i) => f.items.map((it) => ({ ...it, label: `${r.cameras[i].id}: ${it.label}` })));
        out.cameras = family(items);
      }
    }
    return out;
  }

  /** Checks: one line per family */
  function checksSection(c, host) {
    let r = S.lastResult && S.lastResult.component === c.id ? S.lastResult : null;
    if (!r) { r = runValidate(c, ['print', 'cameras']); schedule(c, true); }
    host.innerHTML = '';
    if (!r) { host.appendChild(el('div', 'note', 'not measured')); return; }
    const fams = familiesOf(c, r);
    for (const [k, name] of FAMILIES) {
      const f = fams[k];
      if (!f) continue;
      const line = el('button', 'fline');
      line.type = 'button';
      line.dataset.fam = k;
      line.dataset.level = f.level;
      line.append(el('span', 'dot ' + DOT[f.level]), el('span', 'k', name), el('span', 'r', f.reason));
      line.title = f.why || f.reason;
      line.onclick = () => { if (open.has(k)) open.delete(k); else open.add(k); checksSection(c, host); };
      host.appendChild(line);
      if (open.has(k)) {
        const chips = el('div', 'chips');
        for (const it of f.items) chips.appendChild(chipEl({ key: it.key, level: it.level, text: it.label, tooltip: it.why }));
        host.appendChild(chips);
      }
    }
    S.partLevel = worstLevel(Object.values(fams).filter(Boolean).map((f) => f.level));
  }

  /** repaint the Checks section and the export button of the current part */
  function paintChecks(c) {
    const host = S.body.querySelector('.sec[data-sec="checks"] .sb');
    if (host) checksSection(c, host);
    if (S.renderExport) S.renderExport(c);
  }

  return { schedule, runValidate, checksSection, paintChecks, lastPrint };
}
