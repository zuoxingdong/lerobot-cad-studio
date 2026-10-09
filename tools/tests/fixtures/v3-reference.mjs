/* The v3 reference run's numbers, vendored, which the packages have to keep reproducing.
 *
 * `v3-reference.json` beside this file holds the wrist-mount matrix, each part's `frame`, and
 * for the 25 instanced `frame: "mesh"` parts the zero-pose `transform` and visual-origin
 * `local`; plus the ground truth for four arm presets and three extra FK poses, measured with
 * `armfk.py` (now `tools/sim/armfk.py`) + pyrender.  Nothing reads outside `studio/`. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STUDIO = path.resolve(HERE, '../../..');

const REF = JSON.parse(fs.readFileSync(path.join(HERE, 'v3-reference.json'), 'utf8'));

/** `{ parts: { id: { frame, transform?, local? } } }` — the v3 asset table, trimmed. */
export function v3Assets() { return REF; }

/** The v3 `profiles/lekiwi.json` frames the v4 packages still have to match. */
export function v3Frames() { return { wrist_mount: REF.wrist_mount }; }

/** The four verified arm presets, degrees. */
export const PRESETS = {
  stowed: { arm_shoulder_pan: 0, arm_shoulder_lift: 40, arm_elbow_flex: 77, arm_wrist_flex: -54, arm_wrist_roll: 0, arm_gripper: 0 },
  'reach floor': { arm_shoulder_pan: 0, arm_shoulder_lift: 20, arm_elbow_flex: -76, arm_wrist_flex: 99, arm_wrist_roll: 0, arm_gripper: -30 },
  'reach table': { arm_shoulder_pan: 0, arm_shoulder_lift: 9, arm_elbow_flex: 35, arm_wrist_flex: 8, arm_wrist_roll: 0, arm_gripper: -30 },
  'raised max': { arm_shoulder_pan: 0, arm_shoulder_lift: -49, arm_elbow_flex: 100, arm_wrist_flex: 86, arm_wrist_roll: 0, arm_gripper: 0 }
};

/** Three more poses the FK check exercises (no published tip numbers — FK consistency only). */
export const EXTRA_POSES = {
  zero: {},
  'lift −60 / elbow 45 / wrist 40': { arm_shoulder_lift: -60, arm_elbow_flex: 45, arm_wrist_flex: 40 },
  'pan 30 / lift −90': { arm_shoulder_pan: 30, arm_shoulder_lift: -90 }
};
