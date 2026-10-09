# `pincopen` — Pollen Robotics PincOpen gripper

A printable parallel gripper for the SO-101 wrist, with a camera seat on its top plate. Upstream:
[pollen-robotics/PincOpen](https://github.com/pollen-robotics/PincOpen), **CC BY-SA 4.0**.
Provenance: below.

This is an **attachment** package (`"kind": "attachment"`): it has no base link and no host. A robot
package mounts it — `lekiwi-pincopen` does, at `lekiwi`'s `frames.wrist_flange`.

```
robot.json       generated - components, the jaw joint, slots, frames
meshes/*.stl     the 14 upstream cad/stl originals, verbatim, and the reused STS3215
```

## Where the placements came from

Upstream ships **14 loose STLs and no assembly information** — no URDF, no STEP assembly, no
transform table. Every placement in `robot.json` was **derived by registration**, not by eye:

1. The PincOpen mods `ORIGINAL_INPLACE_*.stl` (off-repo) were built from these same files by mesh CSG
   in the assembly frame, so each original appears there as an exact rigid copy of itself.
2. Each assembly is split into connected bodies; CSG sliver debris is dropped.
3. A body is matched to a source by **sorted bounding-box extents**, not volume: several upstream
   STLs are not closed the way trimesh expects (`Motor_Flange` reports 2.5× its true volume), so
   volume is only a tie-break.
4. ICP is seeded from **all 48 signed permutations** of the two principal frames and the best few are
   refined. A single principal-axis seed — what `trimesh.registration.mesh_other` does — lands in a
   local minimum on near-symmetric bodies.
5. A rigid fit wins ties; a reflection is kept only when it is decisively better, because a negative
   determinant flips face winding and renders inside-out.
6. Residual = point-to-surface distance of 4000 surface samples. It is recorded **per instance** in
   `components[].registration` and summarised in `derivation`.

Result, committed: `tools/build/inputs/pincopen_registration.json`. The registration run needs the
off-repo assemblies above, so it does not ship with the studio.

## Frame

Assembly frame, millimetres, reverse-engineered in the PincOpen mods README (off-repo) and
verified there by point-containment against the meshes:

* **Y = 0** is the jaw mirror plane. The exported state is fully closed.
* **+X** is the fingertip direction; the nose is at X = 70.64, the back face at X = −53.492.
* **Z** is the finger width axis (±12.86).
* Hinges, all parallel to Z: **(34.64, −12.50) (34.64, −24.00) (0, −32.50) (0, −44.00)** — M3
  self-tapping, Ø3.00 anchor holes and Ø3.25 running holes.
* Fingertip pattern: **3 × M2** at (X 51.64, Z ±3.50) and (X 61.64, Z 0), blind from the Y = −7.75
  face. Contact face Y = 0, 57.8 mm² as shipped.
* Camera seat: **Z = 19.50**, hole pattern **15.00 × 37.82** at X −41.27 / −26.27, Y ±18.91.

## Kinematics - the four-bar is a real chain

The four hinge coordinates make this a **parallelogram** four-bar: both bars are 39.999 mm and both
pairs are 11.50 mm apart, so the coupler keeps its **orientation** — which is what makes this a
parallel-jaw gripper. It does **not** slide, though: a parallelogram coupler travels on an **arc**,

```
finger(q) − finger(0) = L · [ cos(θ₀ − q) − cos θ₀ ,  −(sin θ₀ − sin(θ₀ − q)) ]
```

so between closed and wide open the −Y finger moves **−20.000 mm in Y and +5.359 mm in X**. An
earlier version of this package modelled the fingers as prismatic slides along ±Y and animated the
two bars separately; that threw the X term away and left every bar end off its finger pivot
(2.13 mm at an 8.5 mm gap, 5.36 mm wide open). The bars are links now:

| joint | type | parent → child | origin | value |
|---|---|---|---|---|
| `jaw` | revolute ‖Z | `body` → `jaw_ref` | (0, 0) | **0 … 30.0007°** — the single control joint, the OPENING ANGLE |
| `jaw_rod_L` | revolute ‖Z | `body` → `rod_L` | (0, −32.50) | `mimic: jaw × −1` — the −Y Internal_Rod |
| `jaw_rod2_L` | revolute ‖Z | `body` → `rod2_L` | (0, −44.00) | `mimic: jaw_rod_L × 1` — the −Y External_Rod |
| `jaw_finger_L` | revolute ‖Z | `rod_L` → `finger_L` | (34.64, 20.00) in `rod_L` | `mimic: jaw_rod_L × −1` — the coupler, cancelling the bar |
| `jaw_rod_R` / `jaw_rod2_R` / `jaw_finger_R` | | | mirrored in Y | `jaw × +1` and the same two follow-ons |

The mirror sign is written down in exactly one place per side (`jaw_rod_L` = `−jaw`,
`jaw_rod_R` = `+jaw`); everything else follows from the parallelogram.

`jaw = 0` is fully closed — the exported state of every STL here — and

```
gap_mm(q) = 2 · L · (sin θ₀ − sin(θ₀ − q))      L = 39.9991 mm, θ₀ = 30.0007°
```

reaches **40.0 mm** at q = θ₀, where the bars are horizontal. Verified by posing the registered
meshes through the chain: **0° → −0.012 mm, 10° → 12.626 mm, 20° → 26.095 mm, 30.001° → 39.988 mm**,
agreeing with the formula to 1.5 × 10⁻⁵ mm, and every bar's distal pivot stays on the finger pivot
it drives to 0 mm. The 30.001° limit is the linkage's own geometric bound, not an upstream
specification — upstream publishes no joint range.

`kinematics.control_display.jaw` publishes the gap mapping (`kind: "fourbar_gap"`) so a UI can show
the slider as **0 … 40 mm of finger gap** while the joint itself stays an angle.

Which bodies move was **measured**, as the distance from each body to the four hinge axes:

| body | g(0,−32.5) | g(0,−44) | c(34.64,−12.5) | c(34.64,−24) | role |
|---|---|---|---|---|---|
| Top_Plate / Bottom_Plate | 0.00 | 0.01 | 31.7 | 30.7 | ground |
| Internal_Rod | **1.50** | 5.21 | **1.50** | 5.49 | rotating link |
| External_Rod | 7.93 | **1.62** | 7.00 | **1.62** | rotating link |
| Distal_Rod | 30.9 | 35.3 | **1.62** | **1.50** | the coupler bar |
| Distal_Shell / Removable_Tip / Tip_Support | 40+ | 43+ | 5.7–7.1 | 5.7–17.1 | ride the coupler |

So `Distal_Rod`, `Distal_Shell`, `Removable_Tip` and `Tip_Support` carry `frame: "link"` on
`finger_L` / `finger_R`; `Internal_Rod` sits on `rod_L` / `rod_R` and `External_Rod` on
`rod2_L` / `rod2_R`. Everything else stays `frame: "robot"` on `body`. A moving part's `local` is
expressed in **its own link frame**, so `FK(link) · local` reproduces the registered placement
exactly at the zero pose and moves it correctly at every other angle — nothing outside the chain
has to animate anything. `kinematics.linkage.bars` keeps the pivots and lengths as reference data.

**Still an approximation:** the two `Driving_Rod` instances (the servo levers at
(−22.5, ∓27.1, −5.7)) stay on `body`. They really do turn with the servo, but upstream publishes no
pivot for them and the registration found none — the four hinges above are the only ones that were
reverse-engineered and verified. They are the only PincOpen parts that do not move with the jaw.

## Slots

`fingertips` — the `Tip_Support` + `Removable_Tip` pair on each finger, with the mount interface
(hole pattern, screw type, contact area) in `slots.fingertips.interface` so the swap popover and
"Ask an AI agent" have real numbers to hand over.

### Share-alike

CC BY-SA 4.0 is copyleft. The registered placements, `robot.json` and the decimated copies inside
`src/data/assets.js` are adaptations and carry the same licence, with attribution to Pollen Robotics.

## Regenerate

```bash
nice -n 10 python3 tools/build/make_robots.py --only pincopen    # from studio/
```

It reads the committed registration result; the registration itself is not re-run from a clone.

## Source of `meshes/`

| | |
|---|---|
| Repository | https://github.com/pollen-robotics/PincOpen |
| Commit | `1b5a3dc83cb4eae042d535bda3765b9e12a9b8a7` ("Add Xingdong Zuo's blog post", 2026-06-16) |
| Licence | Creative Commons **Attribution-ShareAlike 4.0 International** (CC BY-SA 4.0) |
| Fetched | 2026-09-13 |
| Fetched by | `tools/build/fetch_sources.sh --copy` (the commit is pinned in that script) |

### What was copied, verbatim and unmodified

`meshes/` holds upstream `cad/stl/`, all 14 files:

```
Bottom_Plate  Cam  Camera_basement  Camera_mobile_sup  Distal_Rod  Distal_Shell
Driving_Rod   External_Rod  Interface_ARM100  Internal_Rod  Motor_Flange
Removable_Tip Tip_Support  Top_Plate
```

Files are **copied, not symlinked**. A copy of the upstream licence is `LICENSE-upstream.txt`.

### `meshes/STS3215_03a-v1.stl` — the one part upstream does not ship

Upstream ships the eleven printed parts and nothing else, so the **motor** — the part that
actually drives the Cam — had no mesh. PincOpen reuses the SO-101 gripper's own Feetech STS3215
(upstream README: *"the same motor as the current gripper can be used"*), so the mesh is taken
from the LeKiwi package rather than invented:

| | |
|---|---|
| File | `meshes/STS3215_03a-v1.stl` |
| Repository | https://github.com/SIGRobotics-UIUC/LeKiwi |
| Commit | `efa608d7ee5a495a4803b1d28cd0c955b4f1e033` |
| Upstream path | `URDF/meshes/STS3215_03a-v1.stl`, copied verbatim |
| Licence | **Apache-2.0** — the LeKiwi package's `../lekiwi/LICENSE-upstream.txt` |

It is a **different licence from the rest of this package**: the STL is Apache-2.0 and stays
Apache-2.0; nothing else in `meshes/` was combined with it, only placed beside it.

`components[].id = "sts3215_drive"` is `group: "hardware"`, `printable: false`, and carries a
`placement` block instead of a `registration` one — there is nothing to register a bought part
against. It was **seated** on three interfaces the package's own meshes define, each measured on
the exported geometry: the motor's horn-side shoulder on the Top_Plate slot rails (Z 7.2025,
residual 0.0000 mm), its back mounting-hole pair on the Motor_Flange's two holes (X −26.27 /
Y ±10.245, residual 0.025 / 0.005 mm) and its nose face on the Top_Plate inner wall (X −7.83,
residual 0.030 mm) — which is assembly steps 30–32 of the upstream guide, in that order. The
horn face then lands 0.25 mm off the Cam's top face and the back face 0.13 mm off the flange
strap; both are recorded as `placement.checks`.

### Share-alike notice

CC BY-SA 4.0 is a copyleft licence. `robot.json` and anything derived from these meshes (the
registered placements, the decimated copies embedded in `src/data/assets.js`) are
**adaptations** and are therefore offered under the same CC BY-SA 4.0 terms, with attribution to
Pollen Robotics. Code in this repository (the studio itself) is a separate work and keeps its own
licence — see `../../LICENSE-GEOMETRY.md`.

### Units and frames

The STLs are in **millimetres**, each in its own CAD frame with no assembly information: upstream
ships no URDF, no STEP assembly and no transform table. The placements in `robot.json` were
**derived by registration**, not by hand: see "Where the placements came from" above.
