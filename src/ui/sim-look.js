/* The Sim tab's photoreal look: the baked lab (site/vendor/baked-lab.js, loaded on first use, with
   a progress chip) in place of the procedural room's static decor, the probe as the environment,
   Khronos PBR Neutral at the film's exposure with its white balance, and the robot in the light
   palette whatever the UI theme; the bake's robot dress only on the design it captured.  dispose()
   puts the Design look back.  Any load failure keeps the procedural room. */
import * as THREE from 'three';
import { THREE_VENDOR } from './three-vendor.js';
import { gradeChunk, wbMatrix } from './showcase-render.js';
import { el } from './dom.js';
import { versioned } from '../core/asset-version.js';

export const BAKED_SCRIPT = 'vendor/baked-lab.js';
const cache = {};                                          // the parsed bake, kept across Sim sessions
let script = null;

function loadScript() {
  if (!script) {
    script = new Promise((resolve, reject) => {
      if (globalThis.RPS_BAKED) { resolve(globalThis.RPS_BAKED); return; }
      globalThis.RPS_THREE = THREE_VENDOR;
      const s = document.createElement('script');
      s.src = versioned(BAKED_SCRIPT);
      s.onload = () => (globalThis.RPS_BAKED ? resolve(globalThis.RPS_BAKED) : reject(new Error(BAKED_SCRIPT + ' defined nothing')));
      s.onerror = () => reject(new Error('could not load ' + BAKED_SCRIPT));
      document.head.appendChild(s);
    }).catch((e) => { script = null; throw e; });
  }
  return script;
}

/* the showcase's film grade (its white balance inside NeutralToneMapping); the Design view uses ACES */
const NEUTRAL = THREE.ShaderChunk.tonemapping_pars_fragment;

export function createSimLook({ viewport, room, lab, design = null, onReady = null }) {
  const S = { state: 'off', error: null, stats: null, loadMs: 0 };
  if (!room || typeof document === 'undefined') return { state: S, paint() {}, dispose() {} };
  const r = viewport.renderer, scene = viewport.scene, host = r.domElement.parentElement;
  const chip = el('div', 'sim-bake');
  const bar = el('i');
  const label = el('span', null, 'Loading the lab…');
  const track = el('b');
  track.append(bar);
  chip.append(label, track);
  chip.hidden = true;
  if (host) host.append(chip);
  const kept = { tm: r.toneMapping, exp: r.toneMappingExposure, env: scene.environment, envI: scene.environmentIntensity,
    envR: scene.environmentRotation.clone() };
  let baked = null, dead = false;
  const t0 = performance.now();

  function progress(n, total) {
    chip.hidden = false;
    bar.style.width = Math.round(100 * n / total) + '%';
    label.textContent = `Loading the lab · ${(n / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`;
  }

  async function start() {
    S.state = 'loading';
    const P = await loadScript();
    if (dead) return;
    if (!P.lib.isBaked(P.manifest)) throw new Error('no bake in the manifest');
    const b = await P.lib.buildBakedRoom({ manifest: P.manifest, renderer: r, room, lab, design, onBytes: progress, cache });
    if (dead) { b.dispose(); return; }
    baked = b;
    room.group.add(b.group);
    room.useBaked(b);
    const film = P.manifest.film || {};
    THREE.ShaderChunk.tonemapping_pars_fragment = gradeChunk(wbMatrix(film, true), NEUTRAL);
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 2 ** (film.exposure || 0);
    scene.environment = b.env;
    scene.environmentRotation.set(0, 0, 0);                  // viewport world is Y-up like the probe
    scene.environmentIntensity = (P.manifest.light || {}).env ?? 0.5;
    viewport.setMainWrap((draw) => viewport.materials.neutral(draw));
    S.state = 'ready';
    S.stats = b.stats;
    S.loadMs = Math.round(performance.now() - t0);
    chip.hidden = true;
    if (onReady) onReady(b);
    viewport.invalidate();
  }
  start().catch((e) => {
    if (dead) return;
    S.state = 'failed';
    S.error = String((e && e.message) || e);
    console.warn('sim: the baked lab did not load, keeping the procedural room:', S.error);
    chip.hidden = true;
  });

  return {
    state: S,
    get baked() { return baked; },
    /** after applyInstruments: the bake's movers take the room's tints */
    paint() { if (baked) baked.paint(); },
    dispose() {
      dead = true;
      chip.remove();
      if (!baked) return;
      room.useBaked(null);
      baked.dispose();
      baked = null;
      r.toneMapping = kept.tm;
      r.toneMappingExposure = kept.exp;
      scene.environment = kept.env;
      scene.environmentIntensity = kept.envI;
      scene.environmentRotation.copy(kept.envR);
      viewport.setMainWrap(null);
    },
  };
}
