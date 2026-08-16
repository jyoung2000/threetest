# Particle Earth

An interactive, cinematic Three.js (r185) globe recreated from the reference clip
`bytedance_video-upscaler_773054b3a5b1464db10f6791f3ebed42_0.mp4`: a monochrome
dot-matrix Earth spinning in space — beaded coastline dots, dim dash-grid interiors,
occasional satellite streaks, dust drifting off the limb, film grain and vignette.
Space is expanded with a restrained starfield and faint nebula.

## Run it

`index.html` is a **fully self-contained single file** — Three.js and the continent
data are embedded, so it needs no network, no build step and no server:

- double-click `index.html` (works from `file://`), or
- serve it (`npx serve .` / `python3 -m http.server`) — same file works hosted
  (e.g. GitHub Pages).

## Controls

| Input | Action |
|---|---|
| Drag (mouse / touch) | Spin the globe with momentum; idle auto-spin resumes (~27 s/rev, matching the clip) |
| Click / tap / Enter | Pulse ring on the globe + a gentle spin kick |
| Scroll / pinch / `+` `-` | Zoom |
| Arrow keys | Spin / tilt |
| Double-click | Reset view |

URL overrides: `?quality=mobile|tablet|desktop`, `?debug=1` (fps / draw-call HUD).

## Device adaptation

Tier detection picks per-device dot density, star counts, sphere resolution and a
DPR cap; a dynamic resolution scaler absorbs slow frames. Whole scene renders in
**~7 draw calls / ~17k triangles / ~19–40k points**. Honors
`prefers-reduced-motion` (static globe, on-demand rendering, interactions still
work) and falls back to a styled notice without WebGL2.

## Rebuild

```
python3 tools/build.py
```

`tools/build.py` embeds into `tools/template.html`:

- `three@0.185.1` (`three.module.min.js`, flattened with esbuild because the split
  min build's relative `./three.core.min.js` import can't resolve from a data URI)
  as a base64 ES-module data URI,
- a 1024×512 land mask rasterized (pure-Python even-odd scanline, antimeridian-safe)
  from `world-atlas` `land-110m.json`.

Vendor inputs are fetched with `npm pack three@0.185.1 world-atlas@2.0.2` if not
provided via `--three` / `--land`.

## Licenses

- [three.js](https://threejs.org) — MIT © 2010–2026 Three.js Authors (embedded in `index.html`)
- [world-atlas](https://github.com/topojson/world-atlas) — ISC; derived from
  [Natural Earth](https://www.naturalearthdata.com/) (public domain)
