/* The off-screen class ID pass: every object rendered flat in its class colour, read back
   as a percentage breakdown.  Needs three and scene/frustum-math.js. */

import * as THREE from 'three';
import { CLASS_COLORS, SPARE_COLORS } from './frustum-math.js';

/**
 * idPass(renderer, scene, camera, tagFn, opts)
 *   tagFn(object) -> class id string, or null to HIDE the object for the pass.
 *   Line / Points / Sprite objects are always hidden (grids, rings, axes).
 * Returns { pixels, width, height, classes, palette, classAt(x, y), target }.
 * `classes` is a percentage breakdown that sums to 100 with `background`.
 *
 * Every renderer and scene property it touches is restored before it returns, including
 * on an exception.
 */
export function idPass(renderer, scene, camera, tagFn, opts = {}) {
  const width = opts.width || 160, height = opts.height || 120;
  const target = opts.target || idPass.target(renderer, width, height);

  const palette = { background: CLASS_COLORS.background };
  let spare = 0;
  const matFor = new Map();
  function materialFor(cls) {
    let m = matFor.get(cls);
    if (m) return m;
    let rgb = CLASS_COLORS[cls];
    if (!rgb) { rgb = SPARE_COLORS[spare % SPARE_COLORS.length]; spare++; }
    palette[cls] = rgb;
    m = new THREE.MeshBasicMaterial({
      color: new THREE.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255),
      toneMapped: false, fog: false, side: THREE.DoubleSide
    });
    m.userData.idPass = true;
    matFor.set(cls, m);
    return m;
  }

  /* save every bit of state we are about to trample */
  const saved = {
    target: renderer.getRenderTarget(),
    tone: renderer.toneMapping,
    exposure: renderer.toneMappingExposure,
    cs: renderer.outputColorSpace,
    autoClear: renderer.autoClear,
    scissorTest: renderer.getScissorTest(),
    clear: renderer.getClearColor(new THREE.Color()),
    clearAlpha: renderer.getClearAlpha(),
    viewport: renderer.getViewport(new THREE.Vector4()),
    background: scene.background,
    fog: scene.fog,
    override: scene.overrideMaterial
  };
  const swapped = [];     // [object, material]
  const hidden = [];      // [object]

  try {
    scene.traverse(o => {
      if (o.isLine || o.isPoints || o.isSprite) { if (o.visible) { hidden.push(o); o.visible = false; } return; }
      if (!o.isMesh) return;
      const cls = tagFn ? tagFn(o) : 'robot';
      if (cls == null) { if (o.visible) { hidden.push(o); o.visible = false; } return; }
      swapped.push([o, o.material]);
      o.material = materialFor(String(cls));
    });

    renderer.setScissorTest(false);
    /* device px, and no setViewport: see the note in renderPip().  A CSS-px viewport call
       here cropped the ID pass to its bottom-left quadrant on a 2x display, which silently
       moved every class percentage the verdict chips report. */
    renderer.setRenderTarget(target);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.autoClear = false;
    scene.background = null;
    scene.fog = null;
    scene.overrideMaterial = null;
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);

    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);

    /* classify by NEAREST palette entry: survives any colour-space setting */
    const names = Object.keys(palette);
    const rgbs = names.map(n => palette[n]);
    const counts = new Int32Array(names.length);
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      let best = 0, bd = Infinity;
      for (let k = 0; k < rgbs.length; k++) {
        const c = rgbs[k];
        const d = (r - c[0]) * (r - c[0]) + (g - c[1]) * (g - c[1]) + (b - c[2]) * (b - c[2]);
        if (d < bd) { bd = d; best = k; }
      }
      counts[best]++;
    }
    const total = width * height;
    const classes = {};
    names.forEach((n, i) => { classes[n] = +(counts[i] * 100 / total).toFixed(2); });

    const classAt = (x, y) => {
      const xi = Math.max(0, Math.min(width - 1, Math.round(x)));
      const yi = Math.max(0, Math.min(height - 1, Math.round(y)));
      const i = (yi * width + xi) * 4;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      let best = 'background', bd = Infinity;
      for (const n of names) {
        const c = palette[n];
        const d = (r - c[0]) * (r - c[0]) + (g - c[1]) * (g - c[1]) + (b - c[2]) * (b - c[2]);
        if (d < bd) { bd = d; best = n; }
      }
      return best;
    };

    return { pixels, width, height, classes, palette, classAt, target };
  } finally {
    for (const [o, m] of swapped) o.material = m;
    for (const o of hidden) o.visible = true;
    for (const m of matFor.values()) m.dispose();
    renderer.setRenderTarget(saved.target);
    renderer.toneMapping = saved.tone;
    renderer.toneMappingExposure = saved.exposure;
    renderer.outputColorSpace = saved.cs;
    renderer.autoClear = saved.autoClear;
    renderer.setScissorTest(saved.scissorTest);
    renderer.setClearColor(saved.clear, saved.clearAlpha);
    renderer.setViewport(saved.viewport);
    scene.background = saved.background;
    scene.fog = saved.fog;
    scene.overrideMaterial = saved.override;
  }
}
/** A cached render target per renderer+size, so a 6 Hz evaluation loop allocates nothing. */
idPass.target = (function () {
  const cache = new WeakMap();
  return function target(renderer, w, h) {
    let byRenderer = cache.get(renderer);
    if (!byRenderer) { byRenderer = new Map(); cache.set(renderer, byRenderer); }
    const k = w + 'x' + h;
    let t = byRenderer.get(k);
    if (!t) {
      t = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
        depthBuffer: true, stencilBuffer: false, colorSpace: THREE.NoColorSpace
      });
      byRenderer.set(k, t);
    }
    return t;
  };
})();
