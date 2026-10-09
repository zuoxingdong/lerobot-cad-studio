/* scene/materials.js: theme tokens against src/ui/tokens.css, role materials, outlines and
   the welded outline geometry.  No GPU. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  TOKENS, createMaterials, resolveTokens, effectiveTheme,
  outlineGeometry, makeOutlineMaterial, OUTLINE_TRI_CAP, createOutlineLayer
} from '../../../src/scene/materials.js';

const CSS_TEXT = readFileSync(new URL('../../../src/ui/tokens.css', import.meta.url), 'utf8');

/** The body of the one rule with this selector, brace-matched. */
function ruleBody(selector) {
  const i = CSS_TEXT.indexOf(selector + '{');
  assert.ok(i >= 0, 'tokens.css declares no ' + selector);
  let depth = 0, j = i + selector.length;
  for (; j < CSS_TEXT.length; j++) {
    if (CSS_TEXT[j] === '{') depth++;
    else if (CSS_TEXT[j] === '}' && --depth === 0) break;
  }
  return CSS_TEXT.slice(i + selector.length + 1, j);
}
function customProps(body) {
  const out = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[m[1]] = m[2].trim();
  return out;
}
/* the shipped palette: light on bare :root, dark on the theme attribute */
const SHIPPED = {
  light: customProps(ruleBody(':root')),
  dark: customProps(ruleBody(':root[data-theme="dark"]'))
};
/** only the tokens the 3D side reads, so a new UI-only token is not a failure */
const shipped = (theme) => Object.fromEntries(
  Object.keys(TOKENS[theme]).map((k) => [k, SHIPPED[theme][k]]));

test('the built-in palette is tokens.css, both dark blocks agree, both themes name the same tokens', () => {
  for (const theme of ['light', 'dark']) assert.deepEqual(TOKENS[theme], shipped(theme), theme + ' drifted from tokens.css');
  assert.equal(ruleBody(':root:not([data-theme="light"])'), ruleBody(':root[data-theme="dark"]'));
  assert.deepEqual(Object.keys(TOKENS.light).sort(), Object.keys(TOKENS.dark).sort());
  assert.equal(effectiveTheme('auto'), 'light', 'no matchMedia in node');
  assert.deepEqual(resolveTokens('dark'), TOKENS.dark);
});

test('role materials: cached, distinct, from the --mat-* tokens; a theme swap repaints the same objects', () => {
  const M = createMaterials({ theme: 'dark' });
  for (const role of M.roles) assert.equal(M.get(role), M.get(role), role + ' is cached');
  for (const [role, token] of [['robot', '--mat-robot'], ['arm', '--mat-arm'], ['gripper', '--mat-gripper'],
    ['upgrade', '--mat-upgrade'], ['imported', '--mat-imported'], ['ghost', '--mat-ghost']]) {
    assert.equal('#' + M.get(role).color.getHexString(), SHIPPED.dark[token], role);
  }
  assert.equal(new Set(['robot', 'arm', 'gripper', 'upgrade'].map((r) => M.get(r).color.getHexString())).size, 4);
  const g = M.get('ghost');
  assert.ok(g.transparent && !g.depthWrite && g.opacity < 0.5, 'the ghost writes depth');
  const robot = M.get('robot'), before = robot.color.getHexString();
  const user = M.forColor('#ff8800');
  assert.equal(M.forColor('#ff8800'), user);
  M.setTheme('light');
  assert.ok(M.get('robot') === robot && robot.color.getHexString() !== before, 'not repainted in place');
  assert.equal(user.color.getHexString(), 'ff8800', 'a theme swap repainted a user colour');
  M.dispose();
});

test('the blocked flash decays to zero and then stops asking for frames', () => {
  const M = createMaterials({ theme: 'dark' });
  assert.equal(M.flash(1000), false);
  M.startFlash(1000);
  assert.equal(M.flash(1050), true);
  assert.equal(M.flash(1700), false);
  assert.equal(M.get('blocked').emissiveIntensity, 0);
  M.dispose();
});

