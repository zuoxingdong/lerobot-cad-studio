# DF200 forward arch — the wrist camera

**Sensor (−19.96, 0, 99.23) in the PincOpen frame, 35° below the finger direction, hFOV 87.3° /
vFOV 71.1° — the JR DF200 "100° without distortion" at 640 × 480, 4:3, rectilinear.** Two
printed plates: `arch` and `head`.

![exploded](img/exploded.png)

![assembled](img/assembled.png)

A gusseted arch off the camera seat that straddles the drive servo and carries **the same
insertable clamp pocket the corner mast uses** — same 36.4 × 36.4 pocket, same 3 mm lip, same
open rear, same 58 × 26 rev-8 retainer, same pocket shims. One pocket family, two cameras, and
**one head STL**. Every number it rests on is re-derived in this file and in the arch generator
that writes the meshes.

## What it bolts to

| | |
|---|---|
| seat | the PincOpen camera face, **Z = 19.50**, 4 × M2.5 at **X −41.27 / −26.27, Y ±18.91** |
| straddle | the **STS3215 drive servo** is a real component of the `pincopen` package (`sts3215_drive`): body Y ±12.40, X −53.2…−7.8, up to Z 42.5. The arch's rails run at **\|Y\| 14.8…27.1** — outboard of the servo *and* of the Motor_Flange's own legs (\|Y\| 14.4) — and its bridge crosses **over** the servo, humping from Z 44.5…49.5 at the legs to Z 57.5…62.5 over the connectors |
| the legs | **two true 4 mm plates**, at constant \|Y\| 22.6…26.6, coplanar with the cheeks they feed, each lightened by a 5.5 mm inset window: **0.10 %** of the arch's surface is under 1.2 mm thick |
| the rails | \|Y\| 14.8…27.1, 4.0 mm thick — out to the cheek's own outer face, so the legs stand **on** them |
| the front two screws | the Motor_Flange's own feet sit under the (−26.27, ±18.91) pair: 2.0 mm annular bosses whose tops measure Z **21.36–21.49** (+Y) and **21.52–21.68** (−Y). The arch's front pads start at Z **21.70** — they land on the higher foot with 0.02 mm and the lower one with 0.34 mm. The counterbore is Ø5.4 × **1.5**, leaving **2.50 mm**. The flange's body between the feet reaches Z 22.61, so the pad is relieved over \|Y\| ≤ 16.7 as well |
| tilt | a hinge detent, **30 / 35 / 40 / 45 / 50 / 55 / 60°** — ±15° in 5° steps — on one **M3 × 8** pin into a BLIND 3.0 mm seat, with the **M3 × 60** through-bolt as the hinge. **Shipped in the 35° hole.** The 5° steps are split over two rings (r 25 / r 33) so no two holes are closer than **4.36 mm**; a single ring at 5° needs r ≥ 36.7 mm just to make a 3.2 mm pitch and still leaves 0.3 mm of wall |
| mass | **42.0 g** of arch + head (20.2 + 13.7 cm³), or **49.4 g** with the shared retainer (+ 6.0 cm³), at 100 % PLA (1.24 g/cm³). The portal frame is leg + crossbar, with no gussets. That is the PRINTED parts only: with the DF200 module (~15–25 g) and the hardware the wrist carries ~65–75 g, still ~3 % of the STS3215's 30 kg·cm stall at 140 mm; a 4-wall/40 %-gyroid print is lighter again |

## What the DF200's 87.3° buys, measured from the lens's ENTRANCE PUPIL

`framing()` is the framing model in 3D, and `build()` writes the whole table into
`record.json → params.framing` — it is not a hand-carried table. It measures from the **entrance
pupil**, `PUPIL_FWD = 8.0 mm` in front of the sensor point (a real M12 board lens projects from
6–10 mm in front of it), and reports the 6 mm / 10 mm bracket beside every LED margin.

| detent | sensor | v(LED) | LED margin (8 mm) | at 6 / 10 mm | servo nose | v(grasp) | reach | gate |
|---|---|---|---|---|---|---|---|---|
| 30° | (−22.20, 0, 101.07) | 3.94 | **+13.95°** | +15.76 / +12.10 | +17.09° | 0.84 | ∞ (horizon in frame) | pass |
| **35° (shipped)** | **(−19.96, 0, 99.23)** | **3.42** | **+6.66°** | **+8.50 / +4.78** | **+13.67°** | **0.69** | **∞** | **PASS** |
| 40° | (−17.89, 0, 97.20) | 3.00 | **−0.61° ✗** | +1.25 / −2.53 | +10.15° | 0.55 | 1580 mm | fail |
| 45° | (−16.00, 0, 95.00) | 2.66 | −7.86° ✗ | −5.97 / −9.82 | +6.53° | 0.41 | 720 mm | fail |
| 50° | (−14.31, 0, 92.64) | 2.37 | −15.09° ✗ | −13.17 / −17.09 | +2.77° | 0.28 | 453 mm | fail |
| 55° | (−12.84, 0, 90.15) | 2.13 | −22.29° ✗ | −20.34 / −24.33 | −1.16° ✗ | 0.14 | 322 mm | fail |
| 60° | (−11.58, 0, 87.53) | 1.92 | −29.46° ✗ | −27.48 / −31.55 | −5.88° ✗ | 0.01 | 244 mm | fail |

