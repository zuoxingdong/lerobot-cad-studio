/*
   The Sim view, Lab task (the enzyme screen): the mode is offered on LeKiwi + PincOpen, Step phase
   runs one phase, Reset touches the scene and never the design, the first IK plan shows
   "Planning…" without a long frame, and a run at 2x (then faster through the debug hook) ends
   "task complete" with the puck in the reader, the instrument events in order and the reader's
   bars posed in the room.  The opening view frames the robot and the three stations from inside
   the room (the baked lab, its movers riding the room's animated nodes), and a wall the orbit eye is
   behind is cut away.  The MJCF zip it downloads goes back to run.mjs for tools/sim/check.py.  The WRIST
   feed leaves out its own module and lead (dark edges at the dock, flexed, rolled, driving to the incubator). */

import { frame, sleep, waitFor, test, assert, start, captureDownload, zipNames, b64, CI } from './_case.js';

let win = null, rps = null, zip64 = null;
const doc = () => win.document;
const q = (s) => doc().querySelector(s);
const qa = (s) => [...doc().querySelectorAll(s)];
const sim = () => win.__rpsSim;
const S = () => sim().session;
const btn = (sel, text) => qa(sel).find((b) => b.textContent.trim() === text || b.textContent.includes(text));
const consoleErrors = [];

/* robot-frame mm <-> the viewport's world */
const V = () => rps.page.viewport;
const toWorld = (x, y, z) => V().camera.position.clone().set(x, y, z).applyQuaternion(V().qRoot);
const toRobot = (p) => p.clone().applyQuaternion(V().qRoot.clone().invert());
function lookFrom(eye, at) {
  V().camera.position.copy(toWorld(...eye));
  V().controls.target.copy(toWorld(...at));
  V().controls.update();
  V().invalidate();
}
/* each cut-away zone of the room (the baked lab's once loaded): its walls and whether it is drawn */
const zones = () => sim().view.room.zones();
const alone = (a, s) => (z) => z.walls.length === 1 && z.walls[0].a === a && z.walls[0].s === s;
const frameOnce = async () => { V().invalidate(); await new Promise((r) => win.requestAnimationFrame(() => win.requestAnimationFrame(r))); await sleep(50); };

