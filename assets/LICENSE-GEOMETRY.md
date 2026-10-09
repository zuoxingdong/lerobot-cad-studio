# Geometry licences

Code in this repository is Apache-2.0 (`../LICENSE`). Geometry is not all one licence.
Two upstream projects ship under different terms, and a derived part keeps its source's terms.
Paths below are relative to this folder, `assets/`.

## CC BY-SA 4.0 — PincOpen and its derivatives

Upstream: [PincOpen](https://github.com/pollen-robotics/PincOpen), Pollen Robotics,
commit `1b5a3dc`, Creative Commons Attribution-ShareAlike 4.0 International.
Share-alike: an adaptation must be offered under the same licence, with attribution.

| path | what it is |
|---|---|
| `robots/pincopen/meshes/` (all but `STS3215_03a-v1.stl`) | the 14 upstream meshes, verbatim |
| `robots/pincopen/robot.json` | registered placements of those meshes: the attachment package, not a robot of its own |
| `robots/lekiwi-pincopen/robot.json` | the composed robot, which attaches them |
| `parts/df200_arch/` | the wrist arch, fitted to the PincOpen camera seat |
| `parts/_shop/lekiwi_camera_mounts.3mf` | the print-shop kit; mixed: its wrist-arch objects (4, 5) are CC BY-SA, the rest Apache-2.0 |

The decimated copies of these meshes inside `../src/data/packed.js` and the gripper's meshes in
`../site/lab/movers.glb` (+ `.js`) are adaptations too, as are renders that show the gripper
(`../site/media/`, the hero film, `robots/lekiwi-pincopen/thumb.png`).

## Apache-2.0 — LeKiwi, SO-101 and our own parts

Upstream: [LeKiwi](https://github.com/SIGRobotics-UIUC/LeKiwi), SIGRobotics-UIUC,
commit `efa608d`, Apache License 2.0. It carries the SO-101 arm meshes.

| path | what it is |
|---|---|
| `robots/lekiwi/urdf/`, `robots/lekiwi/meshes/`, `robots/lekiwi/print/` | upstream, verbatim (`print/`: the plates a component uses) |
| `robots/pincopen/meshes/STS3215_03a-v1.stl` | the Feetech servo, copied from LeKiwi |
| `parts/corner_mast_printed/` | the deck corner mast |
| `parts/cam_retainer/`, `parts/camera_shims/` | the shared camera pocket plates |
| `parts/pi_case_vertical/` | the Raspberry Pi case (cradle and panel) |
| `scenes/lab/` | the biolab workcell: `scene.json`, `decor.json` and the props `tools/build/make_lab.py` generates |
| `../site/lab/` (but the gripper in `movers.glb`) | the baked lab, from the models in `tools/render/blender/models/`; its CC0 texture credits are in `../site/lab/ATTRIBUTION.md` |

These parts are built from measured LeKiwi deck dimensions, not from PincOpen meshes.

## Attribution

Copies of both upstream licences ship with the packages:
`robots/lekiwi/LICENSE-upstream.txt` (Apache-2.0, also the licence of the one LeKiwi motor mesh
the PincOpen package carries) and `robots/pincopen/LICENSE-upstream.txt`. Each package's
`SOURCE.md` names its commit.
