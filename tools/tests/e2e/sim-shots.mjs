/*
   The Sim tab's screenshots and frame numbers (1600 × 1000), through ONE headless Chrome (CDP).

     node tools/tests/e2e/sim-shots.mjs [--out dir] [--robot id] [--page index.html] [--file] [--only open,lh,...] [--eval expr]

   Opens the robot (default LeKiwi + PincOpen) in the Sim tab, waits for the baked lab (or its fallback), then saves
   open (the opening view), lh (teleop at the liquid handler), close (the robot close up), inc /
   reader (the lab task at the incubator and the reader, then the dashboard at the end), cams (the
   feeds in the grid), dark (the opening view and the feeds, dark UI), design (the Design view after
   leaving the Sim); prints
   the frame stats of 8 s of teleop at 1×, the draw calls and triangles of each view, and the look. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve, pageUrl, ROOT, SITE, E2E, FLAGS, chromeBinary } from '../_root.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OUT = path.resolve(ROOT, arg('--out', path.join(E2E, 'sim')));
const PAGE = arg('--page', 'index.html');
const ROBOT = arg('--robot', 'lekiwi-pincopen');
const ONLY = new Set((arg('--only', 'open,lh,close,inc,reader,cams,dark,design')).split(','));
/* sim-page.js OPEN_VIEW */
const OPEN = JSON.parse(/OPEN_VIEW = (\{[^}]*\})/.exec(fs.readFileSync(path.join(ROOT, 'src/ui/sim-page.js'), 'utf8'))[1]
  .replace(/(\w+):/g, '"$1":'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { server, port } = await serve(() => {});
const base = argv.includes('--file') ? pathToFileURL(path.join(SITE, PAGE)).href : pageUrl(port, PAGE);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rps-sim-'));
const dport = 9300 + Math.floor(Math.random() * 400);
const ch = spawn(chromeBinary(), [...FLAGS, '--allow-file-access-from-files', `--user-data-dir=${profile}`,
  `--remote-debugging-port=${dport}`, 'about:blank'], { stdio: 'ignore', detached: true });
let ws = null, code = 0;
try {
  let list;
  for (let i = 0; i < 150 && !list; i++) {
    await sleep(100);
    try { list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json(); } catch { /* not up yet */ }
  }
  if (!list) throw new Error('Chrome did not open its debugging port');
  ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const wait = new Map(), logs = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') logs.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && /error|warning/.test(m.params.type)) logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value || a.description).join(' '));
  });
  const send = (method, params = {}) => new Promise((r) => { const k = ++id; wait.set(k, r); ws.send(JSON.stringify({ id: k, method, params })); });
  const js = async (expr) => {
    const r = (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result;
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r?.result?.value;
  };
  const until = async (expr, ms, what) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await js(expr)) return Date.now() - t0; await sleep(150); }
    throw new Error(`timed out waiting for ${what} · ${await js('String(window.__rpsSim && __rpsSim.error)')} · ${logs.slice(-3).join(' | ')}`);
  };
  const shot = async (name) => {
    await js('new Promise((r) => { __rps.page.viewport.invalidate(); requestAnimationFrame(() => requestAnimationFrame(r)); })');
    await sleep(250);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(s.result.data, 'base64'));
    return js(`(() => { const s = __rps.page.viewport.stats();
      return { calls: s.drawCalls, triangles: s.trianglesDrawn, programs: s.programs, textures: s.textures, geometries: s.geometries }; })()`);
  };
  /* robot-frame mm (floor z = 0) -> the orbit eye and target */
  const look = (eye, at) => js(`(() => { const V = __rps.page.viewport, gz = __rpsSim.session.sidecar.ground_z_mm || 0, q = V.qRoot;
    V.camera.position.set(${eye[0]}, ${eye[1]}, ${eye[2]} + gz).applyQuaternion(q);
    V.controls.target.set(${at[0]}, ${at[1]}, ${at[2]} + gz).applyQuaternion(q); V.controls.update(); V.invalidate(); })()`);

  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  fs.mkdirSync(OUT, { recursive: true });
  await send('Page.navigate', { url: base + `?debug=1#/design/${ROBOT}` });
  await until('!!(window.__rps && __rps.page && __rps.readouts && __rps.readouts().treeRows > 0)', 90000, 'the design page');
  await sleep(500);
  const t0 = Date.now();
  await js(`location.hash = '#/sim/${ROBOT}'`);
  await until('!!(window.__rpsSim && __rpsSim.session)', 60000, 'the Sim session');
  const session = Date.now() - t0;
  await until('!__rpsSim.view.look || ["ready", "failed", "off"].includes(__rpsSim.view.look.state.state)', 60000, 'the baked lab');
  const lookState = await js('__rpsSim.view.look ? { ...__rpsSim.view.look.state } : null');
  const out = { page: base, session_ms: session, look: lookState, views: {} };
  await js('__rpsSim.pause()');
  if (arg('--eval')) out.eval = await js(arg('--eval'));
  if (ONLY.has('open')) out.views.open = await shot('sim-open');

  /* 8 s of teleop at 1x: W forward then a turn */
  await js("(() => { const c = document.querySelector('#rps-canvas'); c.focus(); __rpsSim.run(); __rpsSim.clearStats(); })()");
  const key = (type, k) => js(`document.querySelector('#rps-canvas').dispatchEvent(new KeyboardEvent('${type}', { code: '${k}', key: '${k}', bubbles: true }))`);
  await key('keydown', 'KeyQ'); await sleep(600); await key('keyup', 'KeyQ');
  await key('keydown', 'KeyW'); await sleep(2600); await key('keyup', 'KeyW');
  await key('keydown', 'KeyE'); await sleep(600); await key('keyup', 'KeyE');
  await sleep(4000);
  out.frame = await js('__rpsSim.frameStats()');
  await js('__rpsSim.pause()');
  if (ONLY.has('lh')) {                                     // behind the robot's right, the LH ahead
    const p = await js('__rps.page.ctx.model.basePose');
    await look([p.x + 950, p.y - 520, 820], [p.x - 120, p.y + 380, 280]);
    out.views.lh = await shot('sim-teleop-lh');
  }
  if (ONLY.has('close')) {                                  // the robot close up, from its front right
    const p = await js('__rps.page.ctx.model.basePose');
    await look([p.x + 420, p.y + 520, 560], [p.x, p.y + 20, 220]);
    out.views.close = await shot('sim-robot-close');
  }
  if (ONLY.has('inc') || ONLY.has('reader')) {
    await js("__rpsSim.reset(); __rpsSim.setMode('lab')");
    await js('__rpsSim.setSpeed(8); __rpsSim.turbo(400); __rpsSim.run()');
    await until("__rpsSim.session.instruments.snapshot().stations.inc.state === 'running'", 240000, 'the incubator running');
    await js('__rpsSim.pause(); __rpsSim.turbo(0)');
    await look([330, -520, 1150], [980, 470, 380]);
    if (ONLY.has('inc')) out.views.inc = await shot('sim-lab-incubator');
    await js('__rpsSim.turbo(400); __rpsSim.run()');
    await until("__rpsSim.session.instruments.snapshot().stations.reader.state === 'running'", 240000, 'the reader running');
    await js('__rpsSim.pause(); __rpsSim.turbo(0)');
    await look([-330, -520, 1150], [-980, 470, 400]);
    if (ONLY.has('reader')) out.views.reader = await shot('sim-lab-reader');
    await js('__rpsSim.turbo(400); __rpsSim.run()');
    await until('__rpsSim.session.labState().done', 240000, 'task complete');
    await look([-250, -150, 1250], [-1250, 1900, 1450]);
    if (ONLY.has('reader')) out.views.dashboard = await shot('sim-lab-dashboard');
  }
  if (ONLY.has('cams')) {
    await look(OPEN.eye, OPEN.at);
    await js("[...document.querySelectorAll('.sim-camhead button')].find((b) => b.textContent === 'Grid').click()");
    await sleep(600);
    out.views.cams = await shot('sim-camera-feeds');
    await js("[...document.querySelectorAll('.sim-camhead button')].find((b) => b.textContent === 'Column').click()");
  }
  if (ONLY.has('dark')) {
    await js("(() => { while (__rps.store.get('ui.theme', 'auto') !== 'dark') __rps.page.cycleTheme(); })()");
    await look(OPEN.eye, OPEN.at);
    await sleep(400);
    out.views.dark = await shot('sim-open-dark');
    await js("[...document.querySelectorAll('.sim-camhead button')].find((b) => b.textContent === 'Grid').click()");
    await sleep(600);
    out.views.camsDark = await shot('sim-camera-feeds-dark');
    await js("[...document.querySelectorAll('.sim-camhead button')].find((b) => b.textContent === 'Column').click()");
  }
  out.finish = await js(`(() => { const f = __rpsSim.view.finish, n = {};
    for (const k of f.keys.values()) n[k] = (n[k] || 0) + 1;
    return { palette: __rps.page.viewport.materials.palette, keys: n, materials: new Set(f.map.values()).size }; })()`);
  if (ONLY.has('design')) {
    await js(`location.hash = '#/design/${ROBOT}'`);
    await until("!document.querySelector('.sim-rail')", 10000, 'the Sim view to close');
    await sleep(600);
    out.views.design = await shot('design-after-sim');
    out.design = await js(`(() => { const n = {};
      for (const m of __rps.page.meshes.values()) n[m.material.name] = (n[m.material.name] || 0) + 1;
      return { palette: __rps.page.viewport.materials.palette, materials: n }; })()`);
  }
  out.logs = logs;
  console.log(JSON.stringify(out, null, 1));
  await Promise.race([send('Browser.close'), sleep(2000)]).catch(() => {});
} catch (e) {
  console.error('sim-shots: ' + (e && e.message || e));
  code = 1;
} finally {
  try { ws?.close(); } catch { /* already closed */ }
  try { process.kill(-ch.pid, 'SIGKILL'); } catch { ch.kill('SIGKILL'); }
  server.close();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome still holds it */ }
}
process.exit(code);
