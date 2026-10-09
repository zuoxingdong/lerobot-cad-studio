/* Package numbers for the Home cards: the package inventory, and the parts / printed count of
   its default design (the numbers the Design tree shows).  Needs core/ and features/slots.js. */

import { ROBOTS } from '../data/assets.js';
import * as pkg from '../core/package.js';
import { defaultDesign } from '../core/store.js';
import { buildSlots } from '../features/slots.js';
import { partCounts } from '../features/slot-options.js';

const manifest = (id) => pkg.embeddedManifest(id);

/** components / printables / slots / cameras of a package, attachments included. */
export function packageCounts(id) {
  const seen = new Set();
  let comps = 0, print = 0, cams = 0;
  const walk = (rid) => {
    if (!ROBOTS[rid] || seen.has(rid)) return;
    seen.add(rid);
    const m = manifest(rid);
    for (const c of m.components || []) { comps++; if (c.printable) print++; }
    cams += (m.cameras || []).length;
    for (const a of m.attachments || []) walk(a.package);
  };
  walk(id);
  const m = manifest(id);
  return { components: comps, printable: print, cameras: cams,
    slots: Object.keys(m.slots || {}).length };
}

/** parts / printed of the package's default design: the numbers the Design tree shows */
const fittedCache = new Map();
export function fittedCounts(id) {
  if (!fittedCache.has(id)) {
    fittedCache.set(id, pkg.loadEmbedded(id).then((m) => {
      const S = buildSlots(m);
      return partCounts(m, S, S.applyDefaults(defaultDesign(id)));
    }).catch(() => null));
  }
  return fittedCache.get(id);
}
/** fill `[data-k]` spans once the counts are known */
export function fillCounts(node, id) {
  fittedCounts(id).then((n) => {
    if (!n) return;
    for (const k of ['parts', 'printed']) { const e = node.querySelector(`[data-k="${k}"]`); if (e) e.textContent = String(n[k]); }
  });
}
