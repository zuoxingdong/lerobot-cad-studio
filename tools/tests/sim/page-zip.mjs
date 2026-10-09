// The Sim tab's "Download MJCF zip", built headless: the model as the Design page holds it after
// boot, `ui/sim-run.js` for the session and the lab run, `zipSync(files(), {level: 6})` as sim-page.
//   node tools/tests/sim/page-zip.mjs [--robot lekiwi-pincopen] [--no-lab] out.zip
import fs from 'node:fs';
import path from 'node:path';
import { zipSync } from 'fflate';
import * as pkg from '../../../src/core/package.js';
import { defaultDesign } from '../../../src/core/store.js';
import { buildSlots } from '../../../src/features/slots.js';
import { parametricComponentsOf, rebuildComponent } from '../../../src/features/parts.js';

globalThis.requestAnimationFrame ??= (f) => setTimeout(() => f(performance.now()), 0);
const { openSession } = await import('../../../src/ui/sim-run.js');

/** RobotModel + slots + design after the Design page's boot: `rebuildParametric` on every
    parametric component (ui/design-scene.js), no other edit. */
export async function pageState(robot = 'lekiwi-pincopen') {
  const model = await pkg.loadEmbedded(robot, { loadGeometry: true });
  const slots = buildSlots(model);
  const design = slots.applyDefaults(defaultDesign(robot));
  for (const id of parametricComponentsOf(model)) {
    const r = rebuildComponent(model, design, id);
    const c = model.component(id);
    if (!r.ok || !r.geometry || !c) continue;
    c.geometry = r.geometry;
    if (r.place && c.frame === 'robot' && !((design.components || {})[id] || {}).transform) c.local.copy(r.place);
  }
  return { model, slots, design };
}

/** {session, files, zip}: `lab` runs the task to the end first, 25 steps a frame as the page. */
export async function pageZip({ robot = 'lekiwi-pincopen', lab = true } = {}) {
  const st = await pageState(robot);
  const s = await openSession({ ...st, edited: new Map() });
  if (lab) {
    if (s.setMode('lab') !== 'lab') throw new Error(`${robot}: no lab task`);
    while (!s.labState().done) s.advance(1 / 20);
  }
  const files = s.files();
  const zip = zipSync(files, { level: 6 });
  return { session: s, files, zip };
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const a = process.argv.slice(2);
  const ri = a.indexOf('--robot');
  const robot = ri >= 0 ? a[ri + 1] : 'lekiwi-pincopen';
  const out = a.filter((x, i) => !x.startsWith('--') && a[i - 1] !== '--robot').pop();
  if (!out) { console.error('usage: page-zip.mjs [--robot id] [--no-lab] out.zip'); process.exit(2); }
  const { session, zip, files } = await pageZip({ robot, lab: !a.includes('--no-lab') });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, zip);
  const st = session.labState();
  console.log(`wrote ${out}: ${Object.keys(files).length} files, ${zip.byteLength} B, hash ${session.hash}`
    + (st ? `, lab ${st.transfers}/${st.transfersPlanned} transfers, puck in ${st.puckAt}` : ''));
  session.free();
}
