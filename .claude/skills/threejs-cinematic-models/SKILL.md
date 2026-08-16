---
name: threejs-cinematic-models
description: >-
  Build cinematic, high-fidelity 3D web experiences with Three.js (r185) that still load
  fast and hold framerate on desktop, tablet, and mobile. Covers turning an image, a video
  reference, or a text description into an animated 3D model (AI image-to-3D services,
  Gaussian splats from video capture, video frame extraction to photogrammetry or
  multi-view meshes, VideoTexture, motion reference,
  depth-map displacement, SVG extrusion, procedural geometry), the GLB/Draco/Meshopt/KTX2
  asset pipeline, WebGPU + WebGL renderer setup, HDRI/PBR lighting, tone mapping,
  post-processing (bloom, DoF, SSAO), scroll-driven and skeletal animation, and
  device-adaptive quality tiers. Use this skill whenever the user mentions Three.js, WebGL,
  WebGPU, a 3D model or scene on a webpage, a 3D product viewer or configurator, an
  animated or interactive 3D hero section, a spinning globe, image-to-3D, photo-to-3D, or
  video-to-3D (a video of an object/place they want as a web 3D model, a 3D scan from
  phone footage, or a video whose motion should be recreated in 3D),
  GLB/glTF optimization, or "make this load fast on mobile" for anything 3D — even if they
  never say the words "Three.js".
license: MIT
metadata:
  three-version: "r185 (three@0.185.x)"
  updated: "2026-08"
---

# Three.js: Cinematic Models That Load Fast (r185)

The goal of every job under this skill is the same tension: **cinematic quality** (HDRI
lighting, real PBR, post-processing, filmic camera motion) against **budget** (small
download, few draw calls, stable framerate on a mid-range phone). Everything here exists to
resolve that tension rather than pick a side.

Work in this order. Skipping step 1 or step 2 is the single most common cause of a scene
that looks great on the dev machine and dies on a phone.

1. **Classify the input** — model? image? photo? video? logo? text description? → decision tree below
2. **Set the budget** — pick device tiers and targets before writing scene code → `references/performance.md`
3. **Get the asset web-ready** — GLB + compression, always → `references/asset-pipeline.md`
4. **Build the scene** — renderer, loaders, lighting, materials → `references/renderer-setup.md`, `references/cinematic.md`
5. **Animate** — AnimationMixer, GSAP/ScrollTrigger, camera choreography → `references/cinematic.md`
6. **Adapt** — tiers, DPR caps, feature gating, resize → `references/device-adaptation.md`
7. **Verify** — audit script + checklist, test on a real phone → `references/performance.md`

---

## Step 1 — Classify the input

Ask (or infer) what the user is actually starting from, then take the matching path. Do not
default to "generate a model with AI" — three of the five paths need no external model at
all and produce better results for their case.

```
What is the user starting from?

├── A 3D MODEL already (.glb .gltf .fbx .obj .blend)
│     → Path M: optimize + load. references/asset-pipeline.md
│
├── AN IMAGE of a single object (product shot, concept art, toy, character)
│     ├── They need real geometry (interaction, physics, AR, turntable, configurator)
│     │     → Path A: AI image-to-3D service → GLB → cleanup. references/image-to-3d.md
│     └── They just want the image to FEEL 3D on the page (hero, parallax, tilt, scroll)
│           → Path D: depth-map displacement / parallax layers / particle cloud.
│             In-engine, no external model, tiny. references/image-to-3d.md §C
│
├── A PHOTO of a real place or object
│     ├── Photoreal look matters more than editable geometry
│     │     → Path S: Gaussian splats. references/image-to-3d.md §B
│     └── Needs collision/editing/AR anchoring
│           → Path A (AI image-to-3D) or photogrammetry → mesh
│
├── A VIDEO
│     ├── An orbit/walkaround CAPTURE of a real object or place (they filmed it)
│     │     ├── Photoreal viewing experience → Path V1: video → Gaussian splat
│     │     │     (Polycam/Luma/Postshot/KIRI) → three.js splat viewer.
│     │     │     references/video-to-3d.md §2
│     │     └── Needs a usable MESH → Path V2: extract sharp frames (ffmpeg) →
│     │           photogrammetry or multi-view AI image-to-3D → GLB → cleanup.
│     │           references/video-to-3d.md §3
│     ├── The video's MOTION is the reference ("animate it like this clip")
│     │     → Path V3: recreate the motion in code / animation data.
│     │       references/video-to-3d.md §4
│     └── The video itself should PLAY inside the 3D scene
│           → Path V4: VideoTexture on geometry. references/video-to-3d.md §5
│
├── A LOGO, ICON, GLYPH, or FLAT VECTOR
│     → Path E: SVGLoader + ExtrudeGeometry. Crisp, kilobytes, no AI.
│       references/image-to-3d.md §C3
│
└── ONLY A TEXT DESCRIPTION
      ├── Geometric / abstract / stylized / UI-ish ("floating cards", "low-poly city",
      │   "spinning globe", "crystal", "wireframe terrain")
      │     → Path P: build procedurally from primitives. Cheapest, sharpest,
      │       fully art-directable, zero download. references/procedural.md
      └── Specific real-world object needing realistic detail ("a worn leather armchair")
            → Path A via text-to-3D (Tripo/Meshy), then treat as Path M
```

