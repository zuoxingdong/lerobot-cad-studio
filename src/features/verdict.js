/* The one verdict model: pass · warn · fail · unknown.  Unknown (not measured) is grey and
   never escalates a roll-up; only fail gates an export.  An item is
   {key, level, label, value, why, fix?}; a family is the worst item plus the items.
   Roll-up: check -> part -> family (Print / Fit / Limits / Cameras) -> design.  Needs nothing. */

const RANK = { unknown: 0, pass: 1, warn: 2, fail: 3 };
export const FAMILIES = [['print', 'Print'], ['fit', 'Fit'], ['limits', 'Limits'], ['cameras', 'Cameras']];
/** the CSS dot class of a level */
export const DOT = { pass: 'ok', warn: 'warn', fail: 'err', unknown: 'unk' };

/** the worst of some levels; none (or all unknown) is unknown */
export function worstLevel(levels) {
  let w = 'unknown';
  for (const l of levels || []) if (l && RANK[l] > RANK[w]) w = l;
  return w;
}

/** the worst item; the first one wins a tie */
export function worstItem(items) {
  let w = null;
  for (const it of items || []) if (it && (!w || RANK[it.level] > RANK[w.level])) w = it;
  return w;
}

const mm = (v) => (Array.isArray(v) ? v.map((n) => Math.round(n)).join(' × ') + ' mm' : '');

/** A printcheck chip as a verdict item: a label of three words at most, the sentence in `why`. */
export function chipItem(ch) {
  const pass = ch.level === 'pass';
  const v = ch.value;
  const label = {
    closed: pass ? 'closed' : `${v} open edges`,
    bodies: pass ? 'single body' : `${v} shells`,
    bed: pass ? 'fits bed' : 'too big for bed',
    bedcontact: ch.level === 'unknown' ? 'bed contact' : pass ? 'bed contact' : 'lifts off bed',
    orientation: 'print pose not set',
    overhang: `overhang ${Math.round(v || 0)} %`,
    preview: 'approximate shape',
    clearance: pass ? 'no collisions' : (ch.detail || 'hits a part').replace(/ and \d+ more$/, ''),
    design: 'design note',
    build: 'build failed',
  }[ch.key] || String(ch.name || ch.key || '').toLowerCase();
  const fix = ch.key === 'orientation' || (ch.key === 'bedcontact' && !pass) ? 'Lay flat' : null;
  return { key: ch.key, level: ch.level || 'unknown', label, value: ch.key === 'bed' ? mm(v) : v,
    why: ch.detail || '', fix };
}

/** A family from items: the worst one is the reason; all pass reads "ok". */
export function family(items, emptyLevel = null) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return emptyLevel ? { level: emptyLevel, reason: '', items: [] } : null;
  const level = worstLevel(list.map((i) => i.level));
  const w = worstItem(list);
  const reason = level === 'pass' ? 'ok' : w.label;
  return { level, reason, why: w.why || '', fix: w.fix || null, items: list };
}

/** Print and Fit of one part, from its `printCheck` result. */
export function partFamilies(print) {
  if (!print) return { print: null, fit: null };
  const items = (print.chips || []).map(chipItem);
  /* where the print pose came from, stated once: a pass when somebody stated it */
  if (print.orientationLabel && print.orientation !== 'unknown') {
    items.push({ key: 'pose', level: 'pass', label: 'print pose: ' + print.orientationLabel, value: null,
      why: print.orientationSource || '', fix: null });
  }
  return {
    print: family(items.filter((i) => i.key !== 'clearance')),
    fit: family(items.filter((i) => i.key === 'clearance')),
  };
}

/** A camera's family, from `validator.camerasOf` rows or a `cameras.verdict()`. */
export function cameraFamily(v) {
  if (!v) return null;
  const chips = v.chips || (v.verdict && v.verdict.chips) || [];
  return family(chips.map((c) => ({ key: c.key, level: c.level || 'pass', label: c.text, why: v.text || '' })));
}

/**
 * A camera's family over a sweep of the arm presets, `[{preset, level, text}]`: the worst pose
 * is the reason, with how many poses share it ("gripper out of frame at 3 of 4 poses").
 */
export function sweepFamily(list) {
  const f = family((list || []).map((s) => ({ key: 'sweep:' + s.preset, level: s.level || 'unknown',
    label: `${s.preset}: ${s.text}`, why: s.text || '' })));
  if (!f || (f.level !== 'warn' && f.level !== 'fail')) return f;
  const bad = list.filter((s) => s.level === f.level);
  f.reason = bad.length > 1 ? `${bad[0].text} at ${bad.length} of ${list.length} poses` : `${bad[0].preset}: ${bad[0].text}`;
  return f;
}

/** Fit and Limits of the arm at one preset, from `validator.physicsOf` rows. */
export function poseFamilies(p) {
  const hits = p.names || [];
  const limits = p.limits || [];
  return {
    fit: family([{ key: 'pose', level: p.ok === false && hits.length ? 'warn' : 'pass',
      label: hits.length ? 'hits ' + String(hits[0]).split(' × ')[0] : 'no collisions', why: p.tooltip || '' }]),
    limits: family([{ key: 'limits', level: limits.length ? 'warn' : 'pass',
      label: limits.length ? `${limits[0].joint || 'joint'} at limit` : 'in range', why: p.tooltip || '' }]),
  };
}

/** The worst family of one row, and the reason to print beside its dot. */
export function rowVerdict(row) {
  const fams = FAMILIES.map(([k]) => row[k]).filter(Boolean);
  const level = worstLevel(fams.map((f) => f.level));
  const bad = fams.filter((f) => f.level === level);
  return { level, reason: level === 'pass' ? 'ok' : (bad[0] ? bad[0].reason : '') };
}

/** Design roll-up: the level, how many rows are at warn / fail / unknown, the worst row. */
export function rollUp(rows) {
  const counts = { pass: 0, warn: 0, fail: 0, unknown: 0 };
  let worst = null, worstV = null;
  for (const r of rows || []) {
    const v = rowVerdict(r);
    counts[v.level]++;
    if (!worstV || RANK[v.level] > RANK[worstV.level]) { worst = r; worstV = v; }
  }
  const level = counts.fail ? 'fail' : counts.warn ? 'warn' : counts.pass ? 'pass' : 'unknown';
  return { level, counts, row: worst, reason: worst && level !== 'pass' ? `${worst.label}: ${worstV.reason}` : '' };
}
