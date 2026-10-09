/* The showcase renderer: WebGL2, one film grade for every view (the white balance, then Khronos PBR Neutral
   at the film's exposure, 2^EV, as in Blender), MSAA and bloom per quality tier, FXAA after the grade (MSAA
   resolves the HDR target, so a white edge on a dark ground still steps once tone-mapped), the key light's shadow, a
   contact shadow under the robot, the robot camera insets, the frame's draw-call / memory counts and the
   WebGL context loss. */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { kelvinRgb, wbGain, EMIT_CAP } from './showcase-looks.js';

/* dpr: the device-pixel-ratio cap; px: the drawing-buffer cap (the MSAA half-float targets scale with it);
   post: the HDR chain (half-float targets), else the scene draws straight to the 8-bit canvas, tone-mapped in
   each material's shader */
export const TIERS = {
  high: { dpr: 1.5, px: 3.7e6, msaa: 4, bloom: true, post: true, shadow: 2048, transmission: true },
  medium: { dpr: 1.25, px: 2.4e6, msaa: 4, bloom: false, post: true, shadow: 1024, transmission: false },
  low: { dpr: 0.75, px: Infinity, msaa: 0, bloom: false, post: false, shadow: 0, transmission: false },
};

/** the pixel ratio for a tier on a CSS w x h canvas at the device's dpr */
export function pixelRatio(T, dpr, w, h) {
  return Math.min(dpr || 1, T.dpr, Math.sqrt(T.px / Math.max(1, w * h)));
}

/** can the renderer draw into half-float targets (the medium and high tiers' HDR chain) */
export function floatTargets(renderer) {
  const e = renderer.extensions;
  return !!(e && (e.has('EXT_color_buffer_float') || e.has('EXT_color_buffer_half_float')));
}

/** the tier asked for, or low when the HDR chain has no float targets to draw into */
export function usableTier(name, renderer) {
  const T = TIERS[name] ? name : 'medium';
  return TIERS[T].post && !floatTargets(renderer) ? 'low' : T;
}

/** a starting tier from the GPU string and the screen; the page steps it down if the frame rate sags */
export function detectTier(renderer) {
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  if (/swiftshader|llvmpipe|software|basic render/i.test(name) || !floatTargets(renderer)) return { tier: 'low', gpu: name };
  if (/intel|mali|adreno|powervr|apple gpu/i.test(name) || (navigator.hardwareConcurrency || 8) <= 4) return { tier: 'medium', gpu: name };
  return { tier: 'high', gpu: name };
}

// the peak emissive channel x exposure on the tiers without bloom (Khronos Neutral starts to desaturate at 0.76)
const EMIT_PEAK = 0.8;

const QUAD_VS = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
const NEUTRAL = THREE.ShaderChunk.tonemapping_pars_fragment;
const NEUTRAL_HEAD = 'vec3 NeutralToneMapping( vec3 color ) {';

/** the white balance as a row-major 3x3: Blender's (film.wb, fitted from its view transform), else the
    per-channel gain of the film's kelvin */
export function wbMatrix(film = {}, baked = true) {
  if (!baked) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  if (Array.isArray(film.wb) && film.wb.length === 3) return film.wb;
  const g = wbGain(film.white_balance_k);
  return [[g[0], 0, 0], [0, g[1], 0], [0, 0, g[2]]];
}

/* The grade lives in the tone-map function, so the composer's output pass, the insets drawn to the canvas
   and the low tier's direct draw all apply the same white balance before the curve. */
export function gradeChunk(M, src = NEUTRAL) {
  const cols = [0, 1, 2].flatMap((j) => [M[0][j], M[1][j], M[2][j]]).map((v) => Number(v).toFixed(6));
  if (!src.includes(NEUTRAL_HEAD)) throw new Error('three: NeutralToneMapping not found');
  return src.replace(NEUTRAL_HEAD, `${NEUTRAL_HEAD}\n\tcolor = mat3( ${cols.join(', ')} ) * color;`);
}

