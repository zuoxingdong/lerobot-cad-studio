/* The buildSlots() instance: the last-built handle every free function falls back to, the
   option lookups, and the small value helpers the slot modules share.  Needs nothing. */

export const SLOTS_SCHEMA = 'rps/slots@1';
export const ALTERNATIVE_SCHEMA = 'rps/alternative@1';

/** option kinds a package may use (the rps/robot@1 schema, a package's robot.json). */
export const OPTION_KINDS = ['parts', 'components', 'attachment', 'attachment_default', 'none', 'import'];

const isObj = (v) => v !== null && typeof v === 'object';
const uniq = (a) => Array.from(new Set(a));
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

/* `LAST` is a DEBUG HANDLE and a compatibility fallback, nothing more.  Every caller
   should thread the instance it built: with two models alive (a second
   tab of the same bundle, a route change before the old page is collected) a free
   function that falls back to `LAST` silently answers from the wrong robot.  The
   fallback now says so once, loudly, instead of lying quietly. */
let LAST = null;
let warnedFallback = false;
function need(inst) {
  if (inst) return inst;
  if (!LAST) throw new Error('slots: call buildSlots(model) first (and pass the instance in)');
  if (!warnedFallback) {
    warnedFallback = true;
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(`slots: a free function was called without an instance — falling back to the last `
        + `buildSlots() ("${LAST.robot}"). Pass the instance; with two models alive this answers `
        + `from the wrong robot.`);
    }
  }
  return LAST;
}

/**
 * Every option the swap popover shows for a slot, in this order:
 * PACKAGE, then FROM AGENT, then IMPORT.
 */
export function options(slotId, inst) {
  const I = need(inst);
  const slot = I.slots[slotId];
  if (!slot) return [];
  const pkg = slot.options.filter((o) => o.kind !== 'import');
  const alt = (I.alternatives[slotId] || []).slice();
  const imp = slot.options.filter((o) => o.kind === 'import');
  const fallbackImport = imp.length ? imp : [{
    id: 'import', slot: slotId, label: 'Import alternative STL…', kind: 'import',
    group: 'import', shows: [], showSet: new Set(), replaces: [], attachments: [],
    mount: slot.anchor, requires: null, note: '',
  }];
  return [...pkg, ...alt, ...fallbackImport.map((o) => ({ ...o, group: 'import' }))];
}

function findOption(slotId, optionId, inst) {
  const I = need(inst);
  const slot = I.slots[slotId];
  if (!slot) return null;
  if (slot.optionById[optionId]) return slot.optionById[optionId];
  const alt = (I.alternatives[slotId] || []).find((a) => a.id === optionId);
  if (alt) return alt;
  return options(slotId, I).find((o) => o.id === optionId) || null;
}

export { isObj, uniq, clone, need, findOption };

/** Remember the instance a free function may fall back to.  buildSlots() calls this. */
export function setLast(inst) { LAST = inst; }