Gates: the LED out with ≥ 4.7° of pinhole margin **at every pupil offset in the
bracket**, the servo's own forward-top corner out with the same margin, the grasp point
(X 55, Z −30) inside the frame, and both fingertips inside it closed **and** at 40 mm open.
*reach* = where the frame's top edge meets a table 30 mm below the pads.

**Only 30° and 35° pass.** 35° is shipped: it is the steeper of the two, so it keeps more
gripper-relative resolution, the grasp point sits at v 0.69 and both pads are inside the frame at
both jaw openings. Its top edge is above the horizon — indoors the ceiling takes the top of the
picture — which is the price of keeping the servo's LED out of it with a real lens instead of a
pinhole at the sensor plane.

The camera moves with the hinge, so each detent has its own sensor point and its own
`camera_matrix16`; both are in `record.json → params.framing`.

## Verified on the exported meshes

| check | result |
|---|---|
| swept insertion — a 36.4 × 36.4 × 11.3 corridor 40 mm out of the pocket, vs head + arch | **0.0017 mm³** (tessellation) |
| all 7 detents 30…60°, head + retainer vs the arch | **0.0000 mm³** each |
| a real Ø3.0 hinge bolt **and** a real Ø3.0 index pin at every detent | **0.0000 mm³** against arch, head **and the module** |
| plug envelope 18 × 22 × 16 mm and the full corridor 18 × 26 × 18.1 mm ∩ arch | **0.0000 mm³** |
| the whole gripper, jaw **0 → 40 mm**, all 22 `pincopen` components | `top_plate` **0.578 mm³** (the zero-thickness skin where the rails sit on the Z 19.50 seat — 0.003 mm deep) and `camera_basement` **456 mm³** (the upstream camera stand this arch replaces; remove it). **Everything else 0**, including `motor_flange` and `sts3215_drive` |
| wrist roll **−180 → +180°** in 15° steps, mount vs the wrist assembly | constant **479 mm³** against the stock SO-101 fixed jaw the PincOpen replaces — *less* than the **570 mm³** of the wrist mount this arch replaces, and inside the stated PincOpen ↔ wrist-flange registration error ("expect a few mm along +X") |
| fastener access — Ø7 × 60 / Ø3.6 × 60 / ball-end cast along all 9 axes against the assembled robot | **0 blocked**, 0 ball-end-only. The rear pair takes a 26.3 mm straight key from either side |
| wall thickness, 17-ray SDF probe with an opposing-face filter, 6000 samples | **0.10 %** of the arch's surface under 1.2 mm, 2.17 % under 1.6 mm, 1st-percentile wall **1.40 mm** |
| flat bed contact in the shipped print orientation | **398.5 mm²** |
| every mesh and plate | watertight, single body, plate parked on Z = 0.000000 |

**What the frame costs, measured.** At the DF200's real 87.3° and the shipped **35°** detent the
gripper fills **9.1 %** of the frame closed and **9.5 %** at a 40 mm opening, and the arch itself
contributes **0 %** — it is entirely behind its own lens.

**The arch's one real cost.** It sits *ahead of* the servo and looks along the fingers, so the
gripper's body is between the lens and the grasp centre; the studio's wrist chip therefore reads
`tip hidden` where a mount behind and above the fingers reads `tip in frame` with the jaw
closed. **The fingertips themselves are in frame at both jaw openings and at every passing
detent** (|u|, |v| well under 0.5), which is what a wrist camera is for — and a mount behind the
fingers shows the same `tip hidden` the moment the jaw opens. What the arch buys in exchange is the servo and
its LED leaving the frame by GEOMETRY rather than by tilt.

**Reproducibility.** The landmarks live in `gen_wristcam_arch.LANDMARKS` — LED (−26, 0, 39), the
servo's forward-top corner (−7.8, 0, 39), the grasp point (55, 0, −30) and the pad contact points
(66.7, 0, 0) closed and (72.059, 20, 0) at 40 mm — and `framing_table()` writes the whole table
from them plus `PUPIL_FWD`, so `build()` regenerates `record.json → params.framing` rather than it
being carried by hand.

