/* The web mirror of tools/render/looks.json: a spec -> MeshStandardMaterial, or
   MeshPhysicalMaterial for glass, coat, sheen and thin films. Colours are linear Rec.709. */
import * as THREE from 'three';

const LM_PER_W = 683;
const METAL_ROUGH = 0.15;
// a clear medium without the transmission pass: a faint film over what lies behind it, tinted by a tube's
// bore of the medium, that scatters little light back (no glow; a tinted one lights only through its emission)
const MEDIUM = { bore: 0.012, opacity: 0.22, albedo: 0.06 };
// the probe's specular fades out where the bake's irradiance falls below this share of the probe's
export const OCC = [0.05, 0.45];

/** a Planckian white in linear Rec.709 at Y = 1 (looks.kelvin_rgb) */
export function kelvinRgb(k) {
  const t = Number(k);
  const x = t <= 4000
    ? -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.179910
    : -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.240390;
  const y = t <= 2222 ? -1.1063814 * x ** 3 - 1.34811020 * x ** 2 + 2.18555832 * x - 0.20219683
    : t <= 4000 ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
      : 3.0817580 * x ** 3 - 5.87338670 * x ** 2 + 3.75112997 * x - 0.37001483;
  const X = x / y, Z = (1 - x - y) / y;
  return [3.2404542 * X - 1.5371385 - 0.4985314 * Z, -0.9692660 * X + 1.8760108 + 0.0415560 * Z,
    0.0556434 * X - 0.2040259 + 1.0572252 * Z].map((v) => Math.max(v, 0));
}

/** the white-balance gain before tone mapping: 1 / kelvin_rgb(K), normalised to green */
export function wbGain(k) {
  if (!k) return [1, 1, 1];
  const c = kelvinRgb(k);
  return [c[1] / c[0], 1, c[1] / c[2]];
}

/* A lightmapped surface: the lightmap holds its whole diffuse radiance (x pi, albedo and the look's maps
   baked in), added as is, with no IBL diffuse from the probe on top; the probe's specular is scaled by the
   baked irradiance over the probe's own (rpsAlbedo: the albedo the bake saw; below OCC[1] of it counts as occluded),
   so cavities do not mirror the room. */
const LIGHTMAPPED = `
float rpsOcc = 1.0;
#if defined( RE_IndirectDiffuse ) && defined( USE_LIGHTMAP )
  vec3 rpsLm = texture2D( lightMap, vLightMapUv ).rgb * lightMapIntensity;
  reflectedLight.indirectDiffuse += rpsLm * RECIPROCAL_PI * ( 1.0 - metalnessFactor );
  #if defined( USE_ENVMAP ) && defined( STANDARD ) && defined( ENVMAP_TYPE_CUBE_UV )
    const vec3 rpsY = vec3( 0.2126, 0.7152, 0.0722 );
    // the probe's own irradiance (without envMapIntensity, which scales only what it adds)
    rpsOcc = smoothstep( RPS_OCC_LO, RPS_OCC_HI, envMapIntensity * dot( rpsLm, rpsY ) / max( rpsAlbedo * dot( getIBLIrradiance( geometryNormal ), rpsY ), 1e-4 ) );
  #endif
#endif
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
  radiance += rpsOcc * getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );
  #ifdef USE_CLEARCOAT
    clearcoatRadiance += rpsOcc * getIBLRadiance( geometryViewDir, geometryClearcoatNormal, material.clearcoatRoughness );
  #endif
#endif
`;

/** patch a MeshStandard/Physical material with a lightMap for the baked set; albedo: the bake's (luminance) */
export function lightmapped(m, albedo = 0.5) {
  const u = { value: Math.max(albedo, 0.02) };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.rpsAlbedo = u;
    sh.fragmentShader = `uniform float rpsAlbedo;\n#define RPS_OCC_LO ${OCC[0].toFixed(3)}\n#define RPS_OCC_HI ${OCC[1].toFixed(3)}\n`
      + sh.fragmentShader.replace('#include <lights_fragment_maps>', LIGHTMAPPED);
    if (m.userData.emitCap) emitCapChunk(sh);
  };
  m.customProgramCacheKey = () => 'rps-lightmapped' + (m.userData.emitCap ? '+cap' : '');
  return m;
}

