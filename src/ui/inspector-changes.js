/* The inspector's Changes section (a part's op stack, ✕ per op, Reset, Save as part) and the
   hinge knobs of its Shape section (a detent stepper, usable detents highlighted), read from
   the part.json params of any fitted part.  Needs features/ and the record ui/inspector.js hands in. */

import { icon } from './icons.js';
import { el } from './dom.js';
import { opLabel } from '../features/ops.js';
import { partOf, hingesOf, hingeValue, isUsable } from '../features/hinge.js';

export function makeChanges(ctx, S) {
  const nameOf = (c) => (c.label || c.id);
  /* "lower spar + deck base" out of "Corner mast (printed) · lower spar + deck base" */
  const shortName = (c) => nameOf(c).split(' · ').pop();

  /** Changes: one row per op of every selected part (and its placement), ✕ removes just that one */
  function changesSection(c, st, host) {
    const ids = [c.id, ...ctx.selection().filter((id) => id !== c.id && ctx.model.component(id) && ctx.model.component(id).geometry)];
    const byKey = new Map();
    for (const id of ids) { const k = ctx.partKey(id); if (k && !byKey.has(k)) byKey.set(k, id); }
    const withOps = [...byKey].filter(([, id]) => ctx.opsOf(id).length);
    const many = withOps.length > 1 || (withOps.length === 1 && withOps[0][1] !== c.id);
    const s = host;
    s.dataset.role = 'changes';
    const list = el('div', 'oplist');
    let n = 0;
    for (const [key, id] of withOps) {
      const part = ctx.model.component(id);
      ctx.opsOf(id).forEach((op, i) => {
        const row = el('div', 'oprowi');
        row.dataset.index = String(i);
        row.dataset.key = key;
        const t = el('span', 't', (many ? shortName(part) + ' · ' : '') + labelOf(op));
        t.title = opLabel(op, nameOf(part));
        const x = el('button', 'btn icon ghost');
        x.append(icon('close', 'i12'));
        x.title = 'remove this change';
        x.setAttribute('aria-label', 'remove ' + t.textContent);
        x.onclick = () => ctx.on.removeOp(key, i);
        row.append(el('span', 'n', String(++n)), t, x);
        list.appendChild(row);
      });
    }
    const movedIds = ids.filter((id) => ((st.components || {})[id] || {}).transform && ctx.model.component(id).group !== 'imported');
    for (const id of movedIds) {
      const row = el('div', 'oprowi');
      const t = el('span', 't', movedIds.length > 1 || id !== c.id ? `${shortName(ctx.model.component(id))} · Move` : 'Move');
      const x = el('button', 'btn icon ghost');
      x.append(icon('close', 'i12'));
      x.title = 'back to the mount';
      x.onclick = () => ctx.on.resetPlacement(id);
      row.append(el('span', 'n', '·'), t, x);
      list.appendChild(row);
    }
    const ops = withOps, moved = movedIds.length;
    if (!ops.length && !moved) list.appendChild(el('div', 'note', 'No changes'));
    s.appendChild(list);
    const tail = el('div', 'propchips');
    const reset = el('button', 'btn sm');
    reset.append(icon('reset', 'i14'), document.createTextNode('Reset'));
    reset.disabled = !ops.length && !moved;
    reset.title = ids.length > 1 ? 'clear every change of the selection' : 'clear every change of this part';
    reset.dataset.role = 'reset-ops';
    reset.onclick = () => ctx.on.resetOps(ids);
    const save = el('button', 'btn sm');
    save.append(icon('download', 'i14'), document.createTextNode('Save as part'));
    save.title = 'a part folder zip: part.json, mesh/, print/';
    save.dataset.role = 'save-part';
    save.onclick = () => ctx.on.savePart(c.id);
    tail.append(reset, save);
    s.appendChild(tail);
    return true;
  }

  /** Shape: the hinge knobs of the one part folder the selection belongs to (a part or its whole slot) */
  function shapeSection(c, st, host) {
    const pids = [...new Set([c.id, ...ctx.selection()].map((id) => (partOf(ctx.model, id) || {}).id).filter(Boolean))]
      .filter((pid) => hingesOf(ctx.model, pid).length);
    if (pids.length !== 1) return false;
    const p = { id: pids[0] };
    const hinges = hingesOf(ctx.model, p.id);
    const s = host;
    s.dataset.role = 'shape';
    for (const { key, def } of hinges) {
      const v = hingeValue(st, p.id, key, def);
      const i = def.values.indexOf(v);
      const row = el('div', 'hinge');
      row.dataset.key = key;
      const name = key.replace(/_deg$/, '').replace(/_/g, ' ');
      const lab = el('span', 'n', name[0].toUpperCase() + name.slice(1));
      lab.title = `turns ${def.moves.join(', ')} and the ${def.camera} camera`;
      const step = (d) => { const j = i + d; if (j >= 0 && j < def.values.length) ctx.on.setHinge(p.id, key, def.values[j]); };
      const prev = el('button', 'btn icon');
      prev.append(icon('chevron-left', 'i14'));
      prev.disabled = i <= 0;
      prev.setAttribute('aria-label', 'less');
      prev.onclick = () => step(-1);
      const val = el('span', 'v' + (isUsable(def, v) ? '' : ' warn'), `${v}°`);
      val.dataset.role = 'hinge-value';
      const next = el('button', 'btn icon');
      next.append(icon('chevron-right', 'i14'));
      next.disabled = i >= def.values.length - 1;
      next.setAttribute('aria-label', 'more');
      next.onclick = () => step(1);
      row.append(lab, el('div', 'sp'), prev, val, next);
      s.appendChild(row);
      const det = el('div', 'detents');
      for (const x of def.values) {
        const b = el('button', 'det' + (x === v ? ' on' : '') + (isUsable(def, x) ? ' usable' : ''), String(x));
        b.title = isUsable(def, x) ? `${x}°` : `${x}° · the hole exists, but only ${def.usable.join('–')}° pass this part's camera checks`;
        b.onclick = () => { if (x !== v) ctx.on.setHinge(p.id, key, x); };
        det.appendChild(b);
      }
      s.appendChild(det);
    }
    return true;
  }

  return { changesSection, shapeSection };
}

/** "Stretch −20 mm", "Scale 110 %", "Mirror" — the op label without the part name */
export function labelOf(op) {
  return opLabel(op, '\u0000').split(' · ').filter((x) => x !== '\u0000').join(' ');
}
