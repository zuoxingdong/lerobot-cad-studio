/* One material per ROLE, driven by theme tokens, plus the hover/selection outline layer and the
   robot's palette swap (setPalette).  Roles: robot, arm, gripper, upgrade, imported, ghost,
   selected, hovered, blocked.
   Needs three; the only DOM it touches is reading CSS custom properties, so it loads in
   Node for tests. */

import * as THREE from 'three';

/* theme tokens */
/** The palette src/ui/tokens.css declares, copied here for Node and for a page whose
 *  stylesheet has not loaded yet; the browser always overrides it from :root.
 *  tools/tests/scene/materials.test.mjs parses tokens.css and fails on any drift. */
export const TOKENS = {
  light: {
    '--viewer-bg':         '#dde1e8',
    '--viewer-bg-2':       '#c9cfd9',
    '--grid-line':         '#aab2be',
    '--grid-line-strong':  '#7d8795',
    '--accent':            '#2f5bd3',
    '--accent-hi':         '#3f6fe6',
    '--outline-hover':     '#6d95ea',
    '--outline-select':    '#2f6fe0',
    '--danger':            '#a3161c',
    '--mat-robot':         '#ccd2da',
    '--mat-arm':           '#d6dbe2',
    '--mat-gripper':       '#c4cbd4',
    '--mat-upgrade':       '#b7c1ce',
    '--mat-imported':      '#d08a3c',
    '--mat-ghost':         '#aab2be',
    '--frustum':           '#2f5bd3'
  },
  dark: {
    '--viewer-bg':         '#0b0e12',
    '--viewer-bg-2':       '#161b22',
    '--grid-line':         '#2f3742',
    '--grid-line-strong':  '#4a5563',
    '--accent':            '#7ea2ff',
    '--accent-hi':         '#a3bdff',
    '--outline-hover':     '#5b80d8',
    '--outline-select':    '#7ea2ff',
    '--danger':            '#ea6c70',
    '--mat-robot':         '#8e97a4',
    '--mat-arm':           '#99a2af',
    '--mat-gripper':       '#848d9a',
    '--mat-upgrade':       '#78838f',
    '--mat-imported':      '#c58038',
    '--mat-ghost':         '#5d6678',
    '--frustum':           '#7ea2ff'
  }
};

/** Resolve the token table for a theme, letting CSS custom properties win. */
export function resolveTokens(theme = 'light', el) {
  const base = { ...(TOKENS[theme] || TOKENS.light) };
  const root = el || (typeof document !== 'undefined' ? document.documentElement : null);
  if (!root || typeof getComputedStyle !== 'function') return base;
  let cs;
  try { cs = getComputedStyle(root); } catch (e) { return base; }
  for (const k of Object.keys(base)) {
    const v = (cs.getPropertyValue(k) || '').trim();
    if (v) base[k] = v;
  }
  return base;
}

/** 'auto' -> the OS preference; anything else passes through. */
/* Deliberately a second copy of ui/design-helpers.js effectiveTheme: scene/ must not import
   from ui/, and this is four lines. */
