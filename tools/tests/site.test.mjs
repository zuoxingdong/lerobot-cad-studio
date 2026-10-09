/* site/ as GitHub Pages serves it (run after `npm run build`): every URL the pages load exists under
   site/, nothing points outside it, every lazy URL carries the file's current hash, the link-preview
   meta is absolute, the third-party licences ship, README.md is the one doc and every relative
   Markdown link resolves. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, SITE } from './_root.mjs';
import { VENDOR_SCRIPT } from '../../src/features/sim-engine.js';
import { LAB_SCRIPT } from '../../src/features/sim-scene.js';
import { BAKED_SCRIPT } from '../../src/ui/sim-look.js';
import { DIR, BASIS, isBaked } from '../../src/ui/baked-lab.js';

const PAGES = ['index.html', 'showcase.html', '404.html'];
const has = (rel) => fs.existsSync(path.join(SITE, rel));
const read = (rel) => fs.readFileSync(path.join(SITE, rel), 'utf8');
const sha16 = (rel) => createHash('sha256').update(fs.readFileSync(path.join(SITE, rel))).digest('hex').slice(0, 16);
const [, OWNER, REPO] = /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).repository.url);
const PAGES_URL = `https://${OWNER.toLowerCase()}.github.io/${REPO}/`;
const M = JSON.parse(fs.readFileSync(path.join(SITE, DIR, 'manifest.json'), 'utf8'));

const SKIP = new Set(['out', '_cache', '__pycache__', '.pytest_cache', '.ruff_cache']);
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p, out); } else out.push(p);
  }
  return out;
}

test('the pages, the favicon and the scripts they inject exist', () => {
  for (const rel of [...PAGES, 'favicon.svg', VENDOR_SCRIPT, LAB_SCRIPT, ...(isBaked(M) ? [BAKED_SCRIPT] : [])]) assert.ok(has(rel), 'site/' + rel);
});

test('each page bundles the current hash of every file it loads lazily (cache-busting)', () => {
  const basis = (M.lightmaps || []).length ? ['basis_transcoder.js', 'basis_transcoder.wasm'].map((n) => BASIS + n) : [];
  for (const [page, rels] of [['index.html', [VENDOR_SCRIPT, LAB_SCRIPT, ...(isBaked(M) ? [BAKED_SCRIPT] : [])]],
    ['showcase.html', basis], ...(isBaked(M) ? [[BAKED_SCRIPT, basis]] : [])]) {
    const text = read(page);
    for (const rel of rels) assert.ok(text.includes(`"${rel}":"${sha16(rel)}"`), `${page}: no current ?v= for ${rel}`);
  }
  for (const f of M.files) assert.equal(f.sha256, sha16(DIR + f.name), 'manifest sha256 of ' + f.name);
});

test('the pages declare a language, a favicon, a description and absolute link-preview URLs', () => {
  for (const [p, url] of [['index.html', PAGES_URL], ['showcase.html', PAGES_URL + 'showcase.html']]) {
    const html = read(p), meta = (k) => (new RegExp(`<meta (?:name|property)="${k}" content="([^"]+)"`).exec(html) || [])[1];
    assert.match(html, /^<!doctype html>\n<html lang="en">/, p);
    assert.match(html, /<link rel="icon" href="favicon\.svg"/, p);
    assert.ok(meta('description') && meta('og:title') && meta('og:description'), p);
    assert.equal(meta('og:url'), url, p);
    assert.equal(meta('og:image'), PAGES_URL + 'media/hero-poster.jpg', p);
    assert.ok(has('media/hero-poster.jpg'));
    assert.equal(meta('twitter:card'), 'summary_large_image', p);
  }
});

test('every baked file and its file:// wrapper exist, and the KTX2 transcoder', () => {
  for (const f of M.files) for (const rel of [DIR + f.name, DIR + f.name + '.js']) assert.ok(has(rel), 'site/' + rel);
  if ((M.lightmaps || []).length) {
    for (const n of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
      for (const rel of [BASIS + n, BASIS + n + '.js']) assert.ok(has(rel), 'site/' + rel);
    }
  }
});

test('the pages name no URL outside site/', () => {
  for (const p of PAGES) {
    const html = fs.readFileSync(path.join(SITE, p), 'utf8');
    assert.ok(!/assets\/(vendor|scenes\/lab\/web)\//.test(html), p + ' loads from the old assets/ layout');
    for (const [, url] of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
      assert.ok(!url.startsWith('/') && !url.startsWith('../'), `${p}: ${url}`);
    }
  }
});

test('site/ holds no symlink, no dotfile, and fits the Pages artifact', () => {
  let bytes = 0;
  for (const f of walk(SITE)) {
    assert.ok(!fs.lstatSync(f).isSymbolicLink(), f);
    assert.ok(!path.relative(SITE, f).split(path.sep).some((s) => s.startsWith('.')), f);
    bytes += fs.statSync(f).size;
  }
  assert.ok(bytes < 50e6, `${(bytes / 1e6).toFixed(1)} MB`);
});

test('site/THIRD_PARTY_LICENSES.txt names every bundled package and three addon lib', () => {
  assert.ok(has('THIRD_PARTY_LICENSES.txt'), 'npm run build writes it');
  const text = read('THIRD_PARTY_LICENSES.txt');
  const deps = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies;
  for (const name of Object.keys(deps)) {
    const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8'));
    assert.ok(text.includes(`\n${name} ${version}  (`), name);
  }
  for (const lib of ['meshopt decoder', 'ktx-parse', 'zstddec', 'Basis Universal']) assert.ok(text.includes('\n' + lib), lib);
  assert.match(text, /Permission is hereby granted/);
  assert.match(text, /TERMS AND CONDITIONS FOR USE/);
});

/* GitHub's heading anchors: lower case, punctuation dropped, spaces to dashes */
const slug = (h) => h.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
const anchors = (md) => new Set(md.replace(/```[\s\S]*?```/g, '').split('\n')
  .filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#+ /, ''))));

/* every Markdown file the repo publishes: README.md, licences, provenance and the part notes */
const MD_SKIP = new Set([...SKIP, 'node_modules', '.venv', 'fixtures', 'vendor']);
function markdown(dir = ROOT, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!MD_SKIP.has(e.name)) markdown(p, out); } else if (/\.md$/.test(e.name)) out.push(p);
  }
  return out;
}

test('README.md is the one doc: no docs/ folder, no README below the root', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'docs')), 'docs/');
  const extra = markdown().map((f) => path.relative(ROOT, f)).filter((f) => /(^|\/)README[^/]*\.md$/i.test(f) && f !== 'README.md');
  assert.deepEqual(extra, []);
});

test('every relative link in the docs resolves', () => {
  const docs = markdown();
  let n = 0;
  for (const doc of docs) {
    const md = fs.readFileSync(doc, 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const [, target] of md.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue;
      const [file, hash] = target.split('#');
      const abs = file ? path.resolve(path.dirname(doc), file) : doc;
      const where = `${path.relative(ROOT, doc)} -> ${target}`;
      assert.ok(fs.existsSync(abs), where);
      assert.ok(path.relative(ROOT, abs).split(path.sep)[0] !== '..', where + ' leaves the repo');
      if (hash && abs.endsWith('.md')) assert.ok(anchors(fs.readFileSync(abs, 'utf8')).has(hash), where);
      n++;
    }
  }
  assert.ok(n > 5, `${n} links`);
});
