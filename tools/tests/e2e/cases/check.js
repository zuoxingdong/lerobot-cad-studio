/* The Check tab on the built page: three 4:3 tiles beside the viewport in a theme-independent
   environment, enlarge and look-through, Calibrate tilt… (guide, clamp, reload, clear, mount
   removal), the camera rows and their verdicts on load, and a preset stopped at an obstacle. */

import { frame, sleep, waitFor, test, assert, start, openDesign, boxSTL } from './_case.js';

let win = null, rps = null;
const doc = () => win.document;
const q = (s) => doc().querySelector(s);
const qa = (s) => [...doc().querySelectorAll(s)];
const tiles = () => qa('.camtiles .tile').filter((t) => !t.hidden && t.offsetParent);
const tileOf = (id) => q(`.camtiles .tile[data-cam="${id}"]`);
const status = () => (q('.status .msg') || {}).textContent || '';
const closeSheet = () => { const x = q('.sheet .dh .btn'); if (x) x.click(); };
async function toCheck() {
  if (!/^#\/check\//.test(win.location.hash)) win.location.hash = '#/check/lekiwi-pincopen';
  await waitFor(() => q('.app.check-on') && tiles().length, 20000, 'the Check tab');
  rps = win.__rps;
}
async function settle(ms = 400) {
  await sleep(ms);
  rps.page.strip.forceTick();
  await sleep(160);
}
function pixels(id) {
  const cv = tileOf(id).querySelector('canvas');
  return cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
}
function diffFrac(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 12) n++;
  return n / (a.length / 4);
}
const camDots = () => Object.fromEntries(qa('.ctable tbody tr').filter((t) => (t.dataset.id || '').startsWith('cam:'))
  .map((t) => [t.dataset.id.slice(4), qa(`.ctable tbody tr[data-id="${t.dataset.id}"] td.fam .dot`).map((d) => d.title)]));

