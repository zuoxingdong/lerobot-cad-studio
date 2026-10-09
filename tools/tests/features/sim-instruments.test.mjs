/* features/sim-instruments.js on the rps/lab@2 fixture: the section 3.4 machine driven by a scripted
 * puck (no MuJoCo), its snapshot, the dashboard loop, and the nav clearance of sim-lab-watch.js. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInstruments, seatedIn } from '../../../src/features/sim-instruments.js';
import { navClearance } from '../../../src/features/sim-lab-watch.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { lab } = JSON.parse(fs.readFileSync(path.join(HERE, '../fixtures/lab2-sidecar.json'), 'utf8'));
const S = Object.fromEntries(lab.stations.map((s) => [s.id, s]));
const DT = 0.002;

/* a puck resting in a nest, or held at a point; the grasp site at `g` */
const inNest = (id, dx = 0) => ({ bottom: [S[id].nest.xy[0] + dx, S[id].nest.xy[1], S[id].nest.floor_z + 0.4], tilt_deg: 0.3 });
const lifted = (id) => ({ bottom: [S[id].nest.xy[0], S[id].nest.xy[1], S[id].nest.floor_z + 70], tilt_deg: 1 });
const away = (id, mm) => [S[id].nest.xy[0] - mm, S[id].nest.xy[1], 400];

function driver() {
  const inst = createInstruments(lab);
  let t = 0, k = 0;
  const run = (secs, puck, grasp, pads = 0) => {
    const n = Math.round(secs / DT);
    for (let i = 0; i < n; i++) { t += DT; k++; inst.step(t, { step: k, puck: { ...puck, pads, held: pads === 2 }, grasp }); }
  };
  return { inst, run, get t() { return t; } };
}

test('seatedIn: 2.0 mm clearance + 0.5 per side of the square collar, within 2.5 mm of the floor, tilt under 5 deg', () => {
  assert.ok(seatedIn(S.inc, inNest('inc', 2.4), 50));
  assert.ok(!seatedIn(S.inc, inNest('inc', 2.6), 50));
  const corner = { bottom: [S.inc.nest.xy[0] + 2, S.inc.nest.xy[1] - 2, S.inc.nest.floor_z], tilt_deg: 0.1 };
  assert.ok(seatedIn(S.inc, corner, 50), 'a puck resting in a corner (2.83 mm radial) is seated');
  assert.ok(!seatedIn(S.inc, { ...inNest('inc'), tilt_deg: 5.1 }, 50));
  assert.ok(!seatedIn(S.inc, lifted('inc'), 50));
});

