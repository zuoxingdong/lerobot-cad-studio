# Redesign: Overhead camera mount on LeKiwi + PincOpen

## 1 Role
You are designing a 3D-printable replacement for one part of a LeKiwi + PincOpen robot.
Deliver files in the folder layout of section 7; the studio picks them up and checks them.

## 2 Robot
- LeKiwi + PincOpen (`lekiwi-pincopen`), source https://github.com/SIGRobotics-UIUC/LeKiwi@efa608d.
- Units mm. Frame: +X right, +Y forward, +Z up. Ground Z = -32.9 mm.

## 3 Target
- Slot `top_camera_mount` (Overhead camera mount); fitted now: `corner_mast_printed` (Corner mast, printed · 45°).
- Parts, robot frame, bbox = X × Y × Z extent:
  - `spar_lower` Corner mast (printed) · lower spar + deck base: 45.5 × 58.5 × 248 mm, 114.7 cm³, 142 g, printed.
    The deck plate and the tapered hollow spar in one part, Z 57 to the Z 285 spigot, with 3.5 mm walls. 4x M3 × 8 into M3 heat-set inserts in the deck grid, a Ø7.5 × 26 driver relief above every bolt,…
  - `spar_upper` Corner mast (printed) · upper spar + yoke: 58.9 × 60 × 229.6 mm, 72.6 cm³, 90 g, printed.
    Z 285 to the top of the index fan: the spar AND the yoke in one part. The tapered section grows the two hinge cheeks, the M3 × 60 hinge (54.2 mm of stack) and the 40..70° index fan directly - no…
  - `head` Corner mast · camera head: 52 × 61.9 × 57.2 mm, 13.7 cm³, 17 g, printed.
    The clamp block alone: 36.4 × 36.4 pocket, 3 mm lip, OPEN REAR, two ears. The tilt index seats are BLIND, 3.0 mm deep, and cut in BOTH side walls, which is what makes this ONE STL for the corner…
  - `retainer` Corner mast · camera retainer: 32.3 × 46.5 × 43.9 mm, 6 cm³, 7 g, printed.
    The 58 × 26 retainer plate with its 24 × 14 cable window, at its seated pose on the head's ears. NOT a plate of this set: print the shared "Camera retainer plate" upgrade instead. It is the same…
  - `df200` Corner mast · DF200 module (stand-in): 41.2 × 39 × 33.9 mm, 17.6 cm³, hardware (bought).
    The JR DF200 module itself, as a volumetric stand-in: 36 × 36 × 11 body, Ø20 × 9 lens barrel, Ø13 × 3 hood, 9 × 5 × 4 rear connector, sensor 4 mm behind the front face. Seated in the pocket at the…
- Param `tilt_deg`: hinge detents 40–65° usable (70° exists but fails the camera checks), now 45°; turns `head`, `retainer`, `df200` about (-0.985, 0.174, 0) through (-79.9, -44.3, 484.3) mm.

## 4 Hard interface (must hold)
- Anchor `deck_top_centre_rear`: origin (0, -36.5, 57) mm; axes X (1, 0, 0), Y (0, 1, 0), Z (0, 0, 1).
  4×4, column-major: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -36.5, 57, 1]
- Mount (deck_grid): 4 bolts at (-60, -60) (-60, -40) (-60, -20) (-80, -20) mm (X, Y); mating face through (-63.1, -33.5, 57) with normal (0, 0, -1).
- deck_grid: M3 bolt grid on the top deck: 20 mm pitch at Z 57, usable radius 107 mm, holes 3.5 mm (M3 clearance), M3 heat-set inserts
- Camera `top`: hFOV 87.3°, vFOV 71.1°, aspect 4:3; the real lens, do not change it.
  Sensor now at (-75.3, -18.6, 504.9) mm, looking along (0.123, 0.696, -0.707) (pose = cameras.top.local: looks down its local -Z, +Y up).
  It may move with the part: write its new pose in cameras.top.local; the studio re-checks what it sees.
- Keep-outs: the arm sweep at the presets; the deck edge: stay inside the 107 mm grid radius; neighbours.stl holds the parts around the slot.
- Bed 256 × 256 × 256 mm (Bambu Lab A1 / P1S), PLA, max overhang 45° from vertical.

## 5 Self-check before you finish (the studio runs these)
- Closed: every STL is watertight, no open or non-manifold edges.
- Single body: one connected shell per STL.
- Fits the bed: each print plate inside 256 × 256 × 256 mm (a 90° turn is allowed).
- Overhang: under 15 % of the surface faces down more than 45° from vertical, as printed.
- Bed contact: a plate taller than 20 mm stands on at least 20 mm² of flat first layer.
- Clearance: no overlap with neighbours.stl (the robot at stowed, reach_floor, reach_table, raised_max).
- Camera: a pose is published for `top`, the camera this slot provides.
- Camera: the robot fills little of the frame; the fitted mast gives 4.6 % at 45°.
- Limits: under 500,000 faces in all; everything within 1.5 m of the anchor.
- part.json parses, has schema rps/part@1, and every file it names exists.

