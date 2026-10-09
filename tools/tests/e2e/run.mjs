/*
   tools/tests/e2e/run.mjs — THE headless behaviour suite.

     node tools/tests/e2e/run.mjs [--keep] [--timeout 1200] [--only a,b,c] [--shard 1|2|3] [--src other.html]

   `--shard n` runs one third of the suites (CI runs the three in parallel).  With $CI set the
   harness gets ?ci=1: the two timing checks take their relaxed bounds and every watchdog doubles,
   and the `gpu` suites are skipped (SwiftShader on a runner is too slow for MuJoCo in real time;
   `--only` still runs them).

   Serves site/ on loopback under the Pages path (_root.mjs BASE), starts ONE headless Chrome and
   walks it through the suites in `tools/tests/e2e/cases/`, one page at a time —
   `harness.html?suite=<n>&next=<url>` chains itself forward when a suite publishes.  Every suite POSTs its report back here; this file
   merges them into one table and one exit code.  The MJCF zips a suite downloads are
   unzipped and checked by tools/sim/check.py (uv) once Chrome has closed.

   Deliberately NO --virtual-time-budget: it virtualises the clock, starves rAF and breaks
   every debounce the studio relies on (the 120 ms chip pass, the 400 ms preset physics,
   the ~6 Hz camera tick).  The POST-back replaces it, so the page runs in real time and
   the run ends the moment the last suite finishes. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import { buildFixture } from './fixture.mjs';
import { ROOT, SITE, E2E, BASE, serve, FLAGS, chromeBinary } from '../_root.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const CHROME = chromeBinary();
const TIMEOUT = Number(arg('--timeout', 1200)) * 1000;
const SRC = arg('--src', 'index.html');
const SHARD = Number(arg('--shard', 0));
const CI = !!process.env.CI && process.env.CI !== 'false';
const HERE = path.dirname(fileURLToPath(import.meta.url));

/* the suites; `file: true` runs the page from file://, `page` loads that page in place of index.html,
   `case` names the module when two suites share one (`--only <case>` runs both).  `shard` balances the
   three CI jobs, gpu suites skipped; measured on a runner: 1 = 250 s, 2 = 300 s, 3 = 320 s */
const SUITES = [
  { name: 'core',         shard: 2, watchdog: 240, what: 'Home, tree, swaps and cascades, the jaw, Options, import, delete, a gizmo move, Recents, a URDF import' },
  { name: 'shell',        shard: 2, watchdog: 300, what: 'J1 / J2 / J3 click counts, 70 % canvas free, text budget, the pill, 1 2 3, help, narrow windows, layers' },
  { name: 'tweak-ops',    shard: 2, watchdog: 240, what: 'stretch −20 → checks → undo → zip, mirror copy, tilt knob, Esc, v6 tweaks, a mirrored pair' },
  { name: 'swap',         shard: 2, watchdog: 420, what: 'one mount per seat, stock / bare gripper, every camera on its mount, Reset, stored designs, an alternative' },
  { name: 'link-folder',  shard: 2, watchdog: 300, what: 'Ask an agent: prompt, linked folder, a design written mid-session → toast → Use, errors, drop' },
  { name: 'check',        shard: 2, watchdog: 300, what: 'the Check tab: tiles, look-through, calibration, per-camera verdicts on load, blocked presets' },
  { name: 'print-export', shard: 2, watchdog: 420, what: 'print poses, the Export sheet and its waiver, a non-manifold import, the MJCF zip for check.py' },
  { name: 'sim-teleop',   shard: 1, watchdog: 330, file: true, gpu: true, what: 'Sim tab from file://: MuJoCo loads, W drives, arrows jog, F grips, Esc releases, the Design pose back exactly, 3 open/close cycles' },
  { name: 'sim-lab',      shard: 3, watchdog: 420, gpu: true, what: 'Lab task: step, reset, sliced plan, the puck lh -> inc -> reader, the instruments, the downloaded MJCF zip for check.py' },
  { name: 'showcase',     shard: 1, watchdog: 300, file: true, page: 'showcase.html', what: 'showcase.html from file://: loads, plays, 3 chapter marks, free camera, robot cameras, keys, budgets' },
  { name: 'showcase-http', case: 'showcase', shard: 3, watchdog: 300, page: 'showcase.html', what: 'the same over http' },
];

/** `uv run --extra sim python tools/sim/check.py <dir>`: {ok, ms, detail} from its last line */
function checkPy(dir, extra) {
  return new Promise((res) => {
    const t0 = Date.now();
    const p = spawn('uv', ['run', '--extra', 'sim', 'python', 'tools/sim/check.py', dir, ...extra], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { out += c; });
    p.on('close', (rc) => {
      const m = /(\d+) checks, (\d+) failed/.exec(out);
      res({ ok: rc === 0 && !!m && m[2] === '0', ms: Date.now() - t0,
        detail: m ? `${Number(m[1]) - Number(m[2])}/${m[1]} checks ok` : 'check.py: ' + out.trim().split('\n').slice(-2).join(' | ').slice(0, 200) });
    });
    p.on('error', (e) => res({ ok: false, ms: 0, detail: 'check.py did not start: ' + e.message }));
  });
}

