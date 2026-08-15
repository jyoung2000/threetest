# Device Adaptation: Desktop, Tablet, Mobile (Three.js r185)

## Contents
1. Why tiers, not one build
2. Detecting a device tier
3. Quality presets
4. Applying a preset
5. Dynamic resolution scaling
6. Adaptive asset selection
7. WebGPU detection and fallback testing
8. Touch controls
9. Resize, orientation, and visibility
10. iOS Safari specifics
11. Android and low-end specifics
12. Reduced motion and accessibility

---

## 1. Why tiers, not one build

A flagship desktop GPU and a three-year-old mid-range Android differ by more than an order
of magnitude in fill rate and available VRAM. One quality level either wastes the desktop or
kills the phone. Detect once at startup, pick a preset, and let dynamic resolution absorb
the variance within a tier.

Design the mobile tier first and add quality upward. Building desktop-first and stripping
down almost always leaves mobile with desktop-shaped assets.

## 2. Detecting a device tier

There is no reliable single signal. Combine several and be conservative.

```js
export function detectTier() {
  const ua = navigator.userAgent;
  const uaMobile = navigator.userAgentData?.mobile ?? /Android|iPhone|iPod|Mobile/i.test(ua);
  const isTabletUA = /iPad|Tablet|PlayBook|Silk/i.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);  // iPadOS lies
  const coarse = matchMedia('(pointer: coarse)').matches;
  const mem = navigator.deviceMemory ?? 4;              // GB, Chromium only
  const cores = navigator.hardwareConcurrency ?? 4;
  const shortSide = Math.min(screen.width, screen.height);
  const saveData = navigator.connection?.saveData === true;
  const slowNet = /2g/.test(navigator.connection?.effectiveType ?? '');

  if (saveData || slowNet) return 'mobile';             // respect the user's stated constraint
  if (uaMobile && !isTabletUA) return 'mobile';
  if (isTabletUA || (coarse && shortSide >= 700)) return 'tablet';
  if (mem <= 4 || cores <= 4) return 'tablet';          // weak desktop behaves like a tablet
  return 'desktop';
}
```

A stronger signal, when the extra dependency is acceptable, is the GPU renderer string via
`detect-gpu` (`npm i detect-gpu`), which benchmarks the reported GPU against a table:

```js
import { getGPUTier } from 'detect-gpu';
const gpu = await getGPUTier();      // { tier: 0..3, isMobile, gpu: 'apple a17 pro' }
const tier = gpu.tier <= 1 ? 'mobile' : gpu.tier === 2 ? 'tablet' : 'desktop';
```

Always allow a manual override — a query param or a settings toggle — because detection
will be wrong for someone.

```js
const forced = new URLSearchParams(location.search).get('quality');
const tier = forced ?? detectTier();
```

## 3. Quality presets

```js
export const PRESETS = {
  desktop: {
    dpr: 2,
    shadows: true,   shadowMapSize: 2048, shadowType: 'PCFSoft',
    post: true,      bloom: true, dof: true, ao: true, aa: 'smaa',
    maxTextureSize: 2048,
    environment: '/hdr/studio_2k.hdr',
    modelSuffix: '',                 // hero.glb
    anisotropy: 8,
    maxLights: 4,
    particleCount: 20000,
    transmission: true,
  },
  tablet: {
    dpr: 2,
    shadows: true,   shadowMapSize: 1024, shadowType: 'PCF',
    post: true,      bloom: true, dof: false, ao: false, aa: 'none',
    maxTextureSize: 1024,
    environment: '/hdr/studio_1k.hdr',
    modelSuffix: '.md',              // hero.md.glb
    anisotropy: 4,
    maxLights: 3,
    particleCount: 8000,
    transmission: false,
  },
  mobile: {
    dpr: 1,
    shadows: false,  shadowMapSize: 512,  shadowType: 'Basic',
    post: false,     bloom: false, dof: false, ao: false, aa: 'none',
    maxTextureSize: 512,
    environment: 'room',             // generated RoomEnvironment, zero download
    modelSuffix: '.lo',              // hero.lo.glb
    anisotropy: 1,
    maxLights: 2,
    particleCount: 2000,
    transmission: false,
  },
};
```

The mobile tier trades transmission, DoF, AO, and real shadows for a baked shadow plane and
a generated environment. That combination still looks good — the losses are the effects
users notice least and the GPU costs most.

