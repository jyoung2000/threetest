# Performance: Budgets, Optimization, Profiling, Checklist (Three.js r185)

## Contents
1. The frame budget
2. Budgets per tier
3. Draw call reduction
4. Geometry and triangle cost
5. Texture and VRAM cost
6. Overdraw and fill rate
7. On-demand rendering
8. Disposal
9. Loading performance
10. Profiling and instrumentation
11. Testing on real devices
12. Diagnosing by symptom
13. Ship checklist

---

## 1. The frame budget

60 fps means every frame completes in 16.6 ms — including JavaScript, physics, animation
updates, and the GPU's work. A rough healthy split:

| Phase | Budget |
|---|---|
| Application JS (state, input, logic) | 2 ms |
| Animation updates (mixer, tweens, skinning) | 2 ms |
| Three.js scene traversal + draw call submission | 3 ms |
| GPU rendering | 8 ms |
| Browser compositing / slack | 1.6 ms |

30 fps on mobile doubles that to 33 ms. Measure which phase is over before optimizing;
optimizing the wrong phase is the most common wasted effort in web 3D.

CPU-bound and GPU-bound need different fixes:
- **CPU-bound** (JS time high, GPU idle) → fewer draw calls, fewer objects, less per-frame
  JavaScript, instancing, merging.
- **GPU-bound** (JS time low, frame still long) → lower resolution, less overdraw, cheaper
  shaders, smaller textures, less post-processing.

## 2. Budgets per tier

| Metric | Desktop | Tablet | Mobile |
|---|---|---|---|
| Draw calls / frame | < 150 | < 75 | < 50 |
| Scene triangles | < 1.5M | < 750k | < 500k |
| Hero object triangles | 50k–150k | ~50k | ~25k |
| Secondary props (each) | 500–5k | 500–3k | 500–2k |
| Unique materials | < 30 | < 20 | < 12 |
| Unique textures | < 40 | < 25 | < 15 |
| Color texture dimension | 2048 | 1024 | 512–1024 |
| Total texture VRAM | as budgeted | < 250 MB | < 150 MB |
| Shadow-casting lights | 1–2 | 1 | 0 |
| DPR cap | 2 | 2 | 1 |
| Above-fold transfer | < 3 MB | < 2 MB | < 1.5 MB |
| Time to first render | < 2 s | < 2.5 s | < 3 s on 4G |
| Framerate | 60 | 60 | 60 ideal, 30 floor |

Draw calls dominate. 40 draw calls at 900k triangles beats 600 draw calls at 200k triangles
on nearly every device.

## 3. Draw call reduction

One draw call per mesh per material per shadow-casting light. Attack in this order:

1. **Instance** anything repeated — `InstancedMesh` renders thousands of copies in one call.
2. **Merge** static meshes that share a material (`mergeGeometries`).
3. **Atlas** textures so distinct meshes can share one material.
4. **Reduce material count** — every unique material is a shader program and a state change.
5. **Cut shadow casters** — each shadow-casting light re-renders the scene from its POV.
6. **Cull aggressively** — keep `frustumCulled = true` (default), add an LOD level of an
   empty `Object3D` for distance culling, and remove objects entirely when a section is off
   screen rather than just hiding them.

Check the actual number rather than estimating:

```js
console.log(renderer.info.render.calls, renderer.info.render.triangles);
```

`renderer.info` resets each frame; read it right after a render.

## 4. Geometry and triangle cost

- Triangle count matters less than draw calls until it reaches the millions, but vertex
  count drives skinning and morph cost directly.
- `gltf-transform simplify --ratio 0.5 --error 0.001` typically halves triangles with no
  visible difference on a web-scale model.
- `gltf-transform weld` before simplifying — unwelded duplicate vertices defeat the simplifier.
- Prefer normal maps over geometry for surface detail; a 2k-triangle mesh with a good normal
  map beats a 200k-triangle mesh at web viewing distances.
- Delete geometry the camera can never see (interiors, undersides of fixed objects).
- Avoid subdivision-heavy plane geometry unless it is being displaced; a `PlaneGeometry(1, 1, 512, 512)`
  is 524k triangles for one flat surface.

## 5. Texture and VRAM cost

An uncompressed texture in VRAM costs `width × height × 4 bytes × 1.33` (mipmaps included),
regardless of its file size on disk:

| Dimension | VRAM (RGBA + mips) |
|---|---|
| 512² | ~1.4 MB |
| 1024² | ~5.6 MB |
| 2048² | ~22 MB |
| 4096² | ~89 MB |

Ten 2048² textures is ~220 MB — already over the mobile ceiling before geometry. KTX2/Basis
stays compressed on the GPU and cuts this by roughly 4–8×, which is why it matters far more
than the download saving.

