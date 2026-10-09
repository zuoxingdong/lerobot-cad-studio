/* The top bar, the same on every tab: robot chip ▾ · undo / redo · Design Check Sim ·
   the checks pill · the linked-folder chip · Export · help · theme.  Needs ui/dom.js, ui/icons.js. */

import { icon } from './icons.js';
import { MODK } from '../core/keymap.js';
import { el } from './dom.js';
import { DOT } from '../features/verdict.js';
import { themeTitle } from './design-helpers.js';

export const TABS = [['design', 'Design', '1'], ['check', 'Check', '2'], ['sim', 'Sim', '3']];

export function mountTopbar(host, ctx) {
  host.innerHTML = '';
  const bar = el('div', 'topbar');

  const chip = el('button', 'robotchip');
  chip.type = 'button';
  const chipDot = el('span', 'dot');
  const chipName = el('span', null, ctx.model.name);
  chip.append(chipDot, chipName, icon('chevron-down', 'i14'));
  chip.onclick = () => ctx.on.menu(chip, robotMenu());

  const undo = iconBtn('undo', 'Undo', () => ctx.on.undo());
  const redo = iconBtn('redo', 'Redo', () => ctx.on.redo());

  const tabs = el('div', 'tabs');
  tabs.setAttribute('role', 'tablist');
  const tabBtns = new Map();
  for (const [id, label, key] of TABS) {
    const b = el('button', null, label);
    b.type = 'button';
    b.dataset.tab = id;
    b.setAttribute('role', 'tab');
    b.title = `${label} · ${key}`;
    b.onclick = () => ctx.on.tab(id);
    tabs.appendChild(b);
    tabBtns.set(id, b);
  }
  const simOk = ctx.simAvailable ? ctx.simAvailable() : true;
  tabBtns.get('sim').disabled = !simOk;
  if (!simOk) tabBtns.get('sim').title = 'Sim needs a robot with an arm';

  /* the one roll-up of every check; a click opens Check on the problems */
  const pill = el('button', 'checkspill');
  pill.type = 'button';
  const pillDot = el('span', 'dot');
  const pillText = el('span', 'tl', 'Checks');
  pill.append(pillDot, pillText);
  pill.onclick = () => ctx.on.tab('check');

  /* filled by ui/design-agent.js while a folder is linked */
  const folder = el('span', 'folderslot');
  folder.hidden = true;

  const exp = el('button', 'btn accent');
  exp.type = 'button';
  exp.append(icon('export', 'i14'), el('span', 'tl', 'Export'));
  exp.title = `Export · ${MODK} E`;
  exp.onclick = () => ctx.on.exportSheet();

  const help = iconBtn('help', 'Keys · ?', () => ctx.on.help());
  const theme = iconBtn('theme', 'Theme · T', () => ctx.on.theme());
  bar.append(chip, undo, redo, el('div', 'vr'), tabs, el('div', 'sp'), pill, folder, exp, help, theme);
  host.appendChild(bar);

  function iconBtn(name, title, fn) {
    const b = el('button', 'btn icon ghost');
    b.type = 'button';
    b.appendChild(icon(name));
    b.title = title;
    b.setAttribute('aria-label', title.split(' · ')[0]);
    b.onclick = fn;
    return b;
  }

  function robotMenu() {
    return [
      { label: 'Open robot…', run: () => ctx.on.home() },
      { sep: true },
      { label: 'Save design', key: MODK + ' S', run: () => ctx.on.saveDesign() },
      { label: 'Open design…', key: MODK + ' O', run: () => ctx.on.openDesign() },
      { label: 'Save robot package', run: () => ctx.on.savePackage() },
      { sep: true },
      { label: 'Reset to defaults', run: () => ctx.on.resetDefaults() },
      { label: 'Package info', run: () => ctx.on.packageInfo() },
    ];
  }

  let tab = 'design';
  function setTab(id) {
    tab = id;
    for (const [k, b] of tabBtns) {
      b.classList.toggle('on', k === id);
      b.setAttribute('aria-selected', String(k === id));
    }
  }

  function render() {
    const st = ctx.store.getState();
    const dirty = Object.keys(st.slots || {}).length > 0 || Object.keys(st.params || {}).length > 0;
    chipDot.className = 'dot' + (dirty ? ' acc' : '');
    chipName.textContent = ctx.model.name;
    chip.title = ctx.model.id;
    undo.disabled = !ctx.store.canUndo();
    redo.disabled = !ctx.store.canRedo();
    const h = ctx.store.history();
    undo.title = h.past.length ? `Undo · ${MODK}Z · ${h.past[h.past.length - 1]}` : `Undo · ${MODK}Z`;
    redo.title = h.future.length ? `Redo · ⇧${MODK}Z · ${h.future[h.future.length - 1]}` : `Redo · ⇧${MODK}Z`;
    const c = ctx.checks ? ctx.checks() : null;
    const level = c ? c.level : 'unknown';
    pill.dataset.level = level;
    pillDot.className = 'dot ' + DOT[level];
    pillText.textContent = !c ? 'Checks'
      : level === 'fail' ? `${c.counts.fail} fail` : level === 'warn' ? `${c.counts.warn} warn`
        : level === 'pass' ? 'Checks ok' : 'Checks';
    pill.title = c && c.reason ? c.reason : level === 'pass' ? 'every check passes' : 'not checked yet';
    theme.title = themeTitle(ctx.store.get('ui.theme', 'auto'));
  }

  setTab(tab);
  render();
  return { render, setTab, get tab() { return tab; }, el: bar, folder, pill, destroy() { host.innerHTML = ''; } };
}
