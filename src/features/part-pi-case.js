/* The rev-I Raspberry Pi case: the vent field (a port of scripts/vent.py, 3.0 mm stadium
   slots on a 5.90 mm pitch) and the pi_case cradle + drop-in rear panel.
   Needs three and features/geometry-kit.js. */

import * as THREE from 'three';
import {
  D2R, merge, polyG, boxG, circlePts, roundRectPts, capsulePts, tubeZ, bedMatrix, statsOf,
  resolve, COL,
  placePrism, convexHull, clipConvex,
} from './geometry-kit.js';

const VENT_W = 3.0, VENT_PITCH = 5.90, VENT_MINLEN = 8.0, VENT_TRIM = 1.5;

function clipSeg(ox, oy, dx, dy, u0, u1, v0, v1) {
  let t0 = -1e9, t1 = 1e9;
  const ax = (o, d, lo, hi) => {
    if (Math.abs(d) < 1e-12) return !(o < lo || o > hi);
    let a = (lo - o) / d, b = (hi - o) / d;
    if (a > b) { const t = a; a = b; b = t; }
    t0 = Math.max(t0, a); t1 = Math.min(t1, b); return true;
  };
  if (!ax(ox, dx, u0, u1)) return null;
  if (!ax(oy, dy, v0, v1)) return null;
  return t1 > t0 ? [t0, t1] : null;
}

function ventChords(u0, u1, v0, v1, angDeg, exclude) {
  const a = angDeg * D2R, dx = Math.cos(a), dy = Math.sin(a), px = -dy, py = dx;
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  const K = Math.ceil(Math.hypot(u1 - u0, v1 - v0) / VENT_PITCH) + 1;
  const out = [];
  for (let k = -K; k <= K; k++) {
    const ox = cu + px * k * VENT_PITCH, oy = cv + py * k * VENT_PITCH;
    const base = clipSeg(ox, oy, dx, dy, u0, u1, v0, v1);
    if (!base) continue;
    let segs = [base];
    for (const e of exclude || []) {
      const ex = clipSeg(ox, oy, dx, dy, e[0] - 2.5, e[1] + 2.5, e[2] - 2.5, e[3] + 2.5);
      if (!ex) continue;
      const nx = [];
      for (const s of segs) {
        if (ex[1] <= s[0] || ex[0] >= s[1]) { nx.push(s); continue; }
        if (ex[0] > s[0]) nx.push([s[0], ex[0]]);
        if (ex[1] < s[1]) nx.push([ex[1], s[1]]);
      }
      segs = nx;
    }
    for (const s of segs) {
      if (s[1] - s[0] < VENT_MINLEN + 2 * VENT_TRIM) continue;
      const t0 = s[0] + VENT_TRIM, t1 = s[1] - VENT_TRIM, mt = (t0 + t1) / 2;
      out.push({ cx: ox + dx * mt, cy: oy + dy * mt, len: t1 - t0, ang: angDeg });
    }
  }
  return out;
}

const ventPoly = (c) => capsulePts(c.cx, c.cy, c.len, VENT_W, c.ang, 6);

function piDims(P) {
  const wall = P.ui_wall;
  const FLOOR_Z0 = 57.0, FLOOR_Z1 = 61.0, BOARD_Z0 = 64.0;
  const ROOF_Z1 = FLOOR_Z0 + P.height;
  const WALL_IN_X = 31.5, OUT_X = WALL_IN_X + wall;
  const FRONT_Y_OUT = -51.5, FRONT_Y_IN = FRONT_Y_OUT - wall;
  const PCB_SOLDER = FRONT_Y_IN - 5.0, PCB_COMP = PCB_SOLDER - 1.6;
  const LAND_Y = PCB_COMP - P.front_clear, COVER_Y_OUT = LAND_Y - 3.0;
  return { wall, FLOOR_Z0, FLOOR_Z1, BOARD_Z0, ROOF_Z1, WALL_IN_X, OUT_X, FRONT_Y_OUT, FRONT_Y_IN,
           PCB_SOLDER, PCB_COMP, LAND_Y, COVER_Y_OUT,
           HOLE_X: [-24.5, 24.5], HOLE_Z: [BOARD_Z0 + 3.5, Math.min(BOARD_Z0 + 61.5, ROOF_Z1 - 12)],
           PORT_Y: [-75.5, -59.0], PORT_Z: [BOARD_Z0 + 3.4, Math.min(BOARD_Z0 + 46.0, ROOF_Z1 - 8)] };
}

