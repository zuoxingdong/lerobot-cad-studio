/* The gate between "it looks right" and "send it to the printer": a pure function over one
   BufferGeometry, welding by quantised position so CSG seams do not read as holes, reporting
   five chips — closed mesh, single body, fits the bed, overhangs, clearance — and a verdict.
   Needs three and features/geometry-kit.js. */

import * as THREE from 'three';
import { signedVolume, bedTransform, seatOnBed } from './geometry-kit.js';

/** The printer profiles the dropdown offers. */
export const PRINTERS = [
  { id: 'bambu', name: 'Bambu Lab A1 / P1S', size: [256, 256, 256] },
  { id: 'mk4', name: 'Prusa MK4', size: [250, 210, 220] },
  { id: 'ender', name: 'Ender 3', size: [220, 220, 250] },
  { id: 'custom', name: 'Custom', size: [300, 300, 300] },
];
export const DEFAULT_PRINTER = 'bambu';
export const OVERHANG_DEG = 45;      // faces steeper than this need support
export const OVERHANG_WARN = 0.15;   // …and more than 15 % of the surface is a warning
export const BED_EPS_MM = 0.25;      // a down-face this close to Z_min is the FIRST LAYER,
                                     // not an overhang
/* THE BED-CONTACT GATE.  An overhang PERCENTAGE cannot see a part that is balanced on a
   point: `df200_arch/arch_PRINT` shipped with 0.00 mm² of flat first layer under a 78 mm
   tall, 68 × 54 mm fork and passed this check at 6.9 % overhang.  A tall part with almost
   no flat contact does not fail slowly — it comes off the bed and wrecks the print.  So:
   below BED_CONTACT_MIN_MM2 of first layer on a part taller than BED_CONTACT_TALL_MM is a
   FAIL, and the fix is a different orientation, not a brim. */
export const BED_CONTACT_MIN_MM2 = 20;
export const BED_CONTACT_TALL_MM = 20;

/* WHERE THE PRINT POSE CAME FROM, in one word the UI can print (class D1).
   `declared` / `shipped` = the package named a plate and the studio proved the exported
   mesh is that plate; `built` = this project's own part generator laid the part on the bed
   when it made it; `unknown` = nobody stated a pose and the mesh was dropped flat. */
export const ORIENTATION_LABEL = {
  declared: 'from package', shipped: 'from package', built: 'laid flat', unknown: 'not set',
};
/** @param {string|null} o @returns {string|null} */
export function orientationLabel(o) { return ORIENTATION_LABEL[o] || null; }
const WELD_Q = 1e3;                  // quantise to 1 µm before welding

/* Thousands separators are FIXED, never the host locale: these `detail` strings end up in
   the print-check dialog and the e2e suites' report JSON, where `1.234.567`
   (de-DE) or `1 234 567` with a U+202F (fr-FR) is a diff, not a number. */
const groupN = (n) => Number(n).toLocaleString('en-US');

/** ids other layers already use, mapped onto the four profiles above */
export const PRINTER_ALIASES = {
  bambu_a1: 'bambu', bambu_p1s: 'bambu', bambu_x1c: 'bambu',
  prusa_mk4: 'mk4', mk4s: 'mk4', ender3: 'ender', ender_3: 'ender', 'custom_300': 'custom',
};

export function printerProfile(id) {
  const key = PRINTER_ALIASES[id] || id;
  return PRINTERS.find((p) => p.id === key) || PRINTERS.find((p) => p.id === DEFAULT_PRINTER);
}

/* topology + printability of one geometry, in the orientation given */

/**
 * @param {THREE.BufferGeometry} geo  already in PRINT orientation
 * @returns {{tris, boundary, nonManifold, bodies, area, overhangFrac, size, bbox}}
 */
