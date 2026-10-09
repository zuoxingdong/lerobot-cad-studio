# Corner mast, printed spar — the DEFAULT over-the-shoulder top camera

**Sensor (−75.34, −18.57, 504.85) robot mm — 538 above ground — 45° nose-down, panned 10° across
the workspace. hFOV 87.3° / vFOV 71.1° — the JR DF200 "100° without distortion" at 640 × 480,
4:3, rectilinear.** One mount: an all-PLA tapered spar in two halves, carrying the same camera
head as the wrist arch. The kit draws the camera module and its retainer seated in the pocket.

![exploded](img/exploded.png)

![assembled](img/assembled.png)

## Why not another overhead mast

Rev 8 stands on the deck centreline and looks 65° down, so **the arm works between the lens and
the task**: across the four standard poses the robot fills 22–45 % of the frame and the gripper
leaves frame in one. It sees 498 mm ahead — less than a body length, on a robot that drives.

One post on the rear-left corner puts the eye behind and outside the shoulder. The arm crosses
the field of view instead of running down it; the ground plane is oblique, so range is coded as
image position (92 → 838 mm of floor in one frame); the 75 mm lateral offset gives the wrist
camera a baseline to triangulate against rather than a second copy of the same view. And it is
outside the arm's raised envelope by construction, so it can be tall without being in the way:
**0 fouls over 289 forward-working poses and 0 vertices inside |X|<45, Y −100…325, Z<586**. Only
folded-back poses at pan +15…+50 touch it, and fewer of them than touch rev 8 (24 % of a 300-pose
folded band, against rev 8's 41 %).

The other half is **repeatable extrinsics**. Every adjustment is a positive index, never a
friction setting: tilt by a **detent hinge**; pan is fixed by the spigot's own section. Whatever
droop a printed head turns out to have, it is dialled out by moving one pin — and this one's
as-installed droop is **unmeasured**, so the package's calibration default is 0.

## The three plates

**This is the default overhead mount and it is three printed plates: `spar_lower`,
`spar_upper` and `head`.** No aluminium, no hardware store, nothing drilled, nothing
machined.

| plate | what | why |
|---|---|---|
| `spar_lower` | the lower spar **+ two gusset fins** | the spar's own foot is a 34 × 30 mm hollow box rooted in the printed deck plate, which is already a gusset; the plate has room for only two extra 6.5 mm fins (+Y 5.75 mm and −Y 6.5 mm of run — the deck bolts' Ø7.5 driver reliefs take the rest, and ±X gets none). 2098 mm² of bed contact, 1.0 % overhang |
| `spar_upper` | the upper spar, one part | the tapered spar grows the two hinge cheeks and the index fan **directly**: no collar, no seat disc, no clamp and no joint under the cheeks, so there is no spigot fit to hold a tolerance and no soft section where the lever arm is longest |
| `retainer` plate | **reference the shared plate** | the **Camera retainer plate** upgrade (`../cam_retainer/print/camera_retainer_PRINT.stl`) is the same solid to **0.005 mm**, measured on the exported meshes. Nobody should print two of them |
| `pocket_shims` plate | **reference the shared plate** | the **Camera pocket shims** upgrade (`../camera_shims/print/camera_shims_PRINT.stl`): 36 × 36 mm, **0.4 / 0.8 / 1.6 mm**, same 24 × 14 window, for the 36.4 mm pocket |

The head is the **rev-8 clamp block on its own** — 36.4 × 36.4 pocket, 3 mm lip,
genuinely open rear, two ears at ±24 mm on the image-up axis — hung between the two cheeks of
`spar_upper` on the image-right axis:

