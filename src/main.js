/* Boot: the router, the store and the theme.  `#/` is Home; `#/design|check|sim/<robotId>` are
   the three tabs over one mounted Design page.  State that survives a reload comes from
   store.restoreSession() and the recent designs in IndexedDB; `?debug=1` publishes
   `window.__rps` through ui/debug-hooks.js. */

import { createStore, defaultDesign } from './core/store.js';
import * as pkg from './core/package.js';
import * as ASSETS from './data/assets.js';
import { mountSprite } from './ui/icons.js';
import { mountHome, DEFAULT_ROBOT } from './ui/home.js';
import { mountDesign, effectiveTheme, nextTheme } from './ui/design-page.js';
import { openHelpDialog } from './ui/dialogs.js';
import { installDebug } from './ui/debug-hooks.js';
import { mountSim } from './ui/sim-page.js';
import { mountCheck } from './ui/check-page.js';

const params = new URLSearchParams(location.search);
const DEBUG = params.get('debug') === '1';
const { isRobot, robotIds } = ASSETS;
pkg.setRobotSource(ASSETS);
const ERRORS = [];
const ERROR_CAP = 200;                 // a loop in a render hook must not grow this for ever
function noteError(msg) {
  ERRORS.push(String(msg));
  if (ERRORS.length > ERROR_CAP) ERRORS.splice(0, ERRORS.length - ERROR_CAP);
}
addEventListener('error', (e) => noteError((e && e.message) || e));
addEventListener('unhandledrejection', (e) => noteError('promise: ' + String(e.reason)));

const root = document.getElementById('app') || (() => {
  const d = document.createElement('div');
  d.id = 'app';
  document.body.appendChild(d);
  return d;
})();

mountSprite(document.body);

/* the store */
const store = createStore(defaultDesign(null));
store.restoreSession();
applyTheme(store.get('ui.theme', 'auto'));

/* Home's half of the theme.  ui/design-chrome.js has the design page's, which also retints
   the viewport, the gizmo and the frustums; neither page is mounted when the other runs. */
function applyTheme(name) {
  if (name === 'light' || name === 'dark') document.documentElement.setAttribute('data-theme', name);
  else document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.colorScheme = effectiveTheme(name);
}
function cycleTheme(to) {
  const cur = store.get('ui.theme', 'auto');
  const next = to && to !== 'cycle' ? to : nextTheme(cur);
  store.set('ui.theme', next);
  /* the design page repaints the 3D half itself, off the same store key */
  applyTheme(next);
  return next;
}

/* the router */
let page = null;
let currentRoute = null;
let model = null;
let booting = null;
/* `mountDesignPage` awaits the package load, so a home -> design -> home inside that window
   can paint the resumed design page over Home.  Every await below checks the generation it
   started in. */
let routeGen = 0;