## 4. Applying a preset

```js
export function applyPreset(renderer, scene, tier) {
  const p = PRESETS[tier];

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, p.dpr));
  renderer.shadowMap.enabled = p.shadows;
  if (p.shadows) {
    renderer.shadowMap.type = p.shadowType === 'PCFSoft'
      ? THREE.PCFSoftShadowMap
      : p.shadowType === 'PCF' ? THREE.PCFShadowMap : THREE.BasicShadowMap;
  }

  scene.traverse((o) => {
    if (o.isLight && o.shadow) {
      o.castShadow = p.shadows && o.userData.primaryShadowCaster !== false;
      o.shadow.mapSize.setScalar(p.shadowMapSize);
    }
    if (o.isMesh) {
      o.castShadow = p.shadows;
      o.receiveShadow = p.shadows;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!p.transmission && m.transmission > 0) {
          m.transmission = 0; m.transparent = true; m.opacity = 0.45; m.roughness = 0.1;
          m.needsUpdate = true;
        }
        if (m.map) m.map.anisotropy = p.anisotropy;
      }
    }
  });

  return p;   // caller uses p.post to decide whether to build a composer at all
}
```

Gate the composer at construction time, not per frame — a composer that exists costs render
targets and VRAM even if bypassed.

## 5. Dynamic resolution scaling

Absorbs variation inside a tier (thermal throttling, a heavy camera angle, a background tab
returning).

```js
export function createResolutionScaler(renderer, { min = 0.55, max = 1, target = 55 } = {}) {
  let scale = max, frames = 0, elapsed = 0, cooldown = 0;
  const basePixelRatio = Math.min(window.devicePixelRatio, PRESETS[tier].dpr);

  return function update(dt) {
    elapsed += dt; frames++; cooldown -= dt;
    if (elapsed < 1) return;
    const fps = frames / elapsed;
    elapsed = 0; frames = 0;
    if (cooldown > 0) return;

    if (fps < target - 10 && scale > min) {
      scale = Math.max(min, scale - 0.1);
    } else if (fps > target + 5 && scale < max) {
      scale = Math.min(max, scale + 0.05);
    } else {
      return;
    }
    renderer.setPixelRatio(basePixelRatio * scale);
    cooldown = 1.5;                 // avoid oscillating
  };
}
```

Drop a whole tier if the scaler bottoms out and framerate is still under target: disable
post-processing, then shadows, then swap to the lower model.

## 6. Adaptive asset selection

Produce the variants at build time, not at runtime:

```bash
gltf-transform optimize hero.glb hero.glb    --compress draco --texture-compress ktx2 --texture-size 2048
gltf-transform optimize hero.glb hero.md.glb --compress draco --texture-compress ktx2 --texture-size 1024
gltf-transform simplify hero.glb tmp.glb --ratio 0.4 --error 0.001
gltf-transform optimize  tmp.glb  hero.lo.glb --compress draco --texture-compress ktx2 --texture-size 512
```

```js
const url = `/models/hero${PRESETS[tier].modelSuffix}.glb`;
const gltf = await loader.loadAsync(url);
```

Environment selection:

```js
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
if (p.environment === 'room') {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
} else {
  scene.environment = await loadEnvironment(p.environment, renderer, scene);
}
```

## 7. WebGPU detection and fallback testing

```js
export async function hasWebGPU() {
  if (!('gpu' in navigator)) return false;
  try { return !!(await navigator.gpu.requestAdapter()); }
  catch { return false; }
}
```

`WebGPURenderer` already falls back on its own; explicit detection is only needed to branch
behavior (skip compute-driven particles, choose a different post stack). Confirm what was
actually chosen with `renderer.backend.isWebGPUBackend`.

Always test the fallback explicitly — it is the path a meaningful share of mobile users get:

```js
const renderer = new THREE.WebGPURenderer({ forceWebGL: true });
```

Wire this to `?webgl=1` during development so the fallback is one URL away.

## 8. Touch controls

```js
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;

const coarse = matchMedia('(pointer: coarse)').matches;
controls.enablePan = !coarse;                 // panning fights page scroll on touch
controls.rotateSpeed = coarse ? 0.6 : 1.0;
controls.zoomSpeed = coarse ? 0.8 : 1.0;
controls.touches = {
  ONE: THREE.TOUCH.ROTATE,
  TWO: THREE.TOUCH.DOLLY_ROTATE,              // pinch-zoom + two-finger orbit
};
```