| | |
|---|---|
| hinge | one **M3 × 60** through both cheeks and both head lugs (the pin stack is **54.20 mm**, so an M3 × 55 leaves 0.80 mm of thread and takes no nut), at (n −4.0, up −33.0) from the sensor — outside the pocket (±18.2), outside the retainer plate (±29) and outside both driver axes (±24 ± 3), which is what makes all four fit at once |
| tilt index | a printed **fan on the outboard cheek**: 40 / 45 / 50 / 55 / 60 / 65 / 70°, one **M3 × 8** pin. 5° steps split over two rings (r 25 and r 33) so no two holes are closer than **4.36 mm** |
| the pin seat | **BLIND, 3.0 mm deep, and cut in BOTH side walls.** Blind at 3.0 the pocket is closed to light and dust, and an M3 × 8 leaves 2.60 mm in the seat and **0.00 mm³** in the module. Cutting both walls also makes this head the **same solid as the wrist arch's**: one plate, printed once, serves both mounts |
| pan | **fixed at the design 10°**, by the spigot's own section. There is no adjustment and no screw that could give one — that is the price of deleting the collar, the clamp and the pan ring. To change it, regenerate the spar with a different `pan_deg` |
| the clamps | **there are none.** This mount has no pinch clamp at all |
| the spigot | the Z 285 joint is a chamfered rectangle, so it carries the torque **and** fixes the pan: it goes together two ways round only, and a printed witness chevron on the −X face of each half says which. Clearance **0.350 mm per side laterally, 0.180 mm fore-aft** — measured on the exported meshes, and tighter in the plane the head's overhang bends the mast in. The chevrons are on −X because two of the three spigot screws come in on +X and a witness on their axis is a blocked screw |
| the cable duct | **vertical, on the block's mid-depth plane**, with 3.55 mm of wall behind it and 3.25 mm in front |
| the deck | **4 × M3 × 8 into M3 heat-set inserts**, not M3 × 12 + nuts. Three of the four bolts sit over the LiPo (pack top Z 46.5, deck underside Z 50.0). With a nut you fit it blind in a 3.5 mm slot with the bolt tip 1.3 mm off the pack; with an insert the screw stops at Z 51.8 and **nothing protrudes below the deck at all**. The deck's grid holes measure **Ø3.50** on the stock mesh and are opened to Ø4.0 first — the deck plate is **7.0 mm** thick (Z 50 → 57) and takes an M3 × 5.7 insert with 1.3 mm to spare |
| depth | the three pocket shims go behind a thin module so it still clamps solid. Tilt is a detent, not a shim |

### Acceptance, measured on the exported meshes

| check | result |
|---|---|
| swept insertion — a 36.4 × 36.4 × 11.3 corridor 40 mm out of the pocket, vs head + both spars | **0.0022 mm³** (tessellation; the box *is* the pocket, so the nominal clearance is 0.00 by construction) |
| the 7 detents 40…70°, head + retainer vs `spar_upper` | **0.0000 mm³** at every one |
| a real Ø3.0 hinge bolt **and** a real Ø3.0 index pin at every detent | **0.0000 mm³** against head, `spar_upper` **and the module** |
| fastener access — Ø7 × 60 / Ø3.6 × 60 / ball-end cast along all 12 axes against the assembled robot | **0 blocked**, 0 ball-end-only; 10 of 12 take a full Ø7 driver, the deck bolt at (−60, −40) takes 26 mm into its own Ø7.5 × 26 relief, and the hinge nut takes the full 14 mm nut-driver cast |
| arm-fouling sweep, **full** grid | **289 forward-working poses, 0 fouled (0.0 %)** |
| raised-arm envelope \|X\| < 45, Y −100…325, Z < 586 | **0 vertices inside** |
| camera pose at the shipped 45° detent vs the generator | **(−75.3399, −18.5711, 504.8547)**, error **0.000000 mm**, axis error 0 |
| every mesh and every plate | watertight, single body, plate parked on Z = 0.000000 |

**Hardware.** 4 × M3 × 5.7 heat-set inserts + 4 × M3 × 8 (deck) · 1 × M3 × 60 + nyloc (hinge) · 1 × **M3 × 8** (index pin) · 2 × M3 × 12
self-tapping (retainer) · **3 × M3 × 8** (the Z 285 spar spigot: 2 on +X, 1 on −Y).
**No aluminium, no pinch clamp, no nuts except the hinge nyloc, nothing drilled.**

**The one thin feature.** The 5° index needs two rings because a 4.36 mm pitch at r 25 leaves a
**1.16 mm web** between neighbouring Ø3.2 holes — about three extrusions at a 0.4 mm nozzle. It
is a *printability* limit, not a strength one: the pin carries **0.57 N** and 0.08 MPa.

The camera moves with the hinge, so the other detents have their own sensor points — they are in
`record.json → params.detent_cam_mm`: 40° (−75.67, −20.43, 507.06) … 70° (−74.26, −12.45, 491.88).

## The sweep

384 poses; tip-in-frame is over 726 floor / 670 table arm poses; coverage is rendered with the
real STLs in the scene. At **hFOV 87.3 / vFOV 71.1**, with the shipped meshes at every detent and
pans 5 / 10 / 15°. `ws %` is the share of the FRAME the reachable ground disc fills — the
tie-break once every gate passes:

| detent, pan 10° | robot % | floor | table | tip floor | tip table | ground (near→far) | ws % |
|---|---|---|---|---|---|---|---|
| 40° | 17.5 | 81 | 100 | 100 | 100 | 116→6863 | 15.1 |
| **45° (shipped)** | **4.6** | **88** | **100** | **100** | **100** | **69→3174** | **15.5** |
| 50° | 6.8 | 89 | 100 | 100 | 100 | 24→2034 | 14.3 |
| 55° | 8.6 | 89 | 100 | 100 | 100 | −21→1473 | 13.4 |
| 60° | 9.9 | 89 | 100 | 100 | 100 | −65→1136 | 12.9 |
| 65° | 10.9 | 88 | 100 | 100 | 100 | −110→908 | 12.8 |
| 70° | 11.9 | 88 | 100 | 100 | 98 | −157→742 ✗ | 12.9 |

