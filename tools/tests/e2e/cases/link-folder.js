/*
   The agent loop end to end: Ask agent on the corner mast → the prompt carries the typed
   request last and the edited geometry; a linked folder (an in-memory directory handle)
   gets `_context/`; a part folder written mid-session shows as a card and a toast within
   5 s; Preview draws a ghost, Use swaps it in as one undo step and the checks cover it; a bad
   part.json shows its error line; a removed folder drops its card (a fitted one is kept as
   missing); Reconnect; Save as part into the folder; and zips dropped on the Design page. */

import { frame, sleep, waitFor, test as run1, assert, start } from './_case.js';

/* a step that never settles fails on its own instead of costing the suite its watchdog */
const test = (name, fn, ms = 40000) => run1(name, () => Promise.race([fn(),
  new Promise((_, no) => setTimeout(() => no(new Error(`timed out after ${ms} ms`)), ms))]));

let win = null, rps = null, root = null, FS = null, fflate = null;
const doc = () => win.document;
const q = (s) => doc().querySelector(s);
const qa = (s) => [...doc().querySelectorAll(s)];
const SLOT = 'top_camera_mount';
const SPAR = 'corner_mast_printed_spar_lower';
const REQUEST = 'same mast head, 20 mm shorter, keep 45°\nprint it in two halves if it has to';
const notes = {};

const card = (id) => rps.agent.cards().find((c) => c.id === id || c.key.endsWith(':' + id));
const toastText = () => qa('.toast .t').map((t) => t.textContent);

function typeInto(el, value) {
  el.value = value;
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
}
async function generate() {
  const before = rps.agent.panel().prompt;
  q('.agent .btn.accent.wide').click();
  await waitFor(() => { const s = rps.agent.panel(); return !s.busy && s.prompt && s.prompt !== before ? s : null; }, 20000, 'the prompt');
  await sleep(100);
  return rps.agent.panel();
}
/** a part folder written the way an agent would: meshes first, part.json last */
function writePart(id, label, files) {
  for (const [rel, bytes] of Object.entries(files)) if (rel !== 'part.json') root.put(`${id}/${rel}`, bytes);
  root.put(`${id}/part.json`, files['part.json']);
}
/** the pack's current meshes as a new design (what an agent returns when nothing changes) */
function shortMast(id, label) {
  const tpl = JSON.parse(root.read(`_context/${SLOT}/part.json`));
  tpl.id = id; tpl.label = label; tpl.notes = 'e2e';
  const pack = (p) => root.children.get('_context').children.get(SLOT).children.get('current').children.get(p).bytes;
  const files = {};
  for (const m of tpl.meshes) {
    files[m.file] = pack(`${m.id}.stl`);
    if (m.print && !m.print.startsWith('part:')) files[m.print] = pack(`${m.id}_print.stl`);
  }
  files['part.json'] = JSON.stringify(tpl, null, 1);
  return files;
}

