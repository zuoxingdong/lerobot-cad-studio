# tools/build/inputs

Committed inputs the asset generators read. Nothing here is shipped to the page.

| file | read by |
|---|---|
| `v3-profile-lekiwi.json` | every `make_robots.py` run: `PROF`, the measured frames (deck grid, pan axis, reach disc, mast camera pose, wrist mount) and the colour palette. Override with `RPS_V3_PROFILE`. |
| `pincopen_registration.json` | `tools/build/robots/pincopen.py`: the registered placement of every PincOpen part (a one-off ICP registration against off-repo assemblies; see `assets/robots/pincopen/SOURCE.md`) |
| `print_match.json` | `tools/build/robots/printmatch.py`: the cache of which upstream print file matches which LeKiwi mesh, and its bed pose |

The meshes of this project's own parts are not inputs: they are committed under
`assets/parts/<id>/`, and `make_robots.py --only parts` writes each `part.json` from them.