/* The LEDs' emission, scaled so its peak channel stays at EMIT_CAP (the stage sets it per tier: the peak
   over the exposure without bloom, unbounded with it), so the tone map's shoulder cannot bleach the hue. */
export const EMIT_CAP = { value: 1e4 };
const EMIT_CAPPED = `#include <emissivemap_fragment>
totalEmissiveRadiance *= min( 1.0, rpsEmitCap / max( max( totalEmissiveRadiance.r, totalEmissiveRadiance.g ), max( totalEmissiveRadiance.b, 1e-6 ) ) );`;

function emitCapChunk(sh) {
  sh.uniforms.rpsEmitCap = EMIT_CAP;
  sh.fragmentShader = 'uniform float rpsEmitCap;\n' + sh.fragmentShader.replace('#include <emissivemap_fragment>', EMIT_CAPPED);
}

/** an LED's material: its emission capped by EMIT_CAP (lightmapped() keeps the patch) */
export function emitCapped(m) {
  m.userData.emitCap = true;
  m.onBeforeCompile = emitCapChunk;
  m.customProgramCacheKey = () => 'rps-emit-cap';
  return m;
}

export const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/**
 * One material per (look, colour). `color` is the node's [r, g, b, emission] (linear) when the spec
 * takes the object colour or is tinted. `opts.transmission`: real transmission (else fresnel glass).
 */
export class Looks {
  constructor(specs, conf, opts = {}) {
    this.specs = specs || {};
    this.keyScale = conf.key_scale || 1;
    this.tint = conf.tint_strength || 1200 / LM_PER_W;
    this.emit = conf.emit || 6;                          // looks.json emit (looks.EMIT)
    this.opts = opts;
    this.cache = new Map();
  }

  spec(name) {
    return this.specs[name.split('~')[0]] || { base: 'object', rough: 0.6 };
  }

  /** the shared material of a static node; `own` forces a private copy (animated colour) */
  get(name, color, own = false) {
    const k = name + '|' + (color ? color.join(',') : '');
    if (!own && this.cache.has(k)) return this.cache.get(k);
    const m = this.make(name, color);
    if (!own) this.cache.set(k, m);
    return m;
  }

