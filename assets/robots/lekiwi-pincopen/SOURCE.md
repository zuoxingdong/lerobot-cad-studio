# `lekiwi-pincopen` — the robot as actually built

A **composition** (`rps/robot@2`): it contains no geometry and copies nothing of its base, only
the recipe. `src/core/compose.js` resolves it when the page loads it.

```
lekiwi                      the base package                     (base)
  - stock jaw, stock wrist camera, stock flat Pi case             (hide)
  + pincopen  at frames.wrist_flange                              (attach)
  + the parts its slot options name, from ../../parts/<id>/       (slots, rules)
```

| slot | default | what it is |
|---|---|---|
| `top_camera_mount` | `corner_mast_printed` | printed corner mast (two spars + head + retainer + DF200 stand-in), sensor at (-75.3, -18.6, 504.9), 45° nose-down |
| `wrist_camera_mount` | `df200_arch` | DF200 forward clamp arch at 35°, on the PincOpen camera seat Z 19.5 |
| `gripper` | `pincopen` | the whole PincOpen package, attached at the wrist flange |
| `fingertips` | `original` | the upstream PincOpen tip; `none` and `import` are the other options |
| `pi_case` | `vertical_revI` | the vertical Pi 5 case in the rear deck pocket |
| `front_camera` | `stock` | unchanged from LeKiwi |

## Cameras

A camera here is the DEVICE only. The fitted slot option publishes the pose, so swapping
a mount moves its camera. All three are the same module.

| id | posed by | where the default puts it | hFOV |
|---|---|---|---|
| `front` | `slots.front_camera` | base bracket, (0, 111.75, 25.05), 10° above horizontal | 87.3° |
| `wrist` | `slots.wrist_camera_mount` | the DF200 arch, 35° below the finger direction | 87.3° |
| `top` | `slots.top_camera_mount` | the corner mast head, 45° nose-down | 87.3° |

87.3° is the JR DF200 module at 640 × 480, 4:3, rectilinear (user-confirmed 2026-09-15).
`cameras[].source` carries the derivation; do not quote it as a datasheet number.

## The attachment transform

`attach[0].local` is the identity, because `lekiwi.frames.wrist_flange` was **constructed** to
be the PincOpen assembly frame: +X the finger direction, Y = 0 the jaw mirror plane. That frame's
own caveat (derived from the stock gripper, a few mm of uncertainty along +X) is therefore this
package's caveat too.

## Regenerate

```bash
nice -n 10 python3 tools/build/make_robots.py --only lekiwi-pincopen   # from studio/
```
