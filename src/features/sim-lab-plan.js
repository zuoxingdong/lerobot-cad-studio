/* The enzyme-screen task as data: the controller constants and the 32-phase script over the
   sidecar `lab` block (rps/lab@2, world mm).  sim-lab.js runs it; nothing here touches MuJoCo. */

import { LIMIT_BAND_DEG } from './sim-ik.js';

const D2R = Math.PI / 180;

export const LAB = {
  approachAbove: 0.06, placeAbove: 0.05, viaMm: 30, lineViaMm: 5, liftClear: 0.07, insertAir: 0.002,
  carryRobotMm: [0, 200, 400], gripPitchDeg: 0, jawOpenMm: 25, squeezeMm: 1.5, backoffMm: 150,
  jawDegS: 40, closeDegS: 24, tiltOkDeg: 5, inNestTolMm: 0.5, seatedTolMm: 2.5,
  settleMm: 2, settleDeg: 1, viaSettleMm: 40, viaSettleDeg: 5, armSettledDeg: 1.5, releaseSettleS: 0.5, heldRelMmS: 12,
  armDwellS: 0.1, driveDwellS: 0.2,
  driveAMax: 0.6, driveAlphaMax: 2.1, driveGain: 4, saturatedFrac: 0.99, sliceMs: 0, resultBeatS: 1.5,
  ikMarginDeg: 2 * LIMIT_BAND_DEG,              // IK stays this far from a stop: servo lag stays outside the band
};

/* the lab plan's phase ids as words: drive_inc -> "Drive to the incubator" */
const AT = { lh: 'the liquid handler', inc: 'the incubator', reader: 'the reader' };
const NEST = { lh: 'LH', inc: 'incubator', reader: 'reader' };
const PHASE = [
  [/^dock$/, () => 'Docked'], [/^ready$/, () => 'Ready the arm'], [/^drive_(lh|inc|reader)$/, (x) => `Drive to ${AT[x]}`],
  [/^approach_(\w+)$/, (x) => `Above the puck (${NEST[x]})`], [/^descend_(\w+)$/, (x) => `Down to the handle (${NEST[x]})`],
  [/^grasp_(\w+)$/, (x) => `Grip the puck (${NEST[x]})`], [/^lift_(\w+)$/, (x) => `Lift out of the ${NEST[x]} nest`],
  [/^carry_(\w+)$/, () => 'Carry pose'], [/^place_(\w+)$/, (x) => `Above the ${NEST[x]} nest`],
  [/^insert_(\w+)$/, (x) => `Seat in the ${NEST[x]}`], [/^release_(\w+)$/, (x) => `Release in the ${NEST[x]}`],
  [/^retreat_(\w+)$/, () => 'Clear the nest'], [/^stand_(\w+)$/, () => 'Stand up'], [/^backoff_(\w+)$/, () => 'Back off for the lid'],
  [/^wait_inc$/, () => 'Incubating 37 °C'], [/^return_(\w+)$/, (x) => `Return to ${AT[x]}`], [/^drive_mid$/, () => 'Turn at mid-bay'],
  [/^drive_dock$/, () => 'Return to dock'], [/^stow$/, () => 'Stow'], [/^report$/, () => 'Read the result'],
];
export function phaseName(id) {
  for (const [re, t] of PHASE) { const x = re.exec(id); if (x) return t(x[1]); }
  return String(id).replace(/_/g, ' ').replace(/^\w/, (m) => m.toUpperCase());
}

const rot = (yawDeg, [x, y]) => { const c = Math.cos(yawDeg * D2R), s = Math.sin(yawDeg * D2R); return [x * c - y * s, x * s + y * c]; };

/** Task geometry in metres / radians from the sidecar lab block. */
export function labGeometry(lab, C = LAB) {
  const byId = Object.fromEntries(lab.stations.map((s) => [s.id, s]));
  const need = (id) => { const s = byId[id]; if (!s) throw new Error(`lab has no station "${id}"`); return s; };
  const pose = (p) => [p[0] / 1000, p[1] / 1000, p[2] * D2R];
  const park = (id) => pose(need(id).park);
  const backoff = (id) => {
    const s = need(id), [dx, dy] = rot(s.yaw, [0, -C.backoffMm]);
    return pose([s.park[0] + dx, s.park[1] + dy, s.park[2]]);
  };
  const via = lab.waypoints.find((w) => w.id === 'via_mid') || lab.waypoints.find((w) => w.via);
  return {
    station: need, park, backoff,
    via: via ? pose(via.pose) : null,
    dock: pose(lab.dock),
    nest: (id) => need(id).nest,
    prop: lab.props[0],
  };
}

