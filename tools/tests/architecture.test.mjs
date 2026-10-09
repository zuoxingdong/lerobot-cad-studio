/* node --test tools/tests/architecture.test.mjs   (run from studio/)
   The src/ layering, asserted on the real static import graph of src/:
   ui -> features -> scene / core, never upward, and no cycles; and the tools reach into src/ only
   through core/, features/ and data/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const TOOLS = path.resolve(SRC, '../tools');

function jsFiles(dir, ext = /\.js$/) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...jsFiles(p, ext));
    else if (ext.test(name)) out.push(p);
  }
  return out;
}

/** every `from '<relative path>'` (and `import('<relative path>')`) of one module, resolved to a src-relative path */
function importsOf(file) {
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Set();
  for (const m of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
    out.add(path.relative(SRC, path.resolve(path.dirname(file), m[1])));
  }
  return [...out];
}

/* `main.js` is the entry point and sits above every layer; `data/` is the packed geometry and its API. */
const RANK = { core: 0, data: 0, scene: 1, features: 2, ui: 3, '.': 4 };
const layerOf = (rel) => (rel.includes(path.sep) ? rel.split(path.sep)[0] : '.');

const FILES = jsFiles(SRC).map((f) => path.relative(SRC, f));
const GRAPH = new Map(FILES.map((rel) => [rel, importsOf(path.join(SRC, rel))]));

test('src/ has modules in every layer (the walk found them)', () => {
  assert.ok(FILES.length > 60, FILES.length + ' modules');
  for (const l of ['core', 'scene', 'features', 'ui']) {
    assert.ok(FILES.some((f) => layerOf(f) === l), l + ' has no module');
  }
});

test('static imports point down only: ui -> features -> scene / core', () => {
  const bad = [];
  for (const [rel, deps] of GRAPH) {
    for (const dep of deps) {
      if (RANK[layerOf(dep)] > RANK[layerOf(rel)]) bad.push(`src/${rel} -> src/${dep}`);
    }
  }
  assert.deepEqual(bad, [], 'these imports point UP a layer');
});

/* No barrel: a UI module imports the feature module that owns the call, so a call site says
   where it lives.  Nothing in src/ may be named adapters*. */
test('no adapters barrel between ui/ and features/', () => {
  const bad = FILES.filter((rel) => path.basename(rel).startsWith('adapters'));
  assert.deepEqual(bad, []);
});

/* design-page.js installs the eleven design-* modules onto one `page` bag; they call
   `page.<name>()` instead of importing each other.  design-helpers.js is the exception. */
test('no design-* module imports another, bar design-helpers.js', () => {
  const bad = [];
  for (const [rel, deps] of GRAPH) {
    const base = path.basename(rel);
    if (!base.startsWith('design-') || base === 'design-page.js') continue;
    for (const dep of deps) {
      const d = path.basename(dep);
      if (d.startsWith('design-') && d !== 'design-helpers.js') bad.push(`src/${rel} -> src/${dep}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('the import graph is acyclic', () => {
  const state = new Map();
  const cycles = [];
  const walk = (rel, stack) => {
    state.set(rel, 1);
    for (const dep of GRAPH.get(rel) || []) {
      if (state.get(dep) === 1) cycles.push([...stack.slice(stack.indexOf(dep)), dep].join(' -> '));
      else if (!state.has(dep)) walk(dep, [...stack, dep]);
    }
    state.set(rel, 2);
  };
  for (const rel of GRAPH.keys()) if (!state.has(rel)) walk(rel, [rel]);
  assert.deepEqual(cycles, []);
});

/* A tool runs the page's own logic headless, never its DOM: tools/** (bar tools/tests) imports src/ only from
   core/, features/ and data/.  build.mjs hands src/ui entry points to esbuild from the studio root: bundling, not imports. */
test('tools import src/ only from core/, features/ and data/', () => {
  const files = jsFiles(TOOLS, /\.m?js$/).filter((f) => !path.relative(TOOLS, f).startsWith('tests' + path.sep));
  const bad = [], seen = [];
  for (const f of files) {
    for (const dep of importsOf(f)) {
      if (dep.startsWith('..')) continue;                    // not in src/
      seen.push(dep);
      if (!['core', 'features', 'data'].includes(layerOf(dep))) bad.push(`tools/${path.relative(TOOLS, f)} -> src/${dep}`);
    }
  }
  assert.ok(seen.length > 10, 'the walk found the tools\' src imports: ' + seen.length);
  assert.deepEqual(bad, []);
});
