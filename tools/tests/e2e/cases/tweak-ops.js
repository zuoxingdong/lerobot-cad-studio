/* The tweak ops through the real DOM: Stretch −20 on the mast spar (plane, preview, Enter,
   undo) and what it carries, the Checks lines, the zip and Save as part, a whole-slot
   selection, Mirror keep-original, the tilt knob, Esc, v6 tweaks, a mirrored fingertip copy,
   an import's landing, an old #/design/pincopen link, and on the PincOpen fingertips a mirrored
   pair's scale, a comma decimal and Reset. */

import { frame, sleep, waitFor, test, assert, start, boxSTL } from './_case.js';

let win = null, rps = null;
const doc = () => win.document;
const q = (s) => doc().querySelector(s);
const qa = (s) => [...doc().querySelectorAll(s)];
const SPAR = 'corner_mast_printed_spar_lower';
const TIP = 'pincopen/tip_support', TIP2 = 'pincopen/tip_support_2';
const HELD = ['head', 'retainer', 'df200'].map((m) => 'corner_mast_printed_' + m);
const HEAD_PLATE = 'corner_mast_printed_head_PRINT.stl';
const notes = {};
const at0 = {};
const round = (v, n = 3) => Math.round(v * 10 ** n) / 10 ** n;

function extentOf(id) {
  const g = rps.ctx.model.component(id).geometry;
  g.computeBoundingBox();
  const b = g.boundingBox;
  return [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
}
/** extents of a binary STL */
function stlExtent(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = dv.getUint32(80, true);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) {
    const x = dv.getFloat32(84 + i * 50 + 12 + v * 12 + k * 4, true);
    if (x < lo[k]) lo[k] = x;
    if (x > hi[k]) hi[k] = x;
  }
  return hi.map((h, k) => h - lo[k]);
}
function setField(role, text) {
  const inp = q(`.oppop [data-role="${role}"]`);
  assert(inp, 'no field ' + role);
  inp.value = text;
  inp.dispatchEvent(new win.Event('input'));
  inp.dispatchEvent(new win.Event('change'));
  return inp;
}
const enter = (el) => el.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
const escape = (el) => el.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
async function openOp(kind) {
  const b = q(`.opbar [data-op="${kind}"]`);
  assert(b && !b.disabled, `the ${kind} button is ${b ? 'disabled: ' + b.title : 'missing'}`);
  b.click();
  await waitFor(() => q('.oppop:not([hidden])'), 5000, 'the ' + kind + ' popover');
  await sleep(250);
}
/** click the part on the canvas the way a user does (pointer down/up on its screen point) */
async function clickPart(id) {
  const V = rps.page.viewport;
  const c = rps.ctx.model.component(id);
  c.geometry.computeBoundingBox();
  const p = c.geometry.boundingBox.getCenter(c.geometry.boundingBox.min.clone()).applyMatrix4(rps.ctx.model.worldMatrix(id));
  const s = V.worldToScreen(p, { frame: 'robot' });
  const canvas = q('#rps-canvas');
  const r = canvas.getBoundingClientRect();
  const o = { clientX: r.left + s.x, clientY: r.top + s.y, button: 0, buttons: 1, bubbles: true, pointerId: 1, isPrimary: true };
  canvas.dispatchEvent(new win.PointerEvent('pointerdown', o));
  canvas.dispatchEvent(new win.PointerEvent('pointerup', { ...o, buttons: 0 }));
  await sleep(300);
}

