// Bundle src/ into site/index.html, one self-contained page, and the rest of site/ (the Pages root).
//
//   npm run build                        # site/index.html, site/showcase.html, site/vendor/, site/lab/*.js
//   node tools/build/build.mjs --dev     # readable bundle (no minify), for debugging
//   node tools/build/build.mjs --check   # build, then fail if any budget is exceeded
//
// esbuild bundles src/main.js and src/ui/styles.css into site/index.html (tools/build/templates/index.html
// is the template).  Nothing is fetched at runtime but the Google Fonts stylesheet; the page must
// work from file://.  site/vendor/mujoco-wasm.js is written beside it: the Sim tab injects it on
// first use; site/vendor/lab-scene.js (the lab decor: decor.json + props/*.obj) likewise, and
// site/vendor/baked-lab.js (the baked lab's loader and the Sim's baked room) once a bake exists.
// Every lazily loaded file is requested as `<path>?v=<content hash>` (__RPS_V__, src/core/asset-version.js;
// the lab files take their manifest sha256), so a redeploy never mixes old and new files.
// Only site/lab/ (the bake, frozen) and site/media/ are committed; everything else in site/ is written here.
import { build, transform } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(HERE));   // HERE is tools/build
const SITE = join(ROOT, 'site'), LAB = join(SITE, 'lab'), VENDOR = join(SITE, 'vendor');
const DEV = process.argv.includes('--dev');
const CHECK = process.argv.includes('--check');

// size budgets: code, robot geometry, the whole page
const BUDGET = { js: 1.6e6, data: 4e6, html: 8e6, vendor: 4e6, lab: 1.5e6, baked: 0.5e6 };

const sha16 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);
/** the Pages URL, https://<owner>.github.io/<repo>/, from package.json (serve.mjs derives the path the same way) */
const PKG = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const [, OWNER, REPO] = /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(PKG.repository.url);
const PAGES_URL = `https://${OWNER.toLowerCase()}.github.io/${REPO}/`;
const BASIS_SRC = join(ROOT, 'node_modules/three/examples/jsm/libs/basis');
/** {site path: sha16} for every lazily loaded file outside site/lab/ (filled in as they are written) */
const VER = {};
const version = async (rel) => { VER[rel] = sha16(await readFile(join(SITE, rel))); };
const define = () => ({ __RPS_V__: JSON.stringify(VER) });
const kb = (n) => (n / 1024).toFixed(0).padStart(7) + ' kB';

