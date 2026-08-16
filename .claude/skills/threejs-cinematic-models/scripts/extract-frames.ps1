<#
.SYNOPSIS
  Pull sharp, well-spaced frames from a video for photogrammetry or multi-view
  AI image-to-3D input.

.EXAMPLE
  .\extract-frames.ps1 -In .\capture.mp4
.EXAMPLE
  .\extract-frames.ps1 -In .\capture.mp4 -Out .\frames -Fps 3 -SceneThreshold 0.003

.NOTES
  Requires ffmpeg on PATH (winget install Gyan.FFmpeg).
  Target 40–150 frames for photogrammetry; for multi-view AI, hand-pick 3–6
  covering front/sides/back afterwards. Delete blurry frames before reconstructing.
#>
param(
  [Parameter(Mandatory = $true)][string]$In,
  [string]$Out = "frames",
  [double]$Fps = 2,
  [double]$SceneThreshold = 0    # e.g. 0.003 to drop near-duplicate frames
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  throw "ffmpeg not found. Install with: winget install Gyan.FFmpeg"
}
if (-not (Test-Path $In)) { throw "Input not found: $In" }

New-Item -ItemType Directory -Force -Path $Out | Out-Null

if ($SceneThreshold -gt 0) {
  $filter = "select='gt(scene,$SceneThreshold)',fps=$Fps"
} else {
  $filter = "fps=$Fps"
}

ffmpeg -hide_banner -i $In -vf $filter -vsync vfr -qscale:v 2 "$Out/frame_%04d.jpg"
if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed" }

$count = (Get-ChildItem "$Out/frame_*.jpg").Count
Write-Host "`nextracted $count frames to $Out\" -ForegroundColor Green
if ($count -lt 30) {
  Write-Host "warning: fewer than 30 frames — raise -Fps or film a longer, slower orbit." -ForegroundColor Yellow
} elseif ($count -gt 200) {
  Write-Host "note: $count frames is more than photogrammetry needs — consider a lower -Fps." -ForegroundColor Yellow
}
Write-Host "next: review and delete blurry frames, then feed to RealityScan/Meshroom,"
Write-Host "or pick 3-6 covering front/sides/back for multi-view AI (references/video-to-3d.md §3)."
