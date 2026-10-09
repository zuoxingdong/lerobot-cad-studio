/*
   showcase.html, over http and from file:// (two suites share this module): the manifest's assets
   load (fetch, or the .js wrappers), the page declares UTF-8, no float targets falls back to low, the
   green LEDs keep their hue without bloom, the run plays on its clock, three chapter marks seek the camera
   path, the free camera orbits and hands back (a 35 mm lens, inside the room), the robot cameras show three insets, Space and the
   arrows drive it, the budgets hold (first paint, total, main-pass draw calls), quality switches do not
   leak GPU memory, auto quality steps down under load, a lost context comes back, no console errors. A
   baked manifest also has its lightmaps and probe in use. */

import { frame, sleep, waitFor, test, assert, start } from './_case.js';

let win = null, S = null;
const q = (s) => win.document.querySelector(s);
const qa = (s) => [...win.document.querySelectorAll(s)];
const frames = async (n) => { const f0 = S.state().frame; await waitFor(() => S.state().frame >= f0 + n, 60000, n + ' frames'); };
const key = (k) => win.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, code: k === ' ' ? 'Space' : k, bubbles: true }));
const near = (a, b, e) => a.every((v, i) => Math.abs(v - b[i]) <= e);

/* one synchronous render, read back before the browser composites (the drawing buffer is not kept):
   RGBA bytes of a rect in buffer pixels, bottom-left origin; the whole buffer by default */
function grab(rect) {
  const g = S.stage(), gl = g.renderer.getContext();
  g.render();
  g.renderer.setRenderTarget(null);
  const [x, y, w, h] = rect || [0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight];
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}
/* the share of black pixels */
const dark = (px) => { let n = 0; for (let i = 0; i < px.length; i += 4) if (Math.max(px[i], px[i + 1], px[i + 2]) < 20) n++; return n / (px.length / 4); };

/* an LED ring seen face on from 0.25 m, from either side of its thinnest axis: its pixels that read green */
function greenPixels(o) {
  const g = S.stage(), cam = g.camera, gl = g.renderer.getContext(), W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
  o.geometry.computeBoundingBox();
  const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
  const c = b.getCenter(cam.position.clone()), sz = b.getSize(cam.position.clone());
  const axis = ['x', 'y', 'z'].reduce((a, k) => (sz[k] < sz[a] ? k : a), 'x');
  let best = 0;
  for (const sign of [1, -1]) {
    cam.position.copy(c);
    cam.position[axis] += sign * 0.25;
    cam.up.set(0, axis === 'z' ? 1 : 0, axis === 'z' ? 0 : 1);
    cam.fov = 30;
    cam.lookAt(c);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    for (let i = 0; i < 8; i++) {
      const v = c.clone().set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).project(cam);
      const x = (v.x + 1) / 2 * W, y = (v.y + 1) / 2 * H;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    x0 = Math.max(0, Math.floor(x0) - 4); y0 = Math.max(0, Math.floor(y0) - 4);
    x1 = Math.min(W, Math.ceil(x1) + 4); y1 = Math.min(H, Math.ceil(y1) + 4);
    if (x1 <= x0 || y1 <= y0) continue;
    const px = grab([x0, y0, x1 - x0, y1 - y0]);
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i + 1] - Math.max(px[i], px[i + 2]) > 50) n++;
    best = Math.max(best, n);
  }
  return best;
}

