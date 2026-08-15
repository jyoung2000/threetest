# Renderer Setup, Imports, and TSL (Three.js r185)

## Contents
1. Install and import surfaces
2. CDN importmap (no build step)
3. WebGPURenderer with automatic WebGL2 fallback
4. Classic WebGLRenderer
5. Choosing between them
6. Scene, camera, controls boilerplate
7. TSL and node materials
8. Common setup mistakes

---

## 1. Install and import surfaces

```bash
npm install three
npm install gsap                            # animation / scroll
npm install -D vite                         # any bundler; Vite is the common choice
npm install -g @gltf-transform/cli          # asset optimization CLI
```

Three r185 exposes several entry points and they are not interchangeable:

```js
import * as THREE from 'three';            // classic WebGL build
import * as THREE from 'three/webgpu';     // WebGPURenderer + node materials (superset)
import { Fn, uniform, positionLocal, normalLocal, time, mix, texture, vec3, float }
  from 'three/tsl';                        // Three Shading Language
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';   // all examples/jsm
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
```

`three/webgpu` includes the core classes too, so a WebGPU project imports `THREE` from
`three/webgpu` and never from `three`. Mixing the two in one project produces two copies of
the core classes and confusing `instanceof` failures.

## 2. CDN importmap (no build step)

Useful for demos, single-file deliverables, and anything the user should be able to open by
running `npx serve`. Pin the version explicitly.

```html
<script type="importmap">
{
  "imports": {
    "three":            "https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js",
    "three/webgpu":     "https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.webgpu.js",
    "three/tsl":        "https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.tsl.js",
    "three/addons/":    "https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/",
    "gsap":             "https://cdn.jsdelivr.net/npm/gsap@3.13.0/index.js"
  }
}
</script>
<script type="module">
  import * as THREE from 'three';
  import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
</script>
```

Bare specifiers (`import ... from 'three'`) require the importmap. Modules also require a
real server — `file://` fails on CORS. `npx serve` or `python -m http.server` is enough.

## 3. WebGPURenderer with automatic WebGL2 fallback

The default recommendation. One code path, best available backend.

```js
import * as THREE from 'three/webgpu';

const renderer = new THREE.WebGPURenderer({
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
  // forceWebGL: true,   // flip on to test the fallback path
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

await renderer.init();               // REQUIRED before any manual renderer.render()
console.log('backend:', renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2');

renderer.setAnimationLoop(() => renderer.render(scene, camera));
```

`setAnimationLoop` awaits init internally, so if the whole render loop goes through it the
explicit `await renderer.init()` can be skipped. Any manual `render()` — including inside a
GSAP `onUpdate` — needs init to have completed first.

Async render is also available and is what the node post-processing stack uses:

```js
await renderer.renderAsync(scene, camera);
```

## 4. Classic WebGLRenderer

```js
import * as THREE from 'three';

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
  stencil: false,          // skip buffers the scene does not use
  depth: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
```

No init step; render immediately.

## 5. Choosing between them

| Need | Renderer |
|---|---|
| Single code path, best available backend, future-facing | WebGPURenderer (default) |
| Compute shaders, large particle systems, heavy instancing | WebGPURenderer |
| pmndrs `postprocessing` (N8AO, SMAA, mature DoF/bloom) | WebGLRenderer |
| Existing GLSL `ShaderMaterial` or `onBeforeCompile` code | WebGLRenderer (or port to TSL) |
| Smallest bundle | WebGLRenderer |
| Widest older-Safari coverage with zero surprises | WebGLRenderer |

Not supported on the WebGPU backend: `ShaderMaterial`, `RawShaderMaterial`,
`onBeforeCompile`, and `EffectComposer` passes. Porting means TSL node materials and the
node `PostProcessing` / `RenderPipeline` stack.

WebGPU is broadly but not universally available — roughly mid-80s percent globally as of
early 2026, weaker on mobile and on Firefox outside Windows and ARM macOS. The fallback is
not a formality; test it.

## 6. Scene, camera, controls boilerplate

```js
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 1.2, 5);

import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.minDistance = 2;
controls.maxDistance = 12;
controls.maxPolarAngle = Math.PI * 0.52;      // stop the camera going under the floor
controls.target.set(0, 0.8, 0);

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
addEventListener('resize', onResize);
```

A narrow field of view (30–40°) reads as cinematic; the wide 75° default reads as a game
demo and distorts objects near the frame edge.

## 7. TSL and node materials

TSL is a JavaScript shading language that compiles to WGSL on WebGPU and GLSL on WebGL, so
one implementation covers both backends. Node materials are the `*NodeMaterial` family
whose properties accept TSL nodes instead of plain values.

```js
import * as THREE from 'three/webgpu';
import { Fn, uniform, positionLocal, uv, time, sin, mix, vec3, float } from 'three/tsl';

const mat = new THREE.MeshStandardNodeMaterial();

// animated color
mat.colorNode = mix(vec3(0.1, 0.3, 0.9), vec3(0.9, 0.2, 0.4), sin(time.mul(0.5)).mul(0.5).add(0.5));

// vertex displacement (a wave along X)
const amplitude = uniform(0.15);
mat.positionNode = positionLocal.add(
  vec3(0, sin(positionLocal.x.mul(4).add(time.mul(2))).mul(amplitude), 0)
);

// reusable function node
const fresnel = Fn(([power]) => {
  return float(1).sub(normalView.dot(positionViewDirection).abs()).pow(power);
});
mat.emissiveNode = vec3(0.2, 0.6, 1.0).mul(fresnel(3.0));
```

Uniforms update from JS directly:

```js
amplitude.value = 0.4;
```

Node material equivalents: `MeshStandardNodeMaterial`, `MeshPhysicalNodeMaterial`,
`MeshBasicNodeMaterial`, `PointsNodeMaterial`, `SpriteNodeMaterial`, `LineBasicNodeMaterial`.
Standard materials still work under `three/webgpu` and are converted internally — only
custom shading requires the node variants.

Useful TSL nodes: `positionLocal`, `positionWorld`, `positionView`, `normalLocal`,
`normalWorld`, `normalView`, `uv()`, `time`, `texture()`, `mix`, `smoothstep`, `step`,
`clamp`, `fract`, `noise` helpers from `three/tsl`, `attribute()`, `varying()`, `Fn()`,
`If`/`Loop` control flow.

## 8. Common setup mistakes

- **Black canvas, no error, WebGPU** — missing `await renderer.init()` with a manual render loop.
- **Washed out or gray colors** — `outputColorSpace` or texture `colorSpace` wrong, or tone
  mapping applied twice (renderer *and* a tone-mapping post effect).
- **Model loads but is invisible** — no lights and no `scene.environment`; `MeshStandardMaterial`
  renders black without either. Add an env map or a light before debugging further.
- **Model is microscopic or enormous** — glTF units are meters; check `box3.setFromObject()`
  and scale/frame the camera to the bounding box rather than guessing.
- **Blurry on retina** — DPR not set, or set after `setSize`. Call `setPixelRatio` first.
- **Scene fine on desktop, blank on iOS** — VRAM ceiling. Reduce texture sizes and check disposal.
- **`instanceof` failures / duplicate class errors** — `three` and `three/webgpu` both imported.