Other rules:
- Never use 4096² on the web without a specific reason.
- Combine AO/roughness/metalness into one ORM texture (glTF does this by default).
- Reuse textures across materials; a duplicate upload is a duplicate allocation.
- `texture.dispose()` frees the GPU allocation; removing the mesh does not.

## 6. Overdraw and fill rate

Mobile GPUs are usually fill-rate bound. Each full-screen effect costs another pass over
every pixel.

- Transparent objects cannot be depth-culled and are drawn back-to-front — many overlapping
  transparent surfaces is the classic mobile framerate killer.
- `transmission` materials force an extra scene render. Cap at one or two, disable on mobile.
- Every post-processing pass is a full-screen read+write. pmndrs `EffectPass` merges
  compatible effects into one pass; use it instead of stacking separate passes.
- Render AO and DoF at half resolution (`halfRes`, `height: 480`) — the visual difference is
  negligible and the cost roughly quarters.
- Reducing DPR by 0.2 is often a larger win than any geometry optimization.

## 7. On-demand rendering

If nothing is moving, do not render. This halves battery drain on scroll pages and is the
easiest large win in scenes without continuous animation.

```js
let needsRender = true;
const invalidate = () => { needsRender = true; };

controls.addEventListener('change', invalidate);
window.addEventListener('resize', invalidate);
// GSAP: pass invalidate as onUpdate

function tick() {
  requestAnimationFrame(tick);
  if (mixerIsPlaying) { mixer.update(clock.getDelta()); needsRender = true; }
  if (controls.enableDamping) { needsRender = controls.update() || needsRender; }
  if (!needsRender) return;
  needsRender = false;
  composer ? composer.render() : renderer.render(scene, camera);
}
tick();
```

Combine with `IntersectionObserver` so an off-screen canvas stops entirely, and
`visibilitychange` so a hidden tab does no work.

## 8. Disposal

Removing an object from the scene does not free GPU memory. Leaks accumulate across route
changes and are the usual cause of a page that gets slower the longer it is open, and of
iOS tab reloads.

```js
export function disposeHierarchy(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        for (const key of Object.keys(m)) {
          const value = m[key];
          if (value && value.isTexture) value.dispose();
        }
        m.dispose();
      }
    }
    if (o.isSkinnedMesh) o.skeleton?.dispose?.();
  });
  root.parent?.remove(root);
}

export function teardown({ renderer, composer, controls, mixer, scene, pmrem }) {
  mixer?.stopAllAction();
  mixer?.uncacheRoot(mixer.getRoot());
  controls?.dispose();
  composer?.dispose();
  pmrem?.dispose();
  scene?.environment?.dispose();
  scene?.background?.dispose?.();
  disposeHierarchy(scene);
  renderer.setAnimationLoop(null);
  renderer.dispose();
  renderer.domElement.remove();
}
```

Also dispose: `RenderTarget`s, `DRACOLoader` / `KTX2Loader` (they hold worker threads),
`PMREMGenerator`, and any `InstancedMesh` instance attributes.

Verify with `renderer.info.memory` — `geometries` and `textures` should return to baseline
after teardown, not keep climbing.

## 9. Loading performance

- Compress every model (`references/asset-pipeline.md`). 80–90% reduction is normal.
- Serve with gzip or Brotli; GLB compresses further at the HTTP layer.
- `<link rel="preload" as="fetch" href="/models/hero.glb" crossorigin>` for the hero asset.
- Load the environment and hero model in parallel with `Promise.all`, then render; defer
  everything else to `requestIdleCallback`.
- Show real progress from `LoadingManager.onProgress`, not a fake spinner — perceived load
  time drops substantially with an honest progress bar.
- Render a cheap placeholder (a low-poly proxy, a blurred still, a wireframe) immediately so
  the viewport is never empty.
- Lazy-init the whole scene when the canvas approaches the viewport, for 3D below the fold.

## 10. Profiling and instrumentation

```js
import Stats from 'three/addons/libs/stats.module.js';
const stats = new Stats();
stats.showPanel(0);                       // 0 fps, 1 ms, 2 MB
document.body.appendChild(stats.dom);
// in the loop: stats.begin(); ...render...; stats.end();
```

`scripts/check-scene.js` in this skill prints a one-shot audit of draw calls, triangles,
material/texture counts, estimated VRAM, and flags anything over the tier budget.

Manual phase timing:

```js
const t0 = performance.now();
mixer.update(dt);
const tAnim = performance.now() - t0;
renderer.render(scene, camera);
const tTotal = performance.now() - t0;
```

GPU timing (WebGL2, where the extension exists):