export function analyseGeometry(geo) {
  const pos = geo.attributes.position;
  const idx = geo.index ? geo.index.array : null;
  const tris = Math.floor((idx ? idx.length : pos.count) / 3);

  const key = new Map(), weld = new Int32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const k = Math.round(pos.getX(i) * WELD_Q) + ',' + Math.round(pos.getY(i) * WELD_Q) + ',' + Math.round(pos.getZ(i) * WELD_Q);
    let w = key.get(k);
    if (w === undefined) { w = key.size; key.set(k, w); }
    weld[i] = w;
  }
  const parent = new Int32Array(key.size);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };

  if (!geo.boundingBox) geo.computeBoundingBox();
  const zMin = geo.boundingBox.min.z;

  const edges = new Map();
  let area = 0, overhang = 0, bedArea = 0;
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), nrm = new THREE.Vector3();
  const cosLimit = Math.cos(THREE.MathUtils.degToRad(90 - OVERHANG_DEG));
  for (let t = 0; t < tris; t++) {
    const i0 = idx ? idx[t * 3] : t * 3, i1 = idx ? idx[t * 3 + 1] : t * 3 + 1, i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
    const w0 = weld[i0], w1 = weld[i1], w2 = weld[i2];
    union(w0, w1); union(w1, w2);
    for (const [a, b] of [[w0, w1], [w1, w2], [w2, w0]]) {
      const k = a < b ? a + '_' + b : b + '_' + a;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
    A.fromBufferAttribute(pos, i0); B.fromBufferAttribute(pos, i1); C.fromBufferAttribute(pos, i2);
    ab.subVectors(B, A); ac.subVectors(C, A); nrm.crossVectors(ab, ac);
    const a2 = nrm.length() / 2;
    if (a2 > 0) {
      area += a2;
      nrm.divideScalar(a2 * 2);
      if (-nrm.z > cosLimit) {
        const onBed = Math.max(A.z, B.z, C.z) <= zMin + BED_EPS_MM;
        if (onBed) bedArea += a2; else overhang += a2;
      }
    }
  }
  let boundary = 0, nonManifold = 0;
  for (const c of edges.values()) { if (c === 1) boundary++; else if (c > 2) nonManifold++; }
  const roots = new Set();
  for (let i = 0; i < parent.length; i++) roots.add(find(i));

  const bb = geo.boundingBox;
  const size = bb.getSize(new THREE.Vector3());
  return {
    tris, boundary, nonManifold, bodies: roots.size, area, bedArea,
    overhangFrac: area > 0 ? overhang / area : 0, size, bbox: bb,
    volume_cm3: +(Math.abs(signedVolume(geo)) / 1000).toFixed(3),
  };
}

/** Does `size` fit the bed, with a 90° rotation allowed? */
export function fitsBed(size, bed) {
  const [w, d, h] = bed;
  const sz = size.isVector3 ? size : { x: size[0], y: size[1], z: size[2] };
  if (sz.z > h) return { fits: false, why: 'too tall' };
  if (sz.x <= w && sz.y <= d) return { fits: true, rot: false };
  if (sz.y <= w && sz.x <= d) return { fits: true, rot: true };
  return { fits: false, why: 'footprint too large' };
}

/** fail > warn > pass > unknown: an unknown never escalates, and only all-unknown is unknown */
export function worstOf(chips) {
  if (chips.some((c) => c.level === 'fail')) return 'fail';
  if (chips.some((c) => c.level === 'warn')) return 'warn';
  if (chips.length && chips.every((c) => c.level === 'unknown')) return 'unknown';
  return 'pass';
}

/* the five chips */

/**
 * The full print check for one printable mesh.
 *
 * @param {THREE.BufferGeometry} geometry   in its own frame (robot mm)
 * @param {THREE.Matrix4|number[]|null} printTransform  frame -> bed
 * @param {object|string} profile           a PRINTERS entry, its id, or `{name, size}`
 * @param {object} [opts]
 * @param {Array}  [opts.clearance]         hits from `collide.checkTransform`
 * @param {string[]} [opts.warnings]        build warnings from the parametric part
 * @param {string} [opts.error]             a build error (always a `fail`)
 * @param {string} [opts.name]
 * @param {'unknown'|'shipped'|'declared'|'built'|null} [opts.orientation]  whose answer the
 *        print pose is: `'unknown'` = the package states none and the caller dropped the
 *        robot-frame mesh flat, which softens `bedcontact` to a WARN (see below).
 * @param {'csg'|'display'|null} [opts.preview]  which mesh was measured: `'csg'` = an
 *        edited parametric part's live preview, which the export writes as is, so its
 *        `closed` and `bodies` defects fail; `'display'` = the decimated scene mesh, whose
 *        two chips are `unknown` and marked `preview:true` so a caller can keep them out
 *        of a summary chip.
 * @param {boolean} [opts.ownMesh]  these bytes are the USER'S OWN file (an imported STL):
 *        there is no package plate behind it and no repair step, so `closed` and `bodies`
 *        are a verdict (`fail`) rather than a note.
 * @returns {{verdict, chips:[{key,level,name,detail,value}], analysis, printer, ms}}
 */