async function run() {
  win = frame.contentWindow;
  await waitFor(() => win.document.querySelector('.home .card1'), 60000, 'the Home page');
  win.location.hash = '#/design/lekiwi-pincopen';
  await waitFor(() => win.__rps && win.__rps.page && win.__rps.readouts && win.__rps.readouts().treeRows > 0, 60000, 'the design page');
  rps = win.__rps;
  await sleep(500);

  let before = null;
  await test('select the lower spar: click selects the part, the crumb promotes to the mount', async () => {
    rps.page.viewport.setView('front', { ms: 0 });
    rps.page.actions.frame(SPAR);
    await sleep(900);
    await clickPart(SPAR);
    if (rps.readouts().selected !== SPAR) rps.select(SPAR);
    assert(rps.readouts().selected === SPAR, 'selected ' + rps.readouts().selected);
    const bar = rps.opsBar();
    assert(bar && bar.shown, 'no action bar');
    const labels = qa('.opbar .opbtns .btn .tl').map((n) => n.textContent).filter(Boolean);
    assert(labels.join(',') === 'Stretch,Scale,Thicken,Mirror,Move,Options,Ask agent', labels.join(','));
    const chip = q('.crumb [data-role="select-mount"]');
    assert(chip && /Part of .* · select all 5/.test(chip.textContent), 'crumb chip: ' + (chip && chip.textContent));
    chip.click();
    await sleep(300);
    const sel = [rps.store.get('ui.selected'), ...(rps.store.get('ui.multi') || [])];
    assert(sel.length === 5, 'promoted to ' + sel.length);
    rps.select(SPAR);
    await sleep(300);
    before = extentOf(SPAR);
    for (const id of HELD) at0[id] = rps.componentBox(id).min[2];
    at0.cam = rps.camPose('top').origin;
    rps.page.strip.forceTick();
    at0.ev = rps.page.strip.evaluation('top');
    at0.plate = rps.page.printablesFiles()[HEAD_PLATE];
    return `${labels.length} ops · "${chip.textContent}" → ${sel.length} parts · spar ${before.map((v) => round(v, 1)).join(' × ')} mm`;
  });

  await test('Stretch −20 mm: a cut plane in the viewport, a live preview, Enter applies one undo step', async () => {
    await openOp('stretch');
    const plane = rps.page.viewport.robotRoot.getObjectByName('cutPlane');
    assert(plane, 'no cut plane drawn');
    assert(rps.page.gizmo.handles.length === 2, rps.page.gizmo.handles.length + ' handles');
    const cut = +q('.oppop [data-role="cut"]').value;
    const inp = setField('change', '−20');
    await sleep(500);
    const ghost = rps.page.viewport.robotRoot.children.some((o) => o.isMesh && o.material && o.material.opacity === 0.3);
    assert(ghost, 'no 30 % ghost of the original');
    const live = extentOf(SPAR)[2];
    assert(Math.abs(live - (before[2] - 20)) < 1e-3, 'preview height ' + live);
    enter(inp);
    await sleep(500);
    const ops = rps.ops(SPAR);
    assert(ops.length === 1 && ops[0].op === 'stretch' && ops[0].by === -20, JSON.stringify(ops));
    const label = rps.store.history().past.slice(-1)[0];
    assert(/^Shorten · .* · −20 mm$/.test(label), 'undo label ' + label);
    assert(!rps.opsBar().open, 'the popover stayed open');
    const h = extentOf(SPAR)[2];
    assert(Math.abs(h - (before[2] - 20)) < 1e-3, 'height ' + h);
    notes.stretch = { cut, label };
    return `cut ${cut} mm from the mount · "${label}" · ${round(before[2], 1)} → ${round(h, 1)} mm`;
  });

  await test('the shorten carries what the mast holds: head, retainer, DF200 and camera −20.0 mm; tilt 60 turns about the lowered hinge', async () => {
    const dz = HELD.map((id) => rps.componentBox(id).min[2] - at0[id]);
    const cam = rps.camPose('top').origin;
    assert(dz.every((d) => Math.abs(d + 20) <= 0.01), 'held parts moved ' + dz.join(', '));
    assert(Math.abs(cam[2] - at0.cam[2] + 20) <= 0.01 && Math.abs(cam[0] - at0.cam[0]) < 1e-6, 'camera ' + cam);
    rps.page.strip.forceTick();
    const ev = rps.page.strip.evaluation('top');
    const k = (e) => [e.robot_pct, e.arm_pct, e.floor_pct].join('/');
    assert(ev && k(ev) !== k(at0.ev), `the camera verdict was not recomputed: ${k(ev)}`);
    rps.setTab('shape');
    await sleep(300);
    const det = qa('.ibody .detents .det').find((b) => b.textContent === '60');
    assert(det, 'no 60 detent');
    det.click();
    await sleep(1200);
    const p60 = rps.camPose('top').origin, want = [-74.5731, -14.2223, 497.3845 - 20];
    const err = Math.hypot(...p60.map((v, i) => v - want[i]));
    assert(err < 0.01, 'camera at 60° is ' + err + ' mm off the lowered detent');
    const def = rps.ctx.model.manifest.parts.corner_mast_printed.params.tilt_deg;
    const W = rps.ctx.model.worldMatrix(HELD[0]).elements, o = def.origin;
    const fixed = [0, 1, 2].map((i) => W[i] * o[0] + W[4 + i] * o[1] + W[8 + i] * o[2] + W[12 + i]);
    assert(Math.hypot(fixed[0] - o[0], fixed[1] - o[1], fixed[2] - o[2] + 20) < 1e-6, 'the head turns about ' + fixed);
    rps.dispatch('global.undo');
    await sleep(800);
    assert(Math.abs(rps.camPose('top').origin[2] - cam[2]) < 1e-6, 'undo left the camera at ' + rps.camPose('top').origin);
    notes.carry = { dz, cam: cam[2] - at0.cam[2], ev: [k(at0.ev), k(ev)], err60: err };
    return `held ${dz.map((d) => round(d, 3)).join(', ')} mm · camera z ${round(at0.cam[2], 2)} → ${round(cam[2], 2)} · view ${k(at0.ev)} → ${k(ev)} · 60° on the lowered detent (${err.toExponential(1)} mm)`;
  });

  await test('the checks stay pass', async () => {
    await sleep(400);
    const pc = rps.printCheck(SPAR);
    assert(pc.verdict === 'pass', 'print ' + pc.verdict + ' ' + pc.chips.map((c) => c.key + ':' + c.level).join(','));
    const v = rps.opsBar().verdict;
    assert(v.level === 'pass', 'verdict line ' + JSON.stringify(v));
    const dot = q('.opbar .opverdict .dot');
    assert(dot && dot.classList.contains('ok'), 'no green dot');
    return `print ${pc.verdict} · ${pc.chips.map((c) => c.key).join(', ')} · bar "${v.text}"`;
  });

  await test('the Changes list shows the op, ✕ is non-destructive, undo / redo', async () => {
    rps.setTab('shape');
    await sleep(200);
    const rows = qa('.ibody [data-role="changes"] .oprowi');
    assert(rows.length === 1 && /Shorten −20 mm/.test(rows[0].textContent), rows.map((r) => r.textContent).join('|'));
    rps.dispatch('global.undo');
    await sleep(500);
    const u = extentOf(SPAR)[2];
    assert(Math.abs(u - before[2]) < 1e-3 && !rps.ops(SPAR).length, 'undo left ' + u);
    rps.dispatch('global.redo');
    await sleep(500);
    const r = extentOf(SPAR)[2];
    assert(Math.abs(r - (before[2] - 20)) < 1e-3 && rps.ops(SPAR).length === 1, 'redo left ' + r);
    /* ✕ on the first of two ops keeps the second */
    rps.applyOp(SPAR, { op: 'scale', factors: [1, 1, 1.05], about: 'mount' });
    await sleep(400);
    const x = qa('.ibody [data-role="changes"] .oprowi')[0].querySelector('button');
    x.click();
    await sleep(400);
    const left = rps.ops(SPAR).map((o) => o.op).join(',');
    assert(left === 'scale', 'after ✕: ' + left);
    rps.dispatch('global.undo');
    await sleep(400);
    rps.dispatch('global.undo');
    await sleep(500);
    assert(rps.ops(SPAR).map((o) => o.op).join(',') === 'stretch', 'two undos left ' + JSON.stringify(rps.ops(SPAR)));
    assert(Math.abs(extentOf(SPAR)[2] - (before[2] - 20)) < 1e-3, 'height after the undos ' + extentOf(SPAR)[2]);
    return `undo ${round(u, 1)} · redo ${round(r, 1)} mm · ✕ on op 1 of 2 left "${left}"`;
  });

  await test('the printables zip carries the edited plate at the new length; Save as part too', async () => {
    const name = rps.page.exportNameOf(SPAR);
    const files = rps.page.printablesFiles();
    assert(files[name], 'no ' + name + ' in ' + Object.keys(files).join(', '));
    const e = stlExtent(files[name]);
    const long = Math.max(...e);
    assert(Math.abs(long - (Math.max(...before) - 20)) < 1e-3, `the plate is ${round(long, 3)} mm long`);
    const design = JSON.parse(new TextDecoder().decode(files['design.json']));
    assert(design.parts && design.parts[SPAR] && design.parts[SPAR].ops.length === 1, 'design.json has no op stack');
    const pf = rps.partFolder(SPAR);
    assert(pf.doc.derived_from === 'corner_mast_printed' && pf.doc.ops.spar_lower.length === 1, JSON.stringify(pf.doc.ops));
    for (const f of ['part.json', 'mesh/spar_lower.stl', 'print/spar_lower_PRINT.stl']) assert(pf.files[f] > 84, 'no ' + f);
    const folder = rps.page.partFolder(SPAR);
    const plate = stlExtent(folder.files['print/spar_lower_PRINT.stl']);
    assert(Math.abs(Math.max(...plate) - long) < 1e-3, 'the part folder plate is ' + Math.max(...plate));
    /* a carried part keeps its plate; its placement, the hinge and the camera move */
    const hp = files[HEAD_PLATE];
    assert(hp && at0.plate && hp.length === at0.plate.length && hp.every((b, i) => b === at0.plate[i]), 'the head plate changed');
    const def0 = rps.ctx.model.manifest.parts.corner_mast_printed;
    assert(Math.abs(folder.doc.params.tilt_deg.origin[2] - def0.params.tilt_deg.origin[2] + 20) < 1e-6, 'part.json hinge origin');
    assert(Math.abs(folder.doc.cameras.top.local[14] - def0.cameras.top.local[14] + 20) < 1e-6, 'part.json camera');
    const zOf = (u8) => { const dv = new DataView(u8.buffer, u8.byteOffset); let lo = Infinity; for (let i = 0; i < dv.getUint32(80, true); i++) for (let v = 0; v < 3; v++) lo = Math.min(lo, dv.getFloat32(84 + i * 50 + 12 + v * 12 + 8, true)); return lo; };
    assert(Math.abs(zOf(folder.files['mesh/head.stl']) - (at0[HELD[0]] - 20)) < 0.01, 'mesh/head.stl is not lowered');
    return `${name} ${e.map((v) => round(v, 2)).join(' × ')} mm · part folder ${pf.id} (${Object.keys(pf.files).length} files)`;
  });

  await test('the whole slot selected: its tilt knob and the union of its parts\' changes', async () => {
    rps.select(HELD[0]);
    await sleep(300);
    q('.crumb [data-role="select-mount"]').click();
    await sleep(500);
    assert([rps.store.get('ui.selected'), ...(rps.store.get('ui.multi') || [])].length === 5, 'not the whole slot');
    assert(q('.ibody [data-role="shape"] [data-role="hinge-value"]'), 'no tilt knob for the slot');
    const rows = qa('.ibody [data-role="changes"] .oprowi').map((r) => r.textContent);
    assert(rows.some((t) => /Shorten −20 mm/.test(t)), 'changes: ' + rows.join(' | '));
    return rows.join(' | ');
  });

  await test('Mirror with "keep original" makes a copy under Imported; undo takes it away', async () => {
    rps.select(SPAR);
    await sleep(300);
    const orig = rps.ctx.model.worldMatrix(SPAR).elements.slice();
    await openOp('mirror');
    assert(q('.oppop [data-role="plane"] [data-id="self"]').classList.contains('on'), 'an off-centre part does not default to In place');
    q('.oppop [data-role="plane"] [data-id="robot"]').click();
    const keep = q('.oppop [data-role="keep"]');
    keep.checked = true;
    keep.dispatchEvent(new win.Event('change'));
    await sleep(500);
    q('.oppop [data-role="apply"]').click();
    await sleep(800);
    const copies = Object.entries(rps.store.getState().parts).filter(([, e]) => e.copy_of === SPAR);
    assert(copies.length === 1, copies.length + ' copies');
    const id = copies[0][0];
    const c = rps.ctx.model.component(id);
    assert(c && c.group === 'imported' && /\(mirror copy\)$/.test(c.label), 'copy ' + (c && c.label));
    assert(rps.ops(SPAR).length === 1, 'the original changed: ' + JSON.stringify(rps.ops(SPAR)));
    assert(rps.ctx.model.worldMatrix(SPAR).elements.every((v, i) => v === orig[i]), 'the original moved');
    c.geometry.computeBoundingBox();
    const b = c.geometry.boundingBox.clone().applyMatrix4(rps.ctx.model.worldMatrix(id));
    assert(b.min.x > 0, 'the copy is not across X = 0: ' + b.min.x);
    const row = qa('.tree .row').find((r) => /\(mirror copy\)/.test(r.textContent) && /Corner mast/.test(r.textContent));
    assert(row, 'no tree row for the copy');
    const pc = rps.printCheck(id);
    assert(pc.verdict === 'pass', 'the copy prints ' + pc.verdict);
    rps.dispatch('global.undo');
    await sleep(500);
    assert(!rps.ctx.model.component(id), 'undo kept the copy');
    return `${id} · x ${round(b.min.x, 1)}…${round(b.max.x, 1)} · print ${pc.verdict} · undo removed it`;
  });

  await test('the mast tilt knob 45 → 55 turns the head and the top camera; the verdict follows', async () => {
    rps.select(SPAR);
    rps.setTab('shape');
    await sleep(400);
    const val = () => q('.ibody [data-role="hinge-value"]').textContent;
    assert(val() === '45°', 'tilt reads ' + val());
    const p0 = rps.camPose('top');
    rps.page.strip.forceTick();
    const ev0 = rps.page.strip.evaluation('top');
    const head0 = rps.ctx.model.worldMatrix('corner_mast_printed_head').elements.slice();
    const det = qa('.ibody .detents .det').find((b) => b.textContent === '55');
    assert(det && det.classList.contains('usable'), 'no usable 55 detent');
    det.click();
    await sleep(1500);
    const p1 = rps.camPose('top');
    rps.page.strip.forceTick();
    const ev1 = rps.page.strip.evaluation('top');
    /* the option label follows the live hinge, in the Options list and the tree */
    assert(/55°/.test(rps.ctx.optionLabel('top_camera_mount')), 'label ' + rps.ctx.optionLabel('top_camera_mount'));
    const opt = qa('.ibody .sec[data-sec="options"] .opt.on').map((o) => o.dataset.label)[0] || '';
    assert(/55°/.test(opt) && !/45°/.test(opt), 'the fitted option still reads ' + opt);
    assert(Math.abs(p1.tilt_deg - 55) < 1e-6, 'tilt ' + p1.tilt_deg);
    const want = [-74.7906, -15.4558, 500.0 - 20];     // the spar still carries Shorten −20
    const err = Math.hypot(...p1.origin.map((v, i) => v - want[i]));
    assert(err < 1e-3, 'the camera is ' + err + ' mm off the 55° detent');
    const head1 = rps.ctx.model.worldMatrix('corner_mast_printed_head').elements;
    assert(head1.some((v, i) => Math.abs(v - head0[i]) > 1e-6), 'the head did not turn');
    assert(ev0 && ev1 && ev1.robot_pct !== ev0.robot_pct, `verdict robot ${ev0 && ev0.robot_pct}% → ${ev1 && ev1.robot_pct}%`);
    assert(val() === '55°', 'tilt reads ' + val());
    const label = rps.store.history().past.slice(-1)[0];
    assert(label === 'Tilt · Corner mast · 55°', 'undo label ' + label);
    rps.dispatch('global.undo');
    await sleep(800);
    assert(Math.abs(rps.camPose('top').tilt_deg - 45) < 1e-6, 'undo left the camera at ' + rps.camPose('top').tilt_deg);
    notes.hinge = { robot0: ev0.robot_pct, robot1: ev1.robot_pct };
    return `tilt ${round(p0.tilt_deg, 2)} → ${round(p1.tilt_deg, 2)}° · origin on the detent (${err.toExponential(1)} mm) · robot in view ${ev0.robot_pct}% → ${ev1.robot_pct}% · one undo step`;
  });

  await test('Esc cancels a preview and puts the mesh back', async () => {
    rps.select(SPAR);
    await sleep(300);
    const h0 = extentOf(SPAR)[2];
    await openOp('stretch');
    const inp = setField('change', '10');
    await sleep(500);
    assert(Math.abs(extentOf(SPAR)[2] - (h0 + 10)) < 1e-3, 'no preview');
    escape(inp);
    await sleep(300);
    assert(!rps.opsBar().open, 'still open');
    assert(Math.abs(extentOf(SPAR)[2] - h0) < 1e-6, 'Esc left ' + extentOf(SPAR)[2]);
    assert(rps.ops(SPAR).length === 1, 'Esc wrote an op');
    return `preview +10 then Esc → ${round(extentOf(SPAR)[2], 1)} mm`;
  });

  await test('a v6 design with tweaks loads: they move to ops or are named as dropped', async () => {
    const v6 = { schema: 'rps/design@1', robot: 'lekiwi-pincopen', slots: rps.store.getState().slots,
      tweaks: { [SPAR]: { length_mm: -20 }, 'pincopen/tip_support': { length_mm: 5 } } };
    await rps.importFiles(boxSTL(20, 20, 20, 10).buffer, 'leftover.stl');
    await waitFor(() => rps.ctx.model.components.some((c) => c.id.startsWith('imported/')), 5000, 'the import');
    const r = rps.loadDesign(JSON.stringify(v6));
    assert(r.ok, (r.errors || []).join('; '));
    await sleep(600);
    const st = rps.store.getState();
    assert(!st.tweaks, 'design.tweaks survived');
    const status = q('.status .msg').textContent;
    assert(/v6 tweak|dropped/.test(status), 'no status note: ' + status);
    /* what the load dropped is in its answer, and the previous design's import is gone */
    assert(!/dropped/.test(status) || r.warnings.some((w) => /dropped/.test(w)), 'warnings ' + JSON.stringify(r.warnings));
    assert(!rps.ctx.model.components.some((c) => c.id.startsWith('imported/')), 'an imported mesh survived the load');
    return `parts ${Object.keys(st.parts || {}).join(', ') || '—'} · "${status}"`;
  });

  await test('Checks: one line per family, one dot and a short reason, chips on expand', async () => {
    rps.select(SPAR);
    await sleep(900);
    const lines = qa('.ibody .sec[data-sec="checks"] .fline');
    const fams = lines.map((l) => l.dataset.fam);
    assert(fams.includes('print') && fams.includes('fit'), fams.join());
    assert(lines.every((l) => l.querySelectorAll('.dot').length === 1), 'a line carries more than one dot');
    assert(!lines.some((l) => l.querySelector('.r').textContent.length > 40), 'a reason is a sentence');
    assert(!qa('.ibody .sec[data-sec="checks"] .chip').length, 'chips before an expand');
    lines[0].click();
    await sleep(150);
    assert(qa('.ibody .sec[data-sec="checks"] .chip').length, 'no chips on expand');
    qa('.ibody .sec[data-sec="checks"] .fline')[0].click();
    return fams.join(', ');
  });

  await test('a fingertip mirrored in place, keep original: the copy rides finger_L mirrored at two jaw openings; Fit runs on it', async () => {
    const TIP = 'pincopen/removable_tip', M = rps.ctx.model;
    rps.select(TIP);
    rps.page.viewport.resetView({ ms: 0 });
    await sleep(600);
    await openOp('mirror');
    await sleep(500);
    assert(q('.oppop [data-role="plane"] [data-id="self"]').classList.contains('on'), 'the off-centre tip does not default to In place');
    /* the popover does not hide the tip; the bar keeps clear of the axis gizmo */
    const cr = q('#rps-canvas').getBoundingClientRect(), pr = q('.oppop').getBoundingClientRect(), br = q('.opbar .opbtns').getBoundingClientRect();
    const b = rps.componentBox(TIP), pts = [], g = M.component(TIP).geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) pts.push(rps.page.viewport.worldToScreen(g.boundingBox.min.clone().set(x, y, z), { frame: 'robot' }));
    const sy1 = Math.max(...pts.map((p) => p.y)) + cr.top, sx0 = Math.min(...pts.map((p) => p.x)) + cr.left, sx1 = Math.max(...pts.map((p) => p.x)) + cr.left;
    assert(sy1 < pr.top || sx1 < pr.left || sx0 > pr.right, `the popover (top ${round(pr.top, 0)}) hides the tip (bottom ${round(sy1, 0)})`);
    assert(br.right <= cr.right - 128 || br.bottom <= cr.bottom - 128, `the bar reaches ${round(cr.right - br.right, 0)} px from the right edge`);
    const keep = q('.oppop [data-role="keep"]');
    keep.checked = true;
    keep.dispatchEvent(new win.Event('change'));
    await sleep(400);
    q('.oppop [data-role="apply"]').click();
    await sleep(800);
    const [id, e] = Object.entries(rps.store.getState().parts).find(([, x]) => x.copy_of === TIP) || [];
    assert(id, 'no copy');
    const c = M.component(id);
    assert(c.link === 'pincopen/finger_L' && c.label === 'Removable Tip (mirror copy)', `copy on ${c.link}: ${c.label}`);
    const plane = e.ops[e.ops.length - 1].plane, jaw = M.controlJoints().find((j) => /jaw/.test(j)), q0 = M.getJoints();
    const errs = [];
    try {
      for (const v of [0, 20]) {
        M.setJoints({ ...q0, [jaw]: v });
        const W = M.worldMatrix(TIP).elements, Wc = M.worldMatrix(id).elements;
        const tf = (E, p) => [0, 1, 2].map((i) => E[i] * p[0] + E[4 + i] * p[1] + E[8 + i] * p[2] + E[12 + i]);
        const P = tf(W, plane.point), N0 = [0, 1, 2].map((i) => W[i] * plane.normal[0] + W[4 + i] * plane.normal[1] + W[8 + i] * plane.normal[2]);
        const box = (g, E, refl) => {
          const a = g.attributes.position.array, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
          for (let i = 0; i < a.length; i += 3) {
            let w = tf(E, [a[i], a[i + 1], a[i + 2]]);
            if (refl) { const k = 2 * ((w[0] - P[0]) * N0[0] + (w[1] - P[1]) * N0[1] + (w[2] - P[2]) * N0[2]); w = w.map((x, j) => x - k * N0[j]); }
            for (let j = 0; j < 3; j++) { lo[j] = Math.min(lo[j], w[j]); hi[j] = Math.max(hi[j], w[j]); }
          }
          return [...lo, ...hi];
        };
        const want = box(M.component(TIP).geometry, W, true), got = box(c.geometry, Wc, false);
        errs.push(Math.max(...want.map((x, i) => Math.abs(x - got[i]))));
      }
    } finally { M.setJoints(q0); }
    assert(errs.every((x) => x <= 0.01), 'copy vs mirrored original ' + errs.join(', '));
    const fit = rps.printCheck(id).chips.find((x) => x.key === 'clearance');
    assert(fit, 'no Fit chip on the copy');
    rps.dispatch('global.undo');
    await sleep(500);
    assert(!M.component(id), 'undo kept the copy');
    return `${id} on ${c.link} · bbox err ${errs.map((x) => x.toExponential(1)).join(', ')} mm at jaw 0/20 · Fit ${fit.level}`;
  });

  await test('an STL authored at the origin lands beside the robot, on the ground', async () => {
    const seen = new Set(rps.model.components.map((c) => c.id));
    await rps.importFiles(boxSTL(40, 40, 40, 20).buffer, 'open-box.stl');
    const id = rps.model.components.map((c) => c.id).filter((x) => !seen.has(x)).pop();
    await sleep(300);
    const b = rps.componentBox(id);
    assert(b.min[0] > 100 && Math.abs(b.min[2] - rps.model.groundZ) < 1e-6, `landed at x ${b.min[0]}, z ${b.min[2]}`);
    rps.removeComponents([id]);
    await sleep(300);
    return `x ${round(b.min[0], 1)}…${round(b.max[0], 1)} · z ${round(b.min[2], 1)}`;
  });

  await test('an old #/design/pincopen link opens LeKiwi + PincOpen with a one-line notice', async () => {
    win.location.hash = '#/';
    await waitFor(() => q('.home .card1'), 20000, 'Home');
    win.location.hash = '#/design/pincopen';
    const said = () => (q('.status .msg') || {}).textContent || '';
    await waitFor(() => win.__rps.readouts().route === 'design:lekiwi-pincopen' && win.__rps.readouts().treeRows > 0
      && /attachment, not a robot/.test(said()), 60000, 'the default robot and its notice');
    rps = win.__rps;
    assert(win.location.hash === '#/design/lekiwi-pincopen', 'the hash still says ' + win.location.hash);
    assert(rps.readouts().robot === 'lekiwi-pincopen', rps.readouts().robot);
    const note = said();
    const r = rps.loadDesign(JSON.stringify({ schema: 'rps/design@1', robot: 'pincopen', slots: { fingertips: 'original' } }));
    assert(!r.ok && /attachment, not a robot/.test(r.errors[0]), 'a bare PincOpen design: ' + JSON.stringify(r.errors));
    return note;
  });

  await test('PincOpen fingertips: a mirrored pair is one key; Scale 120 % normal to the mount face keeps the face', async () => {
    const geom = (id) => rps.ctx.model.component(id).geometry;
    if (rps.ops(TIP).length) { rps.store.clearOps([TIP], 'reset'); await sleep(300); }
    rps.select(TIP2);
    await sleep(250);
    assert(rps.opsBar().shown && rps.ctx.partKey(TIP2) === TIP, 'the pair is not one key');
    const thick = () => { const g = geom(TIP); g.computeBoundingBox(); return g.boundingBox.max.y - g.boundingBox.min.y; };
    const t0 = thick();
    q('.opbar [data-op="scale"]').click();
    await sleep(250);
    q('.oppop [data-role="mode"] [data-id="axis"]').click();
    const inp = setField('pct-y', '120');
    await sleep(400);
    assert(!qa('.oppop .opwarn .chip').some((c) => /bolt/.test(c.textContent)), 'a normal-to-face scale warned');
    enter(inp);
    await sleep(400);
    assert(geom(TIP) === geom(TIP2), 'the pair split');
    assert(Math.abs(thick() - 1.2 * t0) < 1e-4, `thickness ${t0} → ${thick()}`);
    const g = geom(TIP);
    assert(Math.abs(g.boundingBox.min.y + 7.75) < 1e-5, 'the mount face moved to ' + g.boundingBox.min.y);
  });

  await test('a comma decimal is a decimal, garbage goes red; Reset puts the package geometry back', async () => {
    q('.opbar [data-op="scale"]').click();
    await sleep(250);
    const inp = setField('pct', '112,5');
    await sleep(300);
    assert(!inp.classList.contains('bad'), '"112,5" went red');
    setField('pct', '12,5mm');
    await sleep(150);
    assert(inp.classList.contains('bad'), 'garbage stayed white');
    escape(inp);
    await sleep(250);
    assert(rps.ops(TIP).length === 1, 'Esc applied something');
    rps.setTab('shape');
    await sleep(200);
    q('.ibody [data-role="reset-ops"]').click();
    await sleep(300);
    assert(!rps.ops(TIP).length, 'Reset kept the ops');
    rps.dispatch('global.undo');
    await sleep(400);
    assert(rps.ops(TIP).length === 1, 'undo did not bring the edit back');
  });

  await test('no console errors', async () => {
    const errs = rps.readouts().errors;
    assert(!errs.length, errs.slice(0, 3).join(' | '));
    return 'clean';
  });
}

start(run, () => ({ notes }));