  make(name, color) {
    const s = this.spec(name), tinted = name.endsWith('~tint');
    const glass = (s.transmission || 0) > 0;
    const phys = glass || s.coat || s.sheen || s.thin_film_nm;
    const m = phys ? new THREE.MeshPhysicalMaterial() : new THREE.MeshStandardMaterial();
    m.name = name;
    const base = s.base === undefined || s.base === 'object' || tinted ? (color || [0.6, 0.6, 0.6]) : s.base;
    m.color.setRGB(base[0], base[1], base[2], THREE.LinearSRGBColorSpace);
    m.roughness = Math.max(0.04, s.rough ?? 0.5);        // GGX at 0 overflows half floats
    // a metal mirrors the one probe (no parallax, no roughness maps): satin it, as its offline maps do
    if ((s.metal ?? 0) >= 0.5) m.roughness = Math.max(m.roughness + METAL_ROUGH, 0.42);
    m.metalness = s.metal ?? 0;
    if (s.coat) { m.clearcoat = s.coat; m.clearcoatRoughness = s.coat_rough ?? 0.08; }
    if (s.sheen) { m.sheen = s.sheen; m.sheenRoughness = s.sheen_rough ?? 0.5; m.sheenColor.setRGB(base[0], base[1], base[2]); }
    const film = s.thin_film_nm;                          // not lens.thin_film_nm: no lens disc here, it would coat the part
    if (film) { m.iridescence = 1; m.iridescenceIOR = 1.38; m.iridescenceThicknessRange = [film, film]; }
    if (glass) this.glass(m, s);
    if (tinted) {
      m.emissive.setRGB(base[0], base[1], base[2], THREE.LinearSRGBColorSpace);
      m.emissiveIntensity = (color ? color[3] : 0) * (s.tint_nits ? s.tint_nits / LM_PER_W : this.tint);
    } else if (s.nits) {
      const rgb = s.emit_rgb || (s.kelvin ? kelvinRgb(s.kelvin) : base);
      m.emissive.setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace);
      m.emissiveIntensity = s.nits / LM_PER_W * (s.key ? this.keyScale : 1);
    } else if (s.emit && color) {
      m.emissive.setRGB(base[0], base[1], base[2], THREE.LinearSRGBColorSpace);
      m.emissiveIntensity = s.emit * this.emit;
    }
    m.side = THREE.FrontSide;
    if (/^led_/.test(name)) emitCapped(m);
    m.userData.tint = s.tint_nits ? s.tint_nits / LM_PER_W : this.tint;
    m.userData.objectColor = s.base === undefined || s.base === 'object';
    if (tinted && s.tint_gate) {                         // looks.py tint_gate: an idle colour stays dark
      m.userData.gate = s.tint_gate;
      m.userData.off = Array.isArray(s.base) ? s.base : null;
    }
    return m;
  }

  glass(m, s) {
    m.ior = s.ior ?? 1.5;
    const real = this.opts.transmission && (s.transmission >= 0.99);
    if (real) {
      m.transmission = s.transmission;
      m.thickness = s.thin_wall ? 0 : 0.004;
      if (s.volume) {
        const c = s.volume.color, k = s.volume.density;
        m.attenuationDistance = 0.01;
        m.attenuationColor.setRGB(...c.map((v) => Math.exp(-(1 - v) * k * 0.01)), THREE.LinearSRGBColorSpace);
      }
    } else if (s.volume && s.transmission >= 0.99) {
      const c = s.volume.color, k = s.volume.density;
      const T = c.map((v) => Math.exp(-(1 - v) * k * MEDIUM.bore));
      m.color.setRGB(m.color.r * T[0], m.color.g * T[1], m.color.b * T[2], THREE.LinearSRGBColorSpace).multiplyScalar(MEDIUM.albedo);
      m.userData.albedo = MEDIUM.albedo;
      m.transparent = true;
      m.opacity = MEDIUM.opacity;
      m.depthWrite = false;
      m.specularIntensity = 1;
    } else {
      // fresnel glass: a thin tinted sheet whose reflections come from the env
      m.transparent = true;
      m.opacity = Math.min(0.85, 0.12 + (1 - s.transmission) + (s.volume ? 0.25 : 0) + (s.base[0] < 0.5 ? 0.35 : 0));
      m.depthWrite = false;
      m.specularIntensity = 1;
    }
    m.side = THREE.DoubleSide;
  }

  /** set an animated node's colour: [r, g, b] display sRGB and emission, as the capture holds them;
      tint null leaves the emission alone */
  static paint(m, rgb, e, tint) {
    const a = m.userData.albedo || 1;                   // a clear medium's colour scatters only this much
    const r = srgbToLin(rgb[0]), g = srgbToLin(rgb[1]), b = srgbToLin(rgb[2]);
    const G = m.userData.gate, off = m.userData.off;
    // the gate ramps the emission in over the colour's luminance, and the base from `off` to the colour
    const f = G ? Math.min(1, Math.max(0, (0.2126 * r + 0.7152 * g + 0.0722 * b - G[0]) / (G[1] - G[0]))) : 1;
    if (G && off) m.color.setRGB(off[0] + (r - off[0]) * f, off[1] + (g - off[1]) * f, off[2] + (b - off[2]) * f, THREE.LinearSRGBColorSpace);
    else m.color.setRGB(r * a, g * a, b * a, THREE.LinearSRGBColorSpace);
    if (tint !== null && m.emissive) {
      m.emissive.setRGB(r, g, b, THREE.LinearSRGBColorSpace);
      m.emissiveIntensity = e * tint * f;
    }
  }
}