**Bias toward Path P and Path D.** A procedurally built scene or a depth-displaced image
loads in kilobytes, runs at 60fps on a five-year-old phone, and is fully controllable in
code. An AI-generated mesh is 20k–300k triangles of uneven topology that needs cleanup
before it is web-safe. Reach for AI generation when the user genuinely needs *that specific
object* as geometry.

When the request is ambiguous ("make my product photo into a 3D thing"), state the two
realistic options and their tradeoffs in one or two sentences, then proceed with the one
that fits their stated use — don't stall the whole build on a clarifying question.

---

## Step 2 — Budgets before code

Write the target down before building. These are the defaults; adjust for the project but
stay explicit.

| Metric | Desktop | Tablet | Mobile |
|---|---|---|---|
| Draw calls / frame | < 150 | < 75 | < 50 |
| Scene triangles | < 1.5M | < 750k | < 500k |
| Hero object triangles | 50k–150k | ~50k | ~25k |
| Color texture size | 2048 | 1024 | 512–1024 |
| GPU memory | comfortable | < 250 MB | < 150 MB |
| devicePixelRatio cap | 2 | 2 | 1 (1.5 on flagships) |
| Target framerate | 60 | 60 | 60 ideal, 30 floor |
| Shadows | on | selective | off by default |
| Post-processing | on | selective | off by default |
| Above-the-fold payload | keep the hero asset under ~1.5 MB compressed |

Draw calls dominate everything else. A scene of 40 draw calls and 900k triangles will
outrun a scene of 600 draw calls and 200k triangles on nearly every device.

Full budget rationale, frame-time breakdown, and the audit workflow: `references/performance.md`.

---

## Step 3 — The asset pipeline is not optional

Any model that reaches the browser goes through compression first. Expect 80–90% size
reduction with no visible quality loss.

```bash
# geometry + textures in one pass (broad compatibility)
gltf-transform optimize in.glb out.glb --compress draco --texture-compress webp

# maximum VRAM savings (GPU-native textures, faster decode)
gltf-transform optimize in.glb out.glb --compress meshopt --texture-compress ktx2
```

On Windows PowerShell the binary is `gltf-transform.cmd`. `scripts/optimize-glb.ps1` and
`scripts/optimize-glb.sh` wrap this with size reporting — prefer running those so the user
sees the before/after numbers.

Decoder files (Draco, KTX2 basis transcoder) must be copied into the site's public
directory; `scripts/fetch-decoders.mjs` does that. A loader configured for Draco without
the decoder present fails silently with a blank scene.

Details, loader wiring, LOD, instancing, and merging: `references/asset-pipeline.md`.

---

## Step 4 — Renderer choice

**Default to `WebGPURenderer` from `three/webgpu`.** It selects WebGPU where available and
falls back to WebGL2 automatically, so one code path covers everything. It requires
`await renderer.init()` before any manual render call — a hand-rolled `requestAnimationFrame`
loop without that produces a black canvas and no error. Using `renderer.setAnimationLoop()`
awaits init for you.

**Choose classic `WebGLRenderer` from `three`** when the project needs the mature pmndrs
`postprocessing` effect set, custom GLSL via `ShaderMaterial` / `onBeforeCompile`, the
smallest possible bundle, or guaranteed behavior on older Safari. WebGLRenderer remains
fully maintained and is the conservative choice for ship-this-week work.

Things that do **not** work on the WebGPU backend: `ShaderMaterial`, `RawShaderMaterial`,
`onBeforeCompile`, and `EffectComposer` passes. Custom shading there is TSL / node
materials; post-processing there is the node `PostProcessing` / `RenderPipeline` stack.
TSL compiles to both WGSL and GLSL, so TSL written once runs on both backends.

Setup code for both, plus TSL basics: `references/renderer-setup.md`.

---

## Step 5 — Cinematic look

Four things carry most of the cinematic quality, in order of impact:

1. **Color management done right.** `renderer.outputColorSpace = THREE.SRGBColorSpace`;
   color/emissive maps tagged `SRGBColorSpace`, data maps (normal, roughness, metalness, AO)
   left linear. Getting this wrong makes everything look washed out or muddy no matter what
   else is done.