/* the run */
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const dist = path.join(SITE, SRC);
  if (!fs.existsSync(dist)) { console.error('no site/' + SRC + ' — run `npm run build` first'); process.exit(1); }
  await buildFixture(true);

  const only = (arg('--only', '') || '').split(',').filter(Boolean);
  const skipped = [];
  const plan = SUITES.filter((s) => {
    if (only.length && !only.includes(s.name) && !(s.case && only.includes(s.case))) return false;
    if (SHARD && s.shard !== SHARD) return false;
    if (CI && s.gpu && !only.length) { skipped.push([s.name, 'needs a GPU; run it locally']); return false; }
    return true;
  });
  /* THE FILE:// SUITE GOES FIRST.  One Chrome walks the chain by `location.href`, and a
     page served over http MAY NOT navigate to a `file://` URL — Chrome blocks it silently,
     so the chain died there and the run sat waiting for a report that could never come.
     A file:// page navigating to http is allowed, so putting it at the head works. */
  plan.sort((a, b2) => (b2.file ? 1 : 0) - (a.file ? 1 : 0));
  if (!plan.length) { console.error('no suite to run'); process.exit(1); }

  /* the collector: one POST per suite, plus the chain's final `{done:true}` */
  const reports = [];
  let finish;
  const allDone = new Promise((r) => { finish = r; });
  const t0 = Date.now();
  const { server, port } = await serve((r) => {
    if (r && r.done) { finish(); return; }
    reports.push(r);
    /* one line per suite as it lands, so a stalled run says WHERE it stalled */
    const n = (r && r.results || []).length;
    const bad = (r && r.results || []).filter((x) => x.ok === false).length;
    console.log(`  ${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s  ${String(r && r.suite).padEnd(16)}`
      + `${n - bad}/${n}${bad ? '  ' + bad + ' FAILED' : ''}`);
    if (reports.length >= plan.length) finish();
  });

  const POST = `http://127.0.0.1:${port}/e2e-report`;
  const url = (i) => {
    const s = plan[i];
    if (!s) return '';
    const q = new URLSearchParams({ suite: s.name, post: POST, watchdog: String((s.watchdog || 200) * (CI ? 2 : 1)) });
    if (CI) q.set('ci', '1');
    if (s.case) q.set('case', s.case);
    if (s.page) q.set('src', s.file ? pathToFileURL(path.join(SITE, s.page)).href : BASE + s.page);
    else if (s.file) q.set('src', pathToFileURL(dist).href);
    else q.set('src', BASE + SRC);
    const next = url(i + 1);
    if (next) q.set('next', next);
    const base = s.file
      ? pathToFileURL(path.join(HERE, 'harness.html')).href
      : `http://127.0.0.1:${port}/tools/tests/e2e/harness.html`;
    return `${base}?${q}`;
  };
  const first = url(0);

  console.log(`suites  ${plan.map((s) => s.name).join(' → ')}${SHARD ? `  (shard ${SHARD})` : ''}${CI ? '  (CI bounds)' : ''}`);
  for (const [n, why] of skipped) console.log(`skip    ${n} — ${why}`);
  console.log('url     ' + first);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rps-e2e-'));
  /* --allow-file-access-from-files is for the ONE file:// suite; it changes nothing for
     the http pages, so the whole chain can share a single Chrome. */
  const child = spawn(CHROME, [...FLAGS, '--allow-file-access-from-files',
    '--user-data-dir=' + profile, first], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });

  let timedOut = false;
  await Promise.race([allDone, new Promise((r) => setTimeout(() => { timedOut = true; r(); }, TIMEOUT))]);
  try { child.kill('SIGKILL'); } catch (e) { /* gone */ }
  server.close();
  if (!argv.includes('--keep')) {
    await new Promise((r) => setTimeout(r, 250));
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (e) { /* Chrome still holds it */ }
  }

  /* the table */
  const rows = [];
  for (const s of plan) {
    const r = reports.find((x) => x && x.suite === s.name);
    if (!r) { rows.push({ suite: s.name, name: 'the suite never reported', ok: false, ms: 0, detail: timedOut ? 'the run timed out before it ran' : 'no POST' }); continue; }
    if (r.error) { rows.push({ suite: s.name, name: 'the suite threw', ok: false, ms: 0, detail: String(r.error).slice(0, 200) }); }
    for (const c of (r.results || [])) rows.push({ suite: s.name, ...c });
    if (!(r.results || []).length && !r.error) rows.push({ suite: s.name, name: 'zero checks', ok: false, ms: 0, detail: 'the suite published an empty report' });
  }

  const outDir = E2E;
  fs.mkdirSync(outDir, { recursive: true });
  /* the two MJCF zips the page handed out, unzipped and checked in native MuJoCo */
  for (const [key, suite, name, extra] of [['exportMjcf', 'print-export', 'export-mjcf', ['--no-lab']], ['mjcfZip', 'sim-lab', 'sim-mjcf', []]]) {
    const z64 = (reports.find((r) => r && r[key]) || {})[key];
    if (!z64) continue;
    const zip = path.join(outDir, name + '.zip'), dir = path.join(outDir, name);
    fs.writeFileSync(zip, Buffer.from(z64, 'base64'));
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [rel, bytes] of Object.entries(unzipSync(fs.readFileSync(zip)))) {
      if (rel.endsWith('/')) continue;
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), bytes);
    }
    const r = await checkPy(dir, extra);
    rows.push({ suite, name: `the downloaded ${name}.zip passes tools/sim/check.py${extra.length ? ' ' + extra.join(' ') : ''}`, ok: r.ok, ms: r.ms, detail: r.detail });
  }

  const pad = (v, n) => String(v).padEnd(n);
  const wS = Math.max(5, ...rows.map((r) => r.suite.length));
  const wN = Math.max(5, ...rows.map((r) => String(r.name).length));
  console.log('');
  console.log(`| # | ${pad('suite', wS)} | ${pad('check', wN)} | result | ms   | detail`);
  console.log(`|---|${'-'.repeat(wS + 2)}|${'-'.repeat(wN + 2)}|--------|------|--------`);
  rows.forEach((r, i) => {
    const v = r.ok === null ? 'SKIP' : r.ok ? 'PASS' : 'FAIL';
    console.log(`| ${i + 1} | ${pad(r.suite, wS)} | ${pad(r.name, wN)} | ${pad(v, 6)} | ${String(r.ms || 0).padStart(4)} | ${r.detail}`);
  });
  const ran = rows.filter((r) => r.ok !== null);
  const passed = ran.filter((r) => r.ok).length;
  console.log(`\n${passed}/${ran.length} passed over ${plan.length} suite${plan.length === 1 ? '' : 's'}`
    + (skipped.length ? ` · ${skipped.length} suite${skipped.length === 1 ? '' : 's'} skipped` : ''));

  const stl64 = (reports.find((r) => r && r.stl) || {}).stl || null;
  let extra = 0;
  if (stl64) {
    const stl = path.join(outDir, '_export.stl');
    fs.writeFileSync(stl, Buffer.from(stl64, 'base64'));
    /* the export is only "valid" if a real mesh library can read it back */
    const py = process.env.PYTHON || 'python3';
    const code = `import trimesh,json;m=trimesh.load(${JSON.stringify(stl)},file_type='stl');`
      + `print(json.dumps({'faces':len(m.faces),'verts':len(m.vertices),`
      + `'volume_cm3':round(abs(m.volume)/1000,2),'bbox':[round(float(x),2) for x in m.extents],`
      + `'watertight':bool(m.is_watertight),'bodies':len(m.split(only_watertight=False))}))`;
    await new Promise((res) => {
      /* a wedged interpreter must not hold the whole run open: this is a report line,
         not a check */
      const p2 = spawn(py, ['-c', code], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
      let o = '';
      p2.stdout.on('data', (c) => { o += c; });
      p2.on('close', (rc) => {
        let j = null;
        try { j = rc === 0 && o.trim() ? JSON.parse(o.trim()) : null; } catch (e) { j = null; }
        if (j) {
          extra = 1;
          console.log(`| ${rows.length + 1} | ${pad('core', wS)} | ${pad('export · trimesh reads the STL back', wN)} | PASS   |    0 | `
            + `${j.faces} faces · ${j.volume_cm3} cm³ · ${j.bbox.join(' × ')} mm · watertight ${j.watertight}`);
          fs.writeFileSync(path.join(outDir, 'e2e-stl.json'), JSON.stringify(j, null, 1));
        } else {
          console.log(`stl   ${path.relative(ROOT, stl)}  ${fs.statSync(stl).size} bytes (trimesh not available)`);
        }
        res();
      });
      p2.on('error', () => res());
    });
  }
  void extra;
  fs.writeFileSync(path.join(outDir, 'e2e-report.json'), JSON.stringify(
    { ok: rows.every((r) => r.ok !== false), suites: plan.map((s) => s.name), skipped, rows }, null, 1));

  /* A suite that tested nothing must FAIL, not pass quietly. */
  if (timedOut) {
    console.error(`\ntimed out after ${TIMEOUT / 1000}s — ${reports.length}/${plan.length} suites reported`);
    const errs = stderr.split('\n').filter((l) => /ERROR|Uncaught/.test(l)).slice(0, 10);
    if (errs.length) console.error(errs.join('\n'));
  }
  process.exit(rows.every((r) => r.ok !== false) && !timedOut ? 0 : 1);
}