async function bundle() {
  const js = await build({
    entryPoints: [join(ROOT, 'src/main.js')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome111', 'firefox115', 'safari16'],
    minify: !DEV,
    legalComments: 'none',
    write: false,
    metafile: true,
    logLevel: 'warning',
    // three/addons/* is how the sources spell the three.js examples; map it onto the package
    alias: { 'three/addons': 'three/examples/jsm' },
    define: { 'process.env.NODE_ENV': '"production"', ...define() },
  });
  const css = await build({
    entryPoints: [join(ROOT, 'src/ui/styles.css')],
    bundle: true,
    minify: !DEV,
    write: false,
    logLevel: 'warning',
    loader: { '.woff2': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl' },
  });
  // the 1.6 MB JS cap is about CODE and the robot geometry has its own 4 MB cap, so the
  // metafile is used to separate them rather than conflating the two
  let dataInBundle = 0;
  for (const out of Object.values(js.metafile.outputs)) {
    for (const [file, rec] of Object.entries(out.inputs || {})) {
      if (file.includes('src/data/packed.js')) dataInBundle += rec.bytesInOutput || 0;
    }
  }
  return { js: js.outputFiles[0].text, css: css.outputFiles[0].text, dataInBundle };
}

function inline(tpl, css, js, banner) {
  // the markers sit inside comments so the templates stay valid on their own; the
  // charset comes first, so a server that sends none still decodes the captions as UTF-8
  return '<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n' + tpl.replace(/^<!--[\s\S]*?-->\s*/, banner)
            .replaceAll('__PAGES_URL__', PAGES_URL)
            .replace('/*__CSS__*/', () => css.trim())
            .replace('/*__JS__*/', () => js.trim());
}

/* A classic script (no module, no fetch, no COOP/COEP): the ESM glue minus its export, with
   import.meta.url pointing at the page, plus the WASM as base64 of gzip -9. */
async function vendorMujoco() {
  const dir = join(ROOT, 'node_modules/@mujoco/mujoco');
  const { version, license } = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  const glue = (await readFile(join(dir, 'mujoco.js'), 'utf8'))
    .replace(/^export default loadMujoco;\s*$/m, '')
    .replaceAll('import.meta.url', "(self.location && self.location.href || '')");
  if (glue.includes('import.meta') || /^export /m.test(glue)) throw new Error('vendor: the mujoco glue changed shape');
  const wrapped = `(function(){${glue}\nglobalThis.RPS_MUJOCO={version:${JSON.stringify(version)},load:loadMujoco,wasm:"__RPS_WASM__"};})();`;
  const { code } = await transform(wrapped, { minify: !DEV, legalComments: 'none', target: 'es2022' });
  const wasm = gzipSync(await readFile(join(dir, 'mujoco.wasm')), { level: 9 }).toString('base64');
  const out = `/* @mujoco/mujoco ${version} (${license}, Google DeepMind): the single-thread WASM build (gzip, base64) and its glue.\n`
    + '   Generated by tools/build/build.mjs from node_modules; do not edit. */\n' + code.replace('__RPS_WASM__', () => wasm);
  const file = join(VENDOR, 'mujoco-wasm.js');
  let old = null;
  try { old = await readFile(file, 'utf8'); } catch { /* first build */ }
  if (old !== out) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, out); }
  return Buffer.byteLength(out);
}

async function writeIfChanged(file, out) {
  let old = null;
  try { old = await readFile(file, 'utf8'); } catch { /* first build */ }
  if (old !== out) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, out); }
  return Buffer.byteLength(out);
}

/* The lab decor as a classic script: decor.json, every props/*.obj as one gzip blob of per-mesh
   [float32 xyz | int8 normals, padded to 4 | uint32 indices], and the code that draws it
   (sim-scene-decor.js decorXml/meshFiles, ui/sim-room.js createRoom), so none of it is in index.html. */
async function vendorLab() {
  const dir = join(ROOT, 'assets/scenes/lab');
  const { parseObj } = await import('../../src/features/sim-scene-decor.js');
  const decor = JSON.parse(await readFile(join(dir, 'decor.json'), 'utf8'));
  const files = (await readdir(join(dir, 'props'))).filter((f) => f.endsWith('.obj')).sort();
  const parts = [], meshes = {};
  let off = 0;
  for (const f of files) {
    const g = parseObj(await readFile(join(dir, 'props', f), 'utf8'));
    const nv = g.position.length / 3, pad = ((3 * nv + 3) & ~3) - 3 * nv;
    const buf = Buffer.alloc(12 * nv + 3 * nv + pad + 4 * g.index.length);
    Buffer.from(g.position.buffer).copy(buf, 0);
    Buffer.from(g.normal.buffer).copy(buf, 12 * nv);
    Buffer.from(g.index.buffer).copy(buf, 15 * nv + pad);
    meshes[f.slice(0, -4)] = [off, nv, g.index.length];
    parts.push(buf);
    off += buf.length;
  }
  const lib = await build({
    stdin: { contents: "export { decorXml, meshFiles, labAnim, idleSnapshot } from './src/features/sim-scene-decor.js';\n"
      + "export { createRoom } from './src/ui/sim-room.js';\n", resolveDir: ROOT, loader: 'js' },
    bundle: true, format: 'iife', globalName: 'RPS_LAB_LIB', target: 'es2022', minify: !DEV,
    legalComments: 'none', write: false, logLevel: 'warning',
  });
  const bin = gzipSync(Buffer.concat(parts), { level: 9 }).toString('base64');
  const out = '/* The lab scene decor: assets/scenes/lab/decor.json, props/*.obj and the code that draws them.\n'
    + '   Generated by tools/build/build.mjs; do not edit. */\n' + lib.outputFiles[0].text.trim() + '\n'
    + `globalThis.RPS_LAB_SCENE={...${JSON.stringify({ decor, meshes, bin })},lib:RPS_LAB_LIB};\n`;
  return writeIfChanged(join(VENDOR, 'lab-scene.js'), out);
}

