#!/usr/bin/env bash
# extract-frames.sh — pull sharp, well-spaced frames from a video for photogrammetry
# or multi-view AI image-to-3D input.
#
# Usage:
#   ./extract-frames.sh capture.mp4                 # ~2 fps into ./frames
#   ./extract-frames.sh capture.mp4 out-dir 3       # 3 fps into out-dir
#   ./extract-frames.sh capture.mp4 out-dir 2 0.003 # + motion gate (drops near-duplicates)
#
# Requires: ffmpeg (https://ffmpeg.org)
# Target 40–150 frames for photogrammetry; for multi-view AI, hand-pick 3–6 covering
# front/sides/back afterwards. Review the output and delete blurry frames — one bad
# frame hurts the pose solve more than a missing angle.

set -euo pipefail

command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg not found — install it first." >&2; exit 1; }

IN="${1:?usage: extract-frames.sh <video> [out-dir] [fps] [scene-threshold]}"
OUT="${2:-frames}"
FPS="${3:-2}"
SCENE="${4:-}"

mkdir -p "$OUT"

if [[ -n "$SCENE" ]]; then
  # motion-gated: keep a frame only when it differs enough from the previous one
  FILTER="select='gt(scene,${SCENE})',fps=${FPS}"
else
  FILTER="fps=${FPS}"
fi

ffmpeg -hide_banner -i "$IN" -vf "$FILTER" -vsync vfr -qscale:v 2 "$OUT/frame_%04d.jpg"

COUNT=$(ls "$OUT"/frame_*.jpg 2>/dev/null | wc -l | tr -d ' ')
echo
echo "extracted $COUNT frames to $OUT/"
if (( COUNT < 30 )); then
  echo "warning: fewer than 30 frames — raise fps or film a longer, slower orbit."
elif (( COUNT > 200 )); then
  echo "note: $COUNT frames is more than photogrammetry needs — consider a lower fps."
fi
echo "next: review and delete blurry frames, then feed to RealityScan/Meshroom,"
echo "or pick 3–6 covering front/sides/back for multi-view AI (see references/video-to-3d.md §3)."
