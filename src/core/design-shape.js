/* The SHAPE of an `rps/design@1` document, separate from the store that holds one: a design
   from a file, an old autosave or another tab is DATA, so every top-level field is
   type-checked before it reaches a panel.  Needs nothing. */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/* what each top-level field of `rps/design@1` must be, and how a wrong one reads */
const SHAPES = {
  robot: 'a robot id', joints: 'an object of joint → degrees', slots: 'an object of slot → option',
  params: 'an object of component → parameters', tweaks: 'an object of component → knobs',
  parts: 'an object of part → {ops, params}',
  components: 'an object of component → overrides', removed: 'an object of component → true',
  base: 'a {x, y, yaw} pose', cameras: 'an object of camera → overrides',
  ui: 'an object of panel state',
};

/**
 * Type-check a design that came from somewhere else (a file, an old autosave, another tab).
 * A field of the wrong type is DROPPED — the default takes its place — and named in
 * `warnings`, so a load is never half-applied and never throws on the far side.
 * @returns {{design:object, warnings:string[]}}
 */
export function sanitiseDesign(d) {
  const warnings = [];
  if (d === null || d === undefined) return { design: {}, warnings };
  if (!isObj(d)) return { design: {}, warnings: ['the design must be a JSON object — the defaults were used'] };
  const out = { ...d };
  const drop = (k) => { warnings.push(`"${k}" is not ${SHAPES[k]} — dropped`); delete out[k]; };

  for (const k of ['joints', 'slots', 'params', 'tweaks', 'parts', 'components', 'removed', 'cameras', 'ui']) {
    if (out[k] === undefined) continue;
    if (!isObj(out[k])) drop(k);
  }
  if (out.robot !== undefined && out.robot !== null && typeof out.robot !== 'string') drop('robot');
  if (out.base !== undefined && !isObj(out.base)) drop('base');

  /* the entries INSIDE the maps, whose values are read as numbers, ids or records */
  if (isObj(out.joints)) out.joints = pruneEntries(out.joints, (v) => Number.isFinite(v), 'joints', 'a number', warnings);
  if (isObj(out.slots)) out.slots = pruneEntries(out.slots, (v) => typeof v === 'string', 'slots', 'an option id', warnings);
  if (isObj(out.removed)) out.removed = pruneEntries(out.removed, (v) => v === true || v === false, 'removed', 'true or false', warnings);
  if (isObj(out.params)) out.params = pruneEntries(out.params, isObj, 'params', 'an object', warnings);
  if (isObj(out.components)) out.components = pruneEntries(out.components, isObj, 'components', 'an object', warnings);
  if (isObj(out.cameras)) out.cameras = pruneEntries(out.cameras, isObj, 'cameras', 'an object', warnings);
  if (isObj(out.parts)) out.parts = cleanParts(pruneEntries(out.parts, isObj, 'parts', 'an object', warnings), warnings);
  if (isObj(out.base)) {
    const b = out.base;
    const n = (v) => (Number.isFinite(v) ? v : 0);
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.yaw)) {
      warnings.push('"base" is not a {x, y, yaw} pose — the non-numbers were zeroed');
    }
    out.base = { x: n(b.x), y: n(b.y), yaw: n(b.yaw) };
  }
  return { design: out, warnings };
}

/** an op stack keeps only `{op: <string>, …}` records */
function cleanParts(parts, warnings) {
  let out = parts;
  for (const [k, p] of Object.entries(parts)) {
    if (p.ops === undefined) continue;
    const ops = Array.isArray(p.ops) ? p.ops.filter((o) => isObj(o) && typeof o.op === 'string') : [];
    const n = Array.isArray(p.ops) ? p.ops.length : 1;
    if (ops.length === n && Array.isArray(p.ops)) continue;
    warnings.push(`${n - ops.length} op(s) of "${k}" are not {op, …} records — dropped`);
    if (out === parts) out = { ...parts };
    out[k] = { ...p, ops };
  }
  return out;
}

/** drop the entries of one map whose value fails `ok`, and say how many went */
function pruneEntries(map, ok, field, want, warnings) {
  const bad = Object.keys(map).filter((k) => !ok(map[k]));
  if (!bad.length) return map;
  warnings.push(`${bad.length} "${field}" entr${bad.length === 1 ? 'y is' : 'ies are'} not ${want} — dropped (${bad.slice(0, 3).join(', ')})`);
  const out = { ...map };
  for (const k of bad) delete out[k];
  return out;
}
