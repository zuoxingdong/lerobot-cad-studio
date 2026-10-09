/* Print and export on the built page: every plate in the pose its package states, on the bed
   with the upstream footprint and a name of its own; plain entry names and a constant entry
   time in every zip; the Pi case plate untouched, held back when edited, stretched by an op;
   a refused op; a thicken on the bed face still on the bed; a knob reset that saves as its own
   reload; the Export sheet, its per-row waiver and its reload; a non-manifold import;
   and the Export sheet's MJCF zip, handed to run.mjs for tools/sim/check.py. */

import { frame, sleep, waitFor, test, assert, start, openDesign, captureDownload, zipNames, b64 } from './_case.js';

let win = null, rps = null, mjcf = null;
const doc = () => win.document;
const q = (s) => doc().querySelector(s);
const qa = (s) => [...doc().querySelectorAll(s)];
const BBOX_TOL_MM = 0.25, BED_TOL_MM = 1e-6;
const SPAR = 'corner_mast_printed_spar_lower';
const stlNames = () => Object.keys(rps.printables()).filter((n) => /\.stl$/i.test(n)).sort();
const DOS_2000 = (20 << 9) | (1 << 5) | 1;          // 2000-01-01, the zip writer's fixed date
/** [name, DOS time, DOS date] of each local header */
function zipTimes(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out = [];
  for (let o = 0; o + 30 <= u8.length && dv.getUint32(o, true) === 0x04034b50;) {
    const size = dv.getUint32(o + 18, true), n = dv.getUint16(o + 26, true), x = dv.getUint16(o + 28, true);
    out.push([new TextDecoder().decode(u8.subarray(o + 30, o + 30 + n)), dv.getUint16(o + 10, true), dv.getUint16(o + 12, true)]);
    o += 30 + n + x + size;
  }
  return out;
}
const fixedTime = (u8) => zipTimes(u8).filter(([, t, d]) => t !== 0 || d !== DOS_2000).map(([n]) => n);
/** [lo, hi] corners of a binary STL */
function stlBox(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0, n = dv.getUint32(80, true); i < n; i++) for (let k = 0; k < 9; k++) {
    const x = dv.getFloat32(84 + i * 50 + 12 + k * 4, true);
    lo[k % 3] = Math.min(lo[k % 3], x); hi[k % 3] = Math.max(hi[k % 3], x);
  }
  return [lo, hi];
}
const fromB64 = (e) => Uint8Array.from(win.atob(e.base64), (ch) => ch.charCodeAt(0));
/** z-up extents of an exportBytes() STL */
function stlExtent(e) {
  const [lo, hi] = stlBox(fromB64(e));
  return hi.map((h, k) => Math.round((h - lo[k]) * 1000) / 1000);
}
/** name -> bytes of a zip, inflated by the browser */
async function zipEntries(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out = {};
  for (let o = 0; o + 30 <= u8.length && dv.getUint32(o, true) === 0x04034b50;) {
    const method = dv.getUint16(o + 8, true), size = dv.getUint32(o + 18, true), n = dv.getUint16(o + 26, true), x = dv.getUint16(o + 28, true);
    const data = u8.subarray(o + 30 + n + x, o + 30 + n + x + size);
    out[new TextDecoder().decode(u8.subarray(o + 30, o + 30 + n))] = method
      ? new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()) : data;
    o += 30 + n + x + size;
  }
  return out;
}
/** every STL of the default zip, by name, whose z min is not 0 */
async function offBed() {
  rps.ctx.on.resetDefaults();
  await sleep(1200);
  const files = await zipEntries(await captureDownload(win, () => rps.page.doExport('printables')));
  const stls = Object.keys(files).filter((n) => /\.stl$/i.test(n));
  return { n: stls.length, off: stls.map((n) => [n, stlBox(files[n])[0][2]]).filter(([, z]) => !(Math.abs(z) <= BED_TOL_MM)) };
}
/** {point, normal} on the plate's bed face (its largest down-facing triangle), in the part frame */
function bedSeed(id) {
  const g = rps.page.ctx.validator().geometryOf(rps.store.getState(), id);
  const P = g.geometry.clone().applyMatrix4(g.printTransform), pos = P.attributes.position;
  P.computeBoundingBox();
  const V = P.boundingBox.min.constructor, z0 = P.boundingBox.min.z;
  let best = null, area = 0;
  for (let t = 0; t < pos.count / 3; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => new V().fromBufferAttribute(pos, 3 * t + k));
    if (Math.max(a.z, b.z, c.z) > z0 + 1e-3) continue;
    const n = b.clone().sub(a).cross(c.clone().sub(a));
    if (n.z < 0 && n.length() / 2 > area) { area = n.length() / 2; best = a.add(b).add(c).divideScalar(3); }
  }
  const Ti = g.printTransform.clone().invert();
  return { point: best.applyMatrix4(Ti).toArray(), normal: new V(0, 0, -1).transformDirection(Ti).toArray() };
}
/** two loose triangles: open edges and two shells */
function nonManifold() {
  const tris = [[[0, 0, 0], [30, 0, 0], [0, 30, 0]], [[0, 0, 30], [30, 0, 30], [0, 30, 30]]];
  const buf = new ArrayBuffer(84 + tris.length * 50), dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const t of tris) { o += 12; for (const v of t) { v.forEach((x, k) => dv.setFloat32(o + 4 * k, x, true)); o += 12; } o += 2; }
  return new Uint8Array(buf);
}
async function robot(id) {
  win.location.hash = '#/design/' + id;
  rps = await waitFor(() => (win.__rps && win.__rps.page && win.__rps.readouts().robot === id && win.__rps.readouts().treeRows > 0 ? win.__rps : null), 60000, id);
  await sleep(400);
}
function checkPlates(plates) {
  const off = plates.filter((p) => Math.abs(p.zmin) > BED_TOL_MM || Math.abs(p.xymid[0]) > 0.3 || Math.abs(p.xymid[1]) > 0.3);
  assert(!off.length, 'not on the bed: ' + off.slice(0, 3).map((p) => p.id).join(', '));
  const bad = plates.filter((p) => p.plate_bbox_mm && p.size.some((v, i) => Math.abs(v - p.plate_bbox_mm[i]) > BBOX_TOL_MM));
  assert(!bad.length, 'footprint differs from the upstream plate: ' + bad.slice(0, 3).map((p) => p.id).join(', '));
}