async function run() {
  win = frame.contentWindow;
  await waitFor(() => win.document.querySelector('.home .card1'), 60000, 'the Home page');
  win.location.hash = '#/design/lekiwi-pincopen';
  await waitFor(() => win.__rps && win.__rps.page && win.__rps.readouts && win.__rps.readouts().treeRows > 0, 60000, 'the design page');
  rps = win.__rps;
  const ce = win.console.error.bind(win.console);
  win.console.error = (...a) => { consoleErrors.push(a.map(String).join(' ')); ce(...a); };
  await sleep(500);
  win.location.hash = '#/sim/lekiwi-pincopen';
  await waitFor(() => sim() && sim().session, 15000, 'the Sim view');

  await test('the opening view: the eye inside the room, the robot and the three nests in frame', async () => {
    await frameOnce();
    V().camera.updateMatrixWorld();                   // project() reads the matrices of the last render
    const gz = S().sidecar.ground_z_mm || 0, L = S().sidecar.lab;
    const eye = toRobot(V().camera.position);
    assert(eye.x > -2100 && eye.y < 1950 && eye.z - gz < 2600, `eye ${eye.toArray().map(Math.round)}`);
    const ndc = (x, y, z) => toWorld(x, y, z + gz).project(V().camera);
    const pts = { robot: ndc(0, 0, 150), mast: ndc(0, 0, 700), ...Object.fromEntries(L.stations.map((st) => [st.id, ndc(...st.nest.xy, st.nest.floor_z)])) };
    for (const [n, v] of Object.entries(pts)) assert(Math.abs(v.x) < 0.95 && Math.abs(v.y) < 0.95 && v.z < 1, `${n} at ${v.x.toFixed(2)}, ${v.y.toFixed(2)}`);
    const at = toRobot(V().controls.target);
    assert(Math.abs(pts.robot.x) < 0.5 && Math.abs(pts.robot.y) < 0.6,
      `robot off centre at ${pts.robot.x.toFixed(2)}, ${pts.robot.y.toFixed(2)}; eye ${eye.toArray().map(Math.round)} target ${at.toArray().map(Math.round)} aspect ${V().camera.aspect.toFixed(2)}`);
    return Object.entries(pts).map(([n, v]) => `${n} (${v.x.toFixed(2)}, ${v.y.toFixed(2)})`).join(' · ');
  });

  await test('the walls the orbit eye is behind are cut away, with what stands along them', async () => {
    const gz = S().sidecar.ground_z_mm || 0, at = [0, 300, 350 + gz];
    await waitFor(() => sim().view.look.state.state !== 'loading', 30000, 'the baked lab');
    assert(sim().view.look.state.state === 'ready', 'the baked lab: ' + JSON.stringify(sim().view.look.state));
    lookFrom([1900, -700, 1250 + gz], at);
    await frameOnce();
    const z0 = zones();
    const north = z0.find(alone('y', 1)), west = z0.find(alone('x', -1));
    assert(north && west && z0.every((z) => /baked/.test(z.name)), 'no baked wall zones: ' + z0.map((z) => z.name).join());
    assert(z0.every((z) => z.visible), 'a wall is cut from inside the room');
    const seen = {};
    for (const [n, eye] of [['north', [900, 3600, 1700]], ['west', [-3900, 900, 1500]], ['inside', [1900, -700, 1250]]]) {
      lookFrom([eye[0], eye[1], eye[2] + gz], at);
      await frameOnce();
      const z = zones(), N = z.find((x) => x.name === north.name), W = z.find((x) => x.name === west.name);
      seen[n] = `${N.visible ? 'N' : '-'}${W.visible ? 'W' : '-'}`;
    }
    assert(seen.north === '-W' && seen.west === 'N-' && seen.inside === 'NW', JSON.stringify(seen));
    sim().view.cut(false);
    assert(zones().every((z) => z.visible), 'the robot cameras would not see the walls');
    return `${z0.length} baked zones; drawn walls from north ${seen.north}, west ${seen.west}, inside ${seen.inside}`;
  });

  await test('Lab task is offered on LeKiwi + PincOpen and lists its phases', async () => {
    const b = btn('.sim-head .seg button', 'Lab task');
    assert(b && !b.hidden && !b.disabled, 'no Lab task button');
    b.click();
    await sleep(100);
    const n = qa('.sim-phases li').length;
    assert(S().mode === 'lab' && n === S().labState().phases.length && n > 20, `mode ${S().mode}, ${n} phases`);
    assert(!q('.sim-rail .sim-sec').hidden, 'the lab section is hidden');
    assert(!sim().running, 'the task started on its own');
    return `${n} phases`;
  });

  await test('Step phase runs exactly one phase, then pauses', async () => {
    btn('.sim-head button', 'Step phase').click();
    await waitFor(() => !sim().running, CI ? 60000 : 20000, 'the step to end');
    const k = S().labState().records.length;
    assert(k === 1, `${k} phases ran`);
    assert(q('.sim-phases li .dot.ok'), 'no green dot');
    return S().labState().records[0].phase;
  });

  await test('Reset is the scene only: the design is untouched', async () => {
    const before = JSON.stringify(rps.store.getState());
    btn('.sim-head button', 'Reset').click();
    await sleep(100);
    assert(S().labState().records.length === 0 && S().time === 0, `t ${S().time}`);
    assert(JSON.stringify(rps.store.getState()) === before, 'the design changed');
  });

  let plan = null;
  await test('the first IK plan shows "Planning…" and no frame runs long at 2×', async () => {
    sim().setSpeed(2);
    sim().clearStats();
    btn('.sim-head button', 'Run').click();
    let seen = false;
    await waitFor(() => { if (!q('.sim-plan').hidden || S().labState().planning) seen = true; return S().labState().records.length >= 2; }, 120000, 'the first plan');
    const f = sim().frameStats();
    const ready = S().labState().records.find((p) => p.phase === 'ready');
    plan = { ms: ready && ready.ik && ready.ik.ms, f };
    assert(seen, 'never saw Planning…');
    assert(f.js_max_ms < 50, `longest frame ${f.js_max_ms} ms`);
    return `ready plan ${plan.ms} ms of IK, sliced; frame JS p50 ${f.js_p50_ms} / p95 ${f.js_p95_ms} / max ${f.js_max_ms} ms; rAF p50 ${f.raf_p50_ms} ms`;
  });

  await test('the task runs to "task complete": the puck lh -> inc -> reader, the instruments in order', async () => {
    const t0 = performance.now();
    sim().setSpeed(8);
    sim().turbo(400);
    await waitFor(() => S().labState().done, 240000, 'task complete');
    await sleep(400);
    const ls = S().labState(), o = ls.outcome;
    assert(o.complete && o.transfers === 2 && ls.puckAt === 'reader', `transfers ${o.transfers}, puck in ${ls.puckAt}`);
    assert(o.puck_path.join() === 'lh,inc,reader', 'puck path ' + o.puck_path.join());
    const seq = o.instrument_events.map((e) => `${e.station}:${e.state}`).join(' ');
    assert(seq === 'lh:running inc:armed inc:closing inc:running inc:opening inc:done inc:idle reader:armed reader:closing reader:running reader:opening reader:done', seq);
    assert(o.peak_torque_max_Nm < 2 && o.nav_clearance_min_mm >= 80 && !o.scenery_contacts.length, `peak ${o.peak_torque_max_Nm}, nav ${o.nav_clearance_min_mm}`);
    assert(/task complete/.test(q('.sim-line').textContent), q('.sim-line').textContent);
    assert(q('.sim-summary.ok') && !q('.sim-summary').hidden, 'no summary card');
    const dots = qa('.sim-phases li .dot');
    assert(dots.every((d) => d.classList.contains('ok')), `${dots.filter((d) => !d.classList.contains('ok')).length} phases not green`);
    assert(btn('.sim-head button', 'Run').disabled, 'Run stays enabled after task complete');
    const names = qa('.sim-phases li').map((li) => li.textContent.trim());
    assert(names[2] === 'Drive to the liquid handler' && !names.some((n) => /_/.test(n)), 'phase names: ' + names.slice(0, 4).join(', '));
    assert(/^Transfers 2\/2 · Stations 3\/3 · /.test(q('.sim-task').textContent), q('.sim-task').textContent);
    const m = S().metrics.value;
    return `${o.steps} steps, ${o.sim_seconds} s sim in ${((performance.now() - t0) / 1000).toFixed(1)} s; peak ${o.peak_torque_max_Nm} N·m; nav ${o.nav_clearance_min_mm} mm; metrics peak ${m.peak.toFixed(3)}`;
  });

  await test('the instruments reach the room: reader done, its bars posed, ART-3 the tallest', async () => {
    await frameOnce();
    const snap = S().instruments.snapshot();
    assert(snap.stations.reader.state === 'done' && snap.stations.inc.state === 'idle', JSON.stringify(snap.stations));
    const g = sim().view.room.group.getObjectByName('sim-room:anim:reader.bars');
    assert(g && g.children.length === 4, 'no reader.bars group in the room');
    const zs = g.children.map((c) => c.matrix.elements[10]);
    assert(zs[2] > zs[0] && zs[2] > zs[1] && zs[2] > zs[3], 'bar heights ' + zs.map((v) => v.toFixed(2)).join('/'));
    /* the bake's bars ride the room's (hidden) bars and take their colour; the lid's mesh rides the lid */
    const hifi = g.children.map((c) => c.children[0]);
    assert(g.children.every((c) => !c.material.visible) && hifi.every((m) => m && /^baked:/.test(m.name)), 'the baked bars are not on the room bars');
    assert(hifi[2].material.emissiveIntensity > hifi[0].material.emissiveIntensity, 'the ART-3 bar is not the lit one');
    const lid = sim().view.room.group.getObjectByName('sim-room:anim:reader.lid');
    assert(lid && lid.children.some((c) => c.children.some((m) => /^baked:/.test(m.name))), 'no baked reader hood');
    const chips = qa('.sim-chip').filter((c) => !c.hidden).map((c) => `${c.dataset.station}:${c.dataset.state}`);
    assert(chips.join() === 'lh:running,inc:idle,reader:done', chips.join());
    return `bars z-scale ${zs.map((v) => v.toFixed(2)).join('/')}; chips ${chips.join(' ')}`;
  });

  await test('the rail holds the lab task and the metrics, with no scrolling, and one verdict dot per row', async () => {
    const rail = q('.sim-rail');
    assert(rail.scrollHeight <= rail.clientHeight + 1, `the rail scrolls: ${rail.scrollHeight} > ${rail.clientHeight}`);
    assert(qa('.sim-rail > .sim-sec').length === 2 && !q('.sim-rail canvas'), 'the rail holds more than the lab task and the metrics');
    const rows = qa('.sim-rail .sim-row');
    assert(rows.length === 9, `${rows.length} rows`);
    assert(rows.every((r) => r.querySelector('.dot')), 'a row without a dot');
    const info = q('.sim-info');
    assert(info && info.title === 'kinematic base · convex collision · estimated masses', info && info.title);
    return rows.map((r) => `${r.querySelector('.k').textContent} ${r.querySelector('.v').textContent}`).join(' · ');
  });

  await test('Download MJCF zip: the export layout and this run, for tools/sim/check.py', async () => {
    const z = await captureDownload(win, () => btn('.sim-menu button', 'Download MJCF zip').click());
    const names = zipNames(z);
    for (const f of ['scene.xml', 'scene.json', 'design.json', 'report.json', 'ctrl.f32']) assert(names.includes(f), 'no ' + f);
    const nMesh = names.filter((n) => n.startsWith('meshes/')).length;
    assert(nMesh === S().sim.model.nmesh, `${nMesh} meshes vs nmesh ${S().sim.model.nmesh}`);
    zip64 = b64(z);
    return `${names.length} files, ${(z.length / 1048576).toFixed(2)} MB`;
  });

  /* a feed's darkest outer 20 % column strip (luminance < 64), painted now; `own` false hides the robot's dress and leads */
  function edgeDark(id, own = true) {
    const b = sim().view.look.baked, parts = [...b.dress, b.cables.group], was = parts.map((o) => o.visible);
    if (!own) for (const o of parts) o.visible = false;
    rps.page.syncCameras();
    sim().view.cut(false);
    if (sim().view.claimOwn) sim().view.claimOwn();
    sim().feeds.paint();
    sim().view.cut();
    parts.forEach((o, i) => { o.visible = was[i]; });
    const cv = q(`.sim-tile[data-cam="${id}"] canvas`), w = cv.width, h = cv.height, k = Math.round(0.2 * w);
    const d = cv.getContext('2d').getImageData(0, 0, w, h).data, n = [0, 0];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (x >= k && x < w - k) continue;
      const i = 4 * (y * w + x);
      if (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] < 64) n[x < k ? 0 : 1]++;
    }
    return Math.max(...n) / (k * h);
  }
  function pose(deg) {
    const s = S(), js = [...s.ix.arm, ...s.ix.jaw];
    for (const [n, v] of Object.entries(deg)) s.data.qpos[js.find((j) => j.name === n).adr] = v * Math.PI / 180;
    s.mj.mj_forward(s.sim.model, s.data);
    sim().view.sync(0);
  }
  await test('the robot cameras do not see their own module or lead: the WRIST feed edges stay clear, the main view keeps them', async () => {
    btn('.sim-head button', 'Reset').click();
    await frameOnce();
    const q0 = Float64Array.from(S().data.qpos), rows = [];
    const at = async (name, deg) => {
      if (deg) { S().data.qpos.set(q0); pose(deg); }
      await frameOnce();
      const all = edgeDark('wrist'), scene = edgeDark('wrist', false);
      rows.push(`${name} ${all.toFixed(3)} (+${(all - scene).toFixed(3)})`);
      assert(all - scene < 0.03, `${name}: the robot's own dress darkens ${(100 * (all - scene)).toFixed(1)} % of a WRIST edge`);
      return all;
    };
    for (const [name, deg] of [['dock', {}], ['flexed', { arm_wrist_flex: 40, arm_elbow_flex: -20 }], ['rolled', { arm_wrist_roll: -50, arm_wrist_flex: 15 }]]) {
      const v = await at(name, deg);
      assert(v < 0.12, `${name}: ${(100 * v).toFixed(1)} % of a WRIST edge strip is dark`);
    }
    /* the main view's layers still draw the module and the lead's end; the lead runs down the module's back,
       so the WRIST camera given those layers still sees no lead */
    const V0 = V(), wc = rps.page.ctx.frustums.camera('wrist'), mine = sim().view.owned.wrist || [];
    assert(mine.length >= 2 && mine.some((o) => /:tail$/.test(o.name)) && mine.every((o) => o.visible && V0.camera.layers.test(o.layers) && !wc.layers.test(o.layers)),
      'the wrist camera\'s own parts: ' + mine.map((o) => o.name).join());
    for (const id of ['front', 'top']) assert(mine.every((o) => rps.page.ctx.frustums.camera(id).layers.test(o.layers)), `the ${id} feed skips the wrist module`);
    const m0 = wc.layers.mask;
    wc.layers.mask = V0.camera.layers.mask;
    const seen = edgeDark('wrist') - edgeDark('wrist', false);
    wc.layers.mask = m0;
    assert(seen < 0.03, `with the main view's layers the lead darkens ${(100 * seen).toFixed(1)} % of a WRIST edge`);
    S().data.qpos.set(q0);
    sim().setSpeed(8);
    sim().turbo(400);
    sim().run();
    await waitFor(() => S().labState().phase === 'drive_inc', 120000, 'the drive to the incubator');
    await sleep(800);
    sim().pause();
    sim().turbo(0);
    await frameOnce();
    await at('drive_inc', null);
    return `dark edge (added by the robot's own dress): ${rows.join(' · ')}; main-view layers +${seen.toFixed(3)}`;
  });

  await test('no console errors', async () => {
    const errs = [...rps.errors, ...consoleErrors];
    assert(!errs.length, errs.slice(0, 3).join(' | '));
  });
}

start(run, () => ({ mjcfZip: zip64 }), ['mjcfZip']);