/* The Sim tab's baked lab as a classic script: ui/sim-baked.js with ui/baked-lab.js and three's
   GLTF/KTX2/RGBE loaders, taking three from the page (globalThis.RPS_THREE = ui/three-vendor.js), so
   there is one three; plus the manifest of site/lab/.  Fails when three-vendor.js lacks
   a name the bundle imports.  Not written (and removed) while the manifest has no bake. */
const THREE_NS = /import\s*\*\s*as\s*([\w$]+)\s*from\s*"three"/g, THREE_NAMED = /import\s*\{([^}]*)\}\s*from\s*"three"/g;
async function vendorBaked() {
  const file = join(VENDOR, 'baked-lab.js');
  let man = null;
  try { man = JSON.parse(await readFile(join(LAB, 'manifest.json'), 'utf8')); } catch { /* no bake */ }
  if (!man || !(man.lightmaps || []).length || !man.probe) {
    try { await rm(file); } catch { /* none */ }
    return 0;
  }
  const stdin = { contents: "export { buildBakedRoom } from './src/ui/sim-baked.js';\nexport { isBaked } from './src/ui/baked-lab.js';\n",
    resolveDir: ROOT, loader: 'js' };
  const opts = { stdin, bundle: true, target: 'es2022', legalComments: 'none', write: false, logLevel: 'warning',
    alias: { 'three/addons': 'three/examples/jsm' } };
  const esm = await build({ ...opts, format: 'esm', plugins: [{ name: 'three-out', setup(b) {
    b.onResolve({ filter: /^three$/ }, () => ({ path: 'three', external: true }));
  } }] });
  const code = esm.outputFiles[0].text, need = new Set();
  for (const [, list] of code.matchAll(THREE_NAMED)) for (const x of list.split(',')) if (x.trim()) need.add(x.trim().split(/\s+as\s+/)[0]);
  for (const [, ns] of code.matchAll(THREE_NS)) for (const [, k] of code.matchAll(new RegExp(`(?<![\\w$.])${ns.replace('$', '\\$')}\\.([A-Za-z_$][\\w$]*)`, 'g'))) need.add(k);
  const vendor = await readFile(join(ROOT, 'src/ui/three-vendor.js'), 'utf8');
  const have = new Set((/import\s*\{([^}]*)\}\s*from\s*'three'/.exec(vendor) || [, ''])[1].split(',').map((x) => x.trim()).filter(Boolean));
  const three = new Set(Object.keys(await import('three')));   // messages spell 'THREE.GLTFLoader: …'
  const missing = [...need].filter((k) => three.has(k) && !have.has(k)).sort();
  if (missing.length) throw new Error('src/ui/three-vendor.js lacks what site/vendor/baked-lab.js imports from three: ' + missing.join(', '));
  const lib = await build({ ...opts, format: 'iife', globalName: 'RPS_BAKED_LIB', minify: !DEV, define: define(), plugins: [{ name: 'three-page', setup(b) {
    b.onResolve({ filter: /^three$/ }, () => ({ path: 'three', namespace: 'rps-three' }));
    b.onLoad({ filter: /.*/, namespace: 'rps-three' }, () => ({ contents: 'module.exports = globalThis.RPS_THREE;', loader: 'js' }));
  } }] });
  const out = '/* The baked lab for the Sim tab: ui/sim-baked.js, ui/baked-lab.js, three\'s loaders and the manifest of\n'
    + '   site/lab/.  Generated by tools/build/build.mjs; do not edit. */\n' + lib.outputFiles[0].text.trim() + '\n'
    + `globalThis.RPS_BAKED={manifest:${JSON.stringify(man)},lib:RPS_BAKED_LIB};\n`;
  return writeIfChanged(file, out);
}

