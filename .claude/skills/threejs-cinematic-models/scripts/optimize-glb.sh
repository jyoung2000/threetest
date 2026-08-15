#!/usr/bin/env bash
# optimize-glb.sh — compress a GLB for the web and report the size change.
#
# Usage:
#   ./optimize-glb.sh input.glb [output.glb] [webp|ktx2|avif] [draco|meshopt] [texture-size]
#   ./optimize-glb.sh --tiers input.glb out-dir [webp|ktx2] [draco|meshopt]
#
# Requires: npm install -g @gltf-transform/cli

set -euo pipefail

command -v gltf-transform >/dev/null 2>&1 || {
  echo "gltf-transform not found. Install with: npm install -g @gltf-transform/cli" >&2
  exit 1
}

human() { du -h "$1" | cut -f1; }

if [[ "${1:-}" == "--tiers" ]]; then
  IN="${2:?input.glb required}"
  OUTDIR="${3:-$(dirname "$IN")}"
  TEX="${4:-webp}"
  GEO="${5:-draco}"
  BASE="$(basename "${IN%.*}")"
  mkdir -p "$OUTDIR"
  TMP="$(mktemp -t simplified.XXXXXX.glb)"

  echo "Building per-tier variants (geometry=$GEO, textures=$TEX)..."
  gltf-transform optimize "$IN" "$OUTDIR/$BASE.glb"    --compress "$GEO" --texture-compress "$TEX" --texture-size 2048
  gltf-transform optimize "$IN" "$OUTDIR/$BASE.md.glb" --compress "$GEO" --texture-compress "$TEX" --texture-size 1024
  gltf-transform weld     "$IN" "$TMP"
  gltf-transform simplify "$TMP" "$TMP" --ratio 0.4 --error 0.001
  gltf-transform optimize "$TMP" "$OUTDIR/$BASE.lo.glb" --compress "$GEO" --texture-compress "$TEX" --texture-size 512
  rm -f "$TMP"

  echo
  echo "Results:"
  printf '  %-28s %s\n' "input"   "$(human "$IN")"
  printf '  %-28s %s\n' "desktop" "$(human "$OUTDIR/$BASE.glb")"
  printf '  %-28s %s\n' "tablet"  "$(human "$OUTDIR/$BASE.md.glb")"
  printf '  %-28s %s\n' "mobile"  "$(human "$OUTDIR/$BASE.lo.glb")"
else
  IN="${1:?input.glb required}"
  OUT="${2:-${IN%.*}.opt.glb}"
  TEX="${3:-webp}"
  GEO="${4:-draco}"
  SIZE="${5:-2048}"

  echo "Optimizing (geometry=$GEO, textures=$TEX, max=$SIZE)..."
  gltf-transform optimize "$IN" "$OUT" --compress "$GEO" --texture-compress "$TEX" --texture-size "$SIZE"

  echo
  echo "Results:"
  printf '  %-28s %s\n' "input"  "$(human "$IN")"
  printf '  %-28s %s\n' "output" "$(human "$OUT")"
fi

echo
echo "Reminder: copy decoder files into your public dir (scripts/fetch-decoders.mjs)."
