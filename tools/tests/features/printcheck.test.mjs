/* features/printcheck.js — the in-browser print check.
 * The required case (the brief): the shipped camera-retainer print file
 * `assets/parts/cam_retainer/print/camera_retainer_PRINT.stl` must come back PASS. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { round, near } from './_harness.mjs';
import {
  printCheck, analyseGeometry, fitsBed, worstOf, clearanceChip, chipLine,
  exportGate, bedTransform, printerProfile,
  PRINTERS, OVERHANG_DEG, OVERHANG_WARN, BED_EPS_MM,
  BED_CONTACT_MIN_MM2, BED_CONTACT_TALL_MM,
} from '../../../src/features/printcheck.js';

const ROOT = new URL('../../../', import.meta.url).pathname;
const UP = path.join(ROOT, 'assets/parts');
const loader = new STLLoader();
function stl(rel) {
  const buf = fs.readFileSync(path.join(UP, rel));
  return loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

test('the shipped camera retainer print file PASSES', () => {
  const g = stl('cam_retainer/print/camera_retainer_PRINT.stl');
  const r = printCheck(g, null, 'bambu', { clearance: [], name: 'camera_retainer_PRINT.stl' });
  assert.equal(r.verdict, 'pass');
  assert.equal(exportGate(r).allowed, true);
  assert.equal(r.analysis.bodies, 1);
  assert.equal(r.analysis.boundary, 0, 'closed: no open edges');
  assert.equal(r.analysis.nonManifold, 0);
  assert.ok(near(r.analysis.volume_cm3, 5.998, 0.002), 'part.json says 5.998 cm³');
  assert.equal(r.analysis.tris, 1576, 'the plate has 1576 faces');
  assert.equal(chipLine(r.chips), 'all print checks pass');
});

/* EVERY plate this project ships: one per printed mesh in each part's `print/`. */
function shippedPlates() {
  const out = [];
  for (const dir of fs.readdirSync(UP).sort()) {
    if (dir.startsWith('_')) continue;
    const sub = path.join(UP, dir, 'print');
    if (!fs.existsSync(sub)) continue;
    for (const f of fs.readdirSync(sub).sort()) {
      if (f.endsWith('.stl')) out.push([dir + '/' + f.replace(/_PRINT\.stl$/, ''), path.join(dir, 'print', f)]);
    }
  }
  return out;
}

test('every shipped upgrade print file, on every printer profile', () => {
  const rows = [];
  for (const [dir, rel] of shippedPlates()) {
    const g = stl(rel);
    const r = printCheck(g, null, 'bambu', { clearance: [] });
    const a = r.analysis;
    rows.push({
      part: dir, verdict: r.verdict, actionable: r.actionable,
      bbox: [a.size.x, a.size.y, a.size.z].map((v) => round(v)).join(' × '),
      'cm³': a.volume_cm3, bodies: a.bodies, 'open edges': a.boundary, 'non-manifold': a.nonManifold,
      'overhang %': round(a.overhangFrac * 100, 1),
      bambu: fitsBed(a.size, printerProfile('bambu').size).fits,
      mk4: fitsBed(a.size, printerProfile('mk4').size).fits,
      ender: fitsBed(a.size, printerProfile('ender').size).fits,
    });
  }
  assert.equal(rows.length, 9, 'two shared plates, two Pi-case parts and five set plates');
  assert.equal(rows.every((r) => r.bambu), true, 'every shipped part fits a 256³ bed');
  const spar = rows.find((r) => r.part === 'corner_mast_printed/spar_lower');
  assert.equal(Math.round(+spar.bbox.split(' × ')[2]), 248);
  assert.equal(spar.mk4, false, 'and it does NOT fit a 220 mm bed');
  assert.equal(spar.ender, true, 'an Ender 3 is 220 x 220 x 250 — the spar goes in upright');
  assert.deepEqual(rows.filter((r) => r.verdict !== 'pass').map((r) => r.part), ['camera_shims/camera_shims']);
  assert.equal(rows.find((r) => r.part === 'camera_shims/camera_shims').bodies, 3);
  assert.equal(rows.filter((r) => r['non-manifold'] > 0).length, 0,
    'no shipped plate carries non-manifold edges any more');
});