export function effectiveTheme(theme) {
  if (theme === 'light' || theme === 'dark') return theme;
  if (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'light';
}

/* role recipes */
/* Each recipe is (tokens) -> constructor args. `key` names the token that carries the
   role's base colour, so a theme swap is a colour re-set, never a material rebuild. */
const ROLES = {
  robot:    t => ({ color: t['--mat-robot'],    roughness: 0.62, metalness: 0.06 }),
  arm:      t => ({ color: t['--mat-arm'],      roughness: 0.55, metalness: 0.10 }),
  gripper:  t => ({ color: t['--mat-gripper'],  roughness: 0.48, metalness: 0.14 }),
  upgrade:  t => ({ color: t['--mat-upgrade'],  roughness: 0.50, metalness: 0.08,
                    emissive: t['--mat-upgrade'], emissiveIntensity: 0.06 }),
  imported: t => ({ color: t['--mat-imported'], roughness: 0.70, metalness: 0.02 }),
  ghost:    t => ({ color: t['--mat-ghost'],    roughness: 0.9,  metalness: 0.0,
                    transparent: true, opacity: 0.18, depthWrite: false }),
  blocked:  t => ({ color: t['--danger'],       roughness: 0.5,  metalness: 0.0,
                    emissive: t['--danger'],    emissiveIntensity: 0.0 })
};

/* Overlay roles are unlit basics drawn on top of everything. */
const OVERLAY_ROLES = {
  selected: t => ({ color: t['--outline-select'], opacity: 0.14 }),
  hovered:  t => ({ color: t['--outline-hover'],  opacity: 0.10 })
};

/* ---------------------------------------------------------------- outline shell -- */
const OUTLINE_VERT = /* glsl */`
  uniform float thickness;      // in CSS pixels
  uniform vec2  resolution;     // drawing buffer size in CSS pixels
  void main() {
    vec4 mv   = modelViewMatrix * vec4( position, 1.0 );
    vec4 clip = projectionMatrix * mv;
    vec3 n    = normalize( normalMatrix * normal );
    vec3 nClip = ( projectionMatrix * vec4( n, 0.0 ) ).xyz;
    vec2 dir  = nClip.xy;
    float len = length( dir );
    if ( len > 1e-6 ) {
      dir /= len;
      clip.xy += dir * ( thickness * 2.0 / resolution ) * clip.w;
    }
    gl_Position = clip;
  }
`;
const OUTLINE_FRAG = /* glsl */`
  uniform vec3  color;
  uniform float opacity;
  void main() { gl_FragColor = vec4( color, opacity ); }
`;

/**
 * Outline shell material. `side: BackSide` plus the object's own depth is what turns a
 * duplicate of the geometry into an outline: the object's front faces hide the shell's
 * interior, so only the expanded rim survives.
 *
 * The depth test is therefore NOT optional. Turning it off, or inverting it to
 * `GreaterDepth`, both draw the whole dilated silhouette — the object occludes its own
 * back faces, so "draw where something is in front" is true across the entire part. That
 * reads as "this part is painted blue", not as a selection outline. If a selection hidden
 * behind the arm needs to be findable, use the always-on-top bounding box that
 * createOutlineLayer({ showThrough: true }) adds, not a see-through shell.
 */
export function makeOutlineMaterial({ color = '#f2ad3c', thickness = 2.2, opacity = 1,
                                      resolution = [1, 1] } = {}) {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      color:      { value: new THREE.Color(color) },
      thickness:  { value: thickness },
      opacity:    { value: opacity },
      /* MUST be the live canvas size: the shader divides by it, so a stale (1, 1) turns a
         2.6 px rim into a ~5 clip-unit offset and the shell swallows the whole viewport. */
      resolution: { value: new THREE.Vector2(resolution[0] || 1, resolution[1] || 1) }
    },
    vertexShader: OUTLINE_VERT,
    fragmentShader: OUTLINE_FRAG,
    side: THREE.BackSide,
    transparent: opacity < 1,
    depthTest: true,
    depthFunc: THREE.LessEqualDepth,
    depthWrite: false,
    toneMapped: false
  });
  m.userData.isOutline = true;
  return m;
}

/* A backface shell expanded along FLAT (per-facet) STL normals cracks open at every hard
   edge. Weld the positions once per geometry and average the normals; cache the result on
   the geometry so a second hover is free. Non-indexed STL geometry is the common case. */
const WELD_CACHE = new WeakMap();
export const OUTLINE_TRI_CAP = 260000;   // above this, fall back to a box outline

export function outlineGeometry(geo) {
  if (!geo || !geo.attributes || !geo.attributes.position) return null;
  const cached = WELD_CACHE.get(geo);
  if (cached !== undefined) return cached;
  const pos = geo.attributes.position;
  const tris = (geo.index ? geo.index.count : pos.count) / 3;
  if (tris > OUTLINE_TRI_CAP) { WELD_CACHE.set(geo, null); return null; }

  if (!geo.attributes.normal) geo.computeVertexNormals();

  /* Weld by quantised position (1/512 mm) and average the normals. */
  const n = pos.count;
  const map = new Map();
  const sum = new Float32Array(n * 3);
  const rep = new Int32Array(n);
  const nrm = geo.attributes.normal;
  const Q = 512;
  for (let i = 0; i < n; i++) {
    const k = Math.round(pos.getX(i) * Q) + '|' + Math.round(pos.getY(i) * Q) + '|' + Math.round(pos.getZ(i) * Q);
    let r = map.get(k);
    if (r === undefined) { r = i; map.set(k, i); }
    rep[i] = r;
    sum[r * 3] += nrm.getX(i); sum[r * 3 + 1] += nrm.getY(i); sum[r * 3 + 2] += nrm.getZ(i);
  }
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = rep[i];
    let x = sum[r * 3], y = sum[r * 3 + 1], z = sum[r * 3 + 2];
    const l = Math.hypot(x, y, z) || 1;
    out[i * 3] = x / l; out[i * 3 + 1] = y / l; out[i * 3 + 2] = z / l;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', pos);                       // SHARED, not copied
  g.setAttribute('normal', new THREE.BufferAttribute(out, 3));
  if (geo.index) g.setIndex(geo.index);
  g.boundingSphere = geo.boundingSphere;
  g.boundingBox = geo.boundingBox;
  g.userData.isOutlineGeometry = true;
  WELD_CACHE.set(geo, g);
  return g;
}

