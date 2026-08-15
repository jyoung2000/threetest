<#
.SYNOPSIS
  Compress a GLB/glTF model for the web and report the size change.

.DESCRIPTION
  Wraps @gltf-transform/cli. Optionally emits per-tier variants (full / md / lo)
  for device-adaptive loading.

.EXAMPLE
  .\optimize-glb.ps1 -In .\public\models\hero.glb -Out .\public\models\hero.opt.glb

.EXAMPLE
  .\optimize-glb.ps1 -In .\raw\hero.glb -OutDir .\public\models -Tiers -Geometry meshopt -Textures ktx2
#>
param(
  [Parameter(Mandatory = $true)][string]$In,
  [string]$Out,
  [string]$OutDir,
  [ValidateSet('webp', 'ktx2', 'avif', 'jpeg', 'png')][string]$Textures = 'webp',
  [ValidateSet('draco', 'meshopt', 'quantize')][string]$Geometry = 'draco',
  [int]$TextureSize = 2048,
  [switch]$Tiers,
  [switch]$Inspect
)

$ErrorActionPreference = 'Stop'

function Get-Cli {
  foreach ($candidate in @('gltf-transform.cmd', 'gltf-transform')) {
    if (Get-Command $candidate -ErrorAction SilentlyContinue) { return $candidate }
  }
  throw "gltf-transform not found. Install it with: npm install -g @gltf-transform/cli"
}

function Show-Size($label, $path) {
  $mb = (Get-Item $path).Length / 1MB
  Write-Host ("  {0,-28} {1,8:N2} MB" -f $label, $mb)
  return $mb
}

$cli = Get-Cli
if (-not (Test-Path $In)) { throw "Input not found: $In" }

$inputMb = Show-Size "input" $In

if ($Inspect) {
  Write-Host "`n--- inspect (before) ---" -ForegroundColor Cyan
  & $cli inspect $In
}

function Invoke-Optimize($source, $destination, $size) {
  $dir = Split-Path -Parent $destination
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  & $cli optimize $source $destination `
    --compress $Geometry `
    --texture-compress $Textures `
    --texture-size $size
  if ($LASTEXITCODE -ne 0) { throw "gltf-transform optimize failed for $destination" }
}

Write-Host "`nOptimizing (geometry=$Geometry, textures=$Textures)..." -ForegroundColor Cyan

if ($Tiers) {
  if (-not $OutDir) { $OutDir = Split-Path -Parent $In }
  $base = [System.IO.Path]::GetFileNameWithoutExtension($In)

  $full = Join-Path $OutDir "$base.glb"
  $md   = Join-Path $OutDir "$base.md.glb"
  $lo   = Join-Path $OutDir "$base.lo.glb"
  $tmp  = Join-Path $env:TEMP "$base.simplified.glb"

  Invoke-Optimize $In $full $TextureSize
  Invoke-Optimize $In $md ([Math]::Max(512, [int]($TextureSize / 2)))

  & $cli weld $In $tmp
  if ($LASTEXITCODE -ne 0) { throw "weld failed" }
  & $cli simplify $tmp $tmp --ratio 0.4 --error 0.001
  if ($LASTEXITCODE -ne 0) { throw "simplify failed" }
  Invoke-Optimize $tmp $lo 512
  Remove-Item $tmp -ErrorAction SilentlyContinue

  Write-Host "`nResults:" -ForegroundColor Green
  Show-Size "desktop  ($base.glb)"    $full | Out-Null
  Show-Size "tablet   ($base.md.glb)" $md   | Out-Null
  Show-Size "mobile   ($base.lo.glb)" $lo   | Out-Null
}
else {
  if (-not $Out) {
    $dir  = Split-Path -Parent $In
    $base = [System.IO.Path]::GetFileNameWithoutExtension($In)
    $Out  = Join-Path $dir "$base.opt.glb"
  }
  Invoke-Optimize $In $Out $TextureSize

  Write-Host "`nResults:" -ForegroundColor Green
  $outputMb = Show-Size "output" $Out
  $saved = 100 * (1 - ($outputMb / $inputMb))
  Write-Host ("  {0,-28} {1,7:N0}% smaller" -f "reduction", $saved) -ForegroundColor Green

  if ($Inspect) {
    Write-Host "`n--- inspect (after) ---" -ForegroundColor Cyan
    & $cli inspect $Out
  }
}

Write-Host "`nReminder: copy decoder files into your public dir (scripts/fetch-decoders.mjs)." -ForegroundColor Yellow
