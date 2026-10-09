/* Pure edits of `design.parts` (op stacks and hinge params): the store and the page share them.
   Needs nothing. */

/** The op stack stored for one key ([] when none). */
export function opsOf(design, key) {
  const p = design && design.parts && design.parts[key];
  return p && Array.isArray(p.ops) ? p.ops : [];
}

/** FNV-1a over the stack's JSON: the cache key. */
export function opsHash(ops) {
  const s = JSON.stringify(ops || []);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** `design` with `op` pushed onto `key`'s stack (pure). */
export function withOp(design, key, op) {
  const parts = { ...(design.parts || {}) };
  const cur = parts[key] || {};
  parts[key] = { ...cur, ops: [...(Array.isArray(cur.ops) ? cur.ops : []), op] };
  return { ...design, parts };
}

/** `design` without op `index` of `key` (pure); an empty entry is dropped. */
export function withoutOp(design, key, index) {
  const cur = (design.parts || {})[key];
  if (!cur || !Array.isArray(cur.ops) || index < 0 || index >= cur.ops.length) return design;
  const ops = cur.ops.filter((_, i) => i !== index);
  return withEntry(design, key, { ...cur, ops });
}

/** `design` with `key`'s ops cleared (copies keep their entry: removing it removes the copy). */
export function withoutOps(design, key) {
  const cur = (design.parts || {})[key];
  if (!cur || !Array.isArray(cur.ops) || !cur.ops.length) return design;
  if (cur.copy_of) return withEntry(design, key, null);
  return withEntry(design, key, { ...cur, ops: [] });
}

export function withEntry(design, key, entry) {
  const parts = { ...(design.parts || {}) };
  const keep = entry && ((entry.ops && entry.ops.length) || entry.copy_of
    || (entry.params && Object.keys(entry.params).length));
  if (keep) {
    const e = { ...entry };
    if (Array.isArray(e.ops) && !e.ops.length) delete e.ops;
    parts[key] = e;
  } else delete parts[key];
  return { ...design, parts };
}

/** How many keys carry ops or hinge params: the "n tweaks" count. */
export function editedCount(design) {
  return Object.values((design && design.parts) || {})
    .filter((p) => p && ((Array.isArray(p.ops) && p.ops.length) || (p.params && Object.keys(p.params).length))).length;
}