/* the factory */
/**
 * createMaterials({ theme }) -> the role palette for one viewport.
 * Every material is cached and MUTATED on setTheme(), so objects never need re-materialising.
 */
export function createMaterials({ theme = 'light', element = null } = {}) {
  let name = effectiveTheme(theme);
  let tokens = resolveTokens(name, element);

  const roleMats = new Map();      // role -> MeshStandardMaterial
  const colourMats = new Map();    // role|#hex -> MeshStandardMaterial
  const overlayMats = new Map();   // role -> MeshBasicMaterial
  const outlineMats = new Map();   // kind -> ShaderMaterial
  /* The last size setResolution() was given. Outline materials are created lazily, so a
     material born after the last resize would otherwise keep the (1, 1) placeholder. */
  const res = [1, 1];
  let flashT = 0;

  function applyRole(mat, role) {
    const spec = ROLES[role](tokens);
    for (const [k, v] of Object.entries(spec)) {
      if (k === 'color' || k === 'emissive') mat[k].set(v);
      else mat[k] = v;
    }
  }

  function get(role) {
    if (!ROLES[role]) role = 'robot';
    let m = roleMats.get(role);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ flatShading: false });
      m.name = 'role:' + role;
      applyRole(m, role);
      roleMats.set(role, m);
    }
    return m;
  }

  /** A per-component colour on a role's finish (imported parts, coloured assemblies). */
  function forColor(hex, role = 'imported') {
    const k = role + '|' + hex;
    let m = colourMats.get(k);
    if (!m) {
      const spec = ROLES[ROLES[role] ? role : 'imported'](tokens);
      m = new THREE.MeshStandardMaterial({
        color: new THREE.Color(hex),
        roughness: spec.roughness, metalness: spec.metalness,
        transparent: !!spec.transparent, opacity: spec.opacity ?? 1,
        depthWrite: spec.depthWrite !== false
      });
      m.name = 'role:' + role + ':' + hex;
      m.userData.tinted = { role, hex };
      colourMats.set(k, m);
    }
    return m;
  }

  function overlay(role) {
    let m = overlayMats.get(role);
    if (!m) {
      const spec = (OVERLAY_ROLES[role] || OVERLAY_ROLES.hovered)(tokens);
      m = new THREE.MeshBasicMaterial({
        color: new THREE.Color(spec.color), transparent: true, opacity: spec.opacity,
        depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending
      });
      m.name = 'overlay:' + role;
      overlayMats.set(role, m);
    }
    return m;
  }

  function outline(kind = 'hover') {
    let m = outlineMats.get(kind);
    if (!m) {
      const cfg = kind === 'select'
        ? { color: tokens['--outline-select'], thickness: 2.6 }
        : kind === 'blocked'
          ? { color: tokens['--danger'], thickness: 3.0 }
          : { color: tokens['--outline-hover'], thickness: 1.8 };
      m = makeOutlineMaterial({ ...cfg, resolution: res });
      m.name = 'outline:' + kind;
      outlineMats.set(kind, m);
    }
    return m;
  }

  /**
   * Called by the viewport on every resize so the outline keeps a constant pixel width.
   * The size is REMEMBERED, so an outline material created later (they are lazy, and the
   * first selection can happen long after the last resize) is born with it too.
   */
  function setResolution(w, h) {
    res[0] = w || 1; res[1] = h || 1;
    for (const m of outlineMats.values()) m.uniforms.resolution.value.set(res[0], res[1]);
  }
  /* Create all three up front as well, so nothing depends on the lazy path being right. */
  for (const kind of ['hover', 'select', 'blocked']) outline(kind);

  /** Drive the blocked flash; t in seconds. Returns true while still animating. */
  function flash(now) {
    if (!flashT) return false;
    const dt = (now - flashT) / 1000;
    const m = get('blocked');
    if (dt > 0.6) { m.emissiveIntensity = 0; flashT = 0; return false; }
    m.emissiveIntensity = 0.9 * (1 - dt / 0.6) * (0.5 + 0.5 * Math.cos(dt * 34));
    return true;
  }
  function startFlash(now = (typeof performance !== 'undefined' ? performance.now() : Date.now())) { flashT = now; }

  function setTheme(next) {
    name = effectiveTheme(next);
    tokens = resolveTokens(name, element);
    for (const [role, m] of roleMats) applyRole(m, role);
    for (const [k, m] of colourMats) {
      const role = m.userData.tinted.role;
      const spec = ROLES[role](tokens);
      m.roughness = spec.roughness; m.metalness = spec.metalness;
    }
    for (const [role, m] of overlayMats) m.color.set((OVERLAY_ROLES[role] || OVERLAY_ROLES.hovered)(tokens).color);
    for (const [kind, m] of outlineMats) {
      m.uniforms.color.value.set(kind === 'select' ? tokens['--outline-select']
        : kind === 'blocked' ? tokens['--danger'] : tokens['--outline-hover']);
    }
    return { theme: name, tokens };
  }

  /* the camera views: the light table whatever the UI theme, for the duration of `fn` */
  let neutralDepth = 0;
  function neutral(fn) {
    if (neutralDepth++ === 0 && name !== 'light') {
      const keep = tokens;
      tokens = { ...TOKENS.light };
      for (const [role, m] of roleMats) applyRole(m, role);
      tokens = keep;
    }
    try { return fn(); } finally {
      if (--neutralDepth === 0 && name !== 'light') for (const [role, m] of roleMats) applyRole(m, role);
    }
  }

  /* the robot's palette: 'design' (the roles) or another one (the Sim's real finish), given as
     Map<mesh, material>; each mesh's own material is kept and put back on 'design', and assign()
     is how the Design scene sets one meanwhile */
  let palette = 'design';
  const kept = new Map();
  function setPalette(next, map = null) {
    for (const [mesh, m] of kept) mesh.material = m;
    kept.clear();
    palette = next !== 'design' && map ? next : 'design';
    if (palette !== 'design') for (const [mesh, m] of map) { kept.set(mesh, mesh.material); mesh.material = m; }
  }
  function assign(mesh, m) { if (kept.has(mesh)) kept.set(mesh, m); else mesh.material = m; }

  function dispose() {
    setPalette('design');
    for (const m of roleMats.values()) m.dispose();
    for (const m of colourMats.values()) m.dispose();
    for (const m of overlayMats.values()) m.dispose();
    for (const m of outlineMats.values()) m.dispose();
    roleMats.clear(); colourMats.clear(); overlayMats.clear(); outlineMats.clear();
  }

  return {
    get theme() { return name; },
    get tokens() { return tokens; },
    roles: Object.keys(ROLES),
    get palette() { return palette; },
    get, forColor, overlay, outline, setResolution, setTheme, neutral, setPalette, assign, dispose,
    flash, startFlash
  };
}