async function run() {
  win = frame.contentWindow;
  rps = await openDesign(win);
  await toCheck();
  await settle(800);

  await test('the camera rows carry the current pose\'s verdict on load; Sweep all adds one per preset', async () => {
    const only = q('.ctbar input[type=checkbox]');
    if (only.checked) only.click();
    await sleep(300);
    const d0 = camDots();
    assert(Object.keys(d0).sort().join() === 'front,top,wrist', 'camera rows: ' + Object.keys(d0));
    for (const [cam, t] of Object.entries(d0)) assert(t.length === 1 && /^Stowed: .*robot fills/.test(t[0]), cam + ': ' + t.join(' | '));
    const q0 = JSON.stringify(rps.ctx.model.getJoints());
    const preset0 = rps.store.get('ui.preset');
    [...qa('.check-on .btn, button')].find((b) => b.textContent.includes('Sweep all')).click();
    await sleep(1500);
    const d1 = camDots();
    for (const [cam, t] of Object.entries(d1)) assert(t.length === rps.presets().length, `${cam}: ${t.length} dots after the sweep`);
    /* the sweep restores the pose it started from, and its verdicts feed the roll-up */
    assert(JSON.stringify(rps.ctx.model.getJoints()) === q0, 'the sweep left the arm at another pose');
    assert(rps.store.get('ui.preset') === preset0, 'the pose row moved');
    const c = rps.page.checksNow();
    const swept = c.rows.filter((r) => r.kind === 'camera' && r.sweep);
    assert(swept.length === 3, swept.length + ' camera rows carry the sweep');
    const amber = swept.filter((r) => r.sweep.some((x) => x.level === 'warn' || x.level === 'fail'));
    for (const r of amber) assert(r.cameras.level !== 'pass', `${r.cam}: an amber pose, yet the row is ${r.cameras.level}`);
    const pill = q('.checkspill');
    /* the inspector's Design line follows the same roll-up as the pill, without a click */
    await sleep(300);
    const line = qa('.fline').find((l) => (l.querySelector('.k') || {}).textContent === 'Design');
    assert(!line || line.dataset.level === pill.dataset.level, `inspector ${line && line.dataset.level}, pill ${pill.dataset.level}`);
    if (amber.length) {
      assert(c.level !== 'pass', 'the roll-up ignores the sweep');
      assert(!/Checks ok/.test(pill ? pill.textContent : ''), 'the pill says ok: ' + (pill && pill.textContent));
    }
    only.click();
    await sleep(200);
    if (amber.length) assert(qa('.ctable tbody tr').some((t) => (t.dataset.id || '').startsWith('cam:')), 'Only problems hides the amber camera rows');
    return Object.entries(d0).map(([k, v]) => `${k} "${v[0]}"`).join(' · ') + ` · swept: ${amber.map((r) => r.cam + ' ' + r.cameras.reason).join(', ') || 'all pass'}`;
  });

  await test('three 4:3 tiles beside the viewport, none on Design; the same picture in both themes', async () => {
    const cr = q('.canvas').getBoundingClientRect(), pr = q('.camtiles').getBoundingClientRect();
    assert(!q('.canvas').contains(q('.camtiles')) && pr.left >= cr.right - 1, 'the tiles overlap the viewport');
    assert(tiles().length === 3, tiles().length + ' tiles');
    for (const t of tiles()) {
      const pic = t.querySelector('.pic').getBoundingClientRect(), cv = t.querySelector('canvas');
      assert(Math.abs(pic.width / pic.height - 4 / 3) < 0.01 && Math.abs(cv.width / cv.height - 4 / 3) < 0.01, t.dataset.cam + ' is not 4:3');
      assert(t.querySelector('.th .n').textContent.trim(), 'a tile has no name');
    }
    const theme0 = rps.store.get('ui.theme', 'auto');
    const to = async (t) => { while (rps.store.get('ui.theme', 'auto') !== t) rps.page.cycleTheme(); await settle(400); };
    await to('light');
    const light = pixels('front');
    await to('dark');
    const moved = diffFrac(light, pixels('front'));
    await to(theme0);
    assert(moved < 0.02, `${(moved * 100).toFixed(1)} % of the front tile changed with the theme`);
    win.location.hash = '#/design/lekiwi-pincopen';
    await waitFor(() => !q('.app.check-on'), 10000, 'Design');
    await sleep(200);
    assert(!q('.camtiles').offsetParent, 'tiles on the Design tab');
    await toCheck();
  });

  await test('enlarge: a big 4:3 view with prev / next; Esc restores the tiles', async () => {
    tileOf('top').click();
    await sleep(300);
    assert(rps.cameraPanel().enlarged === 'top' && tiles().length === 1, 'not enlarged');
    const pic = tileOf('top').querySelector('.pic').getBoundingClientRect();
    assert(Math.abs(pic.width / pic.height - 4 / 3) < 0.01 && pic.height > 300, `${pic.width} × ${pic.height}`);
    q('.camtiles .bigbar button:nth-child(2)').click();
    await sleep(250);
    assert(rps.cameraPanel().enlarged === 'front', 'next did not move to front');
    rps.dispatch('global.escape');
    await sleep(250);
    assert(rps.cameraPanel().enlarged === null && tiles().length === 3, 'Esc did not restore');
  });

  await test('look-through: the viewport becomes the top camera and rides the base; unmounting it ends it', async () => {
    const L = rps.lookThrough('top');
    await sleep(300);
    const pose = rps.camPose('top'), cam = rps.ctx.cams.get('top');
    assert(L.id === 'top' && L.orbit === false && q('.lookhud'), 'not looking through');
    assert(Math.hypot(...L.camera.position.map((v, i) => v - pose.origin[i])) < 0.01, 'the render camera is off the sensor');
    assert(Math.abs(L.camera.fov - cam.vfov_deg) < 0.01 && Math.abs(L.rect.width / L.rect.height - cam.aspect) < 0.01, 'not the camera\'s intrinsics');
    rps.setBase({ x: 0, y: 250, yaw: 0 });
    await sleep(300);
    const L2 = rps.lookThrough();
    const rode = Math.hypot(...L2.pose.origin.map((v, i) => v - pose.origin[i]));
    rps.setBase({ x: 0, y: 0, yaw: 0 });
    await sleep(250);
    assert(Math.abs(rode - 250) < 5, `the camera rode ${rode.toFixed(1)} mm of 250`);
    rps.swap('top_camera_mount', 'none');
    await sleep(600);
    const off = rps.lookThrough();
    assert(off.id === null && off.orbit === true && !q('.lookhud'), 'still looking through a camera with no mount');
    rps.swap('top_camera_mount', 'corner_mast_printed');
    await sleep(600);
    await toCheck();
  });

  await test('Calibrate tilt…: a 3-step guide; +6.8° re-aims the top camera and shows Designed / Measured', async () => {
    const seg = () => q('.camhead .seg');
    assert(seg().hidden, 'Designed / Measured shows with nothing measured');
    await settle(300);
    const ev0 = JSON.parse(JSON.stringify(rps.page.strip.evaluation('top')));
    const pix0 = pixels('top');
    const dlg = rps.page.strip.calibrate('top');
    assert(qa('.sheet .steps li').length === 3, 'no 3-step guide');
    dlg.input.value = '6.8';
    dlg.input.dispatchEvent(new win.Event('change'));
    await sleep(100);
    q('.sheet .df .btn.accent').click();
    await settle(500);
    const c = rps.calib();
    assert(!seg().hidden && c.mode === 'installed', 'Measured is not shown');
    assert(Math.abs(c.cameras.find((x) => x.id === 'top').tilt_deg - 51.8) < 0.01, 'the tilt is not 45 + 6.8');
    assert(rps.store.getState().cameras.top.calib.tilt_deg === 6.8, 'design.cameras.top.calib did not record it');
    assert(!JSON.stringify(rps.store.getState().params || {}).includes('"tilt_deg"'), 'the calibration wrote a part parameter');
    const ev1 = rps.page.strip.evaluation('top');
    assert(Math.abs(ev1.pose.tilt_deg - ev0.pose.tilt_deg - 6.8) < 0.01, 'the verdict used the old pose');
    assert(diffFrac(pix0, pixels('top')) > 0.05, 'the tile did not change');
    assert(/measured/.test(tileOf('top').querySelector('.calchip').textContent), 'no measured chip');
  });

  await test('the measurement survives a reload; garbage keeps it and goes red; 1000° clamps to 90°; blank clears', async () => {
    rps.page.strip.setCalibMode('installed');
    await sleep(1600);
    win.__reloadMark = 1;
    win.location.reload();
    await waitFor(() => !win.__reloadMark && win.__rps && win.__rps.page && win.__rps.readouts().treeRows > 0, 60000, 'the reload');
    rps = win.__rps;
    await toCheck();
    await settle(700);
    assert(rps.calib().mode === 'installed' && Math.abs(rps.calib('top').calib.tilt_deg - 6.8) < 1e-6, 'the reload lost it');
    const input = rps.page.strip.calibrate('top').input;
    Object.defineProperty(input, 'validity', { configurable: true, get: () => ({ badInput: true }) });
    input.value = '';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    input.dispatchEvent(new win.Event('change', { bubbles: true }));
    await sleep(350);
    assert(input.classList.contains('bad') && Math.abs(rps.calib('top').calib.tilt_deg - 6.8) < 1e-6, 'garbage deleted it');
    assert(/not a number/i.test(status()), 'nothing said: ' + status());
    delete input.validity;
    input.value = '1000';
    input.dispatchEvent(new win.Event('change', { bubbles: true }));
    await sleep(400);
    assert(Math.abs(rps.calib('top').calib.tilt_deg - 90) < 1e-6 && input.value === '90', 'no clamp');
    input.value = '';
    input.dispatchEvent(new win.Event('change', { bubbles: true }));
    await sleep(350);
    assert(!rps.calib('top').calib.tilt_deg && rps.calib().mode === 'design', 'blank did not clear');
    closeSheet();
    await sleep(150);
    assert(q('.camhead .seg').hidden, 'Designed / Measured outlived the measurement');
  });

  await test('a measurement goes with its mount; a removed camera leaves the table and its tile says so', async () => {
    rps.setCalib('top', { tilt_deg: 7.5 });
    await sleep(400);
    rps.removeSlot('top_camera_mount');
    await sleep(700);
    assert(!(rps.calib('top').design && rps.calib('top').design.calib) && rps.cameraPanel().calib === 'design', 'the offset outlived its mount');
    rps.swap('top_camera_mount', 'corner_mast_printed');
    rps.swap('front_camera', 'none');
    await sleep(700);
    const cams = () => rps.checks().rows.filter((r) => r.kind === 'camera').map((r) => r.id.slice(4)).sort().join();
    assert(cams() === 'top,wrist', 'camera rows: ' + cams());
    assert(/no camera/.test(tileOf('front').textContent), 'the front tile does not say why');
    rps.ctx.on.resetDefaults();
    await sleep(1000);
    assert(cams() === 'front,top,wrist', 'Reset did not bring it back: ' + cams());
  });

  await test('a preset stops at an obstacle, and the Pose popover marks the presets that collide', async () => {
    win.location.hash = '#/design/lekiwi-pincopen';
    await waitFor(() => !q('.app.check-on'), 10000, 'Design');
    rps.applyPreset('reach floor');
    await sleep(350);
    const tip = rps.tipInfo().tip;
    rps.applyPreset('stowed');
    await sleep(350);
    rps.collideNow();
    const gz = rps.model.groundZ;
    const ids0 = new Set(rps.model.components.map((c) => c.id));
    await rps.importFiles(boxSTL(60, 60, 45, gz + 22.5, tip[0], tip[1] - 15).buffer, 'block.stl');
    const block = rps.model.components.map((c) => c.id).filter((id) => !ids0.has(id)).pop();
    await sleep(300);
    assert(rps.collideNow().ok, 'stowed already collides');
    const r = rps.applyPreset('reach floor');
    await sleep(350);
    assert(rps.collideNow().ok, 'reach floor ended inside the block');
    assert(!r.reached && /block/i.test(r.blocked.map((b) => b.by).join(' ')), 'blamed ' + JSON.stringify(r.blocked));
    assert(Math.abs(rps.readouts().joints.arm_shoulder_lift + 163) > 1, 'the shoulder went all the way');
    rps.page.motion.render();
    const m = await waitFor(() => { const x = rps.presetMarks(); return x.fresh && x.rows.length ? x : null; }, 15000, 'the preset pass');
    const shown = qa('.posepop [data-preset]').map((b) => b.dataset.preset);
    const bad = m.rows.filter(([k, ok]) => !ok && shown.includes(k)).map(([k]) => k);
    assert(bad.length && bad.every((k) => m.marked.includes(k)), 'unmarked colliding presets: ' + JSON.stringify(m));
    assert(!m.rows.filter(([k, ok]) => ok && shown.includes(k)).some(([k]) => m.marked.includes(k)), 'a clear preset is marked');
    rps.applyPreset('stowed');
    rps.removeComponents([block]);
    await sleep(300);
    return `stopped by ${r.blocked[0].by} · marked ${bad.join(', ')}`;
  });

  await test('no console errors', async () => {
    const errs = rps.readouts().errors;
    assert(!errs.length, errs.slice(0, 3).join(' | '));
  });
}

start(run);
