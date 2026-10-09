/* The pure helpers the Design page and its modules share: no `page`, no design state,
   everything a function of its arguments.  One thing the design-* modules can import that
   cannot import them back.  Needs nothing. */

/**
 * A download / zip-entry name: letters, digits, `.`, `_` and `-` only, one separator between
 * words, none at either end.  Accents fold to their letter; anything else becomes `_`, and a
 * name with nothing left is `part` (uniqueName keeps those apart).
 */
export function safeName(label) {
  const s = String(label == null ? '' : label).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/[._-]*_[._-]*/g, '_')
    .replace(/([.-])\1+/g, '$1')
    .slice(0, 64)
    .replace(/^[._-]+|[._-]+$/g, '');
  return s || 'part';
}

/**
 * The stem an `.stl` is appended to.  An imported part is LABELLED with its file name,
 * extension and all, so `safeName(label) + '.stl'` exported `bracket.stl` as
 * `bracket.stl.stl` — both from the zip and from `Export → Selected STL`.
 */
export function stlStem(label) {
  return String(label == null ? '' : label).replace(/\.(stl|obj|3mf|ply|dae)$/i, '');
}

/** The `.stl` file name for a label or a plate name. */
export const stlName = (label) => safeName(stlStem(label)) + '.stl';

/** `safeName`, with a counter so no two entries of one zip can collide. */
export function uniqueName(used, label) {
  const base = safeName(label);
  const key = base.toLowerCase();
  const n = (used.get(key) || 0) + 1;
  used.set(key, n);
  return n === 1 ? base : `${base}-${n}`;
}

/** 'auto' resolved against the OS setting — the theme the page is really painted in. */
/* Deliberately a second copy of scene/materials.js effectiveTheme: scene/ must not import
   from ui/, and this is four lines. */
export function effectiveTheme(name) {
  if (name === 'light' || name === 'dark') return name;
  return (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}

/** The theme button's next mode: from auto the other look first, so every click shows. */
export function nextTheme(cur) {
  const sys = effectiveTheme('auto'), other = sys === 'dark' ? 'light' : 'dark';
  return cur === 'auto' || !cur ? other : cur === other ? sys : 'auto';
}
/** "Theme: auto (light) · next dark" */
export function themeTitle(cur, key = 'T') {
  const now = !cur || cur === 'auto' ? `auto (${effectiveTheme('auto')})` : cur;
  const nx = nextTheme(cur);
  return `Theme: ${now} · next ${nx === 'auto' ? 'auto' : nx} · ${key}`;
}

/** one CSS custom property off `:root`, with a visible fallback rather than an empty string */
export function cssVar(name) {
  try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'; }
  catch (e) { return '#888'; }
}

/** where this build came from — a line for the top bar; the package carries no provenance */
export function sourceLine() { return ''; }

/** Fit a frame of `aspect` inside a w x h box without cropping. */
export function letterbox(w, h, aspect = 4 / 3) {
  const W = Math.max(0, w), H = Math.max(0, h);
  if (!W || !H) return { w: 0, h: 0, x: 0, y: 0 };
  let fw = W, fh = W / aspect;
  if (fh > H) { fh = H; fw = H * aspect; }
  return { w: Math.round(fw), h: Math.round(fh), x: Math.round((W - fw) / 2), y: Math.round((H - fh) / 2) };
}

/** the token each robot camera's frustum and tile are painted with */
export const CAM_COLOR = { front: '--cam-front', wrist: '--cam-wrist', top: '--cam-top' };

/** the `components[].group` values that make one gripper, the one copy */
export const GRIPPER_GROUPS = new Set(['gripper', 'finger', 'fingertip', 'linkage', 'body']);

/**
 * The class the camera ID pass paints a component with: its group for the arm and the
 * gripper, then `mast` for a part owned by a slot that provides a camera (a camera mount).
 * @param {object} c  the component
 * @param {object} [slot]  the slot record that owns it (`S.slots[owner]`), if any
 */
export function camClassOf(c, slot) {
  const g = c.group;
  if (g === 'arm') return 'arm';
  if (GRIPPER_GROUPS.has(g)) return 'gripper';
  if (slot && (slot.provides || []).some((p) => String(p).startsWith('cameras.'))) return 'mast';
  return 'robot';
}

/** the scene/materials role a component is drawn with. */
export function roleOf(c) {
  if (c.group === 'imported') return 'imported';
  if (c.group === 'upgrade') return 'upgrade';
  if (c.group === 'arm') return 'arm';
  if (GRIPPER_GROUPS.has(c.group)) return 'gripper';
  return 'robot';
}
