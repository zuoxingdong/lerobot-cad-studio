/* tools/sim/teleop.mjs: the timeline format, the Sim tab's key semantics, and the default lab tour
 * (deterministic ctrl log; the puck gripped by keys at the liquid handler, carried, seated in the
 * incubator, which then runs to done) on the model `npm run sim:export` writes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadStudio, STUDIO } from '../../sim/lib.mjs';
import { compileScript, keyDriver, bindingOf, playScript } from '../../sim/teleop.mjs';
import { buildMjcf } from '../../../src/features/sim-mjcf.js';
import { compileDesign } from '../../../src/features/sim-excludes.js';
import { loadEngine } from '../../../src/features/sim-engine.js';
import { SIM_KEYS, createTeleop } from '../../../src/features/sim-teleop.js';

const TOUR = path.join(STUDIO, 'tools/sim/lab-tour.json');
const mj = await loadEngine();
const c = compileDesign(mj, buildMjcf(await loadStudio('lekiwi-pincopen')));
const m = c.model;

function run(script) {
  const d = new mj.MjData(m);
  const rows = [];
  const r = playScript(mj, m, d, c.sidecar, script, { onRow: (u) => rows.push(Float32Array.from(u.subarray(0, m.nu))) });
  d.delete();
  const log = new Float32Array(rows.length * m.nu);
  rows.forEach((x, i) => log.set(x, i * m.nu));
  return { ...r, log };
}

test('entries run one after another; taps release after their press; at jumps', () => {
  const s = compileScript({ timeline: [
    { label: 'a', keys: ['KeyW'], hold: 0.5, wait: 0.1 },
    { keys: ['KeyF'], wait: 0.2 },
    { label: 'b', at: 2, keys: ['ShiftLeft', 'KeyQ'], hold: 0.25 },
  ] });
  assert.deepEqual(s.events, [
    { step: 0, code: 'KeyW', down: true }, { step: 250, code: 'KeyW', down: false },
    { step: 300, code: 'KeyF', down: true }, { step: 300, code: 'KeyF', down: false },
    { step: 1000, code: 'ShiftLeft', down: true }, { step: 1000, code: 'KeyQ', down: true },
    { step: 1125, code: 'ShiftLeft', down: false }, { step: 1125, code: 'KeyQ', down: false }]);
  assert.deepEqual(s.labels, [{ step: 0, label: 'a' }, { step: 1000, label: 'b' }]);
  assert.equal(s.steps, 1125);
});

test('bad entries say what is wrong', () => {
  assert.throws(() => compileScript({ timeline: [{ keys: ['KeyZ'], hold: 1 }] }), /not a Sim tab key/);
  assert.throws(() => compileScript({ timeline: [{ keys: ['KeyW'] }] }), /held key/);
  assert.throws(() => compileScript({ timeline: [{ keys: ['KeyR'] }] }), /cannot replay/);
  assert.throws(() => compileScript({ timeline: [{ wait: -1 }] }), /seconds/);
  assert.throws(() => compileScript({}), /timeline/);
});

test('every Sim tab key maps to what the Sim tab does with it', () => {
  const tele = createTeleop(mj, m, new mj.MjData(m), c.sidecar);
  const drv = keyDriver(tele);
  const page = fs.readFileSync(path.join(STUDIO, 'src/ui/sim-page.js'), 'utf8');
  const block = /const actions = \{([\s\S]*?)\n {2}\};/.exec(page)[1];
  const pageActions = [...block.matchAll(/^ {4}(\w+):/gm)].map((x) => x[1]).sort();
  assert.deepEqual(pageActions, [...Object.keys(drv.actions), 'reset'].sort());
  const holds = new Set(['fwd', 'back', 'left', 'right', 'turnL', 'turnR', 'up', 'down']);   // what sim-teleop.js reads
  for (const b of SIM_KEYS) {
    for (const code of [].concat(b.code)) assert.equal(bindingOf(code), b, code);
    if (b.hold) assert.ok(holds.has(b.hold), b.id);
    else if (!b.display) assert.ok(b.action in drv.actions || b.action === 'reset', b.id);
  }
  drv.keyDown('KeyW');
  drv.keyDown('ShiftLeft');
  assert.deepEqual([...tele.held], ['fwd']);
  assert.equal(tele.fast, true);
  drv.keyDown('Space');                      // stop clears the held set; W stays dead until re-pressed
  drv.keyUp('KeyW');
  drv.keyUp('ShiftLeft');
  assert.equal(tele.held.size, 0);
  assert.equal(tele.fast, false);
  assert.equal(tele.selected, 1);
  drv.keyDown('ArrowRight');
  assert.equal(tele.joints[tele.selected], 'arm_elbow_flex');
});

test('a script drives the same ctrl as the same keys held by hand', () => {
  const script = compileScript({ timeline: [{ keys: ['KeyW'], hold: 0.4 }, { keys: ['ArrowRight'] }, { keys: ['ArrowUp'], hold: 0.3 }, { keys: ['KeyF'], wait: 0.3 }] });
  const a = run(script).log;
  const d = new mj.MjData(m);
  mj.mj_resetData(m, d);
  mj.mj_forward(m, d);
  const tele = createTeleop(mj, m, d, c.sidecar);
  tele.sync();
  tele.step(0);
  const b = new Float32Array(a.length);
  for (let k = 0; k < script.steps; k++) {
    if (k === 0) tele.held.add('fwd');
    if (k === 200) { tele.held.delete('fwd'); tele.select(1); tele.held.add('up'); }
    if (k === 350) { tele.held.delete('up'); tele.gripper(); }
    tele.step(0.002);
    for (let i = 0; i < m.nu; i++) b[k * m.nu + i] = d.ctrl[i];
    for (let i = 0; i < m.nu; i++) d.ctrl[i] = b[k * m.nu + i];
    mj.mj_step(m, d);
  }
  d.delete();
  assert.deepEqual(Buffer.from(a.buffer), Buffer.from(b.buffer));
});

test('the lab tour: the same ctrl log twice; the puck carried lh -> inc by keys, seated, the incubator runs', () => {
  const script = compileScript(JSON.parse(fs.readFileSync(TOUR, 'utf8')));
  const one = run(script), two = run(script);
  assert.ok(Buffer.from(one.log.buffer).equals(Buffer.from(two.log.buffer)), 'ctrl logs differ');
  const secs = script.steps * 0.002;
  assert.ok(secs >= 40 && secs <= 65, `${secs} s`);
  const at = (label) => one.phases.find((p) => p.label === label);
  const end = one.phases.at(-1);
  console.log(`  ${secs.toFixed(1)} s, ${one.phases.length} phases; seated ${end.puck.seated_at}; ${one.events.map((e) => `${e.station}:${e.state}@${e.t}`).join(' ')}`);
  assert.equal(at('grip the puck').puck.held, true, 'no grip at the liquid handler');
  assert.ok(one.phases.some((p) => p.puck.held && p.puck.lifted_mm > 60), 'the puck never lifted in the jaw');
  assert.equal(at('strafe to the incubator').puck.held, true, 'dropped on the way');
  assert.equal(at('turn right to face the incubator').puck.held, true, 'dropped in the turn');
  assert.equal(at('release').puck.seated_at, 'inc', 'not seated in the incubator');
  assert.equal(end.puck.seated_at, 'inc');
  assert.ok(end.puck.tilt_deg < 5);
  const seq = one.events.map((e) => `${e.station}:${e.state}`);
  assert.equal(seq[0], 'lh:running', seq.join(' '));
  /* the puck may slide on the lead-in while it touches down (armed <-> idle); the lid then runs once */
  const inc = seq.filter((x) => x.startsWith('inc:'));
  assert.deepEqual(inc.slice(-5), ['inc:armed', 'inc:closing', 'inc:running', 'inc:opening', 'inc:done'], seq.join(' '));
  assert.equal(inc.filter((x) => x === 'inc:closing').length, 1);
  assert.equal(end.instruments.inc, 'done');
  assert.ok(one.keys.some((k) => k.joint === 'arm_elbow_flex'), 'jogs carry their joint');
});

test.after(() => m.delete());
