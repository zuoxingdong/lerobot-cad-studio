/* The shell: J1 / J2 / J3 click counts, ≥ 70 % canvas free at 1280 × 800, the inspector text
   budget, the checks pill, 1 2 3, the help overlay, narrow windows, layers and page teardown.
   Every click of a journey goes through `click()` / `clickPart()`; typing and Enter are not clicks. */

import { frame, sleep, waitFor, test, assert, start } from './_case.js';

let win = null, rps = null, fflate = null;
const doc = () => win.document;
const q = (s) => doc().querySelector(s);
const qa = (s) => [...doc().querySelectorAll(s)];
const SPAR = 'corner_mast_printed_spar_lower';
const notes = {};
let clicks = 0;

function click(el, what) {
  assert(el, 'nothing to click: ' + what);
  assert(!el.disabled, what + ' is disabled: ' + (el.title || ''));
  clicks++;
  el.click();
}
/** a click on the part where it is drawn, the way a user picks it */
async function clickPart(id) {
  rps.page.viewport.setView('front', { ms: 0 });
  rps.page.actions.frame(id);
  await sleep(700);
  const V = rps.page.viewport;
  const c = rps.ctx.model.component(id);
  c.geometry.computeBoundingBox();
  const p = c.geometry.boundingBox.getCenter(c.geometry.boundingBox.min.clone()).applyMatrix4(rps.ctx.model.worldMatrix(id));
  const s = V.worldToScreen(p, { frame: 'robot' });
  const canvas = q('#rps-canvas');
  const r = canvas.getBoundingClientRect();
  const o = { clientX: r.left + s.x, clientY: r.top + s.y, button: 0, buttons: 1, bubbles: true, pointerId: 1, isPrimary: true };
  clicks++;
  canvas.dispatchEvent(new win.PointerEvent('pointerdown', o));
  canvas.dispatchEvent(new win.PointerEvent('pointerup', { ...o, buttons: 0 }));
  await sleep(400);
  assert(rps.readouts().selected === id, `the click picked ${rps.readouts().selected}, not ${id}`);
}
function setField(role, text) {
  const inp = q(`.oppop [data-role="${role}"]`);
  assert(inp, 'no field ' + role);
  inp.value = text;
  inp.dispatchEvent(new win.Event('input'));
  inp.dispatchEvent(new win.Event('change'));
  return inp;
}
const enter = (el) => el.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
function capture(fn) {
  const orig = win.URL.createObjectURL;
  let blob = null;
  win.URL.createObjectURL = (b) => { blob = b; return 'blob:captured'; };
  try { fn(); } finally { win.URL.createObjectURL = orig; }
  return blob;
}
/** Home, then the package defaults: every journey starts from the same place */
async function fromHome() {
  if (rps && rps.page && win.location.hash.startsWith('#/design')) { rps.ctx.on.resetDefaults(); await sleep(400); }
  win.location.hash = '#/';
  await waitFor(() => q('.home .card1'), 30000, 'Home');
  await sleep(300);
  clicks = 0;
  click(q('.home .card1'), 'the robot card');
  await waitFor(() => win.__rps && win.__rps.page && win.__rps.readouts && win.__rps.readouts().treeRows > 0, 60000, 'the design page');
  rps = win.__rps;
  await sleep(600);
}
function key(code, k) {
  for (const type of ['keydown', 'keyup']) doc().body.dispatchEvent(new win.KeyboardEvent(type, { key: k, code, bubbles: true, cancelable: true }));
}

