/* The baked lab of site/lab/ (manifest rps/showcase@1): fetches the files (or reads their
   file:// wrappers), parses the meshopt GLBs, transcodes the KTX2 lightmaps, reads the RGBE probe, and
   builds the baked set's materials (the showcase looks + the lightmap patch). Shared by the showcase and
   the Sim tab's baked room (ui/sim-baked.js). */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { loadBytes } from './showcase-assets.js';
import { Looks, lightmapped } from './showcase-looks.js';

export const DIR = 'lab/', BASIS = 'vendor/basis/';
const INLINE = 'inline:/';

/** a real bake (lightmaps and the probe), not the stand-in */
export const isBaked = (M) => !!(M && M.lab && (M.lightmaps || []).length && M.probe);

/** the files a load needs, [{name, bytes}] */
export function bakedFiles(M, { movers = true, run = false } = {}) {
  const byName = new Map((M.files || []).map((f) => [f.name, f]));
  const need = [M.lab.file, ...(M.lightmaps || []).flatMap((l) => [l.file, ...(l.normal ? [l.normal.file] : [])])];
  if (M.probe) need.push(M.probe.file);
  if (movers) need.push(M.movers.file);
  if (run) need.push(M.run.file);
  return need.map((n) => byName.get(n) || { name: n, bytes: 0 });
}

const whole = (b) => (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b.buffer
  : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
export const parseGlb = (loader, bytes) => new Promise((res, rej) => loader.parse(whole(bytes), '', res, rej));

/** a KTX2 loader whose transcoder is read from site/vendor/basis/ into THREE.Cache (file:// has no
    fetch); `release()` drops the cache entries once the transcoder is up */
export async function ktxLoader(renderer, onBytes = () => {}) {
  const was = THREE.Cache.enabled;
  THREE.Cache.enabled = true;
  const [js, wasm] = await Promise.all([loadBytes(BASIS, 'basis_transcoder.js', 0, onBytes),
    loadBytes(BASIS, 'basis_transcoder.wasm', 0, onBytes)]);
  THREE.Cache.add(INLINE + 'basis_transcoder.js', new TextDecoder().decode(js));
  THREE.Cache.add(INLINE + 'basis_transcoder.wasm', wasm.buffer);
  const ktx = new KTX2Loader().setTranscoderPath(INLINE).detectSupport(renderer);
  ktx.release = () => {
    THREE.Cache.remove(INLINE + 'basis_transcoder.js');
    THREE.Cache.remove(INLINE + 'basis_transcoder.wasm');
    THREE.Cache.enabled = was;
  };
  return ktx;
}

const ktxTexture = (ktx, buf, channel, space, aniso) => new Promise((res, rej) => ktx.parse(whole(buf), (t) => {
  t.channel = channel;
  t.flipY = false;
  t.colorSpace = space;
  t.anisotropy = aniso;                                 // thin trims at grazing views keep their own mip
  res(t);
}, rej));

/** the manifest's lightmaps as textures (sRGB unless `srgb: false`, on the manifest's UV channel) */
export function parseLightmaps(ktx, M, bytes, aniso = 1) {
  return Promise.all((M.lightmaps || []).map((l) => ktxTexture(ktx, bytes[l.file], l.channel ?? 1,
    l.srgb === false ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace, aniso)));
}

/** each atlas's normal map (the render LOD's bevels, linear), or null */
export function parseNormals(ktx, M, bytes, aniso = 1) {
  return Promise.all((M.lightmaps || []).map((l) => (l.normal && bytes[l.normal.file]
    ? ktxTexture(ktx, bytes[l.normal.file], l.channel ?? 1, THREE.NoColorSpace, aniso) : null)));
}

/** the RGBE probe as an equirect DataTexture (linear; the file's first row is up) */
export function probeTexture(bytes) {
  const d = new RGBELoader().parse(whole(bytes));
  const t = new THREE.DataTexture(d.data, d.width, d.height, THREE.RGBAFormat, d.type);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.LinearSRGBColorSpace;
  t.flipY = true;
  t.needsUpdate = true;
  return t;
}

/**
 * Everything but the run: {lab, movers (gltf scenes or null), lightmaps, normals, probe (equirect)}.
 * onBytes(n, total) reports the raw bytes read.
 */
export async function loadBaked(M, { renderer, movers = true, onBytes = () => {} }) {
  const files = bakedFiles(M, { movers });
  const total = files.reduce((n, f) => n + (f.bytes || 0), 0) || 1;
  let got = 0;
  const tick = (n) => { got += n; onBytes(got, total); };
  const bytes = Object.fromEntries(await Promise.all(files.map(async (f) => [f.name, await loadBytes(DIR, f.name, f.bytes, tick, f.sha256)])));
  await MeshoptDecoder.ready;
  const gl = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const ktx = await ktxLoader(renderer);
  try {
    const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const lightmaps = await parseLightmaps(ktx, M, bytes, aniso), normals = await parseNormals(ktx, M, bytes, aniso);
    const [lab, mov] = await Promise.all([parseGlb(gl, bytes[M.lab.file]), movers ? parseGlb(gl, bytes[M.movers.file]) : null]);
    return { lab: lab.scene, movers: mov && mov.scene, lightmaps, normals, probe: probeTexture(bytes[M.probe.file]) };
  } finally {
    ktx.release();
    ktx.dispose();
  }
}

/* the chunk that lights a lit material, with every direct light compiled out */
const NO_DIRECT = THREE.ShaderChunk.lights_fragment_begin.replace(/NUM_(POINT|SPOT|DIR|RECT_AREA|HEMI)_LIGHTS > 0/g, '0 > 0');

/** drop the scene's direct lights from a lit material, for the baked set in a one-pass renderer */
export function unlit(m) {
  const before = m.onBeforeCompile, key = m.customProgramCacheKey;
  m.onBeforeCompile = (sh, r) => {
    before.call(m, sh, r);
    sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_begin>', NO_DIRECT);
  };
  m.customProgramCacheKey = () => key.call(m) + '|unlit';
  return m;
}

export const setLooks = (M) => new Looks(M.materials, M, { transmission: false });

/**
 * The material of one baked-set node ({mat, color, lm?, alb?} of manifest lab.nodes): the look with,
 * when lightmapped, the lightmap and the explicit env (`env`, `rotation`: the scene's environment).
 * `normals`: the atlases' normal maps (they bend the probe's specular only); `unlit`: no direct lights;
 * `decal`: a polygon offset towards the eye.
 */
export function labMaterial(looks, M, info, lightmaps, { env = null, rotation = null, normals = [], unlit: noLights = false, decal = false } = {}) {
  const lm = info.lm !== undefined && lightmaps[info.lm];
  const m = looks.get(info.mat, info.color, !!lm || noLights || decal);
  if (lm) {
    // the bake stores the diffuse radiance / scale; the patch adds lightmap x intensity / pi
    m.lightMap = lm;
    m.lightMapIntensity = (M.lightmaps[info.lm].scale || 1) * Math.PI;
    m.envMap = env;
    if (rotation) m.envMapRotation.copy(rotation);
    m.envMapIntensity = (M.light || {}).env_baked ?? 1;
    if (normals[info.lm]) { m.normalMap = normals[info.lm]; m.normalScale.set(1, 1); }
    lightmapped(m, info.alb);
  }
  if (decal) Object.assign(m, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  if (noLights && !m.transparent) unlit(m);
  return m;
}