const pi_case = {
  id: 'pi_case',
  title: 'Vertical Raspberry Pi 5 case',
  group: 'upgrade',
  summary: 'Rev-I vertical Pi 5 cradle with an open top and a rear panel that drops in on two '
    + 'L-hooks. front_clear is the gap in front of the PCB components (set it from YOUR cooler), '
    + 'height is the total case height above the deck; ui_wall, ui_vent_ang and ui_latch tune the '
    + 'shell, the 3 mm stadium vent fields and the top cantilever latch.',
  params: [
    { key: 'front_clear', label: 'Cooler clearance', unit: 'mm', min: 12, max: 45, step: 0.5, default: 29.5, group: 'Board bay',
      handle: { kind: 'translate', axis: 'y', anchor: (p) => [0, -61.1 - (p.front_clear || 29.5), 100], perMm: -1 } },
    { key: 'height', label: 'Case height', unit: 'mm', min: 80, max: 130, step: 1, default: 97, group: 'Board bay',
      handle: { kind: 'translate', axis: 'z', anchor: (p) => [0, -70, 57 + (p.height || 97)], perMm: 1 } },
    { key: 'ui_wall', label: 'Wall', unit: 'mm', min: 2, max: 5, step: 0.1, default: 3.0, group: 'Shell', handle: null },
    { key: 'ui_vent_ang', label: 'Vent slot angle', unit: '°', min: 0, max: 90, step: 5, default: 45, group: 'Shell', handle: null },
    { key: 'ui_latch', label: 'Top latch', unit: '0/1', min: 0, max: 1, step: 1, default: 1, group: 'Panel', handle: null },
  ],
  variants: [
    { name: 'rev I — as printed', params: {}, note: 'Dual-fan ARMOUR cooler, 97 mm tall.' },
    { name: 'slim cooler', params: { front_clear: 18 }, note: 'Passive heatsink only; 11 mm shallower.' },
    { name: 'tall (plug headroom)', params: { height: 115 }, note: 'More room above the board for stiff USB plugs.' },
    { name: 'vertical vents', params: { ui_vent_ang: 90 }, note: 'Slots along the print direction — stronger walls, slightly worse convection.' },
  ],
  dependsOn: [],
  build(params) {
    const P = resolve(pi_case, params);
    const D = piDims(P);
    const warnings = [];

    /* ---------------- cradle
       The three walls are built in their own planes as extruded Shapes with the
       vent slots / port window as real holes — exact, and far more robust than
       CSG-ing 60 overlapping slot prisms out of one shell. */
    const cr = [];
    // front wall (XZ plane, extruded along +Y)
    const frontHoles = ventChords(-29.5, 29.5, D.BOARD_Z0 + 3, D.ROOF_Z1 - 8, P.ui_vent_ang, []).map(ventPoly);
    cr.push(placePrism(polyG(roundRectPts(-D.OUT_X, D.OUT_X, D.FLOOR_Z1, D.ROOF_Z1, 1.2, 3), frontHoles, 0, D.wall),
      'XZ', D.FRONT_Y_IN, 1));
    // side walls (YZ plane, extruded along +X): port window + vents.
    // (the rev-I cable-tie slots sit entirely inside the port window, so there is
    //  nothing left for them to cut — overlapping holes would break the Shape.)
    const exc = [[D.PORT_Y[0] - 1, D.PORT_Y[1] + 1, D.PORT_Z[0] - 1, D.PORT_Z[1] + 1]];
    for (const sx of [1, -1]) {
      const holes = [roundRectPts(D.PORT_Y[0], D.PORT_Y[1], D.PORT_Z[0], D.PORT_Z[1], 2.0, 5)];
      const u1 = sx > 0 ? -59.5 : -56.5;
      for (const c of ventChords(D.LAND_Y + 4, u1, D.FLOOR_Z1 + 4, D.ROOF_Z1 - 6, P.ui_vent_ang, exc)) holes.push(ventPoly(c));
      cr.push(placePrism(polyG(roundRectPts(D.LAND_Y, D.FRONT_Y_IN, D.FLOOR_Z1, D.ROOF_Z1, 0.01, 1), holes, 0, D.wall),
        'YZ', sx > 0 ? D.WALL_IN_X : -D.OUT_X, 1));
    }

    // floor + mounting tabs (bolt holes and drop-in hook slots as Shape holes)
    const floorHoles = [];
    for (const sx of [1, -1]) floorHoles.push(roundRectPts(sx * 29.0, sx * 31.4, D.LAND_Y + 2.2, D.LAND_Y + 5.3, 0.01, 1));
    cr.push(polyG(roundRectPts(-D.OUT_X, D.OUT_X, D.LAND_Y, D.FRONT_Y_OUT, 1.5, 4), floorHoles, D.FLOOR_Z0, D.FLOOR_Z1));
    for (const sx of [1, -1]) {
      const disc = [];
      for (const [bx, by] of [[40, -80], [40, -60], [30.5, -76], [30.5, -64]]) disc.push(...circlePts(sx * bx, by, 3.75, 18));
      // clip the ear to the outboard side so it does not double up on the floor slab
      const half = sx > 0 ? [[D.OUT_X - 0.5, -200], [200, -200], [200, 200], [D.OUT_X - 0.5, 200]]
                          : [[-200, -200], [-(D.OUT_X - 0.5), -200], [-(D.OUT_X - 0.5), 200], [-200, 200]];
      const hull = clipConvex(convexHull(disc), half);
      if (hull.length < 3) continue;
      cr.push(polyG(hull, [circlePts(sx * 40, -80, 1.7, 14, false), circlePts(sx * 40, -60, 1.7, 14, false)], D.FLOOR_Z0, D.FLOOR_Z1));
    }
    // board standoffs (M2.5 pilots) + rest ledges
    for (const hx of D.HOLE_X) for (const hz of D.HOLE_Z) {
      cr.push(placePrism(tubeZ(hx, hz, 3.0, 1.1, 0, 5.0, 18), 'XZ', D.FRONT_Y_IN, -1));
    }
    for (const sx of [1, -1]) cr.push(boxG(sx * D.WALL_IN_X, sx * 27.5, -62.5, -59.0, D.BOARD_Z0 - 3, D.BOARD_Z0));
    // snap-in cable channel up the +X wall (C-section, mouth at +X)
    const cx0 = D.OUT_X - 0.5, cx1 = D.OUT_X + 6.0;
    cr.push(polyG([[cx0, -58.5], [cx1, -58.5], [cx1, -57.5], [cx0 + 2.0, -57.5],
                   [cx0 + 2.0, -52.5], [cx1, -52.5], [cx1, -51.5], [cx0, -51.5]], [], D.FLOOR_Z1, D.ROOF_Z1));
    // top latch hook on the -X landing strip
    if (P.ui_latch) {
      cr.push(placePrism(polyG([[D.LAND_Y, D.ROOF_Z1 - 5.0], [D.LAND_Y - 1.2, D.ROOF_Z1 - 5.0], [D.LAND_Y, D.ROOF_Z1 - 1.5]], [], 0, 2.0),
        'YZ', -34.0, 1));
    }
    const cradle = merge(cr);

    /* rear panel */
    const pHoles = [];
    pHoles.push(roundRectPts(-24, 24, D.FLOOR_Z1 + 1, D.BOARD_Z0, 1.2, 3));          // microSD arch
    for (const c of ventChords(-29.5, 29.5, D.BOARD_Z0 + 3, D.ROOF_Z1 - 8, P.ui_vent_ang,
      [[-29.5, -3.5, D.ROOF_Z1 - 20, D.ROOF_Z1 - 6]])) pHoles.push(ventPoly(c));
    if (P.ui_latch) pHoles.push(roundRectPts(-31.5, -30.7, 126.0, D.ROOF_Z1 - 0.8, 0.01, 1));   // latch isolating slot
    const plate = placePrism(
      polyG(roundRectPts(-D.OUT_X, D.OUT_X, D.FLOOR_Z0, D.ROOF_Z1, 1.5, 4), pHoles, 0, 3.0),
      'XZ', D.COVER_Y_OUT, 1);
    const pn = [plate];
    for (const sx of [1, -1]) {
      pn.push(boxG(sx * 29.3, sx * 31.3, D.LAND_Y, D.LAND_Y + 3.0, D.FLOOR_Z1 + 0.2, D.ROOF_Z1 - 0.2));
      pn.push(boxG(sx * 29.3, sx * 31.3, D.LAND_Y, D.LAND_Y + 5.0, D.FLOOR_Z1 + 0.2, D.FLOOR_Z1 + 2.7));
      pn.push(boxG(sx * 29.3, sx * 31.3, D.LAND_Y + 2.5, D.LAND_Y + 5.0, D.FLOOR_Z0 + 1.2, D.FLOOR_Z1 + 0.4));
    }
    const panel = merge(pn);

    if (P.front_clear < 20) warnings.push('Under ~20 mm the dual-fan ARMOUR cooler will not fit — measure yours before printing.');
    if (P.height > 120) warnings.push('Above ~120 mm the case starts to shadow the mast\'s lower cross tie; check the tie height.');
    if (P.ui_wall < 2.4) warnings.push('Walls under 2.4 mm are only 6 perimeters at 0.4 mm — the deck bolts will pull through.');

    const st = statsOf([cradle, panel]);
    return {
      meshes: [
        { name: 'pi_case_cradle', geometry: cradle, color: COL.pi, printable: true,
          printTransform: bedMatrix(cradle), filename: 'pi_case_cradle.stl' },
        { name: 'pi_case_panel', geometry: panel, color: COL.piPanel, printable: true,
          printTransform: bedMatrix(panel, new THREE.Matrix4().makeRotationX(Math.PI / 2)),
          filename: 'pi_case_panel.stl' },
      ],
      annotations: [
        { text: `cooler gap ${P.front_clear.toFixed(1)} mm`, at: [0, D.LAND_Y + 8, 100] },
        { text: `${P.height.toFixed(0)} mm tall, open top`, at: [0, -70, D.ROOF_Z1 + 6] },
        { text: 'USB-C + 2 × HDMI', at: [D.OUT_X + 8, -67, 88] },
      ],
      frames: {},
      warnings,
      stats: st,
    };
  },
};

export { pi_case };
