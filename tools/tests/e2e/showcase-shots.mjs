/*
   The showcase screenshots and frame numbers (1600 × 1000 by default), through ONE headless Chrome (CDP).

     node tools/tests/e2e/showcase-shots.mjs [--out dir] [--quality high] [--file] [--size 1920x1080]
                                             [--at establish:4.0,grasp:10.466] [--clean]
   --clean hides the page's bar, captions and cards (frames to compare with the Cycles stills).

   Seeks the built showcase.html to each shot, waits for settled frames, saves <name>.png and
   prints the renderer counts (draw calls, triangles, memory) and the measured frame rate. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve, pageUrl, ROOT, SITE, E2E, FLAGS, chromeBinary } from '../_root.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OUT = path.resolve(ROOT, arg('--out', path.join(E2E, 'showcase')));
const QUALITY = arg('--quality', 'high');
const AT = arg('--at', '');
const [W, H] = arg('--size', '1600x1000').split('x').map(Number);
const SHOTS = AT ? AT.split(',').map((s) => ({ name: s.split(':')[0], t: Number(s.split(':')[1]) })) : [
  { name: 'establishing', t: 4.0 },
  { name: 'grasp', t: 10.5 },
  { name: 'incubator', t: 28.9 },
  { name: 'reader', t: 58.0 },
  { name: 'free-cam', t: 45.0, free: [0.9, 0.35] },
  { name: 'robot-cameras', t: 36.9, cams: true },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { server, port } = await serve(() => {});
const url = argv.includes('--file') ? pathToFileURL(path.join(SITE, 'showcase.html')).href : pageUrl(port, 'showcase.html');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rps-sc-'));
const dport = 9300 + Math.floor(Math.random() * 400);
// its own process group, so the finally below takes down the renderer and GPU children too
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
  const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const frames = (n) => js(`new Promise((r) => { const f0 = __showcase.state().frame; const k = () => __showcase.state().frame >= f0 + ${n} ? r(1) : requestAnimationFrame(k); k(); })`);

  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const t0 = Date.now();
  await send('Page.navigate', { url: `${url}?paused&quality=${QUALITY}` });
  let ready = false;
  while (!ready && Date.now() - t0 < 120000) { await sleep(250); ready = await js('!!(window.__showcase && __showcase.ready)'); }
  if (!ready) throw new Error('the showcase was not ready in 120 s: ' + logs.slice(0, 3).join(' | '));
  const loadMs = Date.now() - t0;
  if (argv.includes('--clean')) {
    await js(`(() => { const st = document.createElement('style'); st.textContent = '.sc-bar,.sc-top,.sc-cap,.sc-card,.sc-labels,.sc-fade{display:none!important}'; document.head.appendChild(st); })()`);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const rows = [];
  for (const s of SHOTS) {
    await js(`(() => { const S = __showcase; S.pause(); if (S.state().free) S.toggleFree(); if (S.state().cams !== ${!!s.cams}) S.toggleCams(); S.seek(${s.t}); })()`);
    await frames(3);
    if (s.free) {
      await js(`(() => { __showcase.toggleFree(); const c = __showcase.controls(); c.rotateLeft(${s.free[0]}); c.rotateUp(${-s.free[1]}); c.dollyOut(1.35); c.update(); })()`);
      await frames(12);
    }
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, s.name + '.png'), Buffer.from(shot.result.data, 'base64'));
    const st = await js('__showcase.state()');
    rows.push({ shot: s.name, t: s.t, calls: st.stats.calls, triangles: st.stats.triangles, tier: st.tier });
  }
  await js('(() => { const S = __showcase; if (S.state().free) S.toggleFree(); if (S.state().cams) S.toggleCams(); S.seek(12); S.play(); })()');
  await sleep(6000);
  const st = await js('__showcase.state()');
  console.log(JSON.stringify({ url, loadMs, quality: QUALITY, playing: st.stats, gpu: st.gpu, rows, errors: st.errors, logs }, null, 1));
  await Promise.race([send('Browser.close'), sleep(2000)]).catch(() => {});
} catch (e) {
  console.error('showcase-shots: ' + (e && e.message || e));
  code = 1;
} finally {
  try { ws?.close(); } catch { /* already closed */ }
  try { process.kill(-ch.pid, 'SIGKILL'); } catch { ch.kill('SIGKILL'); }
  server.close();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome still holds it */ }
}
process.exit(code);
