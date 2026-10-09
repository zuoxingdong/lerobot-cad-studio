/*
   The screenshot set, 1600 × 1000 (writes into out/work/e2e/screens/).

     node tools/tests/e2e/shots.mjs                          # every state
     node tools/tests/e2e/shots.mjs selected --out site/media # just these, elsewhere

   Each state is one Chrome run of tests/e2e/shot.html?state=<name>, which drives the BUILT
   page through `window.__rps` and then lets --virtual-time-budget expire so `--screenshot`
   captures a settled frame.  (The behaviour suite in run.mjs never uses virtual time; a
   still frame may.) */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve, ROOT, E2E, FLAGS, chromeBinary } from '../_root.mjs';

const CHROME = chromeBinary();
const argv = process.argv.slice(2);
const outArg = argv.indexOf('--out');
const OUT = outArg >= 0 ? path.resolve(ROOT, argv[outArg + 1])
  : path.join(E2E, 'screens');
const ALL = ['home', 'design', 'selected', 'check', 'export', 'dark'];
/* --virtual-time-budget is spent in VIRTUAL milliseconds; a state that needs longer gets room here */
const BUDGET = {};
const DEFAULT_BUDGET = 40000;
/* A state named `<name>_<n>x` is that state captured on an <n>x display: same CSS layout,
   `--force-device-scale-factor` on top.  It is how a device-pixel regression would show up
   in the screenshot set. */
const DPR_SUFFIX = /_(\d+(?:\.\d+)?)x$/;
const want = argv.filter((a, i) => !a.startsWith('--') && !(outArg >= 0 && i === outArg + 1));
const states = want.length ? want : ALL;

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(CHROME, args, { maxBuffer: 64 * 1024 * 1024, timeout: 180000 }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
    });
  });
}

const reports = [];
const { server, port } = await serve((r) => reports.push(r));
fs.mkdirSync(OUT, { recursive: true });
const rows = [];
let bad = 0;
for (const s of states) {
  const file = path.join(OUT, s + '.png');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rps-shot-'));
  const m = DPR_SUFFIX.exec(s);
  const state = m ? s.slice(0, -m[0].length) : s;
  const dpr = m ? Number(m[1]) : 1;
  /* --window-size is in CSS px, so the frame stays 1600 x 1000 and only the device
     resolution changes — the same thing a user on a 2x display sees. */
  const dprFlags = dpr === 1 ? [] : ['--force-device-scale-factor=' + dpr];
  const url = `http://127.0.0.1:${port}/tools/tests/e2e/shot.html?state=${state}`;
  try {
    await run([...FLAGS, ...dprFlags, '--user-data-dir=' + profile,
      '--virtual-time-budget=' + (BUDGET[state] || DEFAULT_BUDGET), '--screenshot=' + file, url]);
    const st = fs.statSync(file);
    const rep = reports.find((r) => r.state === state);
    const errs = (rep && rep.errors) || [];
    if (errs.length) bad++;
    const saw = rep && rep.saw;
    /* NO REPORT is not "clean": the state never reached its own last line, so the frame that was
       captured is whatever the page happened to be showing.  Say so, and fail the run. */
    if (!rep) bad++;
    const note = !rep ? 'NO REPORT — the state did not finish (raise its virtual-time budget)'
      : errs.length ? errs[0].slice(0, 80)
        : (saw && saw.error) ? 'saw: ' + saw.error
          : (rep.title && /FAIL/.test(rep.title)) ? rep.title
            : 'clean' + (saw && saw.alt ? ` · ${saw.alt} alt parts` : '');
    rows.push([s, path.relative(ROOT, file), (st.size / 1024).toFixed(0) + ' kB', note]);
  } catch (e) {
    bad++;
    rows.push([s, '—', '—', String((e && e.message) || e).slice(0, 90)]);
  } finally {
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); } catch (e) { /* held */ }
  }
}
server.close();

const w = [Math.max(...rows.map((r) => r[0].length)), Math.max(...rows.map((r) => r[1].length))];
console.log('| state'.padEnd(w[0] + 3) + '| file'.padEnd(w[1] + 3) + '| size    | notes');
console.log('|' + '-'.repeat(w[0] + 2) + '|' + '-'.repeat(w[1] + 2) + '|---------|-------');
for (const r of rows) console.log(`| ${r[0].padEnd(w[0])} | ${r[1].padEnd(w[1])} | ${r[2].padStart(7)} | ${r[3]}`);
process.exit(bad ? 1 : 0);
