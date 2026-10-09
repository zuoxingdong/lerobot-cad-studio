/*
   The Sim view, teleop, through the real DOM and real key events: the top-bar Sim tab loads
   MuJoCo (the vendor script, from file:// here) and builds the model in < 5 s; W drives the
   base, the arrows pick and jog a joint, F opens and closes the jaw, Esc releases the keys;
   the key map folds; Design keys stay off; the baked lab and its look load from file://; the
   robot wears its real finish, seen from an eye inside the room; the camera feeds (column right
   of the canvas, Hide / Show kept for the session, click to enlarge, Esc closes, the 2×2 grid);
   the frame time; three open/close cycles leave the WASM heap flat and the design pose, camera,
   look and materials restored; no console errors. */

import { frame, sleep, waitFor, test, assert, start, CI } from './_case.js';

let win = null, rps = null;
const doc = () => win.document;
const q = (s) => doc().querySelector(s);
const sim = () => win.__rpsSim;
const S = () => sim().session;
const consoleErrors = [];

function key(type, code, extra = {}) {
  const k = { KeyW: 'w', KeyF: 'f', KeyG: 'g', ArrowUp: 'ArrowUp', ArrowRight: 'ArrowRight', Escape: 'Escape' }[code] || code;
  q('#rps-canvas').dispatchEvent(new win.KeyboardEvent(type, { code, key: k, bubbles: true, cancelable: true, ...extra }));
}
const press = (code) => { key('keydown', code); key('keyup', code); };
async function simFor(sec) {
  const t0 = S().time;
  await waitFor(() => S().time >= t0 + sec, 30000, `${sec} s of sim time`);
}
const baseY = () => S().data.qpos[S().ix.base[1].q];
const joint = (n) => { const ix = S().ix; const a = [...ix.arm, ...ix.jaw].find((x) => x.name === n); return S().data.qpos[a.adr] * 180 / Math.PI; };
async function openSim() {
  const t0 = performance.now();
  doc().querySelector('.topbar .tabs [data-tab="sim"]').click();
  await waitFor(() => sim() && sim().session, 15000, 'the Sim view');
  return performance.now() - t0;
}
const rect = (e) => e.getBoundingClientRect();
/* spread of the luminance over a canvas: a painted feed is not one flat colour */
function spread(cv) {
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let lo = 255, hi = 0;
  for (let i = 0; i < d.length; i += 4 * 97) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; lo = Math.min(lo, l); hi = Math.max(hi, l); }
  return hi - lo;
}
const feedState = () => { try { return JSON.parse(win.sessionStorage.getItem('rps/sim-cams@1')); } catch (e) { return null; } };
/* the Design pose and what the exports read, before any Sim: joints, wheels, base, STL bytes */
function fnv(u8, h = 0x811c9dc5) { for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i], 16777619) >>> 0; return h; }
function designSnap() {
  const m = rps.page.ctx.model, files = rps.page.printablesFiles();
  const stl = Object.keys(files).filter((n) => /\.stl$/i.test(n)).sort().map((n) => `${n}:${files[n].length}:${fnv(files[n])}`);
  const json = m.toJSON();
  return { q: m.getJoints(), d: m.derivedJoints(), base: { ...m.basePose }, stl, pose: JSON.stringify([json.base_pose, json.pose, json.derived]) };
}
function sameSnap(a, b) {
  const bad = [];
  for (const k of ['q', 'd', 'base']) for (const n of new Set([...Object.keys(a[k]), ...Object.keys(b[k])])) if (!(Math.abs((a[k][n] ?? NaN) - (b[k][n] ?? NaN)) <= 1e-9)) bad.push(`${n} ${a[k][n]} -> ${b[k][n]}`);
  if (a.stl.join() !== b.stl.join()) bad.push('STL bytes differ');
  if (a.pose !== b.pose) bad.push('the exported pose differs');
  return bad;
}
async function closeSim() {
  doc().querySelector('.topbar .tabs [data-tab="design"]').click();
  await waitFor(() => !q('.sim-rail'), 5000, 'the Sim view to close');
  await sleep(200);
}

