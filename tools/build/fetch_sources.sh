#!/usr/bin/env bash
# Re-derive the upstream geometry sources at their PINNED commits.
#
#   bash tools/build/fetch_sources.sh --into /tmp/rps-src          # clone/verify into a scratch dir
#   bash tools/build/fetch_sources.sh --into /tmp/rps-src --copy   # ...and refresh assets/robots/*/
#
# NOTHING IN THE STUDIO READS THE CLONES: assets/robots/<id>/ carries byte-identical copies of every file
# the studio needs (see each SOURCE.md) and everything builds and passes with no clone present.
# This script only re-derives those copies — to re-check them against the pins, or to move a
# package to a newer upstream commit.
#
# Verify the copies in the packages still match the pins:
#   D=/tmp/rps-src && bash tools/build/fetch_sources.sh --into "$D"
#   diff -r "$D/LeKiwi/URDF/meshes"      assets/robots/lekiwi/meshes
#   (cd assets/robots/lekiwi/print && find . -type f -exec cmp "$D/LeKiwi/3DPrintMeshes/{}" {} \;)
#   diff    "$D/LeKiwi/URDF/LeKiwi.urdf" assets/robots/lekiwi/urdf/LeKiwi.urdf
#   for f in "$D"/PincOpen/cad/stl/*.stl; do cmp "$f" assets/robots/pincopen/meshes/"${f##*/}"; done
#
# Idempotent: an existing clone is fetched and checked out at the pin, never re-cloned.  The pins
# below are the ONLY place a source revision is recorded; assets/robots/*/SOURCE.md and each
# robot.json .source.commit must agree with them.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"     # tools/build
STUDIO="$(dirname "$(dirname "$HERE")")"
EXTERNAL="${RPS_EXTERNAL:-}"

# name | url | commit | licence — the only place a source revision is recorded
PINS=(
  "LeKiwi|https://github.com/SIGRobotics-UIUC/LeKiwi.git|efa608d7ee5a495a4803b1d28cd0c955b4f1e033|Apache-2.0"
  "PincOpen|https://github.com/pollen-robotics/PincOpen.git|1b5a3dc83cb4eae042d535bda3765b9e12a9b8a7|CC-BY-SA-4.0"
)

say() { printf '%s\n' "$*"; }

fetch_one() {
  local name="$1" url="$2" commit="$3" lic="$4" dir="$EXTERNAL/$1"
  if [ ! -d "$dir/.git" ]; then
    say "clone  $name  <- $url"
    mkdir -p "$EXTERNAL"
    git clone --filter=blob:none "$url" "$dir"
  fi
  local have; have="$(git -C "$dir" rev-parse HEAD 2>/dev/null || echo none)"
  if [ "$have" != "$commit" ]; then
    say "check  $name  $have -> $commit"
    git -C "$dir" fetch --quiet origin "$commit" 2>/dev/null || git -C "$dir" fetch --quiet --unshallow origin || true
    git -C "$dir" checkout --quiet --detach "$commit"
  fi
  have="$(git -C "$dir" rev-parse HEAD)"
  [ "$have" = "$commit" ] || { say "FAIL   $name is at $have, wanted $commit"; return 1; }
  say "ok     $name  $commit  ($lic)  $(git -C "$dir" log -1 --format=%ci)"
}

COPY=0
_next_is_into=0
for a in "$@"; do
  if [ "$_next_is_into" = 1 ]; then EXTERNAL="$a"; _next_is_into=0; continue; fi
  case "$a" in
    --copy)   COPY=1;;
    --verify) COPY=0;;
    --into)   _next_is_into=1;;
    --into=*) EXTERNAL="${a#--into=}";;
  esac
done
[ -n "$EXTERNAL" ] || { say "usage: fetch_sources.sh --into <scratch dir> [--copy]"; exit 2; }
mkdir -p "$EXTERNAL"
EXTERNAL="$(cd "$EXTERNAL" && pwd)"

for p in "${PINS[@]}"; do
  IFS='|' read -r name url commit lic <<<"$p"
  fetch_one "$name" "$url" "$commit" "$lic"
done

# Originals are COPIED (never symlinked) so a robot package is self-contained and shippable.
if [ "$COPY" = 1 ]; then
  L="$EXTERNAL/LeKiwi"; P="$EXTERNAL/PincOpen"
  A="$STUDIO/assets/robots"
  say "copy   LeKiwi URDF + meshes -> assets/robots/lekiwi/"
  mkdir -p "$A/lekiwi/urdf" "$A/lekiwi/meshes" "$A/lekiwi/print"
  cp -f "$L/URDF/LeKiwi.urdf" "$A/lekiwi/urdf/LeKiwi.urdf"
  rsync -a --delete "$L/URDF/meshes/" "$A/lekiwi/meshes/"
  # only the plates a LeKiwi mesh matches (the files named in inputs/print_match.json); the rest
  # of 3DPrintMeshes/ (Dynamixel, wired, EU, Jetson, ... variants) stays upstream
  python3 -c 'import json,sys; print("\n".join(sorted({v["file"] for v in json.load(open(sys.argv[1]))["links"].values()})))' \
    "$HERE/inputs/print_match.json" | rsync -a --files-from=- "$L/3DPrintMeshes/" "$A/lekiwi/print/"
  # PincOpen's meshes/ also holds the LeKiwi gripper servo it reuses, so no --delete here
  say "copy   PincOpen cad/stl + the STS3215 -> assets/robots/pincopen/meshes/"
  mkdir -p "$A/pincopen/meshes"
  rsync -a "$P/cad/stl/" "$A/pincopen/meshes/"
  cp -f "$L/URDF/meshes/STS3215_03a-v1.stl" "$A/pincopen/meshes/STS3215_03a-v1.stl"
fi

say "done   sources = $EXTERNAL   (re-derivation only; the studio does not read them)"