start(async () => {
  const t0 = performance.now();
  await waitFor(() => { win = frame.contentWindow; return win && win.__showcase && (win.__showcase.ready || win.__showcase.errors.length); },
    120000, 'the showcase');
  S = win.__showcase;

  await test('loads the manifest assets and draws a first frame', async () => {
    assert(S.ready, 'not ready: ' + S.errors.join(' | '));
    await frames(2);
    const st = S.state();
    assert(st.file === (win.location.protocol === 'file:'), 'asset path does not match the protocol');
    assert(st.labNodes > 20 && st.movers > 20, `nodes: lab ${st.labNodes}, movers ${st.movers}`);
    let lit = 0;
    if (win.__RPS_SHOWCASE.stand_in === false) {         // the bake: lightmaps on the set, the probe as the env
      const g = S.stage();
      g.scene.traverse((o) => { if (o.material && o.material.lightMap) lit++; });
      assert(g.baked && lit > 20 && g.scene.environment, `baked ${g.baked}, ${lit} lightmapped nodes`);
    }
    return `${win.location.protocol} · ${lit ? lit + ' lightmapped · ' : ''}${(st.loaded / 1e6).toFixed(2)} MB in ${Math.round(performance.now() - t0)} ms · tier ${st.tier} · ${st.gpu}`;
  });

  await test('the page declares UTF-8: the title and the captions keep their "·", "→" and "°"', async () => {
    const meta = q('head > meta[charset]'), head = win.document.documentElement.outerHTML.slice(0, 1024);
    assert(meta && /^utf-8$/i.test(meta.getAttribute('charset')) && /<meta charset="utf-8">/i.test(head), 'no <meta charset="utf-8"> in the first 1024 bytes');
    assert(win.document.characterSet === 'UTF-8', 'decoded as ' + win.document.characterSet);
    const text = [win.document.title, ...win.__RPS_SHOWCASE.run.edit.captions.map((c) => c.text)].join(' | ');
    for (const ch of ['·', '→', '°']) assert(text.includes(ch), `no "${ch}" in: ${text.slice(0, 160)}`);
    assert(!/[ÂÃ]|â€/.test(text), 'mojibake: ' + text.slice(0, 160));
    const cap = win.__RPS_SHOWCASE.run.edit.captions.find((c) => c.text.includes('→'));
    S.seek((cap.t[0] + cap.t[1]) / 2);
    await frames(2);
    assert(q('.sc-cap').textContent.includes('→'), 'the caption on screen: ' + q('.sc-cap').textContent);
    return win.document.title;
  });

  await test('no float render targets: high falls back to low (8-bit, tone-mapped in the shaders), never a black frame', async () => {
    const g = S.stage(), ext = g.renderer.extensions, has = ext.has;
    ext.has = (n) => (/^EXT_color_buffer_(half_)?float$/.test(n) ? false : has.call(ext, n));
    let d = 1;
    try {
      S.setQuality('high');
      S.seek(12);
      await frames(2);
      assert(S.state().tier === 'low' && !g.composer, `tier ${S.state().tier}, composer ${!!g.composer}`);
      d = dark(grab());
      assert(d < 0.5, `${(d * 100).toFixed(0)} % of the frame is black`);
    } finally { ext.has = has; }
    S.setQuality('high');
    await frames(2);
    assert(S.state().tier === 'high' && g.composer, 'high did not come back with float targets');
    S.setQuality('low');
    await frames(1);
    return `low, ${(d * 100).toFixed(1)} % black`;
  });

  await test('the green done LEDs keep their hue without bloom (medium, low)', async () => {
    S.pause();
    S.seek(4);
    const out = [];
    for (const tier of ['medium', 'low']) {
      S.setQuality(tier);
      await frames(3);
      const rings = [];
      S.stage().scene.traverse((o) => {
        const m = o.material;
        if (o.isMesh && m && m.name === 'led_off~tint' && m.emissiveIntensity > 0.3 && m.emissive.g > 2 * Math.max(m.emissive.r, m.emissive.b)) rings.push(o);
      });
      assert(rings.length, 'no green LED at t 4 s');
      const n = Math.max(...rings.map(greenPixels));
      out.push(`${tier} ${n} px`);
      assert(n >= 30, `${tier}: ${n} green pixels on ${rings.length} lit rings`);
    }
    S.setQuality('low');
    await frames(2);
    return out.join(', ');
  });

  await test('budgets: first paint, total, main-pass draw calls', async () => {
    const b = S.budget, st = S.state();
    const html = win.document.documentElement.outerHTML.length;
    assert(b && b.files > 0, 'no budget in the manifest');
    assert(html <= b.first_cap, `first paint ${html} B > ${b.first_cap}`);
    assert(html + b.files <= b.total_cap, `total ${html + b.files} B > ${b.total_cap}`);
    assert(st.loaded <= b.files, `loaded ${st.loaded} B > the manifest's ${b.files}`);
    if (!S.state().cams) {
      S.setQuality('low');
      await frames(2);
      const c = S.state().stats;
      assert(c.calls <= 250, `main pass ${c.calls} draw calls > 250`);
      return `html ${(html / 1e3).toFixed(0)} kB (raw, gz is smaller) · assets ${(b.files / 1e6).toFixed(2)} MB · ${c.calls} calls, ${(c.triangles / 1e3).toFixed(0)} k tris`;
    }
    return '';
  });

  await test('quality switches free their render targets and passes', async () => {
    const mem = () => { const m = S.state().stats; return [m.textures, m.geometries]; };
    S.setQuality('high');
    await frames(3);
    const base = mem();
    for (const q of ['low', 'medium', 'high', 'medium', 'high']) { S.setQuality(q); await frames(3); }
    const now = mem();
    S.setQuality('low');
    await frames(2);
    assert(now[0] === base[0] && now[1] === base[1], `after 5 switches: textures ${base[0]} -> ${now[0]}, geometries ${base[1]} -> ${now[1]}`);
    return `textures ${now[0]}, geometries ${now[1]}`;
  });

  await test('the robot: soft shading, cables, its camera modules left out of the insets; FXAA and the caption scrim', async () => {
    const g = S.stage(), st = S.state();
    assert(st.shaded > 20 && st.cables >= 10, `shaded ${st.shaded}, cables ${st.cables}`);
    let own = 0, rest = 0;
    g.scene.traverse((o) => { if (o.isMesh && o.layers.mask === 1 << 3) own++; else if (o.isMesh) rest++; });
    assert(own > 0 && !g.insetCam.layers.isEnabled(3) && g.camera.layers.isEnabled(3), `housing meshes ${own}`);
    S.setQuality('medium');
    await frames(2);
    assert(g.fxaa && g.composer.passes[g.composer.passes.length - 1] === g.fxaa, 'no FXAA after the grade');
    S.setQuality('low');
    const cap = win.__RPS_SHOWCASE.run.edit.captions[0];
    S.seek((cap.t[0] + cap.t[1]) / 2);
    await frames(2);
    const sc = q('.sc-scrim');
    assert(sc && Number(win.getComputedStyle(sc).opacity) > 0.9, 'no caption scrim: ' + (sc && win.getComputedStyle(sc).opacity));
    return `${st.shaded} parts shaded, ${st.cables} cables, ${own} housing meshes`;
  });

  await test('plays on the run clock, then pauses', async () => {
    S.seek(12);
    S.play();
    const a = S.state().t;
    await waitFor(() => S.state().t > a + 0.25, 60000, 'the clock to advance');
    S.pause();
    await frames(2);
    const b = S.state().t;
    await frames(3);
    assert(S.state().t === b, 'the clock moved while paused');
    assert(!S.state().playing, 'still playing');
    return `advanced ${(b - a).toFixed(2)} s`;
  });

  await test('three chapter marks seek the edit camera', async () => {
    const marks = qa('.sc-mark');
    const ch = S.chapters();
    assert(marks.length === ch.length && ch.length >= 8, `${marks.length} marks for ${ch.length} shots`);
    const seen = [];
    for (const k of [1, 4, 7]) {
      marks[k].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      await frames(2);
      const st = S.state();
      assert(st.chapter === k, `mark ${k} -> chapter ${st.chapter}`);
      assert(Math.abs(st.t - ch[k].t) < 0.01, `mark ${k} -> t ${st.t} not ${ch[k].t}`);
      assert(q('.sc-chap').textContent === ch[k].label, 'the chapter label');
      seen.push(S.camera().p);
    }
    assert(!near(seen[0], seen[1], 0.05) && !near(seen[1], seen[2], 0.05), 'the camera did not move between shots');
    return [1, 4, 7].map((k) => ch[k].label).join(' → ');
  });

  await test('free camera: F orbits by drag, F hands back to the path', async () => {
    const before = S.camera().p;
    key('f');
    await frames(2);
    assert(S.state().free, 'F did not enter the free camera');
    const cv = q('.sc-canvas'), r = cv.getBoundingClientRect();
    const ev = (type, x, y) => cv.dispatchEvent(new win.PointerEvent(type, { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1,
      clientX: r.left + x, clientY: r.top + y, bubbles: true }));
    ev('pointerdown', r.width / 2, r.height / 2);
    for (let i = 1; i <= 8; i++) { ev('pointermove', r.width / 2 + 25 * i, r.height / 2 + 6 * i); await sleep(16); }
    ev('pointerup', r.width / 2 + 200, r.height / 2 + 48);
    await frames(4);
    const moved = S.camera().p;
    assert(!near(before, moved, 0.02), 'the drag did not orbit the camera');
    key('F');
    await frames(2);
    assert(!S.state().free, 'F did not leave the free camera');
    assert(near(S.camera().p, before, 1e-3), 'the path camera did not come back');
    return `orbited ${Math.hypot(...moved.map((v, i) => v - before[i])).toFixed(2)} m`;
  });

  await test('free camera: a 35 mm lens, the eye in the room and over the floor, no black frame; the shot lens back on exit', async () => {
    const ch = S.chapters(), k = Math.max(0, ch.findIndex((c) => c.id === 'insert'));
    S.seek(ch[k].t + 1);
    await frames(2);
    const fov0 = S.camera().fov;
    key('f');
    await frames(2);
    const g = S.stage(), aspect0 = win.__RPS_SHOWCASE.run.camera_aspect || 16 / 9;
    const want = 2 * Math.atan(12 / 35 * Math.max(1, aspect0 / g.camera.aspect)) * 180 / Math.PI;
    assert(Math.abs(S.camera().fov - want) < 0.01, `free fov ${S.camera().fov.toFixed(2)}°, want ${want.toFixed(2)}°`);
    const box = S.freeBox().expandByScalar(1e-6), cv = q('.sc-canvas'), r = cv.getBoundingClientRect();
    const ev = (type, x, y) => cv.dispatchEvent(new win.PointerEvent(type, { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1,
      clientX: r.left + x, clientY: r.top + y, bubbles: true }));
    const drag = async (dx, dy) => {
      const x = r.width / 2, y = r.height / 2;
      ev('pointerdown', x, y);
      for (let i = 1; i <= 10; i++) { ev('pointermove', x + dx * i / 10, y + dy * i / 10); await sleep(16); }
      ev('pointerup', x + dx, y + dy);
      await frames(6);
    };
    const seen = [];
    const check = (what) => {
      const p = g.camera.position, d = dark(grab());
      seen.push(`${what}: eye ${p.toArray().map((v) => v.toFixed(2)).join(', ')}, ${(d * 100).toFixed(0)} % black`);
      assert(box.containsPoint(p), `${what}: the eye ${p.toArray().map((v) => v.toFixed(2))} is outside the room box`);
      assert(d < 0.5, `${what}: ${(d * 100).toFixed(0)} % of the frame is black`);
    };
    await drag(450, 0);
    check('a 450 px drag');
    await drag(0, -600);
    check('a drag towards the floor');
    for (let i = 0; i < 8; i++) {
      cv.dispatchEvent(new win.WheelEvent('wheel', { deltaY: 120, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
      await sleep(30);
    }
    await frames(6);
    check('8 wheel notches out');
    key('F');
    await frames(2);
    assert(Math.abs(S.camera().fov - fov0) < 1e-6, `the shot lens did not come back: ${S.camera().fov} vs ${fov0}`);
    return `${fov0.toFixed(1)}° shot → ${want.toFixed(1)}° free · ` + seen.join(' · ');
  });

  await test('robot cameras: C shows three labelled insets', async () => {
    key('c');
    await frames(2);
    const labels = qa('.sc-inset').map((e) => e.textContent);
    assert(S.state().cams && labels.length === 3, 'insets: ' + labels.join(','));
    const calls = S.state().stats.calls;
    key('C');
    await frames(2);
    assert(!S.state().cams, 'C did not close them');
    return labels.join(' / ') + ` · ${calls} calls with insets`;
  });

  await test('keys: Space plays and pauses, the arrows step chapters', async () => {
    S.seek(20);
    await frames(1);
    const k0 = S.state().chapter;
    key('ArrowRight');
    await frames(1);
    assert(S.state().chapter === k0 + 1, `→ went to chapter ${S.state().chapter}`);
    key('ArrowLeft');
    await frames(1);
    assert(S.state().chapter === k0, `← went to chapter ${S.state().chapter}`);
    key(' ');
    await frames(1);
    assert(S.state().playing, 'Space did not play');
    key(' ');
    await frames(1);
    assert(!S.state().playing, 'Space did not pause');
    return `chapter ${k0} ↔ ${k0 + 1}`;
  });

  await test('auto quality steps down while the frame rate sags', async () => {
    S.seek(12);
    S.setQuality('auto', 'high');
    S.play();
    const t0 = performance.now();
    await waitFor(() => S.state().tier === 'low', 90000, 'auto to reach the low tier');
    S.pause();
    const st = S.state();
    assert(st.steps.join(',') === 'medium,low', 'steps: ' + st.steps.join(','));
    S.setQuality('low');
    return `high → ${st.steps.join(' → ')} in ${((performance.now() - t0) / 1e3).toFixed(1)} s (SwiftShader)`;
  });

  await test('a lost WebGL context is restored (or the page says to reload)', async () => {
    const g = S.stage(), f0 = S.state().frame, cv = g.renderer.domElement;
    cv.dispatchEvent(new win.Event('webglcontextlost', { cancelable: true }));
    await waitFor(() => S.state().lost, 10000, 'the context-lost event');
    const card = q('.sc-card');
    assert(!card.classList.contains('gone') && /context was lost/.test(card.textContent), 'no message: ' + card.textContent);
    cv.dispatchEvent(new win.Event('webglcontextrestored'));
    await waitFor(() => !S.state().lost, 10000, 'the context-restored event');
    await frames(3);
    assert(card.classList.contains('gone'), 'the message stayed up');
    assert(S.state().frame > f0 && g.scene.environment, 'no frames or no probe after the restore');
    return `lost and restored, ${S.state().frame - f0} frames on`;
  });

  await test('no console errors', async () => {
    const e = S.state().errors;
    assert(e.length === 0, e.slice(0, 3).join(' | '));
    return '';
  });
});