## 6 Context pack
In `lekiwi-designs/_context/top_camera_mount/` (or the unzipped `top_camera_mount-context.zip`):
- `README.txt`: what each file is and where to write the result
- `prompt.md`: this prompt
- `current/spar_lower.stl`: `spar_lower` as fitted, robot frame, mm
- `current/spar_lower_print.stl`: `spar_lower` in its print orientation
- `current/spar_upper.stl`: `spar_upper` as fitted, robot frame, mm
- `current/spar_upper_print.stl`: `spar_upper` in its print orientation
- `current/head.stl`: `head` as fitted, robot frame, mm
- `current/head_print.stl`: `head` in its print orientation
- `current/retainer.stl`: `retainer` as fitted, robot frame, mm
- `current/df200.stl`: `df200` as fitted, robot frame, mm
- `interface.json`: anchor, mount, cameras, keep-outs, full part notes
- `neighbours.stl`: deck, Pi case and the arm at the four presets, decimated, robot frame
- `part.json`: the template of section 7
- `checks.json`: the section 5 thresholds and the printer

## 7 Deliverable
One new folder in `lekiwi-designs/`, next to `_context/`:
```
lekiwi-designs/corner_mast_printed-v2/
  part.json
  mesh/<mesh-id>.stl          as fitted, frame "robot"
  print/<mesh-id>_PRINT.stl   the same solid on the bed, +Z up
```
- STL in mm, closed, in the frame the slot uses (robot: coordinates as fitted, no extra transform).
- The folder name and part.json `id` match: letters, digits, - or _. Rename it if you like.
- Hardware meshes stay as they are: copy them from `current/` unless the request moves them.
- A `"print": "part:<id>"` plate is shared with other parts; keep it unless that mesh changes.
- `params` holds the fitted hinge: keep its shape, move `origin` and `axis` with the hinge, keep `moves` in step with `meshes`.
- Write part.json last; the studio reads a folder once it has not changed for 2 s.
part.json, pre-filled (the same file is `part.json` in the pack, full precision):
```json
{
  "schema": "rps/part@1",
  "id": "corner_mast_printed-v2",
  "label": "Corner mast, printed v2 · 45°",
  "robot": "lekiwi-pincopen",
  "slot": "top_camera_mount",
  "frame": "robot",
  "local": null,
  "meshes": [
    {"id":"spar_lower","file":"mesh/spar_lower.stl","label":"Corner mast (printed) · lower spar + deck base","print":"print/spar_lower_PRINT.stl"},
    {"id":"spar_upper","file":"mesh/spar_upper.stl","label":"Corner mast (printed) · upper spar + yoke","print":"print/spar_upper_PRINT.stl"},
    {"id":"head","file":"mesh/head.stl","label":"Corner mast · camera head","print":"print/head_PRINT.stl"},
    {"id":"retainer","file":"mesh/retainer.stl","label":"Corner mast · camera retainer","print":"part:cam_retainer"},
    {"id":"df200","file":"mesh/df200.stl","label":"Corner mast · DF200 module (stand-in)","hardware":true}
  ],
  "cameras": {"top":{"local":[0.9848,-0.1736,0,0,0.1228,0.6964,0.7071,0,-0.1228,-0.6964,0.7071,0,-75.3399,-18.5711,504.8547,1],"hfov_deg":87.3,"vfov_deg":71.1,"aspect":1.3333}},
  "mount": {"interface":"deck_grid","bolts_mm":[[-60,-60],[-60,-40],[-60,-20],[-80,-20]],"face":{"point":[-63.1473,-33.4511,57],"normal":[0,0,-1]}},
  "params": {"tilt_deg":{"kind":"hinge","value":45,"values":[40,45,50,55,60,65,70],"usable":[40,65],"origin":[-79.883,-44.3366,484.3486],"axis":[-0.9848,0.1736,0],"design":45,"moves":["head","retainer","df200"],"camera":"top"}},
  "source": "agent 2026-09-24",
  "derived_from": "corner_mast_printed",
  "notes": ""
}
```

## 8 Tools
Any tool: CadQuery, build123d, OpenSCAD, trimesh. Export binary STL in mm, one closed solid per file.
Keep the generating script in the part folder so the design can be rebuilt.

## 9 Request
same mast head, 20 mm shorter, keep 45°

If the request conflicts with section 4, keep section 4 and explain why in part.json "notes".