```js
const ext = renderer.getContext().getExtension('EXT_disjoint_timer_query_webgl2');
```

Other tools:
- **Chrome DevTools → Performance**: which phase is over budget, whether it is JS or GPU.
- **Chrome DevTools → Rendering → Frame Rendering Stats**: live fps and GPU raster.
- **Spector.js** (WebGL): capture one frame and inspect every draw call and state change.
- **`chrome://gpu`**: confirm hardware acceleration is actually on.
- **Memory tab / `performance.memory`**: catch JS-side leaks separate from GPU leaks.

## 11. Testing on real devices

Emulation cannot reproduce GPU memory limits, thermal throttling, or driver quirks — which
are exactly what breaks mobile 3D. Do both.

**Emulation (necessary, not sufficient):**
- DevTools Device Toolbar for viewport and DPR
- CPU throttling 4–6× to approximate a mid-range phone
- Network throttling Fast/Slow 4G to check load behavior

**Real devices:**
- Android: `chrome://inspect#devices` with USB debugging for full DevTools on the device
- iOS: Safari → Develop menu → the connected device for the Web Inspector
- Run the scene for at least 60 seconds to catch thermal throttling
- Test with the device already warm and with battery saver on
- Test orientation changes and backgrounding/foregrounding the tab

Expose a quality override (`?quality=mobile`, `?webgl=1`) so both the low tier and the WebGL
fallback can be checked from a desktop browser during development.

## 12. Diagnosing by symptom

| Symptom | Likely cause | First thing to try |
|---|---|---|
| Low fps, high JS time | too many draw calls / objects | instance and merge; check `renderer.info.render.calls` |
| Low fps, low JS time | fill rate | lower DPR, cut post-processing, reduce transparency |
| Fine until the camera moves close | overdraw from transparency or transmission | reduce transparent layers |
| Fine on desktop, blank/reload on iOS | VRAM ceiling | shrink textures, switch to KTX2, verify disposal |
| Gets slower over time | missing disposal | watch `renderer.info.memory` across interactions |
| Long freeze on load | decompression or shader compilation on the main thread | compile materials during the loading screen |
| Stutters the first time an object appears | shader compilation | `renderer.compileAsync(scene, camera)` before showing the scene |
| Model invisible | no lights and no environment, or wrong scale | add `scene.environment`; log the bounding box |
| Everything washed out | color space or double tone mapping | audit `outputColorSpace` and texture `colorSpace` |
| Fast desktop, slow high-refresh desktop | frame-rate-dependent lerp | switch to `MathUtils.damp` with real delta |

Precompile shaders to remove first-appearance hitching:

```js
await renderer.compileAsync(scene, camera);   // during the loading screen
```

## 13. Ship checklist

**Assets**
- [ ] Every model is GLB and has been through `gltf-transform optimize`
- [ ] Geometry compressed (Draco or Meshopt); textures compressed (KTX2 or WebP)
- [ ] Decoder files present in the public directory and paths correct
- [ ] Texture dimensions within tier budget; no stray 4096² maps
- [ ] Per-tier model variants generated if the scene is heavy

**Rendering**
- [ ] `outputColorSpace = SRGBColorSpace`; color maps sRGB, data maps linear
- [ ] A tone mapping mode chosen deliberately, applied exactly once
- [ ] DPR capped (`Math.min(devicePixelRatio, 2)`; 1 on mobile)
- [ ] Environment lighting present (HDRI or `RoomEnvironment`)
- [ ] Shadow camera tightened to the subject; at most one shadow-casting light

**Performance**
- [ ] Draw calls, triangles, texture count within tier budget (`scripts/check-scene.js`)
- [ ] Instancing/merging applied to repeated and static geometry
- [ ] On-demand rendering for scenes without continuous animation
- [ ] Off-screen and hidden-tab rendering paused
- [ ] Post-processing and shadows gated by device tier, not always constructed
- [ ] Disposal implemented and verified against `renderer.info.memory`

**Adaptation**
- [ ] Tier detection with a manual override
- [ ] Dynamic resolution scaling wired
- [ ] Resize via `ResizeObserver`; `orientationchange` handled with a delay
- [ ] Touch controls configured; `touch-action` set so the page still scrolls
- [ ] `prefers-reduced-motion` respected
- [ ] Non-3D fallback for unsupported or failed contexts

**Verification**
- [ ] Tested with `forceWebGL: true` as well as the WebGPU path
- [ ] Tested in DevTools mobile emulation with 4–6× CPU throttle
- [ ] Tested on a real phone for at least 60 seconds, or the limitation stated plainly
- [ ] Time to first render measured on throttled network
- [ ] No console errors; no silently failing loaders