test('the first layer is not an overhang, but a real one is', () => {
  const plate = new THREE.BoxGeometry(60, 40, 6);
  const flat = analyseGeometry(plate);
  assert.equal(round(flat.overhangFrac * 100, 1), 0, 'a plate resting on the bed has no overhang');
  assert.ok(flat.bedArea > 0, 'its bottom face is measured as bed contact instead');
  assert.ok(near(flat.bedArea, 60 * 40, 1e-6));
  /* a sphere is the other extreme: everything under its equator overhangs */
  const ball = new THREE.SphereGeometry(20, 48, 32);
  const round_ = analyseGeometry(ball);
  assert.ok(round_.overhangFrac > 0.14, `a sphere overhangs ${round(round_.overhangFrac * 100, 1)} % of its surface`);
  assert.ok(round_.bedArea < 0.02 * round_.area, 'and touches the bed almost nowhere');
  assert.equal(BED_EPS_MM, 0.25);
  assert.equal(OVERHANG_DEG, 45);
  assert.equal(OVERHANG_WARN, 0.15);
});

test('the bed-contact gate — a tall part balanced on a point FAILS', () => {
  const bed = 'bambu';
  const chip = (g) => printCheck(g, null, bed, { clearance: [] }).chips.find((c) => c.key === 'bedcontact');

  // a cone standing on its point: 40 mm tall, effectively no flat first layer.
  // ConeGeometry's axis is +Y, so rotateX(-90°) puts the apex on the bed.
  const spike = new THREE.ConeGeometry(18, 40, 64).rotateX(-Math.PI / 2);
  const cs = chip(spike);
  assert.equal(cs.level, 'fail', `a 40 mm cone on its point has ${cs.value} mm² of bed contact`);
  assert.ok(cs.value < BED_CONTACT_MIN_MM2);
  assert.match(cs.detail, /comes off the bed/);
  assert.equal(printCheck(spike, null, bed, { clearance: [] }).verdict, 'fail');
  assert.equal(exportGate(printCheck(spike, null, bed, { clearance: [] })).allowed, false);

  // the same cone the other way up: a Ø36 first layer
  const disc = new THREE.ConeGeometry(18, 40, 64).rotateX(Math.PI / 2);
  const cd = chip(disc);
  assert.equal(cd.level, 'pass');
  assert.ok(cd.value > 900, `${cd.value} mm² of bed contact`);

  // SHORT parts are exempt: the retainer plate is 7.5 mm tall and lies flat anyway
  const flat = new THREE.BoxGeometry(60, 40, 6);
  assert.equal(chip(flat).level, 'pass');
  const shortSpike = new THREE.ConeGeometry(9, 18, 64).rotateX(-Math.PI / 2);
  assert.equal(chip(shortSpike).level, 'pass', 'under 20 mm tall the gate does not apply');

  // and the real thing: the consolidated arch plate, printed upright, passes
  const arch = stl('df200_arch/print/arch_PRINT.stl');
  const ca = chip(arch);
  assert.equal(ca.level, 'pass', `arch_PRINT has ${ca.value} mm² of flat first layer`);
  assert.ok(ca.value >= BED_CONTACT_MIN_MM2);
  assert.equal(BED_CONTACT_MIN_MM2, 20);
  assert.equal(BED_CONTACT_TALL_MM, 20);
});

test('fitsBed allows a 90° rotation, and calls out "too tall" separately', () => {
  const bed = [256, 256, 256];
  assert.deepEqual(fitsBed([200, 100, 50], bed), { fits: true, rot: false });
  assert.deepEqual(fitsBed([100, 200, 50], [250, 210, 220]), { fits: true, rot: false });
  assert.deepEqual(fitsBed([205, 100, 50], [250, 210, 220]), { fits: true, rot: false });
  assert.deepEqual(fitsBed([100, 240, 50], [250, 210, 220]), { fits: true, rot: true });
  assert.deepEqual(fitsBed([100, 100, 300], bed), { fits: false, why: 'too tall' });
  assert.deepEqual(fitsBed([300, 300, 50], bed), { fits: false, why: 'footprint too large' });
});

