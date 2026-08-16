# Particle Earth

An interactive, cinematic Three.js (r185) globe recreated from the reference clip
`bytedance_video-upscaler_773054b3a5b1464db10f6791f3ebed42_0.mp4`: a monochrome
dot-matrix Earth spinning in space — beaded coastline dots, a uniform grid of tiny
lit-sphere dots inland that grow bigger and brighter over high-population regions
(driven by real GeoNames city data), dust drifting off the limb, film grain and
vignette. Space is a full halftone sky: a dense twinkling starfield with a
Milky Way band, six real constellations (Big Dipper, Cassiopeia, Orion, Cygnus,
Crux, Lyra) drawn as bright members joined by dotted lines, three dot-spiral
galaxies (one edge-on), faint nebulae, long blue-white shooting stars and short
flaring meteorites — occasionally erupting into a shared-radiant meteor
shower — plus a low-poly telescope satellite with edge-outlined solar panels
and a blinking beacon that drifts across the sky every half-minute or so.

A lively but airy stream of glowing **connection arcs** rises from populous
cities all over the world and curves into twelve pulsing **data-center hubs**
(N. Virginia, Oregon, São Paulo, London, Frankfurt, Stockholm, Johannesburg,
Dubai, Mumbai, Singapore, Tokyo, Sydney). Every connection ripples at the user
end on launch and at the hub on arrival, and the traveling packet head carries a
subtle blue-white tint for pop. A dozen or more connections are in flight at
once, with occasional bursts of users piling on simultaneously — a live online
service — while thinner, dimmer arc bodies keep the swarm from overtaking the
globe. Up close, dots cap at their local grid pitch and sharpen with on-screen
size, so the zoomed-in surface stays crisp, separated spheres; every star
twinkles, and the shooting-star rate roughly triples in the fully zoomed-out
view.

The page opens on a **cinematic cold-open**: a close-up horizon holds in the
dark while a bright glow loads along the limb from left to right, then the
camera pulls back to reveal the full globe as the dots fade up. It lasts about
3.5 seconds, frames itself correctly at any aspect ratio, fast-forwards on any
input, and is skipped entirely under reduced-motion.

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
| Scroll / pinch / `+` `-` | One continuous approach axis: zoom in, then keep scrolling to dive into the nearest bright dot until the screen turns white; scroll back up to return to the full scene |
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
  from `world-atlas` `land-110m.json`,
- ~2,200 cities with population ≥200k (`tools/vendor/cities-pop.json`, extracted
  from the `all-the-cities` npm package / GeoNames), packed 5 bytes per city and
  splatted into a population-influence raster at runtime; the ~680 largest also
  serve as connection-arc origins.

Vendor inputs are fetched with `npm pack three@0.185.1 world-atlas@2.0.2` if not
provided via `--three` / `--land`.

## Licenses

- [three.js](https://threejs.org) — MIT © 2010–2026 Three.js Authors (embedded in `index.html`)
- [world-atlas](https://github.com/topojson/world-atlas) — ISC; derived from
  [Natural Earth](https://www.naturalearthdata.com/) (public domain)
- City populations from [GeoNames](https://www.geonames.org/) via
  [all-the-cities](https://www.npmjs.com/package/all-the-cities) — CC BY 4.0 / MIT