async function run() {
  win = frame.contentWindow;
  await waitFor(() => win.document.querySelector('.home .card1'), 60000, 'the Home page');
  win.location.hash = '#/design/lekiwi-pincopen';
  await waitFor(() => win.__rps && win.__rps.page && win.__rps.readouts && win.__rps.readouts().treeRows > 0, 60000, 'the design page');
  rps = win.__rps;
  const designEye = rps.page.viewport.camera.position.toArray();
  const designMats = new Map([...rps.page.meshes].map(([id, m]) => [id, m.material]));
  const designNormals = new Map([...rps.page.meshes].map(([id, m]) => [id, m.geometry.attributes.normal]));
  let standIns = [];
  const preSim = designSnap();
  const ce = win.console.error.bind(win.console);
  win.console.error = (...a) => { consoleErrors.push(a.map(String).join(' ')); ce(...a); };
  await sleep(500);

  await test('the Sim tab loads MuJoCo and builds the model from the design in < 5 s', async () => {
    const t0 = performance.now();
    doc().querySelector('.topbar .tabs [data-tab="sim"]').click();
    await waitFor(() => q('.sim-load:not([hidden])') || (sim() && sim().session), 3000, 'the loading card');
    const stage = q('.sim-load') ? q('.sim-load').textContent : '';
    await waitFor(() => sim() && sim().session, 15000, 'the Sim view');
    const ms = performance.now() - t0;
    assert(win.location.hash === '#/sim/lekiwi-pincopen', win.location.hash);
    assert(ms < 5000, `ready after ${ms.toFixed(0)} ms`);
    assert(q('.sim-load').hidden, 'the loading card is still up');
    const src = [...doc().scripts].map((s) => s.src).find((s) => /mujoco-wasm\.js(\?|$)/.test(s)) || '';
    assert(/^file:.*\?v=[0-9a-f]{16}$/.test(src), 'the engine script is not the cache-busted file:// one: ' + src);
    const t = S().timing;
    return `${ms.toFixed(0)} ms (engine ${t.engine_ms}, build ${t.build_ms}, sweep ${t.sweep_ms}, compile ${t.compile_ms}) · first stage "${stage}" · vendor ${src.split(':')[0]}:`;
  });

  await test('the baked lab replaces the static decor (file://): lightmaps, the probe, Neutral at the film exposure', async () => {
    const t0 = performance.now();
    await waitFor(() => sim().view.look.state.state !== 'loading', 30000, 'the baked lab');
    const L = sim().view.look.state, V = rps.page.viewport, room = sim().view.room;
    assert(L.state === 'ready', JSON.stringify(L));
    assert(L.stats.lightmapped > 20 && L.stats.movers >= 20 && L.stats.zones >= 4, JSON.stringify(L.stats));
    assert(V.scene.environment && V.scene.environment.isTexture, 'no probe environment');
    assert(V.renderer.toneMapping === 7 && Math.abs(V.renderer.toneMappingExposure - 2 ** 2.4) < 0.5, `tone map ${V.renderer.toneMapping} × ${V.renderer.toneMappingExposure}`);   // 7: NeutralToneMapping
    assert(!room.group.getObjectByName('sim-room:decor').visible && room.group.getObjectByName('sim-room:baked'), 'the procedural decor is still drawn');
    const src = [...doc().scripts].map((x) => x.src).find((x) => /baked-lab\.js(\?|$)/.test(x)) || '';
    assert(/^file:.*\?v=[0-9a-f]{16}$/.test(src), 'the bundle came from ' + src);
    V.invalidate();
    await new Promise((r) => win.requestAnimationFrame(() => win.requestAnimationFrame(r)));
    const st = V.stats();
    assert(st.drawCalls < 400, `${st.drawCalls} draw calls`);
    return `${L.loadMs} ms after open (+${(performance.now() - t0).toFixed(0)} ms waited) · ${L.stats.meshes} meshes, ${L.stats.lightmapped} lightmapped, ${L.stats.zones} zones, ${L.stats.movers} movers · ${st.drawCalls} calls, ${(st.trianglesDrawn / 1000).toFixed(0)} k tris`;
  });

  await test('the robot wears its real finish (cyan and aqua PLA, black servos, clear plates), the opening eye inside the room', async () => {
    const V = rps.page.viewport, f = sim().view.finish, ms = rps.page.meshes;
    assert(V.materials.palette === 'real', V.materials.palette);
    assert([...ms.values()].every((m) => !/^role:/.test(m.material.name)), 'a Design material is still on');
    const lum = (m) => 0.2126 * m.color.r + 0.7152 * m.color.g + 0.0722 * m.color.b;
    const by = (k) => [...f.keys].filter(([, x]) => x === k).map(([id]) => ms.get(id).material);
    assert(by('servo').length >= 6 && by('servo').every((m) => lum(m) < 0.05), 'servos: ' + by('servo').map(lum));
    const cyan = (m) => m.color.b > 2 * m.color.r && m.color.g > 2 * m.color.r && lum(m) > 0.25 && lum(m) < 0.6 && m.roughness > 0.5;
    assert(by('pla_cyan').length > 10 && by('pla_cyan').every(cyan) && by('pla_cyan').every((m) => m.userData.print), 'cyan PLA');
    assert(by('pla_aqua').length >= 4 && by('pla_aqua').every(cyan), 'aqua PLA');
    assert(by('acrylic_clear').length === 2 && by('acrylic_clear').every((m) => m.transparent && m.opacity < 0.5), 'clear plates');
    const n = new Set(f.map.values()).size;
    assert(n <= 24, `${n} materials`);
    const room = sim().view.room, R = S().sidecar.lab.room;
    room.group.updateWorldMatrix(true, false);
    const e = room.group.worldToLocal(V.camera.position.clone());
    assert(e.x > R.x[0] && e.x < R.x[1] && e.y > R.y[0] && e.y < R.y[1] && e.z < 2700, `eye ${e.toArray().map(Math.round)} outside the room`);
    sim().view.cut();
    assert(room.zones().every((z) => z.visible), 'a wall is cut from the opening view');
    return `${ms.size} meshes, ${n} materials · eye ${e.toArray().map(Math.round)} mm`;
  });

  await test('the robot is dressed: soft normals and AO, the Pi, the board and camera modules, the kit, the omni wheels, the cables', async () => {
    const f = sim().view.finish, look = sim().view.look;
    await waitFor(() => f.state.shaded, 30000, 'the robot shading');
    const mats = new Set(f.map.values());
    assert([...mats].every((m) => m.vertexColors), 'a finish material has no AO colours');
    assert([...rps.page.meshes.values()].every((m) => !f.map.has(m) || m.geometry.attributes.color), 'a mesh has no AO');
    const st = look.state.stats, b = look.baked;
    if (!b) return 'no bake: ' + look.state.state;
    assert(st.dress >= 10 && st.cables >= 10, `dress ${st.dress}, cables ${st.cables}`);
    sim().view.sync(0);
    const gone = sim().view.replacedTris();
    assert(st.dress_tris + st.cable_tris - gone <= 20000, `${st.dress_tris} + ${st.cable_tris} - ${gone} extra triangles`);
    const ws = b.dress.filter((d) => d.userData.wheel);
    assert(ws.length >= 6 && new Set(ws.map((d) => d.userData.wheel)).size === 3, `wheel dress ${ws.length}`);
    const keys = new Set(b.dress.map((d) => d.material.name));
    for (const k of ['nitrile_coat', 'fabric_knit_blue', 'velcro_grey', 'abs_black', 'battery', 'roller_ring']) assert(keys.has(k), 'no ' + k + ' in the dress');
    sim().view.sync(0);
    const base = rps.page.ctx.model.basePose, p = rps.page.viewport.camera.position.clone();
    const far = b.dress.filter((d) => { p.setFromMatrixPosition(d.matrix); return Math.hypot(p.x - base.x, p.y - base.y) > 600; });
    assert(b.dress.every((d) => d.visible) && !far.length, `${far.length} dress parts away from the robot`);
    const si = sim().view.standIns;
    assert(si.length === 4 && si.every((m) => !m.visible), `stand-ins: ${si.length}, shown ${si.filter((m) => m.visible).length}`);
    standIns = si;
    return `${f.state.shaded.geometries} geometries shaded in ${f.state.shaded.ms} ms · dress ${st.dress} (${st.dress_tris} tris), cables ${st.cables} (${st.cable_tris} tris), ${gone} Design tris hidden`;
  });

  await test('the canvas has the keys: the pill says so', async () => {
    q('#rps-canvas').focus();
    sim().renderUi();
    const pill = q('.sim-pill');
    assert(!pill.hidden && /Keys active/.test(pill.textContent), pill.textContent);
    return pill.textContent;
  });

  await test('W for 1 s of sim time drives the base > 0.1 m forward, and the robot model follows', async () => {
    const y0 = baseY(), m0 = rps.page.ctx.model.basePose.y, w0 = sim().view.wheelAngles();
    key('keydown', 'KeyW');
    await simFor(1);
    key('keyup', 'KeyW');
    await sleep(100);
    const dy = baseY() - y0, dm = rps.page.ctx.model.basePose.y - m0;
    assert(dy > 0.1, `base y moved ${dy.toFixed(3)} m`);
    assert(Math.abs(dm - dy * 1000) < 15, `model ${dm.toFixed(1)} mm vs sim ${(dy * 1000).toFixed(1)} mm`);
    /* forward: the front wheels roll 0.866 dy / r (opposite joint signs), the back wheel's rollers slide; the
       spin is integrated per frame from the base speed, so it matches dy only to the frame rate */
    const w1 = sim().view.wheelAngles(), dw = (n) => ((w1[n] - w0[n] + 540) % 360) - 180, roll = 0.866 * dy / 0.0508 * 180 / Math.PI;
    assert(Math.abs(Math.abs(dw('base_left_wheel')) - roll) < 0.3 * roll && Math.abs(dw('base_left_wheel') + dw('base_right_wheel')) < 0.05 * roll
      && Math.abs(dw('base_back_wheel')) < 1, `wheels ${JSON.stringify(w1)} from ${JSON.stringify(w0)}, want ±${roll.toFixed(0)}°`);
    const liq = sim().view.liquid.surfaces();
    assert(liq.length === 4 && liq.every((x) => x.tilt_deg < 20), `liquid ${JSON.stringify(liq.map((x) => x.tilt_deg))}`);
    press('Space');
    return `y +${(dy * 1000).toFixed(0)} mm (model +${dm.toFixed(0)} mm), front wheels ±${Math.abs(dw('base_left_wheel')).toFixed(0)}°, real-time × ${(S().metrics.value.rtf || 0).toFixed(2)}`;
  });

  await test('→ picks the next joint, ↑ jogs it, the model joint follows', async () => {
    press('ArrowRight');
    const name = S().teleop.joints[S().teleop.selected];
    const a0 = joint(name);
    key('keydown', 'ArrowUp');
    await simFor(0.6);
    key('keyup', 'ArrowUp');
    await simFor(0.2);
    const a1 = joint(name), shown = rps.page.ctx.model.getJoints()[name];
    assert(Math.abs(a1 - a0) > 15, `${name} ${a0.toFixed(1)} -> ${a1.toFixed(1)}`);
    assert(Math.abs(shown - a1) < 1, `model ${shown} vs sim ${a1}`);
    assert(q('.sim-sel').textContent.includes(name.replace(/^arm_/, '')), q('.sim-sel').textContent);
    return `${name} ${a0.toFixed(1)}° -> ${a1.toFixed(1)}°`;
  });

  await test('F opens the jaw, F again closes it', async () => {
    const jaw = S().sidecar.jaw_joints[0];
    const j0 = joint(jaw);
    press('KeyF');
    await simFor(1.2);
    const open = joint(jaw);
    press('KeyF');
    await simFor(1.2);
    const shut = joint(jaw), shown = rps.page.ctx.model.getJoints()[jaw];
    assert(open > 20 && shut < 2 && Math.abs(shown - shut) < 1, `jaw ${j0.toFixed(1)} -> ${open.toFixed(1)} -> ${shut.toFixed(1)} (model ${shown})`);
    return `jaw ${j0.toFixed(1)}° -> ${open.toFixed(1)}° -> ${shut.toFixed(1)}°`;
  });

  await test('Design keys stay off while the Sim view is up (G does not toggle the grid)', async () => {
    const g = rps.store.get('ui.grid');
    press('KeyG');
    await sleep(100);
    assert(rps.store.get('ui.grid') === g, 'G reached the Design keymap');
  });

  await test('the camera feeds: FRONT, WRIST, TOP in a column right of the canvas, ≥ 240 px wide, painted', async () => {
    const col = q('.sim-camcol'), cv = q('#rps-canvas');
    assert(col && !col.hidden, 'no camera column');
    const tiles = [...doc().querySelectorAll('.sim-camcol .sim-tile')];
    assert(tiles.map((t) => t.dataset.cam).join() === 'front,wrist,top', tiles.map((t) => t.dataset.cam).join());
    assert(!q('.sim-rail canvas'), 'a feed is still in the rail');
    const c = rect(cv), k = rect(col);
    assert(c.right <= k.left + 0.5, `canvas right ${c.right} over the column at ${k.left}`);
    assert(doc().elementFromPoint(c.left + c.width / 2, c.top + c.height / 2) === cv, 'something covers the canvas centre');
    await waitFor(() => tiles.every((t) => spread(t.querySelector('canvas')) > 20), 5000, 'painted feeds');
    const dpr = win.devicePixelRatio || 1, out = [];
    for (const t of tiles) {
      const pic = t.querySelector('.sim-pic'), fc = pic.querySelector('canvas'), r = rect(pic);
      assert(r.width >= 240, `${t.dataset.cam} ${r.width.toFixed(0)} px wide`);
      assert(Math.abs(r.width / r.height - 4 / 3) < 0.02, `${t.dataset.cam} aspect ${(r.width / r.height).toFixed(3)}`);
      assert(Math.abs(fc.width - fc.clientWidth * Math.min(dpr, 2)) <= 1, `${t.dataset.cam} buffer ${fc.width} for ${fc.clientWidth} css px`);
      assert(/^(front|wrist|top)$/i.test(pic.querySelector('.sim-tag').textContent), 'no label');
      out.push(`${t.dataset.cam} ${r.width.toFixed(0)}×${r.height.toFixed(0)}`);
    }
    const rail = q('.sim-rail');
    assert(rail.scrollHeight <= rail.clientHeight + 1, `the rail scrolls: ${rail.scrollHeight} > ${rail.clientHeight}`);
    return `${out.join(', ')} · column ${k.width.toFixed(0)} px · canvas ${c.width.toFixed(0)} px`;
  });

  await test('Hide gives the canvas the width, Show brings the feeds back, and the choice outlives a re-open', async () => {
    const w0 = rect(q('#rps-canvas')).width;
    [...doc().querySelectorAll('.sim-camhead button')].find((b) => b.textContent === 'Hide').click();
    await sleep(300);
    assert(q('.sim-camcol').hidden && !q('.sim-camshow').hidden, 'Hide did not hide');
    const w1 = rect(q('#rps-canvas')).width;
    assert(w1 > w0 + 200, `canvas ${w0} -> ${w1} px`);
    assert(feedState() && feedState().hidden === true, JSON.stringify(feedState()));
    await closeSim();
    await openSim();
    assert(q('.sim-camcol').hidden, 'Hide was forgotten on re-open');
    q('.sim-camshow').click();
    await sleep(300);
    assert(!q('.sim-camcol').hidden && q('.sim-camshow').hidden && feedState().hidden === false, 'Show did not show');
    q('#rps-canvas').focus();
    return `canvas ${w0.toFixed(0)} → ${w1.toFixed(0)} → ${rect(q('#rps-canvas')).width.toFixed(0)} px`;
  });

  await test('a tile click enlarges the feed over the view; Esc closes it and gives the keys back', async () => {
    q('#rps-canvas').focus();
    const tile = q('.sim-tile[data-cam="wrist"]');
    tile.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true }));
    tile.click();
    const big = q('.sim-big');
    assert(big && !big.hidden, 'no enlarged feed');
    const pic = big.querySelector('.sim-pic'), w = rect(pic).width, t = rect(tile.querySelector('.sim-pic')).width;
    assert(w > 2 * t, `enlarged ${w} px vs tile ${t} px`);
    await waitFor(() => spread(pic.querySelector('canvas')) > 20, 5000, 'the enlarged feed painted');
    press('Escape');
    assert(big.hidden, 'Esc did not close it');
    assert(doc().activeElement === q('#rps-canvas'), 'the keys did not come back');
    tile.click();
    assert(!big.hidden, 'did not re-open');
    big.click();
    assert(big.hidden, 'a click did not close it');
    return `wrist ${t.toFixed(0)} → ${w.toFixed(0)} px`;
  });

  await test('Grid puts the three feeds and the view in a 2×2', async () => {
    const bar = () => [...doc().querySelectorAll('.sim-camhead button')];
    bar().find((b) => b.textContent === 'Grid').click();
    await sleep(400);
    const st = rect(q('.stage')), c = rect(q('#rps-canvas'));
    assert(c.left > st.left + st.width / 3 && c.top > st.top + st.height / 3, `canvas at ${c.left.toFixed(0)}, ${c.top.toFixed(0)}`);
    const cells = [...doc().querySelectorAll('.sim-tile')].map((t) => rect(t));
    assert(cells.length === 3 && cells.every((r) => r.width > st.width / 3 && !(r.left >= c.left - 1 && r.top >= c.top - 1)), 'feeds not in the other cells');
    bar().find((b) => b.textContent === 'Column').click();
    await sleep(400);
    assert(!q('.stage').classList.contains('sim-grid') && rect(q('#rps-canvas')).right <= rect(q('.sim-camcol')).left + 0.5, 'Column did not come back');
    q('#rps-canvas').focus();
    return `main view ${c.width.toFixed(0)}×${c.height.toFixed(0)}, feeds ${cells.map((r) => r.width.toFixed(0)).join('/')} px wide`;
  });

  await test('the key map is on screen and folds', async () => {
    const card = q('.sim-keys'), body = q('.sim-kb');
    assert(card && !card.hidden && card.querySelectorAll('kbd').length >= 12, 'no key map');
    q('.sim-kh').click();
    assert(body.hidden, 'did not fold');
    q('.sim-kh').click();
    assert(!body.hidden, 'did not unfold');
    const chips = [...doc().querySelectorAll('.sim-rail .sim-chip')].filter((c) => !c.hidden);
    assert(chips.length === 3 && chips[0].dataset.state === 'done', 'the station chips (the instruments run in Teleop too): ' + chips.map((c) => c.dataset.state));
    return `${card.querySelectorAll('kbd').length} keys`;
  });

  await test('Esc releases the keyboard: W does nothing after it', async () => {
    press('Escape');
    sim().renderUi();
    assert(doc().activeElement !== q('#rps-canvas'), 'the canvas kept focus');
    assert(/Keys off/.test(q('.sim-pill').textContent), q('.sim-pill').textContent);
    const y0 = baseY();
    key('keydown', 'KeyW');
    await simFor(0.5);
    key('keyup', 'KeyW');
    assert(Math.abs(baseY() - y0) < 0.005, `moved ${baseY() - y0} m`);
  });

  await test('the frame time at 1× (sim step + pose sync)', async () => {
    q('#rps-canvas').focus();
    sim().clearStats();
    key('keydown', 'KeyW');
    await sleep(1500);
    key('keyup', 'KeyW');
    await sleep(1500);
    const f = sim().frameStats();
    /* a CI runner draws on a few slow cores (rAF ~400 ms): the loop must still run, inside twice the frame budget */
    assert(f.frames > (CI ? 4 : 10), `${f.frames} frames`);
    assert(f.js_p50_ms < (CI ? 32 : 16), `p50 ${f.js_p50_ms} ms`);
    return `sim JS p50 ${f.js_p50_ms} ms, p95 ${f.js_p95_ms} ms, max ${f.js_max_ms} ms · rAF p50 ${f.raf_p50_ms} ms, p95 ${f.raf_p95_ms} ms (${f.frames} frames) · ${(S().metrics.value.msPerStep || 0).toFixed(3)} ms/step`;
  });

  await test('the report JSON carries the metrics and the frame stats', async () => {
    const r = sim().report();
    assert(r.schema === 'rps/sim-report@1' && r.metrics && r.metrics.levels && r.frame && r.design_hash, JSON.stringify(Object.keys(r)));
    return `peak ${r.metrics.peak.toFixed(2)} N·m (${r.metrics.levels.torque}), limit hits ${r.metrics.limitHits}, self-contact ${r.metrics.self}`;
  });

  await test('leaving after teleop and part of the lab restores the exact Design pose, and the STL export is byte-identical', async () => {
    sim().setMode('lab');
    sim().setSpeed(2);
    sim().turbo(200);
    sim().run();
    await waitFor(() => S().labState().records.length >= 4, 120000, 'four lab phases');
    sim().pause();
    sim().turbo(0);
    const moved = sameSnap(preSim, { ...preSim, q: rps.page.ctx.model.getJoints(), base: { ...rps.page.ctx.model.basePose } });
    assert(moved.length, 'the Sim did not move the model');
    await closeSim();
    const bad = sameSnap(preSim, designSnap());
    assert(!bad.length, bad.slice(0, 4).join(' · '));
    await openSim();
    return `${moved.length} values moved in the Sim, all back · ${preSim.stl.length} STLs identical`;
  });

  await test('leaving frees the model: 3 open/close cycles leave the WASM heap flat, the design pose back', async () => {
    const design = JSON.stringify(rps.store.getState().joints || {});
    await closeSim();
    const pose = rps.page.ctx.model.basePose, V = rps.page.viewport;
    assert(pose.x === 0 && pose.y === 0 && pose.yaw === 0, `base ${JSON.stringify(pose)}`);
    assert(V.renderer.toneMapping === 4 && V.renderer.toneMappingExposure === 1.05 && !V.scene.environment, 'the Design look did not come back');   // 4: ACESFilmic
    assert(V.materials.palette === 'design' && [...rps.page.meshes].every(([id, m]) => m.material === designMats.get(id)), 'a Design material did not come back');
    assert([...rps.page.meshes.values()].every((m) => !m.geometry.attributes.color)
      && [...rps.page.meshes].every(([id, m]) => m.geometry.attributes.normal === designNormals.get(id)), 'a Design normal did not come back');
    assert(standIns.every((m) => m.visible), 'a camera stand-in stayed hidden');
    assert(!q('.app.sim-on') && q('.frame > .rail.l') && getComputedStyle(q('.frame > .rail.l')).display !== 'none', 'the Design frame did not come back');
    const heap = [await win.__rpsSim.heapBytes()];
    const open = [];
    for (let i = 0; i < 3; i++) {
      open.push(await openSim());
      await sleep(300);
      await closeSim();
      heap.push(await win.__rpsSim.heapBytes());
    }
    assert(JSON.stringify(rps.store.getState().joints || {}) === design, 'the design joints changed');
    const eye = rps.page.viewport.camera.position.toArray();
    assert(eye.every((v, i) => Math.abs(v - designEye[i]) < 0.5), `Design camera ${eye.map(Math.round)} vs ${designEye.map(Math.round)}`);
    assert(heap[3] <= heap[1], `heap ${heap.map((h) => (h / 1048576).toFixed(0)).join(' -> ')} MB`);
    return `heap ${heap.map((h) => (h / 1048576).toFixed(0)).join(' → ')} MB · re-open ${open.map((x) => x.toFixed(0)).join(', ')} ms`;
  });

  await test('no console errors', async () => {
    const errs = [...rps.errors, ...consoleErrors];
    assert(!errs.length, errs.slice(0, 3).join(' | '));
  });
}

start(run);