test('the export gate: PASS and WARN go through, FAIL does not', () => {
  const tall = new THREE.BoxGeometry(40, 40, 400);
  const r = printCheck(tall, null, 'bambu', { clearance: [] });
  assert.equal(r.verdict, 'fail');
  const gate = exportGate(r);
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /too tall for Bambu Lab/);
  const ok = printCheck(new THREE.BoxGeometry(40, 40, 40), null, 'bambu', { clearance: [] });
  assert.equal(exportGate(ok).allowed, true);
  const warn = printCheck(new THREE.BoxGeometry(40, 40, 40), null, 'bambu', { clearance: [{ b: 'Base_08q-v1' }] });
  assert.equal(warn.verdict, 'warn');
  assert.equal(exportGate(warn).allowed, true, 'a warn still exports');
  assert.equal(worstOf([{ level: 'pass' }, { level: 'warn' }, { level: 'fail' }]), 'fail');
});

test('the Fit chip names what a new contact hits; a shipped contact passes', () => {
  assert.equal(clearanceChip([]).level, 'pass');
  assert.equal(clearanceChip([]).detail, 'no collisions');
  const c = clearanceChip([{ b: 'a' }, { b: 'b' }, { b: 'c' }, { b: 'd' }], (id) => id.toUpperCase());
  assert.equal(c.level, 'warn');
  assert.equal(c.detail, 'hits A, B, C and 1 more');
  assert.equal(clearanceChip(['Base plate']).detail, 'hits Base plate');
  const bolted = clearanceChip([{ b: 'deck', expected: true }], (id) => id);
  assert.equal(bolted.level, 'pass', 'a contact the part shipped with is by design');
  assert.equal(bolted.detail, 'mount contact: deck');
  const mixed = clearanceChip([{ b: 'deck', expected: true }, { b: 'arm' }], (id) => id);
  assert.equal(mixed.level, 'warn');
  assert.equal(mixed.detail, 'hits arm');
});

test('printTransform is applied, and bedTransform drops a part on Z = 0', () => {
  const g = new THREE.BoxGeometry(20, 30, 40);
  g.applyMatrix4(new THREE.Matrix4().makeTranslation(100, 200, 300));
  const M = bedTransform(g);
  const r = printCheck(g, M, 'bambu', {});
  assert.ok(near(r.analysis.bbox.min.z, 0, 1e-6), 'resting on the bed');
  assert.ok(near(r.analysis.bbox.min.x, -10, 1e-6), 'centred on XY');
  /* the source geometry is never mutated */
  g.computeBoundingBox();
  assert.ok(near(g.boundingBox.min.z, 280, 1e-6));
});

test('nothing printable is a warn, never a crash', () => {
  const r = printCheck(null, null, 'bambu', {});
  assert.equal(r.verdict, 'warn');
  assert.equal(r.chips[0].detail, 'nothing printable in this build');
  const e = printCheck(new THREE.BoxGeometry(10, 10, 10), null, 'bambu', { error: 'CSG failed' });
  assert.equal(e.verdict, 'fail');
  assert.equal(exportGate(e).reason, 'CSG failed');
});