function contactDisc() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d'), grd = g.createRadialGradient(64, 64, 8, 64, 64, 62);
  grd.addColorStop(0, 'rgba(0,0,0,0.42)');
  grd.addColorStop(0.5, 'rgba(0,0,0,0.16)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  m.renderOrder = 1;
  m.matrixAutoUpdate = false;
  return m;
}

/* Baked mode: the lightmapped set (layer 1) renders without the lights; the movers, the lights and
   the shadow-catcher copies (layer 2) render over it with the depth kept.  Layer 3: a robot camera's
   own housing glass, drawn by the main view only (as render.py hides it from that camera's rays). */
export const BAKED = 1 << 1, LIT = 1 << 2, HOUSING = 3;

// a copy that drops NaN/Inf and clamps, so a half-float speck cannot blow up the bloom's blur
const CLAMP = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: QUAD_VS,
  fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv;'
    + 'void main() { vec4 c = texture2D(tDiffuse, vUv); bvec3 bad = bvec3(isnan(c.r) || isinf(c.r), isnan(c.g) || isinf(c.g), isnan(c.b) || isinf(c.b));'
    + ' gl_FragColor = vec4(clamp(mix(c.rgb, vec3(0.0), vec3(bad)), 0.0, 64.0), 1.0); }',
};

/* The scene into its own MSAA target, then copied into the composer's plain chain: bloom blends into
   its read buffer, and a multisampled one is invalidated after each resolve. */
class ScenePass extends Pass {
  constructor(stage, samples) {
    super();
    this.stage = stage;
    this.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples });
    this.quad = new FullScreenQuad(new THREE.ShaderMaterial(CLAMP));
  }

  setSize(w, h) { this.rt.setSize(w, h); }

  render(renderer, writeBuffer) {
    const { scene, camera } = this.stage;
    renderer.setRenderTarget(this.rt);
    this.stage.draw(scene, camera);
    this.quad.material.uniforms.tDiffuse.value = this.rt.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() { this.rt.dispose(); this.quad.material.dispose(); this.quad.dispose(); }
}