test('the full cycle: lh busy once the puck leaves, inc and reader run idle -> armed -> ... -> done', () => {
  const D = driver(), { inst } = D;
  assert.deepEqual(inst.stations, ['lh', 'inc', 'reader']);
  assert.equal(inst.state('lh'), 'done');
  assert.equal(inst.snapshot().loop[1], true);
  D.run(0.5, inNest('lh'), [0, 810, 357], 2);                 // gripped in the lh nest
  assert.equal(inst.state('lh'), 'done');
  D.run(0.5, lifted('lh'), [0, 810, 427], 2);                 // lifted out
  assert.equal(inst.state('lh'), 'running');
  assert.equal(inst.snapshot().loop[1], false);
  D.run(0.5, inNest('inc'), away('inc', 0), 2);               // inserted, still held
  assert.equal(inst.state('inc'), 'idle');
  D.run(0.2, inNest('inc'), away('inc', 0), 0);               // released
  assert.equal(inst.state('inc'), 'armed');
  D.run(3, inNest('inc'), away('inc', 150), 0);               // the robot stands 150 mm off: too close to close
  assert.equal(inst.state('inc'), 'armed');
  D.run(0.99, inNest('inc'), away('inc', 270), 0);            // backed off: the dwell runs
  assert.equal(inst.state('inc'), 'armed');
  D.run(0.016, inNest('inc'), away('inc', 270), 0);
  assert.equal(inst.state('inc'), 'closing');
  D.run(0.39, inNest('inc'), away('inc', 270), 0);
  const mid = inst.snapshot().stations.inc;
  assert.ok(mid.closure > 0.4 && mid.closure < 0.6, `closure ${mid.closure}`);
  D.run(0.42, inNest('inc'), away('inc', 270), 0);
  assert.equal(inst.state('inc'), 'running');
  assert.equal(inst.snapshot().loop[2], true);
  D.run(2, inNest('inc'), away('inc', 270), 0);
  const run = inst.snapshot().stations.inc;
  assert.equal(run.closure, 1);
  assert.ok(Math.abs(run.progress - 0.5) < 0.01 && Math.abs(run.remaining - 2) < 0.03, JSON.stringify(run));
  D.run(2.9, inNest('inc'), away('inc', 270), 0);
  assert.equal(inst.state('inc'), 'done');
  D.run(0.3, lifted('inc'), away('inc', 0), 2);               // picked up again
  assert.equal(inst.state('inc'), 'idle');
  D.run(0.3, inNest('reader'), away('reader', 0), 0);
  assert.equal(inst.state('reader'), 'armed');
  D.run(1.2, inNest('reader'), away('reader', 250), 0);
  assert.equal(inst.state('reader'), 'closing');
  D.run(0.6 + 1.5, inNest('reader'), away('reader', 400), 0);
  const rd = inst.snapshot().stations.reader;
  assert.equal(rd.state, 'running');
  assert.ok(rd.bars.every((b, i) => b > 0 && b < lab.stations[2].result[i]), JSON.stringify(rd.bars));
  D.run(1.5 + 0.61, inNest('reader'), away('reader', 700), 0);
  const end = inst.snapshot();
  assert.equal(end.stations.reader.state, 'done');
  assert.deepEqual(end.stations.reader.bars, lab.stations[2].result);
  assert.equal(end.loop[3], true);
  assert.equal(end.loop[2], false);
  assert.equal(end.loop[0], false);
  D.run(1.5, inNest('reader'), away('reader', 900), 0);
  assert.equal(inst.snapshot().loop[0], true);
  const seq = inst.events.map((e) => `${e.station}:${e.state}`).join(' ');
  assert.equal(seq, 'lh:running inc:armed inc:closing inc:running inc:opening inc:done inc:idle '
    + 'reader:armed reader:closing reader:running reader:opening reader:done');
  for (let i = 1; i < inst.events.length; i++) assert.ok(inst.events[i].step >= inst.events[i - 1].step);
  const e = inst.events.find((x) => x.station === 'inc' && x.state === 'running');
  const c = inst.events.find((x) => x.station === 'inc' && x.state === 'closing');
  assert.ok(Math.abs(e.t - c.t - 0.8) < 0.003, `close took ${e.t - c.t} s`);
});

test('armed falls back to idle when the puck is taken out before the lid closes', () => {
  const D = driver();
  D.run(0.2, inNest('inc'), away('inc', 0), 0);
  assert.equal(D.inst.state('inc'), 'armed');
  D.run(0.1, lifted('inc'), away('inc', 0), 2);
  assert.equal(D.inst.state('inc'), 'idle');
  assert.equal(D.inst.snapshot().stations.inc.closure, 0);
});

test('arming waits 0.1 s seated and let go: a held flicker at touch-down does not arm', () => {
  const D = driver();
  D.run(0.3, inNest('inc'), away('inc', 0), 2);
  D.run(0.06, inNest('inc'), away('inc', 0), 1);
  D.run(0.3, inNest('inc'), away('inc', 0), 2);
  assert.equal(D.inst.state('inc'), 'idle');
  D.run(0.098, inNest('inc'), away('inc', 0), 0);
  assert.equal(D.inst.state('inc'), 'idle');
  D.run(0.004, inNest('inc'), away('inc', 0), 0);
  assert.equal(D.inst.state('inc'), 'armed');
});

test('the same inputs give the same events (deterministic)', () => {
  const go = () => { const D = driver(); D.run(0.1, inNest('inc'), away('inc', 0), 0); D.run(8, inNest('inc'), away('inc', 300), 0); return JSON.stringify(D.inst.events); };
  assert.equal(go(), go());
});

test('nav clearance: 93 mm at the lh park, 83 mm to the charger tower at the dock', () => {
  const a = navClearance(lab, 0, 490), b = navClearance(lab, 0, 0), c = navClearance(lab, 740, 490);
  assert.equal(a.to, 'lh');
  assert.ok(Math.abs(a.mm - 93) < 1e-9, a.mm);
  assert.equal(b.to, 'dock_tower');
  assert.ok(Math.abs(b.mm - 83) < 1e-9, b.mm);
  assert.equal(c.to, 'inc');
  assert.ok(Math.abs(c.mm - 93) < 1e-9, c.mm);
});