test('chip details group thousands the same way in every locale', () => {
  const big = new THREE.SphereGeometry(20, 64, 64).toNonIndexed();   // > 1000 triangles
  const r = printCheck(big, null, 'bambu', { name: 'ball' });
  const closed = r.chips.find((c) => c.key === 'closed');
  assert.ok(closed, 'there is always a closed-mesh chip');
  assert.match(closed.detail, /^[\d,]+ (triangles|open edge)/,
    'thousands are grouped with "," and nothing else: ' + JSON.stringify(closed.detail));
  assert.equal(closed.detail.includes(' '), false, 'no narrow no-break space');
  assert.equal(closed.detail.includes(' '), false, 'no no-break space');

  /* the exact string, not just the shape */
  const tris = big.attributes.position.count / 3;
  assert.ok(tris > 999, `${tris} triangles is enough to need a separator`);
  assert.ok(closed.detail.startsWith(tris.toLocaleString('en-US')),
    `${JSON.stringify(closed.detail)} should start with ${tris.toLocaleString('en-US')}`);

  /* an open mesh counts its edges the same way */
  const open = new THREE.PlaneGeometry(10, 10, 40, 40).toNonIndexed();
  const ro = printCheck(open, null, 'bambu', { name: 'sheet' });
  const oc = ro.chips.find((c) => c.key === 'closed');
  assert.match(oc.detail, /^[\d,]+ open edges/, JSON.stringify(oc.detail));

  const mod = new URL('../../../src/features/printcheck.js', import.meta.url).href;
  const script = `
    import * as THREE from 'three';
    import { printCheck } from ${JSON.stringify(mod)};
    const g = new THREE.SphereGeometry(20, 64, 64).toNonIndexed();
    const c = printCheck(g, null, 'bambu', {}).chips.find((x) => x.key === 'closed');
    process.stdout.write(Intl.NumberFormat().resolvedOptions().locale + '|' + c.detail);
  `;
  const cwd = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
  const rows = [];
  for (const [loc, want] of [['de_DE.UTF-8', 'de-DE'], ['fr_FR.UTF-8', 'fr-FR']]) {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script],
      { cwd, env: { ...process.env, LC_ALL: loc, LANG: loc }, encoding: 'utf8' });
    const [locale, detail] = out.split('|');
    rows.push({ LC_ALL: loc, locale, detail });
    assert.equal(locale, want, 'the child really ran in that locale — an ICU fallback to en-US '
      + 'would make the rest of this check a no-op');
    assert.match(detail, /^[\d,]+ triangles, no open edges$/,
      `${locale} formatted the count as ${JSON.stringify(detail)}`);
    assert.equal(detail, closed.detail, 'byte-identical to the en-US run');
  }
});

test('a multi-shell display mesh is unknown (an approximate shape); an edited CSG preview fails', () => {
  const one = new THREE.BoxGeometry(20, 20, 20);
  const two = new THREE.BufferGeometry();
  {
    const a = new THREE.BoxGeometry(20, 20, 20).toNonIndexed();
    const b = new THREE.BoxGeometry(10, 10, 10).translate(80, 0, 0).toNonIndexed();
    const pos = new Float32Array(a.attributes.position.array.length + b.attributes.position.array.length);
    pos.set(a.attributes.position.array, 0);
    pos.set(b.attributes.position.array, a.attributes.position.array.length);
    two.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    two.computeVertexNormals();
  }

  const clean = printCheck(one, bedTransform(one), 'bambu', { preview: 'csg' });
  assert.equal(clean.chips.some((c) => c.key === 'preview'), false, 'one closed body: no preview chip');
  assert.equal(clean.actionable, 'pass', 'a clean CSG preview still passes');

  const csg = printCheck(two, bedTransform(two), 'bambu', { preview: 'csg' });
  assert.equal(csg.chips.find((c) => c.key === 'bodies').level, 'fail', 'the export writes the preview as is');
  assert.equal(csg.actionable, 'fail');
  assert.equal(exportGate(csg).allowed, false, 'so the gate holds it back');

  const split = printCheck(two, bedTransform(two), 'bambu', { preview: 'display' });
  const chip = split.chips.find((c) => c.key === 'preview');
  assert.ok(chip, 'no preview chip for a 2-shell preview');
  assert.equal(chip.level, 'unknown');
  assert.match(chip.detail, /^2 shells/);
  assert.doesNotMatch(chip.detail, /approximate shape/i, 'the chip repeats its own name');
  assert.equal(chip.preview, undefined, 'the summary chip is not itself a preview artefact');
  assert.equal(split.actionable, 'pass', 'an unknown never escalates');
  assert.equal(exportGate(split).allowed, true, 'an unknown does not block the export');

  /* a REAL print file (no preview flag) is judged exactly as before */
  const real = printCheck(two, bedTransform(two), 'bambu');
  assert.equal(real.chips.some((c) => c.key === 'preview'), false, 'no preview flag, no preview chip');
});

