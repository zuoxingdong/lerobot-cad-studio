/* One Sim session: the live design compiled to MuJoCo, one MjData driven by teleop or the lab
   task at a fixed 2 ms step, the metrics, and the files the ⋯ menu hands out.  No DOM. */

import { strToU8 } from 'fflate';
import { loadEngine, createSim, indexSim } from '../features/sim-engine.js';
import { buildMjcf } from '../features/sim-mjcf.js';
import { compileDesign, setPose } from '../features/sim-excludes.js';
import { sceneDoc, loadLabScene } from '../features/sim-scene.js';
import { TIMESTEP } from '../features/sim-physics.js';
import { createLab } from '../features/sim-lab.js';
import { instrumentCaption, phaseName } from '../features/sim-lab-plan.js';
import { createInstruments, puckProbe } from '../features/sim-instruments.js';
import { indexModel, contacts } from '../features/sim-ik.js';
import { createTeleop } from '../features/sim-teleop.js';
import { createMetrics } from '../features/sim-metrics.js';

export const MAX_STEPS = 25;
const PLAN_SLICE_MS = 10;
const CACHE_KEY = 'rps/sim-excludes@1';
const excludes = new Map();
let excludesLoaded = null;

/* the sweep result per design hash: a sync Map, mirrored to IndexedDB */
function loadExcludes() {
  if (!excludesLoaded) {
    excludesLoaded = import('idb-keyval').then(async (m) => {
      const v = await m.get(CACHE_KEY);
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!excludes.has(k)) excludes.set(k, x);
    }).catch(() => {});
  }
  return excludesLoaded;
}
const excludeCache = {
  get: (k) => excludes.get(k),
  set(k, v) {
    excludes.set(k, v);
    const keep = Object.fromEntries([...excludes].slice(-8));
    import('idb-keyval').then((m) => m.set(CACHE_KEY, keep)).catch(() => {});
  },
};

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

/** Engine, design -> model, data.  `edited`: Map<componentId, BufferGeometry> of live edits. */
export async function openSession({ model, slots, design, edited, onStage = () => {} }) {
  const t0 = performance.now();
  onStage('engine');
  /* the lab decor rides in the model (visual only); without its script the physics is the same */
  const [mj, , labScene] = await Promise.all([loadEngine(), loadExcludes(), loadLabScene().catch(() => null)]);
  const tEngine = performance.now();
  onStage('build');
  await nextFrame();
  const designPose = model.getJoints();
  const built = buildMjcf({ model, slots, design, scene: await sceneDoc('lab'), geometry: edited, labScene });
  const tBuild = performance.now();
  const c = compileDesign(mj, built, { cache: excludeCache });
  const sidecar = c.sidecar, m = c.model;
  let sim = null, ix;
  try {
    sim = createSim(mj, m);
    ix = indexSim(mj, m, sidecar);
  } catch (e) {
    if (sim) sim.free(); else m.delete();          // the compiled model goes with the session
    throw e;
  }
  const tReady = performance.now();
  const timing = { engine_ms: Math.round(tEngine - t0), build_ms: Math.round(tBuild - tEngine),
    compile_ms: c.ms.compile, sweep_ms: c.ms.first ?? 0, cached: c.cached, total_ms: Math.round(tReady - t0) };
  return createSession({ mj, sim, c, built, sidecar, ix, design, designPose, timing, labScene });
}