Gates (tip ≥ 90 %, robot ≤ 20 %, floor ≥ 70 %, table visible, ≥ 0.8 m context) pass at
**40…65°**; 70° fails the context gate. **45° is shipped**: it is the minimum of robot-in-frame
(4.6 % against 8.6 % at 55°), the maximum of workspace-in-frame, its near edge lands at Y = 69 mm
— on the front wheels, so the robot's own deck stays out of the picture — and it still carries
3.2 m of context ahead. Pan matters much less than tilt at this FOV: at 45° the three pan
settings 5/10/15° give robot 7.7 / 4.6 / 8.2 % and floor 88 / 88 / 86 %.

One loss: the parked arm, folded over the deck, sits below the frame's near
edge.

## Stiffness, measured from the real sections

A 1-D beam solve over **EI(z) measured by sectioning the exported meshes at 1 mm stations** —
each part's second moment of area about the post axis by Green's theorem, ΣE·I for the
composite, head + retainer + module as lumps at their own centres of mass; tip deflection by
unit-load virtual work, first mode by the Rayleigh quotient on that same 1 g shape. Printed PLA at 2.5 GPa, 6061-T6 at 68.9 GPa.

| case | tip, fore-aft | tip, lateral | first mode |
|---|---|---|---|
| **printed spar, 3 plates — WHAT SHIPS** | **0.298 mm** | **0.259 mm** | **34.4 / 36.9 Hz** |
| a 15 mm aluminium tube in its place — *modelled, not shipped* | 0.243 mm | 0.252 mm | 35.8 / 35.1 Hz |
| *a rigid prop at Z 232 on the tube — **not shipped*** | *0.087 mm* | *0.088 mm* | *60.3 / 60.0 Hz* |

**Aluminium would buy less than it looks like it should.** The all-PLA mast is 23 % softer
fore-aft, 3 % softer laterally and 4 % lower in first mode than a tube in its place — because
the spar's 34 × 30 mm hollow section is a much bigger beam than a 15 mm tube even at a tenth of
the modulus. The same model reproduces the tube's published 0.240 mm / 33 Hz (0.243 / 35.8 here)
and the published braced 0.082 mm / 56 Hz (0.087 / 60.3), which is what validates it. It treats
the deck plate as rigid.

## Print

PLA, 0.2 mm, 3 walls, 20 % gyroid. Every plate below was measured on the **exported** file:
flat bed contact by the area of down-faces within 0.25 mm of Z min, overhang by area fraction
steeper than 45°, *unsupported span* as twice the distance from each steep down-face sample to
the nearest material in the layer 0.25 mm below it, and wall thickness by a 17-ray SDF cone with
an **opposing-face filter** (without that filter every convex edge reads as a zero-thickness
wall).

| plate | bed | g | flat bed contact | overhang | worst span | wall < 1.2 mm | 1st-pct wall | supports |
|---|---|---|---|---|---|---|---|---|
| `spar_lower` | 45.5 × 58.5 × **248.0** | 142.3 | **2098 mm²** | 1.0 % | 9.2 mm | 0.05 % | 2.80 mm | none — and **never support the inside**, it is hollow |
| `spar_upper` | 58.9 × 60.0 × **229.6** | 90.0 | **337 mm²** | 2.7 % | 18.3 mm | 0.02 % | 3.04 mm | build-plate only + an 8 mm brim |
| `head` | 43.4 × 68.5 × 17.5 | 17.0 | **976 mm²** | 5.5 % | 23.7 mm | 0.82 % | 1.46 mm | build-plate only, under the two hinge-lug ends |

**249.3 g of PLA in three prints**, and all of `spar_upper`'s overhang is in its last 60 mm (the
two cheeks and the fan). `head_PRINT` goes **lens face down** and is the *same STL* as the wrist
arch's head. `retainer` and `pocket_shims` are the shared plates; this set ships neither.

**Both halves need 250 mm of Z** — 248.0 and 229.6 mm. An MK4 (220 mm) will not take them; an
Ender 3 (250 mm) takes the taller one with 2.0 mm to spare. No shorter version of this mount
ships.

**Bed-contact gate.** The print check FAILS a part taller than 20 mm with less than **20 mm² of
flat bed contact**, in the studio and in the generator's checks alike. An overhang percentage
cannot see a tall part balanced on a point.

## Renders

`exploded.png` and `assembled.png` above are the two renders this folder ships, both of the
shipped geometry at the shipped 45° detent. They are pictures of the same meshes the studio
draws, so anything measured in this file is measured on the meshes, not on them.

## After installing

Photograph a known ground target, fit the tilt against it, move the index pin to the detent
that brings it back to the shipped 45°, and log the fitted extrinsics with the dataset. One pin, no reprint, and the sensor point of every detent is already in `record.json`.