async function run() {
  win = frame.contentWindow;
  fflate = await import('/node_modules/fflate/esm/browser.js');
  await waitFor(() => q('.home .card1'), 60000, 'the Home page');

  await test('J1 · open → select → Stretch → Export this part in ≤ 4 clicks', async () => {
    await fromHome();
    await clickPart(SPAR);
    click(q('.opbar [data-op="stretch"]'), 'Stretch');
    await waitFor(() => q('.oppop:not([hidden])'), 5000, 'the Stretch popover');
    await sleep(250);
    enter(setField('change', '5'));
    await sleep(600);
    const ops = rps.ops(SPAR);
    assert(ops.length === 1 && ops[0].op === 'stretch' && ops[0].by === 5, JSON.stringify(ops));
    let blob = null;
    await waitFor(() => { const b = q('.ibody [data-role="export-part"]'); return b && !b.disabled; }, 5000, 'Export this part');
    blob = capture(() => click(q('.ibody [data-role="export-part"]'), 'Export this part'));
    assert(blob && blob.size > 84, 'no STL was written');
    notes.J1 = clicks;
    assert(clicks <= 4, clicks + ' clicks');
    return `${clicks} clicks: card · part · Stretch · Export this part → ${(blob.size / 1024).toFixed(0)} kB STL`;
  });

  await test('J2 · shorten the overhead mast 20 mm in ≤ 4 clicks', async () => {
    await fromHome();
    const h0 = rps.componentBox(SPAR);
    await clickPart(SPAR);
    click(q('.opbar [data-op="stretch"]'), 'Stretch');
    await waitFor(() => q('.oppop:not([hidden])'), 5000, 'the Stretch popover');
    await sleep(250);
    enter(setField('change', '−20'));
    await sleep(600);
    const ops = rps.ops(SPAR);
    assert(ops.length === 1 && ops[0].by === -20, JSON.stringify(ops));
    const h1 = rps.componentBox(SPAR);
    const dz = (h0.max[2] - h0.min[2]) - (h1.max[2] - h1.min[2]);
    assert(Math.abs(dz - 20) < 1e-3, `the spar is ${dz.toFixed(3)} mm shorter`);
    notes.J2 = clicks;
    assert(clicks <= 4, clicks + ' clicks');
    return `${clicks} clicks: card · part · Stretch (then −20 ⏎) → ${dz.toFixed(1)} mm shorter`;
  });

  await test('J3 · Ask agent → Choose folder → Use in ≤ 5 clicks', async () => {
    /* the agent's answer: the studio's own part folder of a 20 mm shorter spar, as a zip */
    assert(rps.ops(SPAR).length === 1, 'J2 left no edit to answer with');
    const f = rps.page.partFolder(SPAR);
    assert(f && f.files['part.json'], 'no part folder to answer with');
    const entries = {};
    for (const [rel, bytes] of Object.entries(f.files)) entries[`${f.id}/${rel}`] = bytes;
    const zip = new win.File([fflate.zipSync(entries)], 'answer.zip', { type: 'application/zip' });
    await fromHome();
    await clickPart(SPAR);
    click(q('.opbar [data-op="ask"]'), 'Ask agent');
    await waitFor(() => q('.agent'), 5000, 'the Ask-an-agent view');
    const req = q('.agent textarea');
    if (req) { req.value = 'same mast, 20 mm shorter'; req.dispatchEvent(new win.Event('input', { bubbles: true })); }
    /* the OS folder picker is the browser's, not a click on the page: answer it here */
    const proto = win.HTMLInputElement.prototype;
    const real = proto.click;
    proto.click = function () {
      if (!this.webkitdirectory) return real.call(this);
      Object.defineProperty(this, 'files', { value: [zip], configurable: true });
      this.onchange();
      return undefined;
    };
    try {
      const choose = qa('.agent button').find((b) => /Choose folder/.test(b.textContent));
      click(choose, 'Choose folder…');
    } finally { proto.click = real; }
    const use = await waitFor(() => qa('.toast button').find((b) => b.textContent.trim() === 'Use'), 15000, 'the new-design toast');
    click(use, 'Use');
    await waitFor(() => /^alt:/.test(rps.readouts().slots.top_camera_mount || ''), 15000, 'the design fitted');
    notes.J3 = clicks;
    assert(clicks <= 5, clicks + ' clicks');
    /* the design's own part.json hinge is a Shape knob, like a package part's */
    await rps.altReady();
    rps.page.inspector.closeAgent();
    const alt = rps.altComponents().filter((a) => a.visible);
    const hinged = alt.find((a) => { rps.select(a.id); return !!q('.ibody [data-role="hinge-value"]'); });
    assert(hinged, 'no Shape knob on any part of the agent design');
    notes.hinged = hinged.id;
    return `${clicks} clicks: card · part · Ask agent · Choose folder · Use → top_camera_mount = ${rps.readouts().slots.top_camera_mount}`;
  });

  await test('the untouched robot: the checks pill is green (or grey), never amber', async () => {
    rps.ctx.on.resetDefaults();
    await sleep(500);
    const c = rps.checks();
    await sleep(200);
    const pill = q('.topbar .checkspill');
    assert(pill.dataset.level === c.level, `the pill says ${pill.dataset.level}, the checks ${c.level}`);
    assert(c.level === 'pass' || c.level === 'unknown', `the pill is ${c.level}: ${c.reason}`);
    notes.pill = { level: c.level, counts: c.counts };
    return `${c.level} · ${c.counts.pass} pass · ${c.counts.warn} warn · ${c.counts.fail} fail · ${c.counts.unknown} unknown`;
  });

  await test('≥ 70 % of the canvas is free at 1280 × 800 with a part selected', async () => {
    frame.style.width = '1280px';
    frame.style.height = '800px';
    win.dispatchEvent(new win.Event('resize'));
    await sleep(800);
    await clickPart(SPAR);
    await sleep(600);
    const canvas = q('#rps-canvas');
    const r = canvas.getBoundingClientRect();
    let free = 0, n = 0;
    for (let i = 0; i < 64; i++) for (let j = 0; j < 40; j++) {
      const x = r.left + (i + 0.5) * r.width / 64, y = r.top + (j + 0.5) * r.height / 40;
      n++;
      if (doc().elementFromPoint(x, y) === canvas) free++;
    }
    const pct = 100 * free / n;
    const floating = qa('.canvas > *').filter((e) => e !== canvas && e.offsetParent && e.getBoundingClientRect().width > 0)
      .map((e) => e.className.split(' ')[0]);
    frame.style.width = '1600px';
    frame.style.height = '1000px';
    win.dispatchEvent(new win.Event('resize'));
    await sleep(500);
    notes.canvasFree = +pct.toFixed(1);
    assert(pct >= 70, `${pct.toFixed(1)} % of the canvas is free`);
    return `${pct.toFixed(1)} % free of ${Math.round(r.width)} × ${Math.round(r.height)} · over it: ${floating.join(', ')}`;
  });

  await test('no inspector text node is over 120 characters', async () => {
    const longest = [];
    const walk = (label) => {
      const w = doc().createTreeWalker(q('.rail.r'), win.NodeFilter.SHOW_TEXT);
      for (let t = w.nextNode(); t; t = w.nextNode()) {
        const s = t.textContent.trim();
        if (s.length) longest.push([s.length, label, s.slice(0, 60)]);
      }
    };
    rps.select(null); await sleep(500); walk('robot');
    rps.select(SPAR); await sleep(700); walk('mast part');
    rps.select('pi_case_cradle'); await sleep(700); walk('Pi case');
    rps.select('df200_arch_arch'); await sleep(700); walk('wrist arch');
    for (const l of qa('.ibody .fline')) l.click();
    await sleep(200); walk('checks expanded');
    longest.sort((a, b) => b[0] - a[0]);
    notes.longestText = longest.slice(0, 3);
    assert(longest[0][0] <= 120, `a ${longest[0][0]}-character text in the inspector (${longest[0][1]}): ${longest[0][2]}…`);
    rps.select(null);
    return `longest ${longest[0][0]} chars (${longest[0][1]}: "${longest[0][2]}")`;
  });

  await test('1 2 3 route Design · Check · Sim', async () => {
    const robot = rps.readouts().robot;
    q('#rps-canvas').blur();
    key('Digit2', '2');
    await waitFor(() => win.location.hash === '#/check/' + robot && q('.app.check-on'), 10000, 'the Check tab');
    key('Digit3', '3');
    await waitFor(() => win.location.hash === '#/sim/' + robot && q('.sim-rail'), 20000, 'the Sim tab');
    q('#rps-canvas').blur();
    key('Digit1', '1');
    await waitFor(() => win.location.hash === '#/design/' + robot && !q('.sim-rail') && !q('.app.check-on'), 10000, 'the Design tab');
    const tab = q('.topbar .tabs button.on');
    assert(tab && tab.dataset.tab === 'design', 'the top bar marks ' + (tab && tab.dataset.tab));
    return '2 → #/check · 3 → #/sim · 1 → #/design';
  });

  await test('the help overlay: ≤ 18 rows from the keymap, the platform modifier, [ ] = options', async () => {
    rps.dispatch('global.help');
    const sheet = await waitFor(() => q('.sheet.help'), 5000, 'the help overlay');
    await sleep(150);
    const rows = [...sheet.querySelectorAll('.helpgrid')].flatMap((g) => {
      const k = [...g.children], o = [];
      for (let i = 0; i + 1 < k.length; i += 2) o.push([k[i].textContent.trim(), k[i + 1].textContent.trim()]);
      return o;
    });
    assert(rows.length <= 18, rows.length + ' rows');
    const bracket = rows.find((r) => /\[/.test(r[0]));
    assert(bracket && /option/i.test(bracket[1]), '[ ] reads ' + (bracket && bracket[1]));
    const mac = /Mac|iPhone|iPad/.test(win.navigator.platform + ' ' + win.navigator.userAgent);
    assert(!rows.some((r) => r[0].includes(mac ? 'Ctrl' : '⌘')), 'a row prints the other platform\'s modifier');
    return rows.length + ' rows';
  });

  await test('Esc closes only the topmost layer; a sheet left open does not survive Home', async () => {
    const escKey = () => doc().body.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    escKey();
    await sleep(200);
    rps.page.actions.swapSlot('top_camera_mount');
    await sleep(350);
    assert(q('.pop') && q('.scrim') === null, 'the popover did not open alone');
    rps.dispatch('global.help');
    await sleep(300);
    escKey();
    await sleep(250);
    assert(!q('.scrim') && q('.pop'), 'one Esc closed both layers');
    escKey();
    await sleep(250);
    assert(!q('.pop'), 'the second Esc left the popover');
    rps.dispatch('global.help');
    await sleep(300);
    win.location.hash = '#/';
    await waitFor(() => q('.home .card1'), 30000, 'Home');
    await sleep(300);
    assert(!q('.scrim'), 'the sheet lies over Home');
    await fromHome();
    assert(rps.resolveKey('KeyG', { key: 'g' }).context === 'design', 'the keyboard stayed in the overlay context');
  });

  await test('narrow windows: the top bar wraps at 900 / 700 / 400 px; at 1100 px the inspector is a drawer', async () => {
    try {
      for (const w of [900, 700, 400]) {
        frame.style.width = w + 'px';
        win.dispatchEvent(new win.Event('resize'));
        await sleep(500);
        const vw = win.innerWidth;
        const off = qa('.topbar button').filter((b) => b.offsetParent !== null)
          .filter((b) => { const r = b.getBoundingClientRect(); return r.right > vw + 0.5 || r.left < -0.5; });
        assert(!off.length, `${w} px: ${off.length} top-bar buttons off-screen`);
        assert(doc().documentElement.scrollWidth <= vw + 1, `${w} px: the page scrolls sideways`);
      }
      frame.style.width = '1100px';
      await sleep(700);
      rps.page.applyLayout();
      await sleep(500);
      assert(q('.canvas').getBoundingClientRect().width >= 640, 'the canvas is under 640 px at 1100');
      assert(q('.rail.r').hidden || q('.rail.r').getBoundingClientRect().width === 0
        || q('[data-page="design"]').classList.contains('insp-drawer'), 'the inspector is still a rail at 1100 px');
    } finally {
      frame.style.width = '1600px';
      win.dispatchEvent(new win.Event('resize'));
      await sleep(700);
      rps.page.applyLayout();
      await sleep(300);
    }
  });

  await test('leaving disposes the viewport; Home wins a home → design → home race', async () => {
    let n = 0;
    const r = rps.ctx.viewport.renderer, orig = r.dispose.bind(r);
    r.dispose = () => { n++; return orig(); };
    win.location.hash = '#/';
    await waitFor(() => q('.home'), 20000, 'Home');
    await sleep(200);
    assert(!q('[data-page="design"]') && n === 1, `design page gone ${!q('[data-page="design"]')}, disposed ${n}`);
    const p = win.__rps.go('#/design/lekiwi-pincopen');
    win.location.hash = '#/';
    try { await p; } catch (e) { /* the losing mount */ }
    await sleep(1500);
    assert(q('.home') && !q('[data-page="design"]'), 'the design page painted over Home');
    await fromHome();
  });

  await test('no console errors', async () => {
    const errs = rps.readouts().errors;
    assert(!errs.length, errs.slice(0, 3).join(' | '));
    return 'clean';
  });
}

start(run, () => ({ notes }));