async function run() {
  win = frame.contentWindow;
  rps = await openDesign(win);
  await sleep(400);

  await test('every fitted plate states where its pose came from, sits on the bed and matches its upstream footprint', async () => {
    const plates = rps.printPlates();
    assert(!plates.some((p) => !p.orientation), 'a plate states nothing');
    assert(!plates.some((p) => p.orientation !== 'unknown' && !p.source), 'a stated pose names no source');
    assert(plates.filter((p) => p.orientation === 'declared').every((p) => p.plate), 'a declared pose names no file');
    const unknown = plates.filter((p) => p.orientation === 'unknown');
    assert(unknown.every((p) => /IS the display mesh/.test(p.note)), 'an unknown pose gives another reason');
    assert(plates.filter((p) => p.orientation === 'declared').length >= 15, 'too few package plates');
    assert(plates.filter((p) => p.plate_bbox_mm).length >= 10, 'too few plates carry extents');
    checkPlates(plates);
    const r = rps.designReport();
    assert(r.worst !== 'fail', 'the default fails its own gate');
    const tip = rps.printCheck(r.components.map((c) => c.id).find((id) => /tip_support/.test(id)));
    assert(tip.chips.find((c) => c.key === 'bedcontact').level === 'unknown' && tip.chips.find((c) => c.key === 'orientation').level === 'unknown',
      'a part with no stated pose is judged in an invented one');
    return `${plates.length} plates · ${unknown.length} unknown`;
  });

  await test('the stock robot prints all 13 parts on a plate it names', async () => {
    await robot('lekiwi');
    const plates = rps.printPlates();
    assert(plates.length === 13 && !plates.some((p) => p.orientation === 'unknown'), `${plates.length} plates`);
    checkPlates(plates);
    const z = await offBed();
    assert(z.n === 13 && !z.off.length, `${z.n} STLs; off the bed: ` + JSON.stringify(z.off.slice(0, 3)));
    await robot('lekiwi-pincopen');
  });

  await test('plate names are distinct and never invented, through a swap and a Reset; the zip is the fitted set', async () => {
    const before = stlNames();
    assert(before.includes('corner_mast_printed_head_PRINT.stl') && before.includes('df200_arch_head_PRINT.stl'), 'a head plate lost its set name');
    assert(!before.some((n) => /-\d+\.stl$/i.test(n)) && new Set(before.map((n) => n.toLowerCase())).size === before.length, 'a name was invented or shared');
    assert(before.length === rps.designReport().components.length && before.length >= 36, `${before.length} STLs`);
    assert(!before.some((n) => /Wrist_Roll_08c/i.test(n)) && 'design.json' in rps.printables(), 'the zip is not the fitted set');
    rps.swap('pi_case', 'none');
    await sleep(900);
    assert(stlNames().length === before.length - 2, 'the Pi case plates stayed');
    rps.ctx.on.resetDefaults();
    await sleep(1200);
    assert(stlNames().join() === before.join(), 'Reset changed the plate list');
  });

  await test('the STL zip: plain unique entry names and one fixed entry time', async () => {
    const z = await captureDownload(win, () => rps.page.doExport('printables'));
    const names = zipNames(z);
    const odd = names.filter((n) => !/^[A-Za-z0-9._-]+$/.test(n) || /[._-]{2,}|^[._-]/.test(n.replace(/\.stl$/, '')));
    assert(!odd.length, 'odd names: ' + odd.slice(0, 3).join(', '));
    assert(new Set(names.map((n) => n.toLowerCase())).size === names.length, 'a name is shared');
    assert(names.includes('Base_plate_lower_layer_1.stl') && names.includes('Vertical_Pi_case_cradle.stl'), names.slice(0, 4).join(', '));
    const off = fixedTime(z);
    assert(!off.length, 'entry time is the clock: ' + off.slice(0, 3).join(', '));
    const bed = await offBed();
    assert(bed.n === names.length - 1 && !bed.off.length, `${bed.n} STLs; off the bed: ` + JSON.stringify(bed.off.slice(0, 3)));
    return `${names.length} entries, all 2000-01-01 00:00, every plate at z 0`;
  });

  await test('a thicken on the bed face of a plate: the STL still sits on the bed and the check passes flat', async () => {
    const z0 = stlExtent(rps.exportBytes(SPAR))[2];
    const ops = rps.applyOp(SPAR, { op: 'offset_face', seed: bedSeed(SPAR), by: 1 });
    await sleep(900);
    assert(ops.length === 1 && ops[0].op === 'offset_face', JSON.stringify(ops));
    const e = rps.exportBytes(SPAR), zip = rps.page.printablesFiles()[rps.page.exportNameOf(SPAR)];
    for (const [what, u8] of [['this part', fromB64(e)], ['the zip entry', zip]]) {
      const zmin = stlBox(u8)[0][2];
      assert(Math.abs(zmin) <= BED_TOL_MM, `${what}: z min ${zmin}`);
    }
    assert(Math.abs(stlExtent(e)[2] - z0 - 1) < 1e-3, `height ${z0} -> ${stlExtent(e)[2]}`);
    const pc = rps.printCheck(SPAR), flat = pc.chips.find((c) => c.key === 'bedcontact');
    assert(pc.verdict !== 'fail' && flat.level === 'pass', `${pc.verdict}, bed contact ${flat.level}: ${flat.detail}`);
    rps.ctx.on.resetOps([SPAR]);
    await sleep(600);
    assert(!rps.ops(SPAR).length, 'the thicken stayed');
    return `${z0} -> ${z0 + 1} mm, z min 0 · ${flat.detail}`;
  });

  await test('a knob reset, saved, reloads as the same JSON', async () => {
    const PI = 'pi_case_cradle', state = (t) => { const { saved, ui, ...j } = JSON.parse(t); void saved; void ui; return JSON.stringify(j); };
    rps.ctx.on.resetDefaults();
    await sleep(1200);
    const fresh = state(rps.store.exportJSON());
    rps.ctx.on.setParam(PI, 'height', 105, true);
    await sleep(900);
    rps.ctx.on.resetParams(PI);
    await sleep(900);
    const text = rps.store.exportJSON();
    assert(state(text) === fresh, 'the reset is not the default design: ' + JSON.stringify(JSON.parse(text).params[PI]));
    assert(rps.loadDesign(text).ok, 'the design did not load');
    await sleep(1200);
    assert(state(rps.store.exportJSON()) === state(text), 'the reload differs: ' + JSON.stringify(JSON.parse(rps.store.exportJSON()).params[PI]));
  });

  await test('an untouched Pi case exports the package plate; an edited one is held back', async () => {
    for (const id of ['pi_case_cradle', 'pi_case_panel']) {
      const pc = rps.printCheck(id);
      assert(pc.preview === null && pc.orientation === 'declared', `${id}: preview ${pc.preview}, pose ${pc.orientation}`);
      for (const k of ['closed', 'bodies']) assert(pc.chips.find((c) => c.key === k).level === 'pass', `${id}: ${k}`);
      const g = rps.model.packageGeometry(id);
      const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
      assert(rps.exportBytes(id).length === 84 + 50 * tris, `${id} is not the package mesh`);
    }
    rps.ctx.on.setParam('pi_case_cradle', 'height', 105, true);
    await sleep(600);
    const pc = rps.printCheck('pi_case_cradle');
    assert(pc.preview === 'csg' && pc.verdict === 'fail' && pc.chips.find((c) => c.key === 'bodies').level === 'fail', `edited: ${pc.preview} ${pc.verdict}`);
    rps.page.openExportSheet();
    await waitFor(() => q('.sheet.export'), 5000, 'the Export sheet');
    const row = q('.sheet.export .exrow[data-id="pi_case_cradle"]');
    assert(row && row.dataset.level === 'fail' && row.querySelector('input[type=checkbox]'), 'the edited row is not held back');
    q('.sheet .dh .btn').click();
    rps.ctx.on.resetParams('pi_case_cradle');
    await sleep(600);
    assert(rps.printCheck('pi_case_cradle').preview === null && rps.designReport().worst !== 'fail', 'Reset did not bring the plate back');
    return 'edited: ' + pc.chips.find((c) => c.key === 'bodies').detail.split(' — ')[0];
  });

  await test('a Pi case stretch +5 mm: the package plate grows 5 mm, closed; the JSON round-trips; a knob keeps it', async () => {
    const PI = 'pi_case_cradle';
    rps.ctx.on.resetDefaults();
    await sleep(1200);
    const z0 = stlExtent(rps.exportBytes(PI))[2];
    rps.select(PI);
    await sleep(600);
    const b = q('.opbar [data-op="stretch"]');
    assert(b && !b.disabled, 'Stretch is ' + (b ? 'disabled: ' + b.title : 'missing'));
    b.click();
    await waitFor(() => q('.oppop:not([hidden])'), 5000, 'the stretch popover');
    await sleep(250);
    const inp = q('.oppop [data-role="change"]');
    inp.value = '5';
    inp.dispatchEvent(new win.Event('input'));
    inp.dispatchEvent(new win.Event('change'));
    await sleep(400);
    inp.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(800);
    const ops = rps.ops(PI);
    assert(ops.length === 1 && ops[0].op === 'stretch' && ops[0].by === 5, JSON.stringify(ops));
    const e1 = rps.exportBytes(PI), z1 = stlExtent(e1)[2];
    assert(Math.abs(z1 - z0 - 5) < 0.01, `plate ${z0} -> ${z1} mm`);
    const pc = rps.printCheck(PI);
    assert(pc.preview === null && ['closed', 'bodies'].every((k) => pc.chips.find((c) => c.key === k).level === 'pass'), 'not closed: ' + pc.verdict);
    assert(rps.printables()['Vertical_Pi_case_cradle.stl'] === e1.length, 'the zip entry is not this plate');
    /* the design, not the session (`saved`, `ui`: selection, camera) */
    const text = rps.store.exportJSON(), state = (t) => { const { saved, ui, ...j } = JSON.parse(t); void saved; void ui; return j; };
    rps.ctx.on.resetDefaults();
    await sleep(1200);
    assert(!rps.ops(PI).length, 'Reset kept the op');
    assert(rps.loadDesign(text).ok, 'the design did not load');
    await sleep(1200);
    const a = state(text), b2 = state(rps.store.exportJSON());
    const moved = Object.keys({ ...a, ...b2 }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b2[k]));
    assert(!moved.length, 'the round trip changed ' + moved.map((k) => k + ' ' + JSON.stringify(a[k]) + ' -> ' + JSON.stringify(b2[k])).join(', '));
    assert(rps.exportBytes(PI).base64 === e1.base64, 'the loaded design exports another plate');
    rps.ctx.on.setParam(PI, 'height', 105, true);
    await sleep(900);
    const z2 = stlExtent(rps.exportBytes(PI))[2];
    assert(rps.ops(PI).length === 1 && Math.abs(z2 - 110) < 0.01, `the knob dropped the op: ${z2} mm`);
    rps.ctx.on.resetParams(PI);
    await sleep(900);
    assert(rps.exportBytes(PI).base64 === e1.base64, 'the knob reset did not bring the stretched plate back');
    rps.ctx.on.resetOps([PI]);
    await sleep(600);
    assert(Math.abs(stlExtent(rps.exportBytes(PI))[2] - z0) < 1e-3 && rps.printCheck(PI).preview === null, 'Reset left the stretch');
    return `${z0} -> ${z1} mm, ${ops[0].at} mm plane · knob 105 -> ${z2} mm`;
  });

  await test('an op that cannot run is refused, not stored', async () => {
    const n0 = rps.ops(SPAR).length;
    const after = rps.applyOp(SPAR, { op: 'stretch', by: 10 });
    const said = (q('.status .msg') || {}).textContent || '';
    assert(after.length === n0 && !(JSON.parse(rps.store.exportJSON()).parts || {})[SPAR], 'the op was stored');
    assert(/op 1 skipped · not a valid edit/.test(said), 'status: ' + said);
    assert(rps.applyOp(SPAR, { op: 'nope' }).length === n0 && rps.applyOp(SPAR, null).length === n0, 'a junk op was stored');
  });

  await test('the Export sheet: STL zip, design JSON and MJCF, a scope and a printer; no waiver on a passing design', async () => {
    qa('.topbar .btn.accent').find((b) => /Export/.test(b.textContent)).click();
    await waitFor(() => q('.sheet.export'), 5000, 'the Export sheet');
    const roles = qa('.sheet.export [data-role]').map((b) => b.dataset.role);
    for (const r of ['stl-zip', 'design-json', 'mjcf-zip']) assert(roles.includes(r), 'no ' + r);
    assert(q('.sheet.export .exscope') && q('.sheet.export select') && qa('.sheet.export .exrow').length, 'no scope / printer / rows');
    assert(!qa('.sheet.export .exrow input[type=checkbox]').length, 'Export anyway on a passing design');
    assert(!qa('.topbar button, .ibody button, .opbar button').some((b) => /anyway/i.test(b.textContent)), 'Export anyway outside the sheet');
  });

  await test('Export → MJCF (.zip) downloads the export layout of this design', async () => {
    const btn = q('.sheet.export [data-role="mjcf-zip"]');
    assert(btn && !btn.disabled, 'MJCF is disabled');
    const z = await captureDownload(win, () => btn.click(), 120000);
    const names = zipNames(z);
    for (const f of ['scene.xml', 'scene.json', 'design.json']) assert(names.includes(f), 'no ' + f);
    assert(names.filter((n) => n.startsWith('meshes/')).length > 50, 'too few meshes');
    assert(!fixedTime(z).length, 'an MJCF entry time is the clock');
    mjcf = b64(z);
    const x = q('.sheet .dh .btn');
    if (x) x.click();
    await sleep(200);
    return `${names.length} files, ${(z.length / 1048576).toFixed(2)} MB`;
  });

  await test('a part that fails its printer: Export this part shuts, the sheet holds its row, the waiver sends it', async () => {
    rps.select(SPAR);
    rps.ctx.on.setPrinter('mk4');
    await sleep(900);
    const pc = rps.printCheck(SPAR);
    assert(pc.verdict === 'fail' && pc.chips.some((c) => c.key === 'bed' && c.level === 'fail'), 'the spar fits an MK4');
    const part = q('.ibody [data-role="export-part"]');
    assert(part.disabled && q('.ibody .fline[data-fam="print"]').dataset.level === 'fail', 'Export this part is live');
    rps.page.openExportSheet();
    await waitFor(() => q('.sheet.export'), 5000, 'the Export sheet');
    q('.sheet.export .exscope input[value="all"]').click();
    await sleep(150);
    const cb = q(`.sheet.export .exrow[data-level="fail"][data-id="${SPAR}"] input[type=checkbox]`);
    assert(cb && !cb.checked, 'no unticked waiver on the fail row');
    const zipBtn = q('.sheet.export [data-role="stl-zip"]');
    const n0 = Number(zipBtn.title.split(' ')[0]);
    cb.click();
    await sleep(100);
    assert(Number(zipBtn.title.split(' ')[0]) === n0 + 1, 'the waiver did not add the row');
    const z = await captureDownload(win, () => zipBtn.click());
    assert(z.length > 10000 && !q('.sheet.export'), 'no zip, or the sheet stayed');
  });

  await test('the waiver never survives a reload or a design export', async () => {
    rps.ctx.setExportAnyway(true);
    await sleep(1400);
    win.__reloadMark = 1;
    win.location.reload();
    await waitFor(() => !win.__reloadMark && win.__rps && win.__rps.page && win.__rps.readouts().treeRows > 0, 60000, 'the reload');
    rps = win.__rps;
    await sleep(700);
    assert(rps.store.get('ui.exportAnyway') !== true && JSON.parse(rps.store.exportJSON()).ui.exportAnyway === false, 'the waiver came back');
    rps.page.openExportSheet();
    await waitFor(() => q('.sheet.export'), 5000, 'the Export sheet');
    q('.sheet.export .exscope input[value="all"]').click();
    await sleep(150);
    assert(!qa('.sheet.export .exrow input[type=checkbox]').some((c) => c.checked), 'a fail row starts ticked');
    q('.sheet .dh .btn').click();
    rps.ctx.on.setPrinter('bambu');
    await sleep(900);
    rps.select(SPAR);
    await sleep(400);
    assert(!q('.ibody [data-role="export-part"]').disabled && rps.designReport().worst !== 'fail', 'the gate did not reopen');
  });

  await test('an imported non-manifold STL fails the gate as itself and exports as one .stl', async () => {
    const seen = new Set(rps.model.components.map((c) => c.id));
    await rps.importFiles(nonManifold().buffer, 'nonmanifold.stl');
    const id = rps.model.components.map((c) => c.id).filter((x) => !seen.has(x)).pop();
    rps.select(id);
    await sleep(1000);
    const pc = rps.printCheck(id);
    assert(pc.preview === null && pc.actionable === 'fail', `preview ${pc.preview}, gate ${pc.actionable}`);
    for (const k of ['closed', 'bodies']) assert(pc.chips.find((c) => c.key === k).level === 'fail', k + ' is not a fail');
    assert(q('.ibody [data-role="export-part"]').disabled && qa('.ibody .expart .link').some((b) => /Open Export/.test(b.textContent)), 'no way past');
    assert(rps.exportBytes(id).name === 'nonmanifold.stl' && !Object.keys(rps.printables()).some((n) => /\.stl\.stl$/i.test(n)), 'the name doubled');
    rps.removeComponents([id]);
    await sleep(300);
  });

  await test('no console errors', async () => {
    const errs = rps.readouts().errors;
    assert(!errs.length, errs.slice(0, 3).join(' | '));
  });
}

start(run, () => ({ exportMjcf: mjcf }), ['exportMjcf']);