/* site/showcase.html: the showcase bundle (an IIFE: file:// has no modules) and the manifest of
   site/lab/ inlined; each asset gets a classic-script wrapper `<file>.js` for file://.  site/lab/ is
   committed output that nothing here rebuilds; a file that differs from its manifest entry fails the build.
   The KTX2 transcoder is copied into site/vendor/basis/ only when the manifest has lightmaps. */
const SHOWCASE = { first: 1.5e6, total: 18e6 };
// per role (bytes); `deployed` is site/lab/ and site/vendor/basis/ on disk with their .js wrappers
const ROLE_CAP = { lab: 1.5e6, lightmap: 12e6, probe: 0.8e6, run: 2e6, deployed: 18e6 };
const wrap = (name, buf) => `(window.__rpsLab=window.__rpsLab||{})[${JSON.stringify(name)}]="${buf.toString('base64')}";\n`;

async function showcase() {
  let man;
  try { man = JSON.parse(await readFile(join(LAB, 'manifest.json'), 'utf8')); } catch { return null; }
  let files = 0;
  for (const f of man.files) {
    const buf = await readFile(join(LAB, f.name));
    if (buf.length !== f.bytes || (f.sha256 && sha16(buf) !== f.sha256)) {
      throw new Error(`showcase: ${f.name} does not match manifest.json (${buf.length} B, the manifest says ${f.bytes} B, sha256 ${f.sha256}); site/lab/ is frozen: check the committed file out again`);
    }
    files += buf.length;
    await writeIfChanged(join(LAB, f.name + '.js'), wrap(f.name, buf));
  }
  if ((man.lightmaps || []).length) {
    for (const n of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
      const buf = await readFile(join(BASIS_SRC, n));
      files += buf.length;
      await mkdir(join(VENDOR, 'basis'), { recursive: true });
      await writeFile(join(VENDOR, 'basis', n), buf);
      await writeIfChanged(join(VENDOR, 'basis', n + '.js'), wrap(n, buf));
    }
  }
  man.budget = { files, first_cap: SHOWCASE.first, total_cap: SHOWCASE.total };
  // the room's walls (mm), which bound the free camera
  man.room = JSON.parse(await readFile(join(ROOT, 'assets/scenes/lab/scene.json'), 'utf8')).room;
  const js = await build({
    entryPoints: [join(ROOT, 'src/ui/showcase-page.js')], bundle: true, format: 'iife', platform: 'browser',
    target: ['chrome111', 'firefox115', 'safari16.4'], minify: !DEV, legalComments: 'none', write: false,
    logLevel: 'warning', alias: { 'three/addons': 'three/examples/jsm' }, define: define(),
  });
  const css = await build({ entryPoints: [join(ROOT, 'src/ui/showcase.css')], bundle: true, minify: !DEV, write: false, logLevel: 'warning' });
  const tpl = await readFile(join(HERE, 'templates', 'showcase.html'), 'utf8');
  const banner = '<!-- LeRobot CAD Studio photoreal showcase - generated by tools/build/build.mjs from src/ui/showcase-*.js\n'
    + '     and site/lab/manifest.json. Do not edit this file; rebuild it. -->\n';
  const html = inline(tpl, css.outputFiles[0].text, js.outputFiles[0].text, banner)
    .replace('/*__MANIFEST__*/', () => 'window.__RPS_SHOWCASE=' + JSON.stringify(man) + ';');
  await writeFile(join(SITE, 'showcase.html'), html);
  const first = gzipSync(html, { level: 9 }).length;
  return { html: Buffer.byteLength(html), first, files, total: first + files,
    roles: await roleSizes(man) };
}

