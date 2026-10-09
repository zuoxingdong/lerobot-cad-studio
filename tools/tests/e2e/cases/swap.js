/* Slots on the built page: one mount per seat, the whole stock gripper on stock_jaw, a bare
   wrist, every camera on the mount that is fitted, Reset = the boot design, stored designs
   reconciled at boot, an imported alternative through undo, a reload and a re-fit. */

import { frame, sleep, waitFor, test, assert, start, openDesign } from './_case.js';

let win = null, rps = null;
const doc = () => win.document;
const q = (s) => doc().querySelector(s);
const drawn = (id) => { const m = rps.page.meshes.get(id); return m ? !!m.visible : false; };
const rowIds = () => [...doc().querySelectorAll('.tree .row')].map((x) => x.dataset.id);
const hidden = () => { const m = (q('.treefoot') || {}).textContent.match(/(\d+) hidden/); return m ? Number(m[1]) : 0; };
const pincopenDrawn = () => rps.model.components.filter((c) => c.id.startsWith('pincopen/') && drawn(c.id)).length;
/** the frustum apex to a component's box, mm (0 inside) */
function apexTo(pose, id) {
  const b = rps.componentBox(id);
  if (!pose || !b) return null;
  let d = 0;
  for (let i = 0; i < 3; i++) {
    const v = pose.origin[i] < b.min[i] ? b.min[i] - pose.origin[i] : (pose.origin[i] > b.max[i] ? pose.origin[i] - b.max[i] : 0);
    d += v * v;
  }
  return Math.sqrt(d);
}
async function reload() {
  win.location.reload();
  await sleep(400);
  win = frame.contentWindow;
  rps = await waitFor(() => (win.__rps && win.__rps.page && win.__rps.readouts && win.__rps.readouts().treeRows > 0 ? win.__rps : null), 60000, 'the page after a reload');
  await rps.altReady();
  await sleep(600);
}
async function reset() {
  rps.ctx.on.resetDefaults();
  await sleep(700);
}

const HOLDER = ['pincopen/camera_basement', 'pincopen/camera_mobile_sup'];
const ARCH = ['df200_arch_arch', 'df200_arch_head', 'df200_arch_retainer', 'df200_arch_df200'];
const STOCK_GRIPPER = ['Wrist_Roll_08c-v1', 'Moving_Jaw_08d-v1', 'STS3215_03a-v1-4'];
const BOOT = { drawn: 69, slots: { top_camera_mount: 'corner_mast_printed', wrist_camera_mount: 'df200_arch', gripper: 'pincopen',
  fingertips: 'original', pi_case: 'vertical_revI', front_camera: 'stock' } };
const drawnCount = () => [...rps.page.meshes].filter(([, m]) => m.visible).length;

