/* features/sim-engine.js and site/vendor/mujoco-wasm.js: the vendor script is a classic
 * script that runs outside node and outside a module, and the node engine is the same build. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { join } from 'node:path';
import { ROOT, SITE } from '../_root.mjs';
import { loadEngine, compile, createSim, VENDOR_GLOBAL, VENDOR_SCRIPT } from '../../../src/features/sim-engine.js';

const BALL = '<mujoco><option timestep="0.002"/><worldbody><geom type="plane" size="1 1 0.1"/>'
  + '<body pos="0 0 0.5"><freejoint/><geom size="0.05" mass="0.1"/></body></worldbody></mujoco>';

test('the vendor script defines the engine without node, modules or fetch', async () => {
  const file = join(SITE, VENDOR_SCRIPT);
  const code = fs.readFileSync(file, 'utf8');
  const pin = JSON.parse(fs.readFileSync(join(ROOT, 'package.json'), 'utf8')).dependencies['@mujoco/mujoco'];
  assert.ok(!/\bimport\.meta\b/.test(code) && !/^export /m.test(code), 'a classic script');
  /* a worker-like global: no process, no window, no document */
  const ctx = { WorkerGlobalScope: function WorkerGlobalScope() {}, crypto: globalThis.crypto, console,
    self: { location: { href: 'file:///studio/index.html' } }, WebAssembly, TextDecoder, TextEncoder,
    setTimeout, clearTimeout, performance, URL };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const V = ctx[VENDOR_GLOBAL];
  assert.equal(V.version, pin);
  const wasm = zlib.gunzipSync(Buffer.from(V.wasm, 'base64'));
  const mj = await V.load({ wasmBinary: wasm, locateFile: () => '' });
  const vfs = new mj.MjVFS();
  vfs.addBuffer('a.xml', new TextEncoder().encode(BALL));
  const m = mj.MjModel.from_xml_path('a.xml', vfs);
  vfs.delete();
  const d = new mj.MjData(m);
  for (let i = 0; i < 500; i++) mj.mj_step(m, d);
  assert.ok(Math.abs(d.qpos[2] - 0.05) < 0.005, `ball at rest on the floor: z ${d.qpos[2]}`);
  d.delete();
  m.delete();
  console.log(`  ${(code.length / 1e6).toFixed(2)} MB script, ${(wasm.length / 1e6).toFixed(2)} MB wasm`);
});

test('node engine: compile through the VFS, a fixed 2 ms step, explicit free', async () => {
  const mj = await loadEngine();
  assert.equal(await loadEngine(), mj, 'one engine per process');
  const m = compile(mj, { xml: BALL, meshes: new Map() });
  const sim = createSim(mj, m);
  sim.step(250);
  assert.ok(Math.abs(sim.time - 0.5) < 1e-9);
  sim.reset();
  assert.equal(sim.time, 0);
  sim.free();
  sim.free();
  assert.throws(() => createSim(mj, compile(mj, { xml: BALL.replace('0.002', '0.005'), meshes: new Map() })), /timestep/);
});