/**
 * The phase script.  `pt` builds the arm targets at phase start (world metres):
 * pt.grip(id, dz), pt.slot(id, dz).  Kinds: hold, arm, drive, grasp, release, wait.
 */
export function labPlan(G, C, pt, stowed, inst) {
  const P = C.carryRobotMm, J = C.jawOpenMm;
  // vertical lines near contact (mm/s): dense IK, slow over the part inside the collar or at the post
  const down = { fast: 100, slow: 30, slowEndMm: 12 }, up = { fast: 100, slow: 30, slowStartMm: 12 };
  const seat = { fast: 70, slow: 8, slowEndMm: 10 };
  const pick = (id) => [
    { kind: 'arm', name: `approach_${id}`, station: id, point: () => pt.grip(id, C.approachAbove), jaw: J, branch: true, max: 7 },
    { kind: 'arm', name: `descend_${id}`, station: id, point: () => pt.grip(id, 0), jaw: J, line: down, max: 5 },
    { kind: 'grasp', name: `grasp_${id}`, station: id, max: 4 },
    { kind: 'arm', name: `lift_${id}`, station: id, point: () => pt.grip(id, C.liftClear), line: up, max: 5 },
    { kind: 'arm', name: `carry_${id}`, station: id, robot: P, max: 6, measure: true },
  ];
  const place = (id) => [
    { kind: 'arm', name: `place_${id}`, station: id, point: () => pt.slot(id, C.placeAbove), branch: true, max: 7, rehold: true },
    { kind: 'arm', name: `insert_${id}`, station: id, point: () => pt.slot(id, 0), line: seat, max: 6 },
    { kind: 'release', name: `release_${id}`, station: id, max: 3 },
    { kind: 'arm', name: `retreat_${id}`, station: id, point: () => pt.slot(id, C.placeAbove), jaw: J, line: up, max: 6 },
    { kind: 'arm', name: `stand_${id}`, station: id, robot: P, jaw: J, max: 8 },
  ];
  return [
    { kind: 'hold', name: 'dock', arm: stowed, jaw: 0, dur: 1.5 },
    { kind: 'arm', name: 'ready', robot: P, jaw: J, branch: true, max: 8 },
    { kind: 'drive', name: 'drive_lh', pose: G.park('lh'), max: 9 },
    ...pick('lh'),
    { kind: 'drive', name: 'drive_inc', pose: G.park('inc'), max: 12 },
    ...place('inc'),
    { kind: 'drive', name: 'backoff_inc', pose: G.backoff('inc'), max: 6 },
    { kind: 'wait', name: 'wait_inc', station: 'inc', until: () => inst.state('inc') === 'done', max: 12 },
    { kind: 'drive', name: 'return_inc', pose: G.park('inc'), max: 6 },
    ...pick('inc'),
    { kind: 'drive', name: 'drive_mid', pose: G.via, via: true, max: 9 },
    { kind: 'drive', name: 'drive_reader', pose: G.park('reader'), max: 12 },
    ...place('reader'),
    { kind: 'drive', name: 'drive_dock', pose: G.dock, max: 12 },
    { kind: 'hold', name: 'stow', arm: stowed, jaw: 0, dur: 1 },
    { kind: 'wait', name: 'report', station: 'reader', until: () => inst.state('reader') === 'done', beat: C.resultBeatS, max: 10 },
  ];
}

/** The instrument half of a caption, from a snapshot's stations: '' when nothing is happening. */
export function instrumentCaption(st) {
  const inc = st?.inc, rd = st?.reader;
  if (rd && rd.state === 'done') return 'ART-3: hit → next design round';
  if (rd && rd.state === 'running') return `Reading fluorescence · ${rd.remaining.toFixed(1)} s`;
  if (rd && ['closing', 'opening'].includes(rd.state)) return `Reader hood ${rd.state}`;
  if (inc && inc.state === 'running') return `Incubating 37 °C · ${inc.remaining.toFixed(1)} s`;
  if (inc && ['closing', 'opening'].includes(inc.state)) return `Incubator lid ${inc.state}`;
  if (inc && inc.state === 'done') return 'Incubation done';
  return '';
}