export function printCheck(geometry, printTransform, profile, opts = {}) {
  const t0 = Date.now();
  const bed = typeof profile === 'string' ? printerProfile(profile) : (profile && profile.size ? profile : printerProfile(DEFAULT_PRINTER));
  const chips = [];
  if (!geometry || !geometry.attributes || !geometry.attributes.position) {
    chips.push({ key: 'mesh', level: 'warn', name: 'Printable mesh', detail: 'nothing printable in this build' });
    return { verdict: 'warn', chips, analysis: null, printer: bed, ms: Date.now() - t0 };
  }

  let geo = geometry;
  let cloned = false;
  if (printTransform) {
    const M = printTransform.isMatrix4 ? printTransform : new THREE.Matrix4().fromArray(printTransform);
    geo = geometry.clone(); cloned = true;
    geo.applyMatrix4(M);
  }
  const a = analyseGeometry(geo);
  if (cloned) geo.dispose();

  /* AN IMPORTED MESH IS NOT A PREVIEW OF ANYTHING.  A package part is measured on a
     decimated display mesh, so its open edges are an artefact and only warn; the file the
     user dropped in IS what the export writes, so the same defects are the verdict.  So is
     an edited CSG preview: no repair step stands between it and the zip. */
  const csg = opts.preview === 'csg';
  const own = csg || (!opts.preview && !!opts.ownMesh);
  const soft = !own && !!opts.preview;
  const why = csg ? ' — the export writes this live preview as is; reset the knobs to print the package plate'
    : soft ? ' — measured on the decimated display mesh, not on the package print file'
      : own ? ' — measured on the file you imported: a slicer cannot fill it'
        : ' — slicers repair these';
  chips.push(a.boundary === 0 && a.nonManifold === 0
    ? { key: 'closed', level: 'pass', name: 'Closed mesh', value: 0, detail: `${groupN(a.tris)} triangles, no open edges` }
    : { key: 'closed', level: own ? 'fail' : soft ? 'unknown' : 'warn', preview: soft, name: 'Closed mesh', value: a.boundary,
        detail: `${groupN(a.boundary)} open edge${a.boundary === 1 ? '' : 's'}`
          + (a.nonManifold ? `, ${a.nonManifold} non-manifold` : '') + why });

  chips.push(a.bodies === 1
    ? { key: 'bodies', level: 'pass', name: 'Single body', value: 1, detail: 'one connected shell' }
    : { key: 'bodies', level: own ? 'fail' : soft ? 'unknown' : 'warn', preview: soft, name: 'Single body', value: a.bodies,
        detail: `${a.bodies} separate shells — check for loose geometry`
          + (own ? ', and this is the file that would be exported' : '') });

  const f = fitsBed(a.size, bed.size);
  const dims = [a.size.x, a.size.y, a.size.z].map((v) => v.toFixed(0)).join(' × ');
  chips.push(f.fits
    ? { key: 'bed', level: 'pass', name: 'Fits the bed', value: [a.size.x, a.size.y, a.size.z],
        detail: `${dims} mm on ${bed.size.join(' × ')}${f.rot ? ' (rotated 90°)' : ''}` }
    : { key: 'bed', level: 'fail', name: 'Fits the bed', value: [a.size.x, a.size.y, a.size.z],
        detail: `${dims} mm — ${f.why} for ${bed.name}` });

  const bedMm2 = a.bedArea || 0;
  const tall = a.size.z > BED_CONTACT_TALL_MM;
  const bedBad = tall && bedMm2 < BED_CONTACT_MIN_MM2;
  /* Bed contact and overhangs describe the PRINT pose.  With no stated pose (`unknown`) the
     part is measured lying as the robot holds it, which nobody chose: those two are unknown,
     never a verdict.  A stated pose (plate, print_transform, generator) makes them real. */
  const unknownOrient = opts.orientation === 'unknown';
  chips.push({
    key: 'bedcontact', level: unknownOrient ? 'unknown' : bedBad ? 'fail' : 'pass', name: 'Bed contact',
    value: +bedMm2.toFixed(1), orientation: opts.orientation || null,
    orientationLabel: orientationLabel(opts.orientation), orientationSource: opts.orientationSource || null,
    detail: unknownOrient
      ? `${bedMm2.toFixed(1)} mm² of first layer as modelled; print pose not set`
      : bedBad
        ? `${bedMm2.toFixed(1)} mm² of first layer under a part ${a.size.z.toFixed(0)} mm tall`
          + ` — under ${BED_CONTACT_MIN_MM2} mm² it comes off the bed; re-orient it`
        : `${bedMm2.toFixed(0)} mm² of flat first layer`,
  });
  if (unknownOrient) {
    chips.push({
      key: 'orientation', level: 'unknown', name: 'Print pose', analysis: true,
      orientation: 'unknown', orientationLabel: 'not set', orientationSource: opts.orientationSource || null,
      detail: 'print pose not set: no print mesh and no print_transform'
        + (opts.orientationSource ? ` (${opts.orientationSource})` : ''),
    });
  }

  const pct = a.overhangFrac * 100;
  const steep = a.overhangFrac > OVERHANG_WARN;
  chips.push({
    key: 'overhang', level: unknownOrient ? 'unknown' : steep ? 'warn' : 'pass', name: 'Overhangs', value: +pct.toFixed(1),
    detail: `${pct.toFixed(1)}% of the surface steeper than ${OVERHANG_DEG}°`
      + (unknownOrient ? ' as modelled' : steep ? ' — supports or a re-orient' : ''),
  });

  /* A display mesh is an approximate shape: its seams and shells are not the part's, so
     they are unknown, never a warning. */
  const previewDefect = soft && (a.bodies > 1 || a.boundary > 0 || a.nonManifold > 0);
  if (previewDefect) {
    const bits = [];
    if (a.bodies > 1) bits.push(`${a.bodies} shells`);
    if (a.boundary > 0) bits.push(`${groupN(a.boundary)} open edge${a.boundary === 1 ? '' : 's'}`);
    if (a.nonManifold > 0) bits.push(`${a.nonManifold} non-manifold`);
    chips.push({
      key: 'preview', level: 'unknown', name: 'Approximate shape', value: a.bodies,
      detail: `${bits.join(', ')} in the preview`,
    });
  }

  if (opts.clearance !== undefined) chips.push(clearanceChip(opts.clearance, opts.label));

  for (const w of opts.warnings || []) chips.push({ key: 'design', level: 'warn', name: 'Design', detail: w });
  if (opts.error) chips.push({ key: 'build', level: 'fail', name: 'Build', detail: opts.error });

  return {
    verdict: worstOf(chips), chips, analysis: a, printer: bed,
    name: opts.name || null, preview: opts.preview || null,
    /** whose answer the print pose is, and the file (or generator) it came from (class D1) */
    orientation: opts.orientation || null,
    orientationLabel: orientationLabel(opts.orientation),
    orientationSource: opts.orientationSource || null,
    /** the worst chip that is not a known preview artefact — what a summary chip shows */
    actionable: worstOf(chips.filter((c) => !c.preview)),
    ms: Date.now() - t0,
  };
}