If the canvas is inside a scrolling page, decide deliberately whether one-finger drag
rotates the model or scrolls the page. Common resolution: canvas is `touch-action: pan-y`
so vertical drags scroll and horizontal drags rotate.

```css
canvas { touch-action: pan-y; }
```

For scroll-driven scenes, disable OrbitControls entirely and let scroll own the camera.

## 9. Resize, orientation, and visibility

```js
let resizeRaf = 0;
function onResize() {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    const w = container.clientWidth, h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, PRESETS[tier].dpr) * currentScale);
    composer?.setSize(w, h);
    needsRender = true;
  });
}

// ResizeObserver beats the resize event for canvases in layout-driven containers
new ResizeObserver(onResize).observe(container);

// iOS reports stale layout during orientationchange — re-run after it settles
addEventListener('orientationchange', () => setTimeout(onResize, 250));

// stop rendering when the tab is hidden
document.addEventListener('visibilitychange', () => {
  if (document.hidden) renderer.setAnimationLoop(null);
  else { clock.getDelta(); renderer.setAnimationLoop(tick); }   // flush the accumulated delta
});
```

Calling `clock.getDelta()` once on resume prevents a giant delta from teleporting every
animation forward.

Use `IntersectionObserver` to pause a canvas that has scrolled off screen:

```js
new IntersectionObserver(([e]) => {
  running = e.isIntersecting;
  renderer.setAnimationLoop(running ? tick : null);
}, { threshold: 0.01 }).observe(container);
```

## 10. iOS Safari specifics

These cause the majority of "works everywhere except iPhone" reports.

- **VRAM ceiling.** Safari kills or silently reloads a tab that exceeds its per-tab GPU
  memory budget. Keep total texture memory under roughly 150 MB. Symptom: the page reloads
  itself, or the canvas goes white, with no console error. Fix by shrinking textures and
  using KTX2 rather than by shrinking geometry.
- **DPR.** A 3× phone at native DPR renders nine times the pixels of 1×. Cap at 1 (1.5 on
  recent flagships if profiling supports it).
- **Orientation change** reports stale `innerWidth`/`innerHeight`; re-run resize on a timeout.
- **Audio and video textures** need a user gesture to start.
- **`preserveDrawingBuffer: true`** is expensive; only enable it for screenshot features.
- **High-precision floats** in custom shaders are slow; prefer `mediump` where quality allows.
- **Thermal throttling** kicks in after 30–60 seconds of sustained load and can halve
  framerate. Design so 30 fps is acceptable, and reduce work when the scene is idle.
- **WebGPU** is available on iOS/iPadOS 26+; older versions take the WebGL2 fallback path.
- **iPadOS reports as MacIntel** — detect with `navigator.maxTouchPoints > 1`.
- **100vh** includes the browser chrome; use `100dvh` or a resize-driven pixel height so the
  canvas does not jump when the toolbar hides.

## 11. Android and low-end specifics

- Enormous device variance; `detect-gpu` is more valuable here than any UA check.
- Many mid-range GPUs are fill-rate bound: reducing resolution helps far more than
  reducing triangles.
- Avoid `antialias: true` on low tiers — MSAA is expensive on tiled mobile GPUs. Prefer
  rendering at a slightly higher internal scale with no MSAA, or FXAA/SMAA in post.
- Some drivers handle `HalfFloatType` render targets poorly; if a post chain produces
  black output on a specific device, that is the first thing to test.
- Battery saver modes cap the refresh rate; do not treat 30 fps there as a bug.

## 12. Reduced motion and accessibility

```js
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
if (reduceMotion) {
  // no auto-rotate, no float, no scroll-driven camera swings
  controls.autoRotate = false;
  idleMotionEnabled = false;
  gsapTimeline.progress(1).pause();   // jump to the end state rather than animating there
}
```

Also provide: a non-3D fallback (a rendered still image) when WebGL/WebGPU is unavailable,
meaningful text content that does not depend on the canvas, and keyboard-reachable controls
for anything interactive.

```js
if (!renderer) {
  container.innerHTML = '<img src="/fallback/hero.jpg" alt="…">';
}
```
