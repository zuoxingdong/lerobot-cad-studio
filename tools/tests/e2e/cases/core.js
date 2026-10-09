/* Core flows on the built page: Home (two robots) → Design, the tree, slot swaps and their cascades, the
   jaw, the Options list, import, delete / restore, a gizmo move, Recents and a URDF import. */

import { frame, sleep, waitFor, test, assert, start, openDesign, boxSTL, homeImport } from './_case.js';

let win = null, rps = null;
const doc = () => win.document;
const q = (s) => doc().querySelector(s);
const qa = (s) => [...doc().querySelectorAll(s)];
const esc = () => doc().dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

/** where the design, the model, the mesh and the collision world each put a part */
function placementOf(id) {
  const c = rps.model.component(id), mesh = rps.page.meshes.get(id), w = rps.ctx.collide();
  const at = (m) => (m ? [m.elements[12], m.elements[13], m.elements[14]] : null);
  return {
    design: ((rps.store.getState().components || {})[id] || {}).transform || null,
    local: c && c.local ? at(c.local) : null, mesh: mesh ? at(mesh.matrix) : null,
    body: w && w.parts && w.parts.get(id) ? at(w.worldMatrix(id)) : null,
  };
}
const near = (a, b) => a && b && Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.5;

async function run() {
  win = frame.contentWindow;

  await test('Home → the default robot opens on Design', async () => {
    await waitFor(() => q('.home .card1'), 30000, 'Home');
    const pkgs = qa('.home .pkgs .pkg .n').map((n) => n.textContent);
    assert(/PincOpen/.test(q('.home .card1').getAttribute('aria-label')) && pkgs.join() === 'LeKiwi (stock)',
      'Home offers ' + [q('.home .card1').getAttribute('aria-label'), ...pkgs].join(' · '));
    q('.home .card1').click();
    await waitFor(() => win.__rps && win.__rps.page && win.__rps.readouts().treeRows > 0, 60000, 'the design page');
    rps = win.__rps;
    const r = rps.readouts();
    assert(r.route === 'design:lekiwi-pincopen', r.route);
    assert(r.components >= 60, r.components + ' components');
    return `${r.components} components · ${r.treeRows} rows`;
  });

  await test('the page declares UTF-8 (the server sends no charset)', async () => {
    const meta = win.document.querySelector('head > meta[charset]');
    assert(meta && /^utf-8$/i.test(meta.getAttribute('charset')) && win.document.characterSet === 'UTF-8',
      'decoded as ' + win.document.characterSet);
  });

  await test('tree: Parts you can change lists every slot, Stock robot is collapsed, no unfitted part is listed', async () => {
    const g = (k) => q(`.tree .grow[data-group="${k}"]`);
    assert(g('changes').getAttribute('aria-expanded') === 'true', 'Parts you can change is closed');
    assert(g('stock').getAttribute('aria-expanded') === 'false', 'Stock robot is open');
    const want = Object.keys(rps.ctx.slots.slots).length;
    assert(rps.slotRows().length === want, `${rps.slotRows().length} slot rows for ${want} slots`);
    const unfit = rps.ctx.slots.unfittedSet(rps.store.getState());
    assert(!qa('.tree .row[data-id]').some((r) => unfit.has(r.dataset.id)), 'an unfitted part is listed');
    assert(!qa('.tree .row[data-id] .swap').length, 'a part row carries ⇄');
    g('stock').click();
    await sleep(80);
    const wheels = qa('.tree .row[data-id]').filter((r) => /Omni-Directional-Wheel/.test(r.dataset.id)).length;
    g('stock').click();
    assert(wheels === 3, wheels + ' wheel rows');
  });

  await test('swap: no mast switches the top camera off; the mast back restores its pose', async () => {
    const pose0 = rps.camPose('top');
    rps.swap('top_camera_mount', 'none');
    await sleep(400);
    assert(!rps.camPose('top'), 'the top camera is still posed');
    rps.swap('top_camera_mount', 'corner_mast_printed');
    await sleep(400);
    const pose1 = rps.camPose('top');
    for (let i = 0; i < 3; i++) assert(Math.abs(pose1.origin[i] - pose0.origin[i]) < 1e-6, 'the sensor moved on axis ' + i);
  });

  await test('swap: the wrist mount changes the tree; a gripper swap fires the cross-slot rules', async () => {
    rps.swap('wrist_camera_mount', 'pincopen_holder');
    await sleep(200);
    const ids = qa('.tree .row').map((x) => x.dataset.id);
    assert(ids.includes('pincopen/camera_basement') && !ids.includes('df200_arch_arch'), 'the tree did not follow the swap');
    rps.swap('wrist_camera_mount', 'df200_arch');
    const before = rps.readouts().slots;
    rps.swap('gripper', 'stock_jaw');
    await sleep(400);
    const after = rps.readouts().slots;
    const moved = Object.keys(after).filter((k) => k !== 'gripper' && after[k] !== before[k]);
    assert(moved.length, 'no cascade');
    assert(/also/.test(q('.status .msg').textContent), 'the status does not name the cascade');
    const grip = rps.motionJoints().filter((j) => j.gripper);
    assert(grip.length === 1 && grip[0].name === 'arm_gripper', 'the gripper row is ' + grip.map((j) => j.name));
    rps.swap('gripper', 'pincopen');
    await sleep(500);
    return 'also ' + moved.map((k) => `${k} → ${after[k]}`).join(', ');
  });

  await test('the Jaw row is the finger gap in mm; FK turns the four-bar rods', async () => {
    const g = rps.motionJoints().filter((j) => j.gripper);
    assert(g.length === 1 && g[0].name === 'pincopen/jaw', g.map((j) => j.name).join());
    assert(g[0].unit === 'mm' && g[0].min === 0 && g[0].max === 40, `${g[0].min}…${g[0].max} ${g[0].unit}`);
    const at = () => rps.ctx.model.worldMatrix('pincopen/distal_shell').elements.slice(12, 15);
    const a = at();
    rps.setJoint('pincopen/jaw', g[0].fromDisplay(36));
    await sleep(200);
    const b = at();
    assert(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) > 5, 'the finger did not move');
    const rod = [...rps.page.meshes].find(([id]) => /internal_rod$/.test(id));
    rps.setJoint('pincopen/jaw', 0);
    await sleep(200);
    const fk = rps.ctx.model.worldMatrix(rod[0]).elements;
    assert(Math.max(...fk.map((v, i) => Math.abs(v - rod[1].matrix.elements[i]))) < 1e-9, 'the rod mesh is not model.worldMatrix');
  });

  await test('the arm presets come from the package and are collision-free', async () => {
    const list = rps.presets();
    assert(list.length === 4 && list.every((p) => /\.presets$/.test(p.source)), list.map((p) => p.source).join());
    const bad = rps.presetCheck().filter((x) => !x.ok);
    assert(!bad.length, 'blocked: ' + bad.map((x) => x.id).join());
  });

  await test('[ ] cycle the selected part\'s slot options', async () => {
    rps.select('df200_arch_arch');
    const before = rps.readouts().slots.wrist_camera_mount;
    rps.dispatch('design.variant', { delta: 1 });
    await sleep(150);
    assert(rps.readouts().slots.wrist_camera_mount !== before, 'no cycle');
    rps.swap('wrist_camera_mount', before);
    await sleep(200);
  });

  await test('Options: one line per option, Import… and Ask agent; the one-design-per-slot lists', async () => {
    const WANT = {
      top_camera_mount: ['Corner mast, printed · 45°', 'No overhead camera (stock LeKiwi)'],
      wrist_camera_mount: ['DF200 arch · 35°', 'PincOpen camera holder (as assembled)', 'Stock LeKiwi wrist camera', 'No wrist camera'],
      gripper: ['PincOpen (as assembled)', 'Stock SO-101 jaw', 'No gripper (bare wrist)'],
      front_camera: ['Stock LeKiwi front camera', 'No front camera'],
    };
    for (const [sid, want] of Object.entries(WANT)) {
      rps.ctx.on.swapSlot(sid, q('.topbar'));
      const pop = await waitFor(() => q('.pop'), 5000, 'the Options popover');
      await sleep(150);
      const rows = [...pop.querySelectorAll('.opt')];
      const names = rows.map((c) => c.dataset.label);
      assert(JSON.stringify(names) === JSON.stringify(want), `${sid}: ${names.join(' | ')}`);
      assert(!rows.some((o) => o.getBoundingClientRect().height > 32), sid + ': an option is more than one line');
      assert(pop.querySelector('[data-role="import"]') && pop.querySelector('[data-role="ask"]'), 'no Import… / Ask agent');
      assert(pop.getBoundingClientRect().bottom <= win.innerHeight, 'the popover runs off the window');
      esc();
      await sleep(120);
      assert(!q('.pop'), 'Esc did not close it');
    }
  });

  await test('a package zip imports under Imported and selects', async () => {
    const buf = await (await fetch('/out/work/e2e/fixtures/box-kit.zip')).arrayBuffer();
    const n0 = rps.readouts().components;
    await rps.importZip(buf, 'box-kit.zip');
    await sleep(400);
    const imported = qa('.tree .row').map((x) => x.dataset.id).filter((id) => id && id.startsWith('imported/'));
    assert(rps.readouts().components > n0 && imported.length, 'nothing imported');
    rps.select(imported[0]);
    await sleep(100);
    assert(rps.readouts().selected === imported[0], 'not selectable');
    rps.removeComponents(imported);
    await sleep(300);
  });

  await test('emptying a slot: its row reads None with ⇄; undo restores it', async () => {
    const before = rps.readouts();
    const fitted = before.slots.wrist_camera_mount;
    rps.removeSlot('wrist_camera_mount');
    await sleep(350);
    const mid = rps.readouts();
    assert(mid.slots.wrist_camera_mount === 'none' && mid.visible < before.visible, 'the slot did not empty');
    const hole = q('.tree .row.hole[data-slot="wrist_camera_mount"]');
    assert(hole && /None/.test(hole.textContent) && hole.querySelector('.rowbtn.swap'), 'no "None" row with ⇄');
    rps.dispatch('global.undo');
    await sleep(400);
    const after = rps.readouts();
    assert(after.slots.wrist_camera_mount === fitted && after.visible === before.visible, 'undo did not restore it');
  });

  await test('Delete: a stock plate goes under Removed and out of the gate; Restore; a multi-delete is one undo', async () => {
    const id = 'base_plate_layer1-v5';
    const before = rps.readouts();
    const inGate = () => rps.designReport().components.map((c) => c.id).includes(id);
    assert(inGate(), 'not in the gate to begin with');
    rps.removeComponents([id]);
    await sleep(350);
    assert(rps.readouts().removed.includes(id) && rps.readouts().visible === before.visible - 1, 'not removed');
    const grp = qa('.tree .grow').find((g) => /Removed/.test(g.textContent));
    assert(grp && grp.getAttribute('aria-expanded') === 'true', 'the Removed group is not open');
    assert(q(`.tree .row.rm[data-id="${id}"] .rowbtn.restore`), 'no Restore on its row');
    assert(!inGate(), 'still in the export gate');
    rps.restoreComponents([id]);
    await sleep(350);
    assert(!rps.readouts().removed.includes(id) && inGate(), 'Restore did not bring it back');
    const n0 = rps.readouts().removed.length;
    rps.select('Camera-Mount-v8');
    rps.select(id, 'add');
    rps.dispatch('selection.delete');
    await sleep(350);
    assert(rps.readouts().removed.length === n0 + 2, 'the multi-delete missed one');
    rps.dispatch('global.undo');
    await sleep(400);
    assert(rps.readouts().removed.length === n0 && rps.readouts().visible === before.visible, 'one undo did not take both back');
  });

  await test('a gizmo drag moves the design, the model, the mesh and the collision body; undo moves all back', async () => {
    const seen = new Set(rps.model.components.map((c) => c.id));
    await rps.importFiles(boxSTL(24, 24, 24, 12).buffer, 'bracket.stl');
    const id = rps.model.components.map((c) => c.id).filter((x) => !seen.has(x)).pop();
    await sleep(400);
    const at0 = placementOf(id);
    const drag = (to) => {
      const mesh = rps.page.meshes.get(id), g = rps.page.gizmo;
      g.attach(mesh);
      g.controls.dispatchEvent({ type: 'dragging-changed', value: true });
      mesh.position.set(...to);
      g.controls.dispatchEvent({ type: 'objectChange' });
      g.controls.dispatchEvent({ type: 'dragging-changed', value: false });
    };
    drag([-103, 77, 23]);
    await sleep(400);
    const m = placementOf(id);
    assert(m.design && near(m.local, [-103, 77, 23]) && near(m.mesh, [-103, 77, 23]) && near(m.body, [-103, 77, 23]), JSON.stringify(m));
    rps.dispatch('global.undo');
    await sleep(500);
    const b = placementOf(id);
    assert(!b.design && near(b.local, at0.local) && near(b.mesh, at0.mesh) && near(b.body, at0.body || at0.local), JSON.stringify(b));
    rps.page.setStatus('ready');
    drag([0, 0, 60]);
    await sleep(500);
    const said = q('.status .msg').textContent;
    assert(/^blocked · /.test(said), 'a drag into the chassis said nothing: ' + said);
    rps.removeComponents([id]);
    await sleep(300);
  });

  await test('the selected part exports a binary STL', async () => {
    const b = rps.stlBytes('corner_mast_printed_spar_lower');
    assert(b && b.length > 84, 'no STL');
    window.__e2eStl = b.base64;
    return b.length + ' bytes';
  });

  await test('Recents: an untouched design reads "defaults"', async () => {
    rps.ctx.on.resetDefaults();
    await sleep(2600);
    assert(!qa('.tree .row.slot .badge .dot').length, 'a slot row says changed');
    win.location.hash = '#/';
    await waitFor(() => q('.rrow'), 20000, 'a Recents row');
    await sleep(300);
    const row = (q('.rrow .rs') || {}).textContent;
    assert(row === 'defaults', `"${row}"`);
  });

  await test('Home: an alternative zip → Fit it opens its robot with the design fitted', async () => {
    const bytes = new Uint8Array(await (await fetch('/out/work/e2e/fixtures/corner_mast_meta.zip')).arrayBuffer());
    await homeImport(win, [[bytes, 'corner_mast_meta.zip']], 'Fit it');
    await waitFor(() => win.__rps && win.__rps.page && win.__rps.readouts().treeRows > 0 && /^#\/design\//.test(win.location.hash), 60000, 'the design page');
    rps = win.__rps;
    await rps.altReady();
    await sleep(600);
    const r = rps.readouts();
    assert(/^alt:/.test(r.slots.top_camera_mount || '') && r.treeAlt.length, 'not fitted: ' + r.slots.top_camera_mount);
    return r.slots.top_camera_mount;
  });

  await test('a URDF zip gets its own route id and printables, and survives a reload', async () => {
    const bytes = new Uint8Array(await (await fetch('/out/work/e2e/fixtures/urdf-import.zip')).arrayBuffer());
    win.location.hash = '#/';
    await waitFor(() => q('.home .card1'), 20000, 'Home');
    await homeImport(win, [[bytes, 'lekiwi-urdf.zip']], 'Open');
    await waitFor(() => win.__rps && win.__rps.page && win.__rps.readouts().components > 0 && /^import-/.test(win.__rps.readouts().robot), 40000, 'the import');
    rps = win.__rps;
    const r = rps.readouts();
    assert(rps.model.printables().length > 0, 'no printables');
    const errs = [...r.errors];
    win.location.reload();
    await sleep(500);
    win = frame.contentWindow;
    await waitFor(() => win.__rps && win.__rps.page && win.__rps.readouts().components > 0, 60000, 'the import after a reload');
    rps = win.__rps;
    assert(rps.readouts().robot === r.robot && rps.readouts().components === r.components, 'the reload lost it');
    assert(!errs.length, 'console errors before the reload: ' + errs.slice(0, 3).join(' | '));
    return `${r.robot} · ${r.components} components`;
  });

  await test('no console errors', async () => {
    const errs = rps.readouts().errors;
    assert(!errs.length, errs.slice(0, 3).join(' | '));
  });
}

start(run, () => ({ stl: window.__e2eStl || null }));