/* ---------------------------------------------------------------- outline layer -- */
/**
 * The hover / selection outline layer: one shell Mesh per highlighted Mesh, reusing the
 * source geometry's position buffer (no clone) and the welded-normal geometry above.
 *
 * layer.set('hover', [meshes])  /  layer.set('select', [meshes])
 * layer.clear(kind) / layer.clearAll() / layer.dispose()
 * layer.stats() -> { shells, triangles }
 */
export function createOutlineLayer({ scene, materials, maxShells = 24, boxFallback = true,
                                    showThrough = false }) {
  const groups = {};
  const boxes = {};
  for (const kind of ['hover', 'select', 'blocked']) {
    const g = new THREE.Group();
    g.name = 'outline:' + kind;
    g.renderOrder = kind === 'hover' ? 1000 : 1001;
    g.matrixAutoUpdate = false;
    scene.add(g);
    groups[kind] = g;
    boxes[kind] = [];
  }
  const state = { hover: [], select: [], blocked: [] };

  function shellFor(mesh, kind) {
    const g = outlineGeometry(mesh.geometry);
    if (!g) return null;
    const s = new THREE.Mesh(g, materials.outline(kind));
    s.matrixAutoUpdate = false;
    s.frustumCulled = mesh.frustumCulled;
    s.renderOrder = groups[kind].renderOrder;
    s.userData.src = mesh;
    return s;
  }

  function boxFor(mesh, kind) {
    const box = new THREE.Box3().setFromObject(mesh);
    if (box.isEmpty()) return null;
    const h = new THREE.Box3Helper(box, new THREE.Color(
      materials.outline(kind).uniforms.color.value));
    h.material.depthTest = false;
    h.material.transparent = true;
    h.material.opacity = kind === 'select' ? 0.9 : 0.5;
    h.renderOrder = groups[kind].renderOrder;
    return h;
  }

  function clear(kind) {
    const g = groups[kind];
    for (const c of g.children.slice()) { g.remove(c); if (c.isBox3Helper) { c.geometry.dispose(); c.material.dispose(); } }
    state[kind] = [];
  }

  /** meshes: an array of THREE.Mesh already in the scene graph (world matrices used). */
  function set(kind, meshes) {
    clear(kind);
    const list = (meshes || []).filter(m => m && m.isMesh).slice(0, maxShells);
    for (const m of list) {
      const s = shellFor(m, kind);
      if (s) { groups[kind].add(s); state[kind].push({ shell: s, src: m }); }
      else if (boxFallback) { const b = boxFor(m, kind); if (b) groups[kind].add(b); }
      /* an always-on-top box so a selection behind the arm is still findable */
      if (s && kind === 'select' && showThrough) { const b = boxFor(m, kind); if (b) groups[kind].add(b); }
    }
    sync();
  }

  /* a shell is a sibling of the source, not a child, so an ancestor that is switched off
     does not hide it: walk the chain, or hiding a whole group leaves its outlines painted */
  function visibleChain(o) { for (let n = o; n; n = n.parent) if (n.visible === false) return false; return true; }

  /** Copy world matrices; call from the viewport's onBeforeRender hook. */
  function sync() {
    for (const kind of ['hover', 'select', 'blocked']) {
      for (const e of state[kind]) {
        e.shell.matrix.copy(e.src.matrixWorld);
        e.shell.matrixWorldNeedsUpdate = true;
        e.shell.visible = visibleChain(e.src);
      }
    }
  }

  /**
   * A source mesh swapped its geometry (a parametric rebuild): re-weld its shell.  Without
   * this the outline keeps the pre-tweak silhouette and re-uploads a disposed attribute
   * every frame.  `mesh` omitted refreshes every shell.
   */
  function refresh(mesh) {
    for (const kind of ['hover', 'select', 'blocked']) {
      for (const e of state[kind]) {
        if (mesh && e.src !== mesh) continue;
        const g = outlineGeometry(e.src.geometry);
        if (g && g !== e.shell.geometry) e.shell.geometry = g;
      }
    }
    sync();
  }

  function stats() {
    let shells = 0, triangles = 0;
    for (const kind of ['hover', 'select', 'blocked']) {
      for (const e of state[kind]) {
        shells++;
        const g = e.shell.geometry;
        triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
      }
    }
    return { shells, triangles };
  }

  function setVisible(kind, v) { groups[kind].visible = v; }

  function dispose() {
    for (const kind of ['hover', 'select', 'blocked']) { clear(kind); scene.remove(groups[kind]); }
  }

  return { set, clear, clearAll: () => ['hover', 'select', 'blocked'].forEach(clear), sync, refresh, stats, setVisible, dispose, groups };
}

/* Outlines are a scaled back-face shell, not OutlinePass: one extra draw over the selected geometry
   (< 0.1 ms) instead of ~5 full-screen passes per frame, and it works inside the scissored camera PiPs
   and on-demand rendering, which an EffectComposer does not. outlineGeometry() welds the normals so
   hard edges do not crack the shell; above OUTLINE_TRI_CAP a Box3Helper stands in. */