async function run() {
  win = frame.contentWindow;
  rps = await openDesign(win);
  await sleep(500);

  await test('boot: one wrist mount, one gripper, 69 meshes, nothing hidden', async () => {
    const r = rps.readouts();
    assert(JSON.stringify(r.slots) === JSON.stringify({ ...r.slots, ...BOOT.slots }), JSON.stringify(r.slots));
    assert(drawnCount() === BOOT.drawn, drawnCount() + ' meshes');
    assert(ARCH.every(drawn), 'the arch is not whole');
    for (const id of [...HOLDER, ...STOCK_GRIPPER]) assert(!drawn(id) && !rowIds().includes(id) && rps.ctx.unfitted().has(id), id + ' is on the robot');
    assert(drawn('pincopen/cam') && pincopenDrawn() === 20, pincopenDrawn() + '/20 PincOpen parts');
    assert(!r.treeHoles.length && hidden() === 0, 'a None row or hidden part at boot');
  });

  await test('stock_jaw brings the whole stock gripper back and cascades the wrist camera onto its bracket', async () => {
    const arch = rps.camPose('wrist');
    const st = rps.swap('gripper', 'stock_jaw');
    await sleep(700);
    for (const id of STOCK_GRIPPER) assert(drawn(id) && rowIds().includes(id), id + ' did not come back');
    assert(st.slots.wrist_camera_mount === 'stock' && st.slots.fingertips === 'none', JSON.stringify(st.slots));
    assert(!pincopenDrawn(), 'PincOpen parts survived');
    const cp = rps.camPose('wrist');
    assert(/slot:wrist_camera_mount/.test(cp.source) && apexTo(cp, 'Camera-Model-v3-1') === 0, 'the camera is not in its bracket');
    assert(Math.hypot(...cp.origin.map((v, i) => v - arch.origin[i])) > 20, 'the camera stayed on the arch');
    assert(rps.ctx.cams.get('wrist').hfov_deg === 87.3, 'the lens changed');
  });

  await test('no gripper is a bare wrist and switches the wrist camera off; the arch brings it back', async () => {
    rps.swap('gripper', 'pincopen');
    rps.swap('wrist_camera_mount', 'df200_arch');
    await sleep(700);
    const none = rps.swap('gripper', 'none');
    await sleep(700);
    for (const id of STOCK_GRIPPER) assert(!drawn(id), id + ' on a bare wrist');
    assert(none.slots.wrist_camera_mount === 'none' && !rps.camPose('wrist'), 'the wrist camera is still posed');
    assert(rps.store.get('cameras.wrist.enabled') === false, 'the camera is not off');
    rps.swap('gripper', 'pincopen');
    await sleep(700);
    assert(!rps.camPose('wrist'), 'the gripper invented a wrist mount');
    rps.swap('wrist_camera_mount', 'df200_arch');
    rps.swap('fingertips', 'original');
    await sleep(700);
    assert(apexTo(rps.camPose('wrist'), 'df200_arch_head') === 0 && rps.store.get('cameras.wrist.enabled') !== false, 'the camera did not come back');
    assert(pincopenDrawn() === 20 && hidden() === 0, pincopenDrawn() + ' PincOpen parts');
  });

  await test('every camera slot × option: the apex is on the fitted mount, or the camera is off', async () => {
    rps.store.set('ui.frustums', true);
    const S = rps.ctx.slots.slots;
    const rows = [];
    for (const sid of Object.keys(S)) for (const p of S[sid].provides || []) {
      if (!p.startsWith('cameras.')) continue;
      const cid = p.slice(8);
      for (const o of S[sid].options) {
        if (o.kind === 'import') continue;
        await reset();
        rps.swap(sid, o.id);
        await sleep(600);
        const opt = rps.ctx.slots.option(sid, rps.ctx.slots.activeOption(rps.store.getState(), sid));
        const pose = rps.camPose(cid);
        const block = ((opt && opt.cameras) || {})[cid];
        if (!pose) {
          assert(!block, `${sid}=${o.id}: ${cid} has no pose although the option publishes one`);
          assert(rps.store.get(`cameras.${cid}.enabled`) === false, `${sid}=${o.id}: ${cid} is not switched off`);
          rows.push(`${o.id}: off`);
          continue;
        }
        const vis = rps.ctx.visible();
        const d = Math.min(...(opt.shows || []).filter((id) => vis.get(id) !== false).map((id) => apexTo(pose, id)).filter((x) => x != null));
        assert(d <= 25, `${sid}=${o.id}: the ${cid} apex is ${d.toFixed(1)} mm from its mount`);
        assert(pose.source === 'slot:' + sid, `${sid}=${o.id}: pose from ${pose.source}`);
        const m = /(-?\d+(?:\.\d+)?)\s*°/.exec(opt.label || '');
        if (m && block && !block.carrier && (opt.frame || 'robot') === 'robot') {
          assert(Math.abs(Number(m[1]) - pose.tilt_deg) < 0.51, `${sid}=${o.id}: label ${m[1]}°, pose ${pose.tilt_deg}°`);
        }
        rows.push(`${o.id}: ${d.toFixed(1)} mm`);
      }
    }
    assert(rows.length === 8, rows.length + ' option/camera pairs');
    return rows.join(' · ');
  });

  await test('Reset is the boot design and re-adopts every slot camera; a swap after it moves one slot', async () => {
    rps.swap('wrist_camera_mount', 'pincopen_holder');
    rps.swap('top_camera_mount', 'none');
    await sleep(600);
    await reset();
    assert(drawnCount() === BOOT.drawn, drawnCount() + ' meshes after Reset');
    const st = rps.store.getState();
    for (const [sid, oid] of Object.entries(BOOT.slots)) assert(rps.ctx.slots.activeOption(st, sid) === oid, sid + ' is ' + rps.ctx.slots.activeOption(st, sid));
    assert(!drawn('pincopen/camera_basement'), 'the holder is drawn under the arch');
    const p = rps.camPose('top');
    assert(p && apexTo(p, 'corner_mast_printed_head') < 25 && Math.abs(p.tilt_deg - 45) < 0.05, 'the top camera is not on the mast');
    const before = { ...rps.readouts().slots };
    rps.swap('pi_case', 'none');
    await sleep(700);
    const after = rps.readouts().slots;
    assert(Object.keys(after).filter((k) => after[k] !== before[k]).join() === 'pi_case', 'the swap moved more than one slot');
    assert(drawnCount() === BOOT.drawn - 2, drawnCount() + ' meshes');
  });

  await test('one undo after one swap restores the slots, the scene and the tree', async () => {
    await reset();
    const before = rps.readouts();
    rps.swap('top_camera_mount', 'none');
    await sleep(250);
    rps.dispatch('global.undo');
    await sleep(400);
    const after = rps.readouts();
    assert(JSON.stringify(after.slots) === JSON.stringify(before.slots) && after.visible === before.visible, 'undo did not restore');
  });

  await test('a design for another robot is refused by name; a malformed one is repaired and named', async () => {
    const slots0 = JSON.stringify(rps.store.getState().slots);
    const r = rps.store.importJSON(JSON.stringify({ schema: 'rps/design@1', robot: 'lekiwi', cameras: { top: { hfov_deg: 120 } } }), { merge: true });
    assert(r.ok === false && r.errors[0] === 'design is for lekiwi; open that robot first', JSON.stringify(r));
    assert(JSON.stringify(rps.store.getState().slots) === slots0, 'the slots moved');
    const bad = rps.loadDesign(JSON.stringify({ schema: 'rps/design@1', robot: 'lekiwi-pincopen', joints: 'x', removed: ['a'], cameras: 'nope' }));
    assert(bad.ok && bad.warnings.length >= 3, JSON.stringify(bad.warnings));
    await sleep(400);
    assert(/dropped/.test(q('.status .msg').textContent), 'the status says nothing');
    assert(rps.readouts().treeRows > 0 && !rps.readouts().errors.length, 'the page broke');
  });

  await test('a stale or retired autosave is reconciled at boot: defaults, no ghosts, nothing hidden', async () => {
    const design = { schema: 'rps/design@1', robot: 'lekiwi-pincopen',
      slots: { wrist_camera_mount: 'normacam_22', top_camera_mount: 'mast_rev8_65', fingertips: 'tip_K_combined', gripper: 'pincopen', wrist_cable: 'clip_F' },
      components: { 'pincopen/camera_basement': { visible: true }, 'Wrist_Roll_08c-v1': { visible: true }, normacam_22: { visible: true } },
      joints: 'nope' };
    win.sessionStorage.setItem('rps/session@1', JSON.stringify({ when: Date.now(), design }));
    await reload();
    const r = rps.readouts();
    for (const [sid, oid] of Object.entries(BOOT.slots)) assert(r.slots[sid] === oid, `${sid} is ${r.slots[sid]}`);
    assert(rps.ctx.slots.slots.wrist_cable === undefined && !rps.ctx.model.component('normacam_22'), 'a retired id came back');
    for (const id of [...HOLDER, ...STOCK_GRIPPER]) assert(!drawn(id), id + ' survived the reconcile');
    assert(ARCH.every(drawn) && pincopenDrawn() === 20 && !r.treeHoles.length && hidden() === 0, 'not the boot design');
    win.sessionStorage.removeItem('rps/session@1');
  });

  const SENSOR = [-75.3398685057, -18.5710809793, 504.854682432];
  let printables0 = 0;
  await test('an imported alternative fits, poses the top camera from its robot-frame block, and undo unfits it whole', async () => {
    printables0 = rps.model.printables().length;
    const bytes = new Uint8Array(await (await fetch('/out/work/e2e/fixtures/corner_mast_meta.zip')).arrayBuffer());
    rps.select('corner_mast_printed_spar_lower');
    rps.setTab('options');
    (await waitFor(() => q('.ibody .sec[data-sec="options"] [data-role="import"]'), 15000, 'Import…')).click();
    const input = await waitFor(() => q('.scrim .sheet input[type=file]'), 15000, 'the import dialog');
    const dt = new win.DataTransfer();
    dt.items.add(new win.File([bytes], 'corner_mast_meta.zip', { type: 'application/zip' }));
    input.files = dt.files;
    input.dispatchEvent(new win.Event('change'));
    (await waitFor(() => { const b = q('.scrim .sheet .df button.accent'); return b && !b.disabled && /Fit it/.test(b.textContent) ? b : null; }, 30000, 'Fit it')).click();
    await waitFor(() => rps.readouts().slots.top_camera_mount === 'alt:corner_mast_meta' && rps.altComponents().filter((c) => c.visible).length >= 4, 30000, 'the fit');
    await sleep(700);
    assert(!drawn('corner_mast_printed_spar_lower'), 'the package mast is still drawn');
    const p = rps.camPose('top');
    assert(p.origin.every((v, i) => Math.abs(v - SENSOR[i]) < 0.05), 'sensor ' + p.origin);
    rps.dispatch('global.undo');
    await sleep(700);
    assert(!rps.readouts().treeAlt.length && !rps.altComponents().length, 'alternative parts survived the undo');
    assert(rps.model.printables().length === printables0 && rps.collideNow().world.ok, 'a ghost is left');
    assert(drawn('corner_mast_printed_spar_lower'), 'the package mast did not come back');
  });

  await test('after a reload the cached alternative re-fits from IndexedDB; Reset takes it off again', async () => {
    await waitFor(async () => { const c = (await rps.altCached()).find((x) => x.id === 'corner_mast_meta'); return c && c.blobs === c.wanted; }, 15000, 'the cache');
    await reload();
    assert(!rps.altComponents().length && rps.model.printables().length === printables0, 'the boot rebuilt the ghost');
    const rec = rps.ctx.alternativesFor('top_camera_mount').find((a) => a.id === 'corner_mast_meta');
    assert(rec, 'the cached card was thrown away');
    await rps.fitAlternative('top_camera_mount', rec);
    await sleep(700);
    assert(rps.altComponents().filter((c) => c.visible).length >= 4, 'the re-fit drew nothing');
    assert(rps.camPose('top').origin.every((v, i) => Math.abs(v - SENSOR[i]) < 0.05), 'the re-fitted sensor moved');
    await reset();
    assert(!rps.altComponents().length && rps.model.printables().length === printables0 && rps.collideNow().world.ok, 'Reset left a ghost');
  });

  await test('no console errors', async () => {
    const errs = rps.readouts().errors;
    assert(!errs.length, errs.slice(0, 3).join(' | '));
  });
}

start(run);