/** bytes per manifest role, and the deployed lab dir (+ the basis transcoder) with the wrappers */
async function roleSizes(man) {
  const out = {};
  for (const f of man.files) out[f.role] = (out[f.role] || 0) + f.bytes;
  let disk = 0;
  for (const dir of [LAB, join(VENDOR, 'basis')]) {
    let names = [];
    try { names = await readdir(dir); } catch { continue; }
    for (const n of names) disk += (await stat(join(dir, n))).size;
  }
  out.deployed = disk;
  return out;
}

/* the favicon and the page Pages serves for a missing path */
async function extras() {
  await writeIfChanged(join(SITE, 'favicon.svg'), await readFile(join(HERE, 'templates', 'favicon.svg'), 'utf8'));
  const banner = '<!-- LeRobot CAD Studio - generated by tools/build/build.mjs. Do not edit this file; rebuild it. -->\n';
  await writeIfChanged(join(SITE, '404.html'), inline(await readFile(join(HERE, 'templates', '404.html'), 'utf8'), '', '', banner));
}

/* site/THIRD_PARTY_LICENSES.txt: the bundles drop legal comments, so the licence of every bundled
   package (the package.json dependencies) and of the three addon libs they pull in ships beside them. */
const ADDON_LIBS = [
  ['meshopt decoder (via three addons)', 'MIT', 'Copyright (c) 2016-2022 Arseny Kapoulkine'],
  ['ktx-parse (via three addons)', 'MIT', 'Copyright (c) Don McCurdy'],
  ['zstddec (via three addons)', 'MIT', 'Copyright (c) Don McCurdy'],
  ['Basis Universal transcoder (via three addons, site/vendor/basis/)', 'Apache-2.0', 'Copyright (c) Binomial LLC'],
];
// packages that ship no licence file: their copyright line
const NO_FILE = { 'urdf-loader': 'Copyright (c) Garrett Johnson, NASA Jet Propulsion Laboratory', '@mujoco/mujoco': 'Copyright Google DeepMind' };
async function licences() {
  const fileOf = async (dir) => {
    for (const n of ['LICENSE', 'LICENCE', 'LICENSE.md', 'LICENSE.txt']) try { return await readFile(join(dir, n), 'utf8'); } catch { /* next */ }
    return null;
  };
  const mit = (await readFile(join(ROOT, 'node_modules/three/LICENSE'), 'utf8')).replace(/^[\s\S]*?Copyright[^\n]*\n/, '').trim();
  const terms = (spdx, line) => `${line}\n\n` + (spdx === 'MIT' ? mit : 'Licensed under the Apache License 2.0; the full text closes this file.');
  const entries = [];
  for (const name of Object.keys(PKG.dependencies).sort()) {
    const dir = join(ROOT, 'node_modules', name), { version: v, license } = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    const text = await fileOf(dir);
    if (!text && !NO_FILE[name]) throw new Error(`licences: ${name} ships no licence file; add its copyright line to NO_FILE`);
    entries.push([`${name} ${v}`, license, text || terms(license, NO_FILE[name])]);
  }
  for (const [name, spdx, line] of ADDON_LIBS) entries.push([name, spdx, terms(spdx, line)]);
  const rule = '='.repeat(78);
  // terms only: the appendix carries this repo's own copyright line
  const lic = await readFile(join(ROOT, 'LICENSE'), 'utf8');
  const apacheTerms = lic.slice(0, lic.indexOf('END OF TERMS AND CONDITIONS') + 27) + '\n';
  const out = `Third-party code bundled into site/index.html, site/showcase.html and site/vendor/.\n\n`
    + entries.map(([n, spdx, body]) => `${rule}\n${n}  (${spdx})\n${rule}\n\n${body.trim()}\n`).join('\n')
    + `\n${rule}\nApache License 2.0\n${rule}\n\n` + apacheTerms;
  await writeIfChanged(join(SITE, 'THIRD_PARTY_LICENSES.txt'), out);
}