test('outlines: a cached back-face shell per kind, depth-tested, thicker for select and blocked, token colours', () => {
  const M = createMaterials({ theme: 'dark' });
  const [h, s, b] = ['hover', 'select', 'blocked'].map((k) => M.outline(k));
  assert.equal(M.outline('hover'), h);
  for (const m of [h, s, b]) {
    assert.ok(m.isShaderMaterial && m.side === THREE.BackSide && /resolution/.test(m.vertexShader));
    assert.ok(m.depthTest && m.depthFunc === THREE.LessEqualDepth && !m.depthWrite, 'not an outline');
  }
  assert.ok(h.uniforms.thickness.value < s.uniforms.thickness.value && s.uniforms.thickness.value < b.uniforms.thickness.value);
  const hex = (m) => '#' + m.uniforms.color.value.getHexString();
  assert.deepEqual([hex(h), hex(s), hex(b)], [SHIPPED.dark['--outline-hover'], SHIPPED.dark['--outline-select'], SHIPPED.dark['--danger']]);
  const t = s.uniforms.thickness.value;
  M.setTheme('light');
  assert.equal(hex(s), SHIPPED.light['--outline-select']);
  assert.equal(s.uniforms.thickness.value, t, 'the thickness changed with the theme');
  M.dispose();
});

test('an outline material takes the live canvas size, whenever it is made; a zero canvas clamps', () => {
  const M = createMaterials({ theme: 'dark' });
  M.setResolution(1600, 1000);
  for (const k of ['hover', 'select', 'blocked']) {
    const r = M.outline(k).uniforms.resolution.value;
    assert.deepEqual([r.x, r.y], [1600, 1000], k);
  }
  M.setResolution(900, 600);
  M.setTheme('light');
  assert.deepEqual([M.outline('select').uniforms.resolution.value.x, M.outline('select').uniforms.resolution.value.y], [900, 600]);
  M.setResolution(0, 0);
  const r = M.outline('select').uniforms.resolution.value;
  assert.ok(r.x >= 1 && r.y >= 1);
  M.dispose();
});

test('outlineGeometry welds flat STL normals over the shared positions; cached; capped; null for nothing', () => {
  const g = new THREE.BoxGeometry(10, 10, 10).toNonIndexed();
  g.computeVertexNormals();
  const o = outlineGeometry(g);
  assert.ok(o.attributes.position === g.attributes.position && o.attributes.normal !== g.attributes.normal);
  const n = o.attributes.normal;
  let diag = 0;
  for (let i = 0; i < n.count; i++) {
    assert.ok(Math.abs(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) - 1) < 1e-5);
    if (Math.abs(n.getX(i)) > 0.4 && Math.abs(n.getY(i)) > 0.4 && Math.abs(n.getZ(i)) > 0.4) diag++;
  }
  assert.ok(diag > 0, 'corner normals are not welded');
  assert.equal(outlineGeometry(g), o);
  const big = new THREE.BufferGeometry();
  big.setAttribute('position', new THREE.BufferAttribute(new Float32Array((OUTLINE_TRI_CAP + 30) * 9), 3));
  assert.equal(outlineGeometry(big), null);
  const bare = new THREE.BoxGeometry(4, 4, 4).toNonIndexed();
  bare.deleteAttribute('normal');
  assert.ok(outlineGeometry(bare));
  assert.equal(outlineGeometry(null), null);
  assert.equal(outlineGeometry(new THREE.BufferGeometry()), null);
  assert.equal(makeOutlineMaterial({ color: '#ff0000', thickness: 3 }).uniforms.thickness.value, 3);
});

test('an outline follows its source\'s visibility chain, and refresh() re-welds a swapped geometry', () => {
  const scene = new THREE.Scene();
  const layer = createOutlineLayer({ scene, materials: createMaterials({ theme: 'dark' }) });
  const group = new THREE.Group(), mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10));
  group.add(mesh);
  scene.add(group);
  scene.updateMatrixWorld(true);
  layer.set('select', [mesh]);
  const shell = layer.groups.select.children.find((c) => !c.isBox3Helper);
  group.visible = false;
  layer.sync();
  assert.equal(shell.visible, false, 'hiding the group left its outline');
  group.visible = true;
  layer.sync();
  const first = shell.geometry;
  mesh.geometry = new THREE.SphereGeometry(20, 8, 6);
  layer.sync();
  assert.equal(shell.geometry, first, 'sync() alone re-welded');
  layer.refresh(mesh);
  assert.equal(shell.geometry.getAttribute('position'), mesh.geometry.getAttribute('position'), 'refresh kept the old silhouette');
  layer.dispose();
});