async function run() {
  fflate = await import('/node_modules/fflate/esm/browser.js');

  await test('design page up, the action bar has Ask agent', async () => {
    await waitFor(() => { win = frame.contentWindow; return win.document.querySelector('.home .card1'); }, 30000, 'Home');
    /* the test double lives in the page's realm, loaded once the page is (not about:blank) */
    FS = await win.eval("import('/tools/tests/fixtures/agent/fake-fs.mjs')");
    q('.home .card1').click();
    await waitFor(() => win.__rps && win.__rps.page && win.__rps.readouts().treeRows > 0, 60000, 'the design page');
    rps = win.__rps;
    await sleep(500);
    rps.select(SPAR);
    await waitFor(() => rps.opsBar() && rps.opsBar().shown, 5000, 'the action bar');
    const b = q('.opbar [data-op="ask"]');
    assert(b, 'no Ask agent button');
    b.click();
    const ta = await waitFor(() => q('.agent textarea'), 5000, 'the Ask an agent view');
    await sleep(100);
    assert(doc().activeElement === ta, 'the request box is not focused');
    const chips = qa('.agent .agent-chip').map((c) => c.dataset.slot);
    assert(chips.join() === SLOT, 'For chips: ' + chips.join());
    assert(!qa('.pop').length, 'the swap popover opened as well');
    return `For ${qa('.agent .agent-chip .t').map((t) => t.textContent).join(', ')}`;
  });

  await test('Generate: 9 sections, the typed request last, the edited geometry in the pack', async () => {
    rps.applyOp(SPAR, { op: 'scale', factors: [1, 1, 1.05], about: 'mount' });
    await sleep(300);
    rps.agent.open([SPAR]);
    typeInto(q('.agent textarea'), REQUEST);
    const s = await generate();
    const p = s.prompt;
    const heads = p.split('\n').filter((l) => /^## \d /.test(l)).map((l) => l.slice(3, 4));
    assert(heads.join('') === '123456789', 'sections ' + heads.join(''));
    const tail = p.slice(p.indexOf('## 9 Request'));
    assert(tail.includes(REQUEST), 'the request is not verbatim in section 9');
    assert(p.lastIndexOf(REQUEST) > p.lastIndexOf('## 8 Tools'), 'the request is not last');
    const after = p.slice(p.indexOf(REQUEST) + REQUEST.length).trim().split('\n');
    assert(after.length === 1 && /conflicts with section 4/.test(after[0]), 'after the request: ' + after.join(' | '));
    for (const bad of ['claude', '~/', '/home/']) assert(!p.toLowerCase().includes(bad), 'the prompt contains ' + bad);
    /* "20 mm shorter" moves the camera: the keep-camera constraint unticks itself, and no
       placeholder path stands in for a folder nobody linked */
    assert(s.constraints.keepCamera === false && /It may move with the part/.test(p) && !/Keep this pose within/.test(p), 'keep camera contradicts the request');
    assert(!p.includes('<linked-folder>') && /context zip the user gives you/.test(p), 'section 6 names a placeholder folder');
    const pre = q('.agent .agent-prompt');
    assert(pre && !pre.hidden && pre.textContent === p, 'the preview does not show the prompt');
    assert(q('.agent .agent-acts:not([hidden])'), 'no Copy / Download buttons');
    const c = s.contexts[0];
    const spar = c.parts.find((x) => x.id === 'spar_lower');
    const dz = spar.bbox.max[2] - spar.bbox.min[2];
    assert(c.parts.length === 5, 'parts ' + c.parts.length);
    assert(dz > 248 * 1.04, `spar_lower is ${dz.toFixed(1)} mm tall: the scale op is not in the pack`);
    assert(spar.printStlBytes && spar.printStlBytes.length > 84, 'no print plate for spar_lower');
    assert(c.neighbours && c.neighbours.stlBytes.length > 84, 'no neighbours.stl');
    assert(c.slot.params.tilt_deg && c.slot.params.tilt_deg.value === 45, 'hinge ' + JSON.stringify(c.slot.params.tilt_deg && c.slot.params.tilt_deg.value));
    assert(c.cameras[0] && Math.abs(c.cameras[0].hfov - 87.3) < 0.05, 'camera hfov ' + (c.cameras[0] && c.cameras[0].hfov));
    rps.ctx.on.resetOps([SPAR]);
    await sleep(200);
    notes.prompt = { lines: p.split('\n').length, neighbours: c.neighbours.note };
    return `${p.split('\n').length} lines · spar ${dz.toFixed(1)} mm · ${c.neighbours.note}`;
  });

  await test('Link folder: chip in the top bar, Generate writes _context/<slot>/', async () => {
    root = new FS.FakeDir('lekiwi-designs');
    await rps.agent.link(root);
    await waitFor(() => rps.agent.state().state === 'connected', 5000, 'connected');
    const chip = await waitFor(() => q('.folderslot:not([hidden]) .folderchip'), 3000, 'the folder chip');
    assert(/lekiwi-designs/.test(chip.textContent), 'chip ' + chip.textContent);
    const s = await generate();
    assert(root.read(`_context/${SLOT}/prompt.md`) === s.prompt, 'prompt.md is not the prompt');
    assert(s.prompt.includes('lekiwi-designs/_context/' + SLOT), 'the prompt does not name the folder');
    const n = q('.agent .agent-note');
    assert(n && !n.hidden && /_context/.test(n.textContent), 'no written line: ' + (n && n.textContent));
    const files = root.paths().filter((p) => p.startsWith('_context/'));
    assert(files.includes(`_context/${SLOT}/current/spar_lower.stl`), 'no current/spar_lower.stl');
    await sleep(2500);
    assert(!rps.agent.cards().length, '_context became a card');
    /* an edit after Generate: Copy waits for Generate, and prompt.md leaves the folder */
    const copyBtn = () => [...qa('.agent .agent-acts button')].find((b) => /Copy prompt/.test(b.textContent));
    typeInto(q('.agent textarea'), REQUEST + ' and lighter');
    await sleep(200);
    assert(copyBtn().disabled && rps.agent.panel().stale, 'Copy is live on a stale prompt');
    assert(!root.read(`_context/${SLOT}/prompt.md`), 'a stale prompt.md stayed in _context');
    const again = await generate();
    assert(!copyBtn().disabled && root.read(`_context/${SLOT}/prompt.md`) === again.prompt, 'Generate did not refresh it');
    typeInto(q('.agent textarea'), REQUEST);
    await generate();
    return `${files.length} files · "${n.textContent}" · a stale prompt disables Copy`;
  });

  await test('a part folder written mid-session: card + toast within 5 s', async () => {
    const t0 = Date.now();
    writePart('short-mast', 'short mast', shortMast('short-mast', 'short mast'));
    const c = await waitFor(() => card('short-mast'), 5000, 'the card');
    const ms = Date.now() - t0;
    const t = await waitFor(() => toastText().find((x) => /New design for Overhead camera mount: short mast/.test(x)), 1000, 'the toast');
    assert(c.ok && c.isNew && c.slot === SLOT, JSON.stringify(c));
    const row = await waitFor(() => q('.agent-row[data-key="linked:short-mast"]'), 2000, 'the results row');
    assert(row.querySelector('.badge.new'), 'no new badge');
    assert(rps.ctx.alternativesFor(SLOT).some((a) => a.id === 'short-mast'), 'not in the slot options');
    notes.detectMs = ms;
    return `${ms} ms · "${t}" · verdict ${c.verdict}${c.reason ? ' (' + c.reason + ')' : ''}`;
  });

  await test('Preview ghosts it, Use swaps it in (one undo step) and the checks cover it', async () => {
    const tb = qa('.toast').find((n) => /short mast/.test(n.textContent));
    [...tb.querySelectorAll('button')].find((b) => b.textContent === 'Preview').click();
    await sleep(100);
    const ghost = rps.page.viewport.robotRoot.getObjectByName('agentPreview');
    assert(ghost && ghost.children.length >= 4, 'no preview ghost');
    const undo0 = rps.store.history().past.length;
    [...tb.querySelectorAll('button')].find((b) => b.textContent === 'Use').click();
    await waitFor(() => rps.readouts().slots[SLOT] === 'alt:short-mast', 10000, 'the swap');
    await waitFor(() => rps.altComponents().filter((x) => x.visible).length >= 4, 20000, 'its parts drawn');
    assert(!rps.page.viewport.robotRoot.getObjectByName('agentPreview'), 'the ghost stayed');
    assert(rps.store.history().past.length === undo0 + 1, 'undo steps ' + (rps.store.history().past.length - undo0));
    const rep = rps.ctx.designReport();
    const mine = rep.components.filter((x) => String(x.component || x.id).startsWith('alt:short-mast/'));
    assert(mine.length >= 3, 'the print checks do not cover it: ' + mine.length);
    const pose = rps.camPose('top');
    assert(pose && pose.origin[2] > 480, 'top camera ' + JSON.stringify(pose && pose.origin));
    rps.dispatch('global.undo');
    await waitFor(() => rps.readouts().slots[SLOT] === 'corner_mast_printed', 10000, 'the undo');
    q('.agent-row[data-key="linked:short-mast"] .btn').click();
    await waitFor(() => rps.readouts().slots[SLOT] === 'alt:short-mast', 10000, 'Use from the results');
    return `${mine.length} parts checked · worst ${rep.worst} · undo/redo ok`;
  });

  await test('a bad part.json shows its error line', async () => {
    root.put('bad-mast/part.json', JSON.stringify({ schema: 'rps/part@1', id: 'bad-mast', label: 'bad mast', slot: SLOT,
      frame: 'robot', meshes: [{ id: 'x', file: 'mesh/x.stl', print: 'print/x_PRINT.stl' }] }));
    root.put('typo/part.json', '{ "schema": "rps/part@1", ');
    root.put('old-name/meta.json', JSON.stringify({ schema: 'rps/part@1', id: 'old-name', slot: SLOT, meshes: [] }));
    await waitFor(() => card('bad-mast') && card('typo') && card('old-name'), 5000, 'the three cards');
    const meta = await waitFor(() => q('.agent-row[data-key="linked:old-name"] .agent-err'), 2000, 'the meta.json error line');
    assert(/rename it part\.json/.test(meta.textContent), 'meta.json line: ' + meta.textContent);
    const line = await waitFor(() => q('.agent-row[data-key="linked:bad-mast"] .agent-err'), 2000, 'the error line');
    assert(/failed: mesh\/x\.stl missing/.test(line.textContent), 'line: ' + line.textContent);
    const typo = q('.agent-row[data-key="linked:typo"] .agent-err').textContent;
    assert(/not valid JSON/.test(typo), 'typo line: ' + typo);
    const why = [...q('.agent-row[data-key="linked:bad-mast"]').querySelectorAll('button')].find((b) => b.textContent === 'Why');
    why.click();
    await waitFor(() => q('.agent-row[data-key="linked:bad-mast"] .agent-why li'), 1000, 'Why');
    assert(!rps.ctx.alternativesFor(SLOT).some((a) => a.id === 'bad-mast'), 'a failed design joined the options');
    return `"${line.textContent}" · "${typo}"`;
  });

  await test('removing a folder removes its card; the fitted one stays as missing', async () => {
    root.rm('bad-mast');
    root.rm('typo');
    root.rm('old-name');
    root.rm('short-mast');
    await waitFor(() => !card('bad-mast') && !card('typo') && !card('old-name'), 5000, 'the cards to go');
    const c = await waitFor(() => { const x = card('short-mast'); return x && x.missing ? x : null; }, 3000, 'missing');
    assert(q('.agent-row[data-key="linked:short-mast"] .badge.miss'), 'no missing badge');
    rps.dispatch('global.undo');
    await waitFor(() => !card('short-mast'), 5000, 'the missing card to go after the undo');
    return `short-mast was ${c.missing ? 'missing' : '?'} while fitted, gone once off the robot`;
  });

  await test('Reconnect: a folder that loses permission turns the chip amber', async () => {
    const entries = root.entries;
    root.entries = async function* denied() { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); };
    await rps.agent.scan();
    await waitFor(() => rps.agent.state().state === 'reconnect', 5000, 'reconnect');
    await waitFor(() => q('.folderchip.amber'), 2000, 'the amber chip');
    const b = await waitFor(() => q('.agent .agent-reconnect'), 2000, 'the Reconnect button');
    root.entries = entries;
    b.click();
    await waitFor(() => rps.agent.state().state === 'connected', 5000, 'connected again');
    return `"${b.textContent}" → connected`;
  });

  await test('Save as part writes into the linked folder, which then offers it', async () => {
    await rps.ctx.on.savePart(SPAR);
    const id = 'corner_mast_printed_edited';
    assert(root.read(`${id}/part.json`), 'no part.json in the folder: ' + root.paths().filter((p) => !p.startsWith('_')).join(', '));
    const c = await waitFor(() => card(id), 5000, 'the saved part as a card');
    return `${root.paths().filter((p) => p.startsWith(id)).length} files · card ${c.verdict}`;
  });

  await test('a design generated at 60° comes back exact: Use it, click 65, the camera tilts 65°', async () => {
    rps.select(SPAR);
    rps.setHinge('corner_mast_printed', 'tilt_deg', 60);
    await sleep(600);
    assert(Math.abs(rps.camPose('top').tilt_deg - 60) < 0.01, 'the knob did not reach 60');
    rps.agent.open([SPAR]);
    typeInto(q('.agent textarea'), 'same mast, nothing else');
    const s = await generate();
    assert(/fitted now: `corner_mast_printed` \(Corner mast, printed · 60°\)/.test(s.prompt), 'the prompt label is not live');
    const tpl = JSON.parse(root.read(`_context/${SLOT}/part.json`));
    assert(tpl.params.tilt_deg.design === 60 && tpl.params.tilt_deg.value === 60, 'template hinge ' + JSON.stringify(tpl.params.tilt_deg));
    assert(/ v2 · 60°$/.test(tpl.label) && tpl.meshes.every((m) => m.label), 'template labels ' + tpl.label);
    notes.originZ = tpl.params.tilt_deg.origin[2];
    const files = shortMast('tilted-mast', tpl.label);
    writePart('tilted-mast', tpl.label, files);
    const c = await waitFor(() => { const x = card('tilted-mast'); return x && x.ok ? x : null; }, 8000, 'the card');
    const warns = rps.agent.cards().find((x) => x.id === 'tilted-mast');
    await rps.agent.use(c.key);
    await waitFor(() => rps.readouts().slots[SLOT] === 'alt:tilted-mast', 10000, 'the swap');
    await rps.altReady();
    const t0 = rps.camPose('top').tilt_deg;
    assert(Math.abs(t0 - 60) < 0.01, `fitted as generated, the camera is at ${t0}°`);
    /* the tree and "Parts you can change" name it, not "None" */
    await sleep(300);
    const row = q(`.tree .row.slot[data-slot="${SLOT}"]`);
    assert(row && !/: None$/.test(row.title) && /v2/.test(rps.ctx.optionLabel(SLOT)), 'slot row ' + (row && row.title));
    rps.setHinge('tilted-mast', 'tilt_deg', 65);
    await sleep(600);
    const t1 = rps.camPose('top').tilt_deg;
    assert(Math.abs(t1 - 65) < 0.01, `clicked 65, the camera is at ${t1}°`);
    assert(/65°/.test(rps.ctx.optionLabel(SLOT)), 'label ' + rps.ctx.optionLabel(SLOT));
    rps.dispatch('global.undo');
    rps.dispatch('global.undo');
    await waitFor(() => rps.readouts().slots[SLOT] === 'corner_mast_printed', 10000, 'back to the stock mast');
    rps.setHinge('corner_mast_printed', 'tilt_deg', 45);
    root.rm('tilted-mast');
    return `60° → Use → ${t0.toFixed(2)}° → click 65 → ${t1.toFixed(2)}° · card ${warns.verdict}${warns.reason ? ' (' + warns.reason + ')' : ''}`;
  });

  await test('shortened −20 and tilted 60: the template hinge origin drops 20 mm with the head', async () => {
    rps.select(SPAR);
    await waitFor(() => rps.opsBar() && rps.opsBar().shown, 5000, 'the action bar');
    q('.opbar [data-op="stretch"]').click();
    const inp = await waitFor(() => q('.oppop:not([hidden]) [data-role="change"]'), 5000, 'the stretch popover');
    inp.value = '−20';
    inp.dispatchEvent(new win.Event('input'));
    inp.dispatchEvent(new win.Event('change'));
    await sleep(300);
    inp.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor(() => rps.ops(SPAR).length === 1, 5000, 'the shorten');
    rps.setHinge('corner_mast_printed', 'tilt_deg', 60);
    await sleep(600);
    rps.agent.open([SPAR]);
    typeInto(q('.agent textarea'), 'same mast, shorter already');
    await generate();
    const tpl = JSON.parse(root.read(`_context/${SLOT}/part.json`));
    const z = tpl.params.tilt_deg.origin[2];
    assert(Math.abs(notes.originZ - 20 - z) < 0.01, `hinge origin z ${notes.originZ} → ${z}`);
    assert(tpl.params.tilt_deg.design === 60, 'design ' + tpl.params.tilt_deg.design);
    rps.dispatch('global.undo');
    rps.dispatch('global.undo');
    await waitFor(() => !rps.ops(SPAR).length, 5000, 'the undo');
    return `origin z ${notes.originZ.toFixed(2)} → ${z.toFixed(2)} mm`;
  });

  await test('drop a zip on the Design page: a part zip and a meta.json zip join the slot', async () => {
    const files = Object.fromEntries(Object.entries(shortMast('dropped-mast', 'dropped mast')).map(([k, v]) => [k, typeof v === 'string' ? fflate.strToU8(v) : v]));
    notes.dropped = { ...files, 'part.json': fflate.strToU8(new TextDecoder().decode(files['part.json']).replace(/dropped-mast/g, 'home-mast')) };
    const zip = fflate.zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => ['dropped-mast/' + k, v])));
    await dropFiles([new win.File([zip], 'dropped-mast.zip', { type: 'application/zip' })]);
    const c = await waitFor(() => card('dropped-mast'), 10000, 'the dropped part');
    assert(c.ok && c.source === 'drop', JSON.stringify(c));
    const meta = new Uint8Array(await (await fetch('/out/work/e2e/fixtures/corner_mast_meta.zip')).arrayBuffer());
    await dropFiles([new win.File([meta], 'corner_mast_meta.zip', { type: 'application/zip' })]);
    const t = await waitFor(() => card('corner_mast_meta'), 20000, 'the meta.json zip');
    assert(t.ok, 'meta.json zip: ' + t.reason);
    const ids = rps.ctx.alternativesFor(SLOT).map((a) => a.id);
    assert(ids.includes('dropped-mast') && ids.includes('corner_mast_meta'), 'options ' + ids.join());
    const n0 = rps.ctx.model.components.length;
    await dropFiles([new win.File([cube()], 'bracket.stl')]);
    await waitFor(() => rps.ctx.model.components.length > n0, 10000, 'the mesh import');
    const imp = rps.ctx.model.components.filter((x) => x.id.startsWith('imported/'));
    assert(imp.length, 'the mesh did not land under Imported');
    return `options ${ids.join(', ')} · mesh → ${imp[imp.length - 1].id}`;
  });

  function cube() {
    const buf = new ArrayBuffer(84 + 12 * 50), dv = new DataView(buf);
    const v = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]];
    const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    dv.setUint32(80, 12, true);
    let o = 84;
    for (const tri of t) { o += 12; for (const i of tri) { for (let k = 0; k < 3; k++) dv.setFloat32(o + k * 4, v[i][k], true); o += 12; } o += 2; }
    return new Uint8Array(buf);
  }
  async function dropFiles(list) {
    const dt = new win.DataTransfer();
    for (const f of list) dt.items.add(f);
    const target = q('#rps-canvas');
    target.dispatchEvent(new win.DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    target.dispatchEvent(new win.DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    await sleep(200);
  }

  await test('drop a part zip on Home: its robot opens with the design fitted', async () => {
    const zip = fflate.zipSync(Object.fromEntries(Object.entries(notes.dropped).map(([k, v]) => ['home-mast/' + k, v])));
    win.location.hash = '#/';
    const home = await waitFor(() => q('.home'), 20000, 'Home');
    const dt = new win.DataTransfer();
    dt.items.add(new win.File([zip], 'home-mast.zip', { type: 'application/zip' }));
    home.dispatchEvent(new win.DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    await waitFor(() => /^#\/design\//.test(win.location.hash) && win.__rps.page && win.__rps.readouts().treeRows > 0, 60000, 'the design page');
    rps = win.__rps;
    await waitFor(() => rps.readouts().slots[SLOT] === 'alt:home-mast', 20000, 'the fitted drop');
    return `${win.location.hash} · ${SLOT} = alt:home-mast`;
  });

  await test('no page errors', async () => {
    const errs = rps.readouts().errors || [];
    assert(!errs.length, errs.slice(0, 3).join(' | '));
    return `detected in ${notes.detectMs} ms`;
  });
}

start(run, () => ({ notes: { ...notes, dropped: undefined } }));