const t0 = Date.now();
await licences();
const vendorBytes = await vendorMujoco();
const labBytes = await vendorLab();
await version('vendor/mujoco-wasm.js');
await version('vendor/lab-scene.js');
for (const n of ['basis_transcoder.js', 'basis_transcoder.wasm']) VER['vendor/basis/' + n] = sha16(await readFile(join(BASIS_SRC, n)));
const bakedBytes = await vendorBaked();
if (bakedBytes) await version('vendor/baked-lab.js');
const { js, css, dataInBundle } = await bundle();
await extras();
const tpl = await readFile(join(HERE, 'templates', 'index.html'), 'utf8');
/* No date in the banner: a rebuild of the same sources is byte-identical. */
const banner = `<!-- LeRobot CAD Studio - generated by tools/build/build.mjs.
     One self-contained page: code, styles, robot geometry and thumbnails are all inline.
     Source: src/** and assets/**. Do not edit this file; rebuild it. -->\n`;
/* templates/index.html is a page FRAGMENT: no doctype, html, head or body of its own.  The
   standalone file is opened from disk, so inline() gives it a doctype, or the browser renders it
   in quirks mode. */
const html = inline(tpl, css, js, banner);
const out = join(SITE, 'index.html');
await mkdir(SITE, { recursive: true });
await writeFile(out, html);

let dataBytes = 0;
try { dataBytes = (await stat(join(ROOT, 'src/data/packed.js'))).size; } catch { /* not packed yet */ }

const jsAll = Buffer.byteLength(js);
const rows = [
  ['JS code', jsAll - dataInBundle, BUDGET.js],
  ['robot data (inlined)', dataInBundle, BUDGET.data],
  ['CSS', Buffer.byteLength(css), null],
  ['JS bundle total', jsAll, null],
  ['packed.js on disk', dataBytes, null],
  ['page HTML', Buffer.byteLength(html), BUDGET.html],
  ['vendor mujoco-wasm', vendorBytes, BUDGET.vendor],
  ['vendor lab-scene', labBytes, BUDGET.lab],
  ['vendor baked-lab', bakedBytes, BUDGET.baked],
];
console.log('lerobot cad studio build  (%s, %d ms)', DEV ? 'dev' : 'minified', Date.now() - t0);
let over = false;
for (const [name, n, cap] of rows) {
  const flag = cap && n > cap ? '  OVER BUDGET' : (cap ? `  (cap ${kb(cap).trim()})` : '');
  if (cap && n > cap) over = true;
  console.log('  %s %s%s', name.padEnd(20), kb(n), flag);
}
console.log('  -> %s', relative(ROOT, out));
const sc = await showcase();
if (!sc) console.log('  showcase: no site/lab/manifest.json, skipped');
else {
  for (const [name, n, cap] of [['showcase first paint', sc.first, SHOWCASE.first], ['showcase assets', sc.files, null],
    ['showcase total', sc.total, SHOWCASE.total]]) {
    if (cap && n > cap) over = true;
    console.log('  %s %s%s', name.padEnd(20), kb(n), cap && n > cap ? '  OVER BUDGET' : (cap ? `  (cap ${kb(cap).trim()}, gz)` : ''));
  }
  for (const [role, n] of Object.entries(sc.roles)) {
    const cap = ROLE_CAP[role];
    if (cap && n > cap) over = true;
    console.log('  %s %s%s', ('  ' + role).padEnd(20), kb(n), cap && n > cap ? '  OVER BUDGET' : (cap ? `  (cap ${kb(cap).trim()})` : ''));
  }
  console.log('  -> site/showcase.html');
}
if (over && CHECK) { console.error('budget exceeded'); process.exit(1); }