/* class D1
   WHOSE POSE IS THIS?  Every chip above is a statement about a part lying one particular
   way up, so the check has to say where that pose came from — and a pose the STUDIO
   invented may not fail a part for it. */

test('the print check names the orientation it measured', () => {
  const spike = new THREE.ConeGeometry(18, 40, 64).rotateX(-Math.PI / 2);
  const bed = 'bambu';

  const declared = printCheck(spike, null, bed, {
    clearance: [], orientation: 'declared', orientationSource: 'base_camera_mount.stl' });
  assert.equal(declared.orientation, 'declared');
  assert.equal(declared.orientationLabel, 'from package');
  assert.equal(declared.orientationSource, 'base_camera_mount.stl');
  /* the package chose this pose, so the bed-contact verdict is a VERDICT */
  assert.equal(declared.chips.find((c) => c.key === 'bedcontact').level, 'fail');
  assert.equal(declared.chips.find((c) => c.key === 'bedcontact').orientationLabel, 'from package');
  assert.equal(declared.chips.some((c) => c.key === 'orientation'), false,
    'a stated orientation needs no "print pose not set" chip');

  const built = printCheck(spike, null, bed, {
    clearance: [], orientation: 'built', orientationSource: 'pi_case - built on the bed' });
  assert.equal(built.orientationLabel, 'laid flat');

  const unknown = printCheck(spike, null, bed, {
    clearance: [], orientation: 'unknown',
    orientationSource: 'Tip_Support.stl - this file IS the display mesh' });
  assert.equal(unknown.orientationLabel, 'not set');
  assert.equal(unknown.chips.find((c) => c.key === 'bedcontact').level, 'unknown');
  assert.equal(unknown.chips.find((c) => c.key === 'overhang').level, 'unknown');
  assert.equal(unknown.actionable, 'pass', 'the unknown pose never escalates');
  const o = unknown.chips.find((c) => c.key === 'orientation');
  assert.ok(o && o.level === 'unknown' && o.analysis === true);
  assert.match(o.detail, /print pose not set/);
  assert.match(o.detail, /this file IS the display mesh/);

  /* and with nothing said at all, nothing is claimed */
  const silent = printCheck(spike, null, bed, { clearance: [] });
  assert.equal(silent.orientationLabel, null);
  assert.equal(silent.orientationSource, null);
});

test('a package plate: the exported bytes ARE the plate, on the bed', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/robots/lekiwi/robot.json'), 'utf8'));
  const rows = [];
  for (const c of pkg.components) {
    if (!Array.isArray(c.print_transform)) continue;
    const buf = fs.readFileSync(path.join(ROOT, 'assets/robots/lekiwi', c.mesh));
    const g = loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const moved = g.clone().applyMatrix4(new THREE.Matrix4().fromArray(c.print_transform));
    const a = analyseGeometry(moved);
    assert.ok(Math.abs(moved.boundingBox.min.z) < 1e-3, `${c.id}: Z min ${moved.boundingBox.min.z}`);
    assert.ok(Math.abs(moved.boundingBox.min.x + moved.boundingBox.max.x) < 2e-3, `${c.id}: not X-centred`);
    for (let i = 0; i < 3; i++) {
      const got = [a.size.x, a.size.y, a.size.z][i];
      assert.ok(Math.abs(got - c.print_bbox_mm[i]) < 0.01,
        `${c.id} axis ${i}: ${got} vs the plate's ${c.print_bbox_mm[i]}`);
    }
    rows.push({ part: c.id, plate: c.print_file.split('/').pop(),
      fit_mm: c.print_fit_worst_mm, footprint: `${round(a.size.x, 1)} x ${round(a.size.y, 1)}` });
    moved.dispose(); g.dispose();
  }
  assert.equal(rows.length, 13, 'the stock robot states a bed pose for all 13 printables');
  assert.ok(rows.every((r) => r.fit_mm < 0.05), 'every plate fit is under 0.05 mm');
});