function parseHash() {
  const h = (location.hash || '#/').replace(/^#/, '');
  const m = h.match(/^\/(design|check|sim)\/([^/?]+)/);
  if (m) return { name: m[1], robot: decodeURIComponent(m[2]) };
  return { name: 'home' };
}

/* A link or saved design for an attachment package (not a robot of its own) opens the
   default robot, with a one-line notice. */
let notice = null;
function redirectRetired(r) {
  if (!r.robot || isRobot(r.robot) || !ASSETS.ROBOTS[r.robot]) return r;
  notice = `${ASSETS.manifest(r.robot).name} is an attachment, not a robot; opened ${ASSETS.manifest(DEFAULT_ROBOT).name}`;
  history.replaceState(null, '', `#/${r.name}/${encodeURIComponent(DEFAULT_ROBOT)}`);
  return { ...r, robot: DEFAULT_ROBOT };
}
function flushNotice() {
  if (notice && page && page.setStatus) page.setStatus(notice, 'warn');
  notice = null;
}

async function route() {
  const r = redirectRetired(parseHash());
  const key = r.name + ':' + (r.robot || '');
  if (key === currentRoute) { flushNotice(); return; }
  /* tab switches of the mounted robot keep the page */
  if (r.robot && page && pageRobot === r.robot) { currentRoute = key; store.set('ui.page', r.name); setView(r.name); flushNotice(); return; }
  setView('design');
  /* whatever the design page still owes the recents list, it pays before it goes */
  if (recentTimer) writeRecent();
  currentRoute = key;
  const gen = ++routeGen;
  if (page && page.destroy) { page.destroy(); page = null; pageRobot = null; }
  store.set('ui.page', r.name);
  if (r.name === 'home') { mountHomePage(); return; }
  await mountDesignPage(r.robot, gen);
  if (gen === routeGen) setView(r.name);
}

let sim = null, check = null, pageRobot = null;
/** one of 'design' | 'check' | 'sim' over the mounted page */
function setView(name) {
  const ok = page && page.viewport;
  if (name !== 'sim' && sim) { sim.destroy(); sim = null; }
  if (name !== 'check' && check) { check.destroy(); check = null; }
  if (name === 'sim' && ok && !sim) {
    if (page.simAvailable && !page.simAvailable()) { location.hash = '#/design/' + encodeURIComponent(pageRobot); return; }
    sim = mountSim(page, { store, model });
  }
  if (name === 'check' && ok && !check) check = mountCheck(page);
  if (page && page.topbar) page.topbar.setTab(sim ? 'sim' : check ? 'check' : 'design');
}

function mountHomePage() {
  document.title = 'LeRobot CAD Studio';
  page = mountHome(root, {
    store,
    setTheme: cycleTheme,
    onOpen: (robotId, design) => {
      pendingDesign = design || null;
      location.hash = '#/design/' + encodeURIComponent(robotId);
    },
    onImportedModel: (res) => {
      /* a part folder is not a robot: open the robot its part.json names (or the one
         declaring its slot) and hand the folders to that page's intake */
      if (res && res.kind === 'parts') {
        pendingImport = res;
        pendingDesign = null;
        partTarget(res).then((rid) => { location.hash = '#/design/' + encodeURIComponent(rid); });
        return;
      }
      if (!res || !res.model) return;
      importedModel = res.model;
      pendingDesign = null;
      location.hash = '#/design/' + encodeURIComponent(res.model.id || 'imported');
    }
  });
}

/** the robot a part folder is for: part.json `robot`, else the package declaring its `slot` */
async function partTarget(res) {
  let doc = {};
  const f = res.folders[0];
  const j = f && (f.files.get('part.json') || f.files.get('meta.json'));
  try { doc = JSON.parse(await j.text()) || {}; } catch (e) { doc = {}; }
  return isRobot(doc.robot) ? doc.robot : robotForAlternative(doc);
}

/** the package an alternative belongs to: the one declaring its slot, else the first shipped */
function robotForAlternative(alt) {
  const ids = robotIds();
  const slot = alt && alt.slot;
  const declares = (id) => {
    const seen = new Set();
    const walk = (rid) => {
      if (!ASSETS.ROBOTS[rid] || seen.has(rid)) return false;
      seen.add(rid);
      const m = pkg.embeddedManifest(rid) || {};
      if ((m.slots || {})[slot]) return true;
      return (m.attachments || []).some((a) => walk(a.package));
    };
    return walk(id);
  };
  if (slot) { const hit = ids.find(declares); if (hit) return hit; }
  return ids.includes(DEFAULT_ROBOT) ? DEFAULT_ROBOT : ids[0];
}

let pendingDesign = null;
let pendingImport = null;
let importedModel = null;

async function mountDesignPage(robotId, gen = routeGen) {
  document.title = 'LeRobot CAD Studio — ' + robotId;
  root.innerHTML = '';
  const wait = document.createElement('div');
  wait.className = 'status';
  wait.textContent = `loading ${robotId} …`;
  root.appendChild(wait);
  try {
    if (importedModel && (importedModel.id === robotId || robotId === 'imported')) {
      model = importedModel;
      importedModel = null;
    } else if (isRobot(robotId)) {
      const loaded = await pkg.loadEmbedded(robotId);
      if (gen !== routeGen) return;                 // the user left while it loaded
      model = loaded;
    } else {
      /* an imported robot: its bytes are in no bundle, so they were kept at import time.
         Without this a reload (or a recent-designs row) of `#/design/import-…` bounced
         straight back Home and the import was gone. */
      const res = await pkg.reopenImported(robotId);
      if (gen !== routeGen) return;
      /* the bytes are gone (only the last few imports are kept, and site data can be cleared):
         say so rather than bouncing Home with no message at all */
      if (!res || !res.model) { showDeadImport(robotId); return; }
      model = res.model;
    }
  } catch (e) {
    if (gen !== routeGen) return;
    root.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'status';
    err.textContent = 'could not load ' + robotId + ' · ' + (e && e.message);
    root.appendChild(err);
    noteError(e);
    return;
  }

  /* a design from the recent list, else whatever the session held for this robot */
  const session = store.getState();
  const base = pendingDesign || (session.robot === model.id ? session : null);
  store.reset({ ...defaultDesign(model.id), ...(base || {}), robot: model.id });
  pendingDesign = null;
  applyTheme(store.get('ui.theme', 'auto'));

  root.innerHTML = '';
  page = mountDesign(root, { store, model, onHome: () => { location.hash = '#/'; } });
  pageRobot = robotId;
  flushNotice();
  saveRecent();
  publishDebug();
  /* an import Home could not open on its own (an alternative) is fitted here, on the robot
     it belongs to, through the same path the design page's own import dialog uses */
  if (pendingImport) {
    const res = pendingImport;
    pendingImport = null;
    try { Promise.resolve(page.ctx.on.importLoose(res)).catch((e) => noteError(e)); }
    catch (e) { noteError(e); }
  }
}

/** an imported route whose stored package is gone: the reason, plus a way back */
function showDeadImport(robotId) {
  root.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'status';
  box.textContent = `${robotId} was imported and its files are no longer stored — import it again · `;
  const back = document.createElement('a');
  back.href = '#/';
  back.textContent = 'robot list';
  box.appendChild(back);
  root.appendChild(box);
  noteError('reopen: no stored package for ' + robotId);
}

let recentTimer = null;
/* The autosave entry of Home's recent list.  The entry owns its LABEL — keep whatever it
   already has and fall back to the package name, or the next autosave overwrites a rename
   1.5 s later (and `design.saved` is a timestamp, not a name). */
function saveRecent() {
  clearTimeout(recentTimer);
  recentTimer = setTimeout(writeRecent, 1500);
}
/* A DEBOUNCED WRITE MUST NOT OUTLIVE THE PAGE.  Landing 1.5 s after the user went Home put
   the row back on a list they may have just deleted it from (or another tab had); leaving
   the design page flushes it instead, so nothing is lost and nothing is resurrected. */
async function writeRecent() {
  clearTimeout(recentTimer);
  recentTimer = null;
  if (!model) return;
  const id = 'auto/' + model.id;
  try {
    const was = (await pkg.listRecent()).find((r) => r.id === id);
    await pkg.saveRecent({
      id, robot: model.id,
      label: (was && was.label) || model.name,
      design: store.getState(), saved: Date.now()
    });
  } catch (e) { /* IndexedDB blocked */ }
}
store.subscribe(() => { if (currentRoute && !currentRoute.startsWith('home')) saveRecent(); });

/* `model` and `page` are getters: the debug object outlives the page it was installed for. */
const DEBUG_ENV = {
  store, errors: ERRORS,
  get model() { return model; },
  get page() { return page; },
  route: () => currentRoute,
  go: (hash) => { location.hash = hash; return route(); },
};
function publishDebug() { if (DEBUG) installDebug(DEBUG_ENV); }

/* start */
/* the boot route is a promise too: a hashchange while it runs must queue, not race */
window.addEventListener('hashchange', () => { booting = Promise.resolve(booting).catch(() => {}).then(route); });
if (!location.hash) location.hash = '#/';
booting = route();
if (DEBUG) {
  window.__rps = window.__rps || { errors: ERRORS, route: () => currentRoute, booting };
  window.__rpsHelp = () => openHelpDialog();
}