/**
 * The Fit chip, from `collide.checkTransform(...).hits` (or a plain list of names).  A hit
 * marked `expected` is a contact the part had as shipped (it bolts on there): a pass.  A new
 * contact is a WARN, not a FAIL: a mount often touches what it bolts to.
 */
export function clearanceChip(hits, label) {
  const nm = (h) => (typeof h === 'string' ? h : (label ? label(h.b) : h.b));
  const list = (names) => names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '');
  const all = hits || [];
  const fresh = all.filter((h) => typeof h === 'string' || !h.expected);
  if (!fresh.length) {
    return { key: 'clearance', level: 'pass', name: 'Fit', value: 0,
      detail: all.length ? 'mount contact: ' + list(all.map(nm)) : 'no collisions' };
  }
  return { key: 'clearance', level: 'warn', name: 'Fit', value: fresh.length, detail: 'hits ' + list(fresh.map(nm)) };
}

/** One-line summary for a chip row / the status bar. */
export function chipLine(chips) {
  const bad = (chips || []).filter((c) => c.level !== 'pass');
  return bad.length
    ? bad.map((c) => `${c.level.toUpperCase()} ${c.name}: ${c.detail}`).join('\n')
    : 'all print checks pass';
}

/** The export gate. */
export function exportGate(result) {
  const v = result && result.verdict;
  return {
    allowed: v !== 'fail',
    verdict: v || 'warn',
    reason: v === 'fail'
      ? ((result.chips.find((c) => c.level === 'fail') || {}).detail || 'the print check failed')
      : null,
  };
}

/* features/geometry-kit.js owns it; a part that carries its own `printTransform` keeps it. */
export { bedTransform, seatOnBed };