export class Stage {
  constructor(canvas, manifest) {
    this.canvas = canvas;
    this.man = manifest;
    // the film grade: set before the first program compiles
    const baked = (manifest.lightmaps || []).length > 0 || !!manifest.probe;
    THREE.ShaderChunk.tonemapping_pars_fragment = gradeChunk(wbMatrix(manifest.film, baked));
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 2 ** ((manifest.film || {}).exposure || 0);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.info.autoReset = false;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0c0e);
    this.camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.03, 60);
    this.camera.up.set(0, 0, 1);
    this.insetCam = new THREE.PerspectiveCamera(71, 4 / 3, 0.01, 30);
    this.insetCam.layers.enableAll();
    this.insetCam.layers.disable(HOUSING);
    this.lights();
    this.disc = contactDisc();
    this.scene.add(this.disc);
    this.tier = null;
    this.lost = false;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; this.frames = []; if (this.onLost) this.onLost(); });
    canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      try { this.restore(); if (this.onRestored) this.onRestored(); } catch (err) { if (this.onLost) this.onLost(err); }
    });
    this.frames = [];
    this.catchers = [];                                  // baked mode: shadow-catcher copies of the floor and plinth tops
  }

  lights() {
    const L = this.man.light || {}, baked = (this.man.lightmaps || []).length > 0;
    const k = kelvinRgb(L.key_kelvin || 4000), col = new THREE.Color().setRGB(k[0], k[1], k[2], THREE.LinearSRGBColorSpace);
    const key = this.key = new THREE.DirectionalLight(col, L.key ?? 0.55);
    key.position.set(0.9, -1.1, 2.6);
    key.target.position.set(-0.1, 0.45, 0);
    key.castShadow = true;
    const s = key.shadow;
    s.camera.left = -2.6; s.camera.right = 2.6; s.camera.top = 2.2; s.camera.bottom = -2.2;
    s.camera.near = 0.5; s.camera.far = 6;
    s.bias = -0.0004; s.normalBias = 0.015; s.radius = 3;
    const fill = new THREE.HemisphereLight(col, 0x6a6e70, baked ? 0 : (L.fill ?? 0.12));
    fill.up = new THREE.Vector3(0, 0, 1);
    fill.position.set(0, 0, 1);
    this.baked = baked;
    if (baked) for (const o of [key, fill]) o.layers.set(2);
    this.camera.layers.enable(1);
    this.camera.layers.enable(2);
    this.camera.layers.enable(HOUSING);
    this.scene.add(key, key.target, fill);
  }

  /** the probe (an equirect DataTexture) or the procedural room as scene.environment */
  environment(equirect) {
    this.envSource = equirect;                           // kept: a context restore regenerates the PMREM
    const old = this.scene.environment;
    const pm = new THREE.PMREMGenerator(this.renderer);
    // both env sources are Y-up; the lab is Z-up
    const room = new RoomEnvironment();
    room.rotation.x = Math.PI / 2;
    const rt = equirect ? pm.fromEquirectangular(equirect) : pm.fromScene(room, 0.04);
    if (equirect) this.scene.environmentRotation.set(Math.PI / 2, 0, 0);
    pm.dispose();
    room.dispose();
    this.scene.environment = rt.texture;
    if (old) this.scene.traverse((o) => { if (o.material && o.material.envMap === old) o.material.envMap = rt.texture; });
    this.scene.environmentIntensity = (this.man.light || {}).env ?? 0.22;
    this.envBytes = rt.width * rt.height * 8;
  }

  /** the scene into the current target: one pass, or the baked set then the lit layer over it */
  draw(scene, camera) {
    const r = this.renderer;
    if (!this.baked) { r.render(scene, camera); return; }
    const m = camera.layers.mask, bg = scene.background, own = m & (1 << HOUSING);
    r.autoClear = false;
    r.clear();
    // a Color background clears on every render() even without autoClear: only the first pass draws it
    for (const k of [BAKED, LIT | own]) { camera.layers.mask = k; r.render(scene, camera); scene.background = null; }
    scene.background = bg;
    camera.layers.mask = m;
    r.autoClear = true;
  }

  /** after a context restore: three re-uploads buffers and textures; the targets and the PMREM are rebuilt */
  restore() {
    this.environment(this.envSource);
    if (this.key.shadow.map) { this.key.shadow.map.dispose(); this.key.shadow.map = null; }
    this.setQuality(this.tier);
  }

  setQuality(name) {
    name = usableTier(name, this.renderer);
    const T = TIERS[name];
    this.tier = name;
    this.T = T;
    this.frames = [];                                    // the frame rate is measured per tier
    const r = this.renderer;
    // without bloom an LED's emission stays under the curve's shoulder, so it keeps its hue
    EMIT_CAP.value = T.bloom ? 1e4 : EMIT_PEAK / r.toneMappingExposure;
    r.setPixelRatio(this.ratio());
    r.shadowMap.enabled = T.shadow > 0;
    for (const c of this.catchers) c.visible = T.shadow > 0;
    if (T.shadow > 0) {
      this.key.shadow.mapSize.set(T.shadow, T.shadow);
      if (this.key.shadow.map) { this.key.shadow.map.dispose(); this.key.shadow.map = null; }
    }
    this.disposePost();
    if (T.post) {
      const size = r.getDrawingBufferSize(new THREE.Vector2());
      const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType });
      const c = this.composer = new EffectComposer(r, rt);
      c.addPass(new ScenePass(this, T.msaa));
      if (T.bloom) c.addPass(this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.2, 0.12, 1.0));
      c.addPass(new OutputPass());
      c.addPass(this.fxaa = new ShaderPass(FXAAShader));
    }
    this.resize();
  }

  /** EffectComposer.dispose frees only its own two targets and copy pass: the passes free theirs */
  disposePost() {
    if (!this.composer) return;
    for (const p of this.composer.passes) p.dispose();
    this.composer.dispose();
    this.composer = this.bloom = this.fxaa = null;
  }

  ratio() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    return pixelRatio(this.T, window.devicePixelRatio, w, h);
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(this.ratio());
    this.renderer.setSize(w, h, false);
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
      const p = this.renderer.getPixelRatio();
      if (this.fxaa) this.fxaa.material.uniforms.resolution.value.set(1 / (w * p), 1 / (h * p));
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.size = { w, h };
  }

  /** the contact shadow under the base (x, y, yaw) */
  ground(base) {
    this.disc.visible = !!base;
    if (base) this.disc.matrix.makeRotationZ(base.yaw).setPosition(base.x, base.y, 0.0015);
    this.disc.matrixWorldNeedsUpdate = true;
  }

  /** one frame: the main view, then each inset {n, rect: [x, y, w, h] CSS px from the top left}, posed by
      pose(n, cam); the insets draw to the canvas, graded by the same tone-map function as the main view */
  render(insets = [], pose = null) {
    const r = this.renderer;
    if (this.lost) return;
    r.info.reset();
    if (this.composer) this.composer.render();
    else this.draw(this.scene, this.camera);
    if (insets.length && pose) {
      r.setScissorTest(true);
      for (const it of insets) {
        const [x, y, w, h] = it.rect, yy = this.size.h - y - h;
        this.insetCam.aspect = w / h;
        pose(it.n, this.insetCam);
        r.setViewport(x, yy, w, h);
        r.setScissor(x, yy, w, h);
        this.draw(this.scene, this.insetCam);
      }
      r.setScissorTest(false);
      r.setViewport(0, 0, this.size.w, this.size.h);
    }
    const now = performance.now();
    this.frames.push(now);
    while (this.frames.length > 2 && now - this.frames[1] > 2000) this.frames.shift();
  }

  fps() {
    const f = this.frames;
    return f.length > 1 ? (f.length - 1) * 1000 / (f[f.length - 1] - f[0]) : 0;
  }

  /** the frame-rate window's length (s) */
  span() {
    const f = this.frames;
    return f.length > 1 ? (f[f.length - 1] - f[0]) / 1000 : 0;
  }

  /** GPU memory estimate: textures, env, render targets and the shadow map (bytes) */
  memory() {
    const seen = new Set();
    let tex = 0;
    this.scene.traverse((o) => {
      if (!o.material) return;
      for (const k of ['map', 'lightMap', 'aoMap', 'emissiveMap', 'normalMap', 'roughnessMap']) {
        const t = o.material[k];
        if (!t || seen.has(t)) continue;
        seen.add(t);
        const im = t.image || {}, w = im.width || (t.mipmaps && t.mipmaps[0] && t.mipmaps[0].width) || 0;
        const h = im.height || (t.mipmaps && t.mipmaps[0] && t.mipmaps[0].height) || 0;
        tex += w * h * (t.isCompressedTexture ? 1 : 4) * 1.33;
      }
    });
    const p = this.renderer.getPixelRatio(), W = this.size.w * p, H = this.size.h * p;
    const targets = this.composer ? W * H * 8 * (3 + (this.T.msaa || 0)) + (this.T.bloom ? W * H * 8 * 0.7 : 0) : 0;
    const shadow = this.T.shadow ? this.T.shadow ** 2 * 4 : 0;
    return { textures: Math.round(tex), env: this.envBytes || 0, targets: Math.round(targets), shadow,
      total: Math.round(tex + (this.envBytes || 0) + targets + shadow) };
  }

  stats() {
    const i = this.renderer.info;
    return { calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries,
      textures: i.memory.textures, programs: (i.programs || []).length, fps: Math.round(this.fps() * 10) / 10,
      tier: this.tier, memory: this.memory() };
  }
}