2. **HDRI environment lighting through PMREM.** An IBL environment does more for realism
   than any number of added lights. 1–2K HDRI on desktop, 1K or a baked/gradient env on mobile.
3. **Tone mapping.** `ACESFilmicToneMapping` for punchy filmic; `AgXToneMapping` for
   neutral highlights and better hue retention in bright scenes; `NeutralToneMapping` for
   accurate product color.
4. **Restrained post-processing.** Subtle bloom, shallow depth of field, light SSAO. Gate
   all of it behind the device tier.

Then camera motion: eased, damped, never linear; `CatmullRomCurve3` for paths; GSAP
ScrollTrigger driving a proxy object rather than the camera directly.

Lighting rigs, material recipes, post-processing setup for both backends, AnimationMixer,
morph targets, scroll choreography: `references/cinematic.md`.

---

## Step 6 — Adapt to the device

Detect a tier at startup, apply a preset, and let dynamic resolution scaling handle the
rest. Never ship one quality level to all devices.

```js
const tier = detectTier();                 // 'desktop' | 'tablet' | 'mobile'
const preset = applyPreset(renderer, scene, tier);
if (preset.post) buildComposer();          // post-processing gated, not assumed
```

Mobile specifics that actually bite: cap DPR at 1 (a 3× phone screen renders 9× the pixels
of 1×), keep total VRAM under ~150 MB or iOS Safari silently reloads the tab, re-run resize
on a timeout after `orientationchange` because iOS reports stale layout, and dispose
everything on teardown.

Detection, presets, dynamic resolution, touch controls, iOS quirks: `references/device-adaptation.md`.

---

## Step 7 — Verify before declaring done

Paste `scripts/check-scene.js` into the project and run the audit, then walk the checklist
in `references/performance.md`. At minimum confirm:

- draw calls and triangles within the tier budget
- DPR capped, shadows and post gated by tier
- color space and tone mapping set
- disposal wired for every removed object
- the WebGL fallback path tested (`forceWebGL: true`), not just WebGPU
- tested in DevTools mobile emulation with 4–6× CPU throttling, and on a real phone if one is available

Emulation hides GPU memory ceilings and thermal throttling, which are exactly what kills
mobile 3D. Say so plainly if only emulation was possible.

---

## Delivery conventions

- Prefer a **working, runnable scene** over snippets. A vanilla `index.html` with an
  importmap runs from `npx serve` with no build step and is the fastest thing for the user
  to verify. `assets/starter-scene.html` is a complete, tier-adaptive, HDRI-lit,
  GLB-loading, scroll-animated starting point — copy and adapt it rather than writing a
  scene from scratch.
- Pin the exact Three.js version in the importmap or `package.json`. Three ships roughly
  every two weeks; unpinned CDN URLs break scenes without warning.
- Keep loaders, lighting, and animation in separate modules once a scene exceeds ~200 lines,
  so quality tiers can swap pieces without rewrites.
- Always include disposal. It is boring and it is what prevents iOS tab crashes.

## Reference map

| File | Read it when |
|---|---|
| `references/renderer-setup.md` | Starting any scene; choosing WebGPU vs WebGL; writing TSL/node materials |
| `references/asset-pipeline.md` | Loading or optimizing GLB/glTF; Draco/KTX2/Meshopt; LOD, instancing, merging |
| `references/cinematic.md` | Lighting, materials, tone mapping, post-processing, animation, camera choreography |
| `references/device-adaptation.md` | Tier detection, quality presets, mobile/tablet handling, iOS quirks |
| `references/performance.md` | Budgets, draw-call reduction, disposal, on-demand rendering, profiling, checklist |
| `references/image-to-3d.md` | Any image or photo input; AI services and APIs; splats; depth displacement; SVG extrude |
| `references/video-to-3d.md` | Any video input; capture guidance; video→splat; frame extraction→mesh; motion reference; VideoTexture |
| `references/procedural.md` | Text-description-only input; building scenes from primitives; globes, terrain, particles |

| Script | Purpose |
|---|---|
| `scripts/optimize-glb.ps1` / `.sh` | One-command GLB compression with before/after sizes |
| `scripts/fetch-decoders.mjs` | Copy Draco + KTX2 decoders into the site's public dir |
| `scripts/check-scene.js` | Live draw-call / triangle / texture audit against tier budgets |
| `scripts/image-to-3d.mjs` | Submit an image to an image-to-3D API, poll, download the GLB |
| `scripts/extract-frames.sh` / `.ps1` | Pull sharp, well-spaced frames from a video for photogrammetry or multi-view AI input |

| Asset | Purpose |
|---|---|
| `assets/starter-scene.html` | Complete runnable adaptive scene — the fastest correct starting point |