**The module and its retainer.** `df200.stl` is the volumetric stand-in (36 × 36 × 11 body,
Ø20 × 9 barrel, Ø13 × 3 hood, 9 × 5 × 4 connector, sensor 4 mm behind the front face) seated in
the pocket at the shipped detent: module ∩ head **0.000 mm³**, connector ∩ retainer **0.000 mm³**
with the connector on the image-up axis through the retainer's 24 × 14 window, and the retainer
boss pressing the back face by **0.40 mm** (206 mm³ — the clamp preload). That preload is only as
repeatable as the print: 0.40 mm is *inside* the ±0.1 mm band, so the real clamp force lands
anywhere between **8 N and 58 N**. The pocket shims are the tuning element, not a nominal.

## Print

PLA, 0.2 mm, 4 perimeters, 40 % gyroid (the cantilever rule: stiffness, not strength).

| plate | bed | g | flat bed contact | overhang | worst span | wall < 1.2 mm | 1st-pct wall | supports |
|---|---|---|---|---|---|---|---|---|
| `arch` | 49.3 × 54.2 × 88.3 | 25.0 | **398 mm²** | 12.5 % | 22.5 mm | 0.10 % | 1.40 mm | **both cheek undersides, the fan's lower edge, the crown hump** |
| `head` | 43.4 × 68.5 × 17.5 | 17.0 | **976 mm²** | 5.5 % | 23.7 mm | 0.82 % | 1.46 mm | **under the two hinge-lug ends** |

**The arch prints UPRIGHT**, standing on its own two seat rails. The orientation that minimises
the overhang *percentage* (−45° about Y, 6.9 %) leaves **0.00 mm² of flat bed contact**: a tall
fork balanced on two points. A 168-orientation search:

| orientation | flat bed contact | overhang | bed size |
|---|---|---|---|
| **upright, as built (shipped)** | **398.5 mm²** | 12.49 % | 49 × 54 × 88 mm |
| −135° about Y | 31.8 mm² | 5.55 % | 79 × 54 × 68 mm |
| +90° about X (flat on a leg face) | 1330.4 mm² | 14.02 % | but ~900 mm² of that overhang is the far leg's underside floating 49 mm up — one huge supported slab |
| −45° about Y | **0.00 mm²** | 6.93 % | 68 × 54 × 79 mm |

Upright is the one that prints, and it makes the two rails — the faces that have to be flat,
because they are the datum the arch seats on — the first layer.

`head` goes **lens face down**, and it is **the same geometry as the corner mast's head**: the
blind index seats are cut in both side walls, so one print serves both mounts. On the arch only
the −Y fan cheek has pin holes: the two open holes on the head's +Y wall are unused seats. The retainer and
the pocket shims are the two shared print-only upgrades; this set ships neither.

**Bed-contact gate.** The print check FAILS any part taller than 20 mm with less than **20 mm² of
flat bed contact**, in the studio and in the generator's checks alike.

## Assembly access

The STS3215 hangs horn-down, so the face carrying its two 3-pin 2.54 mm sockets points **up** —
case back Z 39.0, socket shelf Z 40.8, pin tops Z 42.5 — and a 2.54 mm plug is ~10 mm tall before
its wires bend. So the crossbar **humps**: it keeps the Z 44.5 … 49.5 section outboard of \|Y\| = 26, where it
meets the legs, ramps up at **45°** between \|Y\| 26 and 13 (a 45° ramp is the difference
between a 1.80 mm and a **3.54 mm** perpendicular web on a 5.0 mm vertical section), and crosses
the connector band at **Z 57.5 … 62.5**. A separate, unconditional cut keeps the whole corridor
(X −54.2 … −6.8, \|Y\| ≤ 13, seat → Z 57.4) empty, so no later edit can close it again:
**18.1 mm** of clear air over the socket face, and a plug envelope and full corridor that both
measure **0.0000 mm³** against the arch. A **zip-tie lug** on the front of the crown anchors the
harness.

The four M2.5 seat screws each get a **Ø6.0 × 16 mm driver relief** above their counterbore. The
legs are at \|Y\| 22.6, 0.69 mm clear of the Ø6.0 relief, and the rail keeps 1.11 mm inboard of it.

The full fastener table, the tool definitions and the order of operations are in
**`ASSEMBLY.md`** in this folder.

## Renders

`exploded.png` and `assembled.png` above are the two renders this folder ships, both of the
shipped geometry at the shipped 35° detent.

The camera the studio uses is the one this folder publishes — `part.json → cameras.wrist`, in
the `attachment` frame, which the studio resolves to the slot's anchor on the wrist flange. On
the composed robot that anchor is the PincOpen assembly frame itself, so the fold is the
identity. Fitting this arch moves the wrist camera to **(−4.80, 243.86, 169.20) robot mm, 70°
nose-down** at the arm's zero pose.

## After installing

Measure the DF200's real hFOV (a checkerboard, or the same landmark fit used for the top
camera), then pick the detent from the table above and log the fitted extrinsics with the dataset.
Every detent's sensor point and 4 × 4 are already in `record.json → params.framing`.