function createSession({ mj, sim, c, built, sidecar, ix, design, designPose, timing, labScene }) {
  const m = c.model;
  const nu = m.nu;
  const labOK = !!(sidecar.lab && sidecar.lab.schema === 'rps/lab@2' && sidecar.jaw_joints && sidecar.jaw_joints.length && (sidecar.props || []).length);
  const hasLab2 = !!(sidecar.lab && sidecar.lab.schema === 'rps/lab@2' && sidecar.lab.props.length);
  let mode = 'teleop', lab = null, labRun = null, acc = 0, dead = false, speed = 1, inst = null, probe = null;
  let teleop = createTeleop(mj, m, sim.data, sidecar);
  const instruments = () => (mode === 'lab' ? lab && lab.instruments : inst);
  let metrics = createMetrics(mj, m, sidecar, { speed: () => speed, instruments });
  /* teleop steps its own instruments; the lab task owns one */
  const stepInstruments = () => {
    if (!inst) return;
    const s = probe(sim.data, contacts(sim.data));
    inst.step(sim.data.time, s);
  };

  const armPose = () => Object.fromEntries(sidecar.arm_joints.map((n) => [n, designPose[n] || 0]));
  const jawPose = () => (sidecar.jaw_joints[0] ? designPose[sidecar.jaw_joints[0]] || 0 : 0);

  function freeLab() { if (lab) { lab.free(); lab = null; } }

  /** scene reset: the design pose for teleop, the lab's own start for the task */
  function reset() {
    freeLab();
    acc = 0;
    metrics.reset();
    if (mode === 'lab') {
      labRun = { log: new Float32Array(nu * 32768), rows: 0, done: false, phases: [], wallMs: 0 };
      lab = createLab(mj, m, sim.data, sidecar, {
        sliceMs: PLAN_SLICE_MS,
        onCtrl: (u) => {
          if ((labRun.rows + 1) * nu > labRun.log.length) { const g = new Float32Array(labRun.log.length * 2); g.set(labRun.log); labRun.log = g; }
          labRun.log.set(u, labRun.rows * nu);
          labRun.rows++;
        },
        onPhase: (rec) => labRun.phases.push(rec),
      });
    } else {
      sim.reset();
      setPose(mj, m, sim.data, built.sweep, { jaw: jawPose(), q: armPose() });
      teleop.sync();
      teleop.step(0);
    }
    inst = mode === 'teleop' && hasLab2 ? createInstruments(sidecar.lab) : null;
    if (inst && !probe) probe = puckProbe(mj, m, indexModel(mj, m, sidecar), sidecar.lab);
  }
  reset();

  /** Step for `dtWall` seconds of wall time at the current speed; at most `cap` steps. */
  function advance(dtWall, cap = MAX_STEPS) {
    if (dead) return { steps: 0, wallMs: 0 };
    acc += (dtWall * speed) / TIMESTEP;
    let n = Math.floor(acc);
    if (n > cap) { n = cap; acc = 0; } else acc -= n;
    const d = sim.data, t = performance.now();
    let steps = 0, planning = false;
    if (mode === 'lab' && lab) {
      for (let i = 0; i < n; i++) {
        const more = lab.step();
        if (lab.planning) { planning = true; break; }
        if (!more) { labRun.done = true; break; }
        metrics.afterStep(d);
        steps++;
      }
    } else {
      for (let i = 0; i < n; i++) {
        teleop.step(TIMESTEP);
        mj.mj_step(m, d);
        stepInstruments();
        metrics.afterStep(d);
        steps++;
      }
    }
    const wallMs = performance.now() - t;
    if (mode === 'lab' && labRun) labRun.wallMs += wallMs;
    return { steps, wallMs, planning, simDt: steps * TIMESTEP };
  }

  function labState() {
    if (!lab) return null;
    const recs = labRun.phases, ins = lab.phases.filter((p) => p.kind === 'release');
    const visited = new Set(recs.filter((p) => p.grasp || p.insertion).map((p) => p.station));
    const snap = lab.instruments.snapshot();
    const extra = instrumentCaption(snap.stations);
    return {
      phase: lab.phase, planning: lab.planning, done: lab.done, outcome: lab.outcome, t: sim.data.time,
      index: Math.min(recs.length, lab.phases.length - 1), phases: lab.phases.map((p) => p.name), records: recs,
      transfers: recs.filter((p) => p.insertion && p.insertion.success).length, transfersPlanned: ins.length,
      stations: visited.size, stationsPlanned: sidecar.lab.stations.length, instruments: snap,
      caption: !extra || lab.phase === 'done' ? phaseName(lab.phase) : extra.startsWith(phaseName(lab.phase)) ? extra : `${phaseName(lab.phase)} · ${extra}`,
      puckAt: lab.seatedAt,
    };
  }

  function finalProps() {
    const d = sim.data, out = {};
    for (const p of ix.props) {
      out[p.name] = { xpos: Array.from(d.xpos.subarray(3 * p.body, 3 * p.body + 3)), xquat: Array.from(d.xquat.subarray(4 * p.body, 4 * p.body + 4)) };
    }
    return out;
  }

  /* the run-lab.mjs report, so tools/sim/check.py replays a browser run */
  function labReport() {
    if (!lab || !labRun.done || !lab.outcome) return null;
    const recs = labRun.phases, ik = recs.filter((p) => p.ik).map((p) => p.ik.ms);
    return {
      engine: '@mujoco/mujoco 3.14.0 (wasm, single thread, browser)', model: 'scene.xml', design_hash: sidecar.design_hash,
      nq: m.nq, nv: m.nv, nu, timestep: m.opt.timestep,
      ctrl_log: { file: 'ctrl.f32', dtype: 'float32', rows: labRun.rows, cols: nu,
        actuators: Array.from({ length: nu }, (_, i) => mj.mj_id2name(m, mj.mjtObj.mjOBJ_ACTUATOR.value, i)) },
      schema: 'rps/lab@2', outcome: lab.outcome, final_props: finalProps(),
      timing: { ...timing, task_wall_ms: Math.round(labRun.wallMs), ik_ms_total: Math.round(ik.reduce((a, b) => a + b, 0)), ik_ms_max: Math.max(0, ...ik),
        step_ms_mean: +((labRun.wallMs - ik.reduce((a, b) => a + b, 0)) / Math.max(1, labRun.rows)).toFixed(4) },
      phases: recs,
    };
  }

  /** {path: bytes}: the `npm run sim:export` layout, plus the lab run when one finished */
  function files() {
    const out = { 'scene.xml': strToU8(c.xml), 'scene.json': strToU8(JSON.stringify(sidecar, null, 1) + '\n'),
      'design.json': strToU8(JSON.stringify(design, null, 1) + '\n') };
    for (const [f, b] of built.meshes) out['meshes/' + f] = b;
    const rep = labReport();
    if (rep) {
      out['report.json'] = strToU8(JSON.stringify(rep, null, 1) + '\n');
      out['ctrl.f32'] = new Uint8Array(labRun.log.buffer, 0, labRun.rows * nu * 4).slice();
    }
    return out;
  }

  return {
    mj, sim, sidecar, ix, timing, labOK, hash: c.hash, xml: c.xml, labScene: sidecar.decor ? labScene : null,
    get data() { return sim.data; },
    get mode() { return mode; },
    setMode(v) { mode = v === 'lab' && labOK ? 'lab' : 'teleop'; reset(); return mode; },
    get speed() { return speed; },
    set speed(v) { speed = +v || 1; },
    get teleop() { return teleop; },
    get metrics() { return metrics; },
    get lab() { return lab; },
    get instruments() { return instruments() || null; },
    get time() { return sim.data.time; },
    reset, advance, labState, labReport, files,
    heapBytes: () => sim.data.qpos.buffer.byteLength,
    free() {
      if (dead) return;
      dead = true;
      freeLab();
      teleop = metrics = null;
      sim.free();
    },
  };
}
