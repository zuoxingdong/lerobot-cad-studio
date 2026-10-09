/* The inspector's "Ask an agent" view: the slots the redesign is for, the request, the
   constraints, Generate → prompt preview → Copy / Download context pack, and the Results the
   linked, chosen or dropped folder produced.  One persistent element, so a re-render of the
   inspector keeps the text and the focus.  Needs ui/dom.js, ui/icons.js. */

import { el } from './dom.js';
import { icon } from './icons.js';
import { DEFAULT_CONSTRAINTS } from '../features/context-pack.js';
import { printerProfile } from '../features/printcheck.js';

const MATERIALS = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU'];
/* a request that changes a length, a height or a position moves the camera with the part */
const MOVES_CAMERA = /\b(shorter|longer|taller|lower|higher|raised?|lift|move[ds]?|shift|height|length|reach|offset|closer|further|farther|\d+(\.\d+)?\s*(mm|cm))\b/i;
const list2 = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
const DOT = { pass: 'ok', warn: 'warn', fail: 'err', unknown: '' };

function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/** @param {object} page  @param {object} agent  ui/design-agent.js */
export function createAgentPanel(page, agent) {
  const { ctx } = page;
  const S = { targets: [], request: '', constraints: { ...DEFAULT_CONSTRAINTS }, prompt: '', contexts: [], note: '', why: new Set(), busy: false,
    stale: false, written: [], collapsed: false, cameraAuto: true };
  const root = el('div', 'agent');
  root.setAttribute('data-view', 'agent');

  /* header */
  const head = el('div', 'agent-h');
  const close = el('button', 'btn icon ghost');
  close.append(icon('close', 'i14'));
  close.title = 'Close · back to the part';
  close.setAttribute('aria-label', 'Close');
  close.onclick = () => agent.close();
  head.append(icon('sparkle', 'i14'), el('span', 'n', 'Ask an agent'), el('div', 'sp'), close);

  /* for */
  const forRow = el('div', 'agent-for');

  /* request */
  const reqLabel = el('label', 'agent-k', 'What should change?');
  const req = el('textarea', 'text-in agent-req');
  req.rows = 3;
  req.id = 'rps-agent-request';
  reqLabel.htmlFor = req.id;
  req.placeholder = 'e.g. 20 mm shorter, same head and camera angle';
  const grow = () => { req.style.height = 'auto'; req.style.height = Math.min(240, req.scrollHeight + 2) + 'px'; };
  req.oninput = () => {
    S.request = req.value;
    grow();
    if (S.cameraAuto) { S.constraints.keepCamera = !MOVES_CAMERA.test(S.request); camBox.checked = S.constraints.keepCamera; renderSummary(); }
    changed();
  };
  /* the prompt on screen (and prompt.md in the folder) no longer matches: Copy waits for Generate */
  function changed() {
    if (!S.prompt || S.stale) return;
    S.stale = true;
    if (S.written.length) agent.forgetPrompts(S.written);
    S.note = 'the request changed · Generate again';
    renderPrompt();
  }

  /* constraints */
  const cons = el('details', 'agent-cons');
  const consSum = el('summary');
  const consBody = el('div', 'agent-cons-b');
  cons.append(consSum, consBody);
  const check = (key, label) => {
    const l = el('label', 'agent-chk');
    const b = el('input');
    b.type = 'checkbox';
    b.checked = !!S.constraints[key];
    b.onchange = () => { S.constraints[key] = b.checked; if (key === 'keepCamera') S.cameraAuto = false; renderSummary(); changed(); };
    l.append(b, document.createTextNode(label));
    l.box = b;
    return l;
  };
  const num = (key, label, unit, placeholder) => {
    const l = el('label', 'agent-num');
    const n = el('input', 'text-in');
    n.type = 'number';
    n.value = S.constraints[key] == null ? '' : S.constraints[key];
    if (placeholder) n.placeholder = placeholder;
    n.onchange = () => { S.constraints[key] = n.value === '' ? null : Number(n.value); renderSummary(); changed(); };
    l.append(el('span', null, label), n, el('span', 'dim', unit));
    return l;
  };
  const mat = el('select', 'text-in');
  for (const m of MATERIALS) mat.appendChild(Object.assign(el('option', null, m), { value: m }));
  mat.value = S.constraints.material;
  mat.onchange = () => { S.constraints.material = mat.value; renderSummary(); changed(); };
  const matRow = el('label', 'agent-num');
  matRow.append(el('span', null, 'Material'), mat);
  const printerRow = el('div', 'agent-num');
  const printerName = el('span', 'dim');
  printerRow.append(el('span', null, 'Printer'), printerName);
  const camRow = check('keepCamera', 'Keep the camera pose');
  const camBox = camRow.box;
  camRow.title = 'off: the camera moves with the part, and the agent reports its new pose';
  consBody.append(check('keepMount', 'Keep the mount interface'), camRow,
    matRow, printerRow, num('maxOverhangDeg', 'Max overhang', '°'), num('maxMassG', 'Max mass', 'g', 'none'));
  function renderSummary() {
    const p = printerProfile(ctx.printer());
    printerName.textContent = p.name;
    const bits = [S.constraints.keepMount ? 'keep mount' : 'mount free', S.constraints.keepCamera ? 'keep camera' : 'camera may move',
      S.constraints.material, p.name.split(' / ')[0]];
    consSum.textContent = 'Constraints · ' + bits.join(' · ');
  }

  /* generate */
  const gen = el('button', 'btn accent wide');
  gen.type = 'button';
  gen.append(icon('sparkle', 'i14'), document.createTextNode('Generate prompt'));
  gen.onclick = () => generate();
  const pre = el('pre', 'agent-prompt code');
  pre.tabIndex = 0;
  pre.hidden = true;
  const note = el('div', 'agent-note code dim');
  const acts = el('div', 'agent-acts');
  const copy = el('button', 'btn');
  copy.type = 'button';
  copy.append(icon('copy', 'i14'), document.createTextNode('Copy prompt'));
  copy.onclick = () => copyPrompt();
  const pack = el('button', 'btn');
  pack.type = 'button';
  pack.append(icon('download', 'i14'), document.createTextNode('Download context pack'));
  pack.onclick = () => agent.downloadPacks(S.contexts, S.request);
  const show = el('button', 'btn sm ghost');
  show.type = 'button';
  show.onclick = () => { S.collapsed = !S.collapsed; renderPrompt(); };
  acts.append(copy, pack, el('div', 'sp'), show);
  acts.hidden = true;

  /* results */
  const resH = el('div', 'agent-res-h');
  const list = el('div', 'agent-list');
  root.append(head, forRow, reqLabel, req, cons, gen, pre, note, acts, el('div', 'agent-sep'), resH, list);

  async function generate() {
    if (!S.targets.length || S.busy) return;
    S.busy = true;
    gen.disabled = true;
    try {
      const r = await agent.generate(S.targets, S.request, S.constraints);
      S.prompt = r.prompt;
      S.contexts = r.contexts;
      S.written = r.written.length ? r.contexts.map((c) => c.slot.id) : [];
      S.note = r.error ? r.error
        : S.written.length ? `wrote ${agent.link().name}/_context/${list2(S.written.map((x) => x + '/'))}` : '';
    } catch (e) {
      S.written = [];
      S.prompt = '';
      S.note = 'could not build the prompt · ' + ((e && e.message) || e);
    }
    S.busy = false;
    S.stale = false;
    S.collapsed = false;
    render();
  }

  async function copyPrompt() {
    if (S.stale || !S.prompt) return;
    let ok = false;
    try { await navigator.clipboard.writeText(S.prompt); ok = true; } catch (e) { ok = false; }
    if (!ok) {
      const r = document.createRange();
      r.selectNodeContents(pre);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    }
    page.setStatus(ok ? 'prompt copied' : 'select the prompt and copy it', ok ? undefined : 'warn');
    if (ok) { S.collapsed = true; renderPrompt(); }       // Results come back into view
  }

  function chip(sid) {
    const c = el('span', 'chip acc agent-chip');
    c.dataset.slot = sid;
    const opt = ctx.slots.slots[sid];
    let count = 0;
    try {
      const o = ctx.slots.option(sid, ctx.slots.activeOption(ctx.store.getState(), sid));
      count = ((o && o.shows) || []).length;
    } catch (e) { count = 0; }
    c.append(el('span', 't', `${opt ? opt.label : sid}${count ? ` · ${count} part${count === 1 ? '' : 's'}` : ''}`));
    const x = el('button', 'x', '×');
    x.type = 'button';
    x.title = 'Remove';
    x.onclick = () => { S.targets = S.targets.filter((t) => t !== sid); render(); };
    c.appendChild(x);
    return c;
  }

  function renderFor() {
    forRow.innerHTML = '';
    forRow.append(el('span', 'agent-k', 'For'));
    for (const sid of S.targets) forRow.appendChild(chip(sid));
    const add = el('button', 'btn sm ghost');
    add.type = 'button';
    add.append(icon('plus', 'i12'), document.createTextNode('add'));
    const rest = ctx.slots.order.filter((sid) => !S.targets.includes(sid));
    add.disabled = !rest.length;
    add.onclick = () => page.openMenu(add, rest.map((sid) => ({
      label: ctx.slots.slots[sid].label, run: () => { S.targets.push(sid); render(); } })));
    forRow.appendChild(add);
  }

  function renderResults() {
    const L = agent.link();
    resH.innerHTML = '';
    resH.append(el('span', 'agent-k', 'Results'), el('div', 'sp'));
    if (L.state === 'connected') {
      const f = el('span', 'agent-folder');
      f.append(icon('folder', 'i14'), el('span', 't', L.name), el('span', 'dot ok'), el('span', 'dim', 'watching'));
      f.title = L.error || `${L.name} · checked every 2 s`;
      const un = el('button', 'btn sm ghost', 'Unlink');
      un.type = 'button';
      un.onclick = () => agent.unlink();
      resH.append(f, un);
    } else if (L.state === 'reconnect') {
      const b = el('button', 'btn sm agent-reconnect');
      b.type = 'button';
      b.append(icon('folder', 'i14'), document.createTextNode(`Reconnect ${L.name}`));
      b.onclick = () => agent.reconnect();
      resH.appendChild(b);
    } else if (L.supported) {
      const b = el('button', 'btn sm', 'Link folder…');
      b.type = 'button';
      b.title = 'watch a folder: new designs appear here';
      b.onclick = () => agent.linkFolder();
      resH.appendChild(b);
    }
    if (L.state !== 'connected') {
      const b = el('button', 'btn sm', 'Choose folder…');
      b.type = 'button';
      b.title = 'read a folder once; a part folder or a zip can also be dropped anywhere';
      b.onclick = () => agent.chooseFolder();
      resH.appendChild(b);
    }

    list.innerHTML = '';
    const cards = agent.results();
    if (!cards.length) { list.appendChild(el('div', 'agent-empty dim', 'Nothing yet')); return; }
    for (const c of cards) list.appendChild(row(c));
  }

  function row(c) {
    const r = el('div', 'agent-row' + (c.ok ? '' : ' bad'));
    r.dataset.key = c.key;
    const top = el('div', 'agent-row-t');
    const name = el('span', 'n', c.label);
    name.title = `${c.label} · ${c.id} · ${c.folderId}/ · ${agent.sourceNote(c)}`;
    top.append(icon('sparkle', 'i12'), name);
    if (c.isNew && c.ok) top.appendChild(el('span', 'badge new', 'new'));
    if (c.missing) top.appendChild(el('span', 'badge miss', 'missing'));
    top.append(el('div', 'sp'), el('span', 'dim when', ago(c.time)));
    const dot = el('span', 'dot ' + (DOT[c.verdict] || ''));
    dot.title = c.verdict + (c.reason ? ' · ' + c.reason : '');
    top.appendChild(dot);
    if (c.ok) {
      const use = el('button', 'btn sm', agent.isFitted(c) ? 'In use' : 'Use');
      use.type = 'button';
      use.disabled = c.missing || agent.isFitted(c);
      use.title = `${agent.slotLabel(c.slot)} → ${c.label}`;
      use.onclick = () => agent.use(c.key);
      use.onmouseenter = () => { if (!agent.isFitted(c)) agent.preview(c.key); };
      use.onmouseleave = () => { if (agent.previewing() === c.key) agent.preview(null); };
      top.appendChild(use);
    }
    if (!c.ok || c.warnings.length || c.verdict === 'fail') {
      const why = el('button', 'btn sm ghost', 'Why');
      why.type = 'button';
      why.onclick = () => { if (S.why.has(c.key)) S.why.delete(c.key); else S.why.add(c.key); renderResults(); };
      top.appendChild(why);
    }
    r.appendChild(top);
    if (!c.ok || (c.verdict === 'fail' && c.reason)) {
      const line = el('div', 'agent-err', `${c.ok ? '' : 'failed: '}${c.reason}`);
      line.title = c.reason;
      r.appendChild(line);
    }
    if (S.why.has(c.key)) {
      const w = el('ul', 'agent-why');
      for (const e of c.errors) w.appendChild(el('li', 'err', e));
      for (const e of c.warnings) w.appendChild(el('li', 'warn', e));
      if (c.ok && c.verdict === 'fail' && c.reason) w.appendChild(el('li', 'err', c.reason));
      r.appendChild(w);
    }
    return r;
  }

  function render() {
    renderFor();
    renderSummary();
    if (req.value !== S.request) { req.value = S.request; grow(); }
    gen.disabled = S.busy || !S.targets.length;
    gen.title = S.targets.length ? 'the prompt, with your request last' : 'add a slot first';
    renderPrompt();
    renderResults();
  }

  function renderPrompt() {
    pre.hidden = !S.prompt || S.collapsed;
    if (pre.textContent !== S.prompt) pre.textContent = S.prompt;
    pre.classList.toggle('stale', S.stale);
    acts.hidden = !S.prompt;
    copy.disabled = pack.disabled = S.stale;
    copy.title = pack.title = S.stale ? 'the request changed: Generate again' : '';
    show.textContent = S.collapsed ? 'Show prompt' : 'Hide prompt';
    note.textContent = S.note;
    note.hidden = !S.note;
  }

  const off = agent.subscribe(() => { if (root.isConnected) renderResults(); });
  render();

  return {
    el: root,
    render,
    state: S,
    setTargets(t) {
      const same = t.length === S.targets.length && t.every((x) => S.targets.includes(x));
      if (same) return;
      S.targets = t.slice();
      S.prompt = ''; S.contexts = []; S.note = ''; S.stale = false; S.written = [];
    },
    /** Into `host`, keeping the focus when it is already there. */
    mount(host) {
      if (host.firstChild === root && host.childNodes.length === 1) { render(); return; }
      const f = document.activeElement;
      const had = root.contains(f);
      host.replaceChildren(root);
      render();
      if (had && f && f.focus) f.focus();
    },
    reveal(o = {}) {
      if (o.why) S.why.add(o.why);
      render();
      requestAnimationFrame(() => {
        if (o.results) resH.scrollIntoView({ block: 'start' });
        else { req.focus(); req.setSelectionRange(req.value.length, req.value.length); }
      });
    },
    destroy() { off(); root.remove(); },
  };
}
