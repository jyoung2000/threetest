# Image → 3D: Services, Splats, and In-Engine Pseudo-3D

Three.js cannot generate a mesh from a photograph. Every "image to 3D model" job is one of
the paths below. Choosing correctly matters more than executing well — the wrong path
produces a 40 MB mesh where a 200 KB technique would have looked better.

## Contents
A. AI image-to-3D services (real geometry)
B. Gaussian splats (photoreal capture)
C. In-engine pseudo-3D — depth displacement, parallax, SVG extrude, particles
D. Text-to-3D and procedural
E. Cleanup pipeline for generated meshes
F. Choosing, restated

---

## A. AI image-to-3D services (real geometry)

Use when the user needs *that specific object* as manipulable geometry: a configurator,
physics, AR placement, a real turntable, a model that gets animated.

### Current landscape (as of mid-2026 — verify pricing and licensing before shipping)

| Service | Strengths | Output | Licensing note |
|---|---|---|---|
| **Tripo** (H3.1 / P1 Smart Mesh) | fast, game-ready topology, solid public API | GLB, FBX, OBJ, STL | free tier typically non-commercial; paid tiers grant commercial use |
| **Meshy** (v6) | strong all-rounder, PBR maps, auto-rigging | GLB, FBX, OBJ, USDZ | free tier output often CC BY and public; paid for private/commercial |
| **Hyper3D Rodin** (Gen-2) | highest detail, cleanest quad topology, characters | GLB, OBJ, STL | commercial terms on paid plans |
| **Microsoft TRELLIS 2** | open source, excellent quality, mesh + splat output | GLB, Gaussian | MIT; self-host, needs a capable GPU |
| **Tencent Hunyuan3D** (2.1) | open source, genuine PBR output | GLB | open license with regional restrictions |
| **Stability SF3D / SPAR3D** | sub-second turnaround for prototypes | GLB (often albedo only) | revenue-capped free use |
| **Luma Genie** | easy free previews | GLB | non-commercial |

Confirm current terms yourself — this space changes monthly and free-tier licensing in
particular has shifted repeatedly.

### Input image quality drives output quality

Tell the user this before they spend credits:
- one subject, centered, fully in frame
- plain, uncluttered background (a cutout with transparency is ideal)
- even, diffuse lighting; avoid hard shadows and blown highlights
- a three-quarter view shows more geometry than a flat front-on shot
- avoid motion blur, heavy bokeh, and reflective surfaces that confuse depth
- multi-view input (front/side/back), where supported, dramatically improves the back of the model

### Generic API integration pattern

All of these services are asynchronous: submit → receive a task id → poll → download.
Keep API keys server-side; never ship them in client JavaScript.

```js
// scripts/image-to-3d.mjs implements this shape against a configurable endpoint.
const submit = await fetch(`${BASE}/generation/image-to-model`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: MODEL_VERSION,
    file: { type: 'jpg', url: imageUrl },   // or an uploaded file token
    texture: true,
    pbr: true,
    texture_quality: 'detailed',
  }),
});
const { data: { task_id } } = await submit.json();

// poll
let result;
for (let i = 0; i < 150; i++) {
  await new Promise(r => setTimeout(r, 2000));
  const res = await fetch(`${BASE}/task/${task_id}`, { headers: { Authorization: `Bearer ${API_KEY}` } });
  const body = await res.json();
  if (body.data.status === 'success') { result = body.data.output; break; }
  if (['failed', 'banned', 'expired'].includes(body.data.status)) throw new Error(body.data.status);
}
// download result.model_url → .glb, then run the cleanup pipeline
```

Handle: auth failure, rate limiting, generation failure (bad input image), timeout, and
insufficient credits. Report the actual failure reason to the user rather than retrying blindly.

**Always run generated meshes through section E before putting them on a page.**

---

## B. Gaussian splats (photoreal capture)

Use when the source is a real capture of a place or object and photorealism matters more
than editable geometry. Splats reproduce reflections, foliage, and fine detail that meshes
cannot, but have no surface to collide with, light, or edit.

Capture with Luma, Polycam, Postshot, or Scaniverse → `.ply` / `.splat` / `.ksplat`
(`.spz` is emerging as a compressed interchange format).

```bash
npm install @mkkellogg/gaussian-splats-3d
```

```js
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';

const viewer = new GaussianSplats3D.DropInViewer({
  gpuAcceleratedSort: true,
  sharedMemoryForWorkers: false,   // set false unless COOP/COEP headers are configured
});
await viewer.addSplatScene('/splats/room.ksplat', {
  splatAlphaRemovalThreshold: 5,
  showLoadingUI: true,
  position: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
});
scene.add(viewer);   // renders inside a normal Three.js scene alongside meshes
```

Notes:
- Convert `.ply` → `.ksplat` ahead of time; it loads far faster.
- Splat count is the performance dial. Cap around 1–2M on desktop and 300–500k on mobile.
- Sorting is the bottleneck; `gpuAcceleratedSort` matters.
- `sharedMemoryForWorkers: true` requires cross-origin isolation headers — leave it off unless those are in place.
- Splats and meshes coexist, but splats do not receive scene lighting or cast shadows.

---

## C. In-engine pseudo-3D (no external model)

The right answer far more often than people expect. Loads in kilobytes, runs everywhere,
fully art-directable.

### C1. Depth-map displacement

Turns a flat image into real relief. The standard technique for 3D hero images, parallax
photo sections, and scroll-driven photo scenes.

**Step 1 — get a depth map.** Generate offline with a monocular depth model (Depth Anything
V2, MiDaS, Marigold) via a hosted endpoint or locally, then save a grayscale PNG where white
is near and black is far. Some phone photos already carry a depth channel (iOS Portrait mode).

**Step 2 — displace a subdivided plane.**

```js
const [color, depth] = await Promise.all([
  new THREE.TextureLoader().loadAsync('/img/photo.jpg'),
  new THREE.TextureLoader().loadAsync('/img/photo-depth.png'),
]);
color.colorSpace = THREE.SRGBColorSpace;
depth.colorSpace = THREE.NoColorSpace;

const aspect = 1600 / 1067;
const geometry = new THREE.PlaneGeometry(4 * aspect, 4, 256, 256);  // segments = smoothness
const material = new THREE.MeshStandardMaterial({
  map: color,
  displacementMap: depth,
  displacementScale: 0.6,      // tune: too high tears the image apart at depth edges
  displacementBias: -0.3,
  roughness: 0.9,
  metalness: 0,
});
const plane = new THREE.Mesh(geometry, material);
scene.add(plane);
```

**Step 3 — parallax on pointer or scroll.** The illusion lives in the motion:

```js
addEventListener('pointermove', (e) => {
  const x = (e.clientX / innerWidth) * 2 - 1;
  const y = -(e.clientY / innerHeight) * 2 + 1;
  gsap.to(camera.position, { x: x * 0.35, y: y * 0.25, duration: 1.2, ease: 'power2.out',
    onUpdate: () => camera.lookAt(0, 0, 0) });
});
```

Tuning notes: 256×256 segments is a good quality/cost point (128 on mobile). Keep camera
motion small — large moves expose the missing information behind foreground objects. A
slight vignette or a blurred duplicate plane behind the main one hides edge stretching.

The point-cloud variant of the same idea often looks better for abstract treatments:

```js
const geo = new THREE.PlaneGeometry(w, h, 320, 320);
const mat = new THREE.PointsMaterial({ size: 0.008, map: color, alphaTest: 0.5,
  displacementMap: depth, displacementScale: 0.8 });
scene.add(new THREE.Points(geo, mat));
```

On WebGPU, drive the same displacement through TSL for full control:

```js
import { texture, uv, positionLocal, vec3, float } from 'three/tsl';
const mat = new THREE.MeshStandardNodeMaterial({ map: color });
const d = texture(depth, uv()).r;
mat.positionNode = positionLocal.add(vec3(0, 0, d.mul(float(0.8))));
```

### C2. Parallax layers (2.5D diorama)

Cut the image into foreground / midground / background PNGs with transparency (any image
editor, or a segmentation model), place each on a plane at a different Z, move them at
different rates.

```js
const layers = [
  { url: '/img/bg.png',  z: -3, factor: 0.15 },
  { url: '/img/mid.png', z: -1, factor: 0.45 },
  { url: '/img/fg.png',  z:  1, factor: 1.00 },
];
// per pointer move: layer.mesh.position.x = mouse.x * layer.factor * 0.6;
```

Cheaper than depth displacement, and cleaner when the image has clearly separable subjects.

### C3. SVG logo or icon → extruded 3D

For logos, icons, glyphs, and flat vector art this beats every AI path: crisp at any zoom,
a few kilobytes, and fully controllable.

```js
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';

const data = await new SVGLoader().loadAsync('/logo.svg');
const group = new THREE.Group();

for (const path of data.paths) {
  const shapes = SVGLoader.createShapes(path);          // handles holes correctly
  for (const shape of shapes) {
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: 18,
      bevelEnabled: true,
      bevelThickness: 2,
      bevelSize: 1.5,
      bevelSegments: 3,
      curveSegments: 12,
    });
    geometry.center();
    const material = new THREE.MeshPhysicalMaterial({
      color: path.userData.style.fill ?? 0xffffff,
      metalness: 0.9, roughness: 0.25, clearcoat: 1,
    });
    group.add(new THREE.Mesh(geometry, material));
  }
}
group.scale.y *= -1;         // SVG's Y axis points down; Three's points up
group.scale.multiplyScalar(0.01);
scene.add(group);
```

Text works the same way via `TextGeometry` + a loaded font, or by converting text to paths
in the SVG first (more reliable for exact brand typography).

### C4. Image as texture on geometry

Sometimes the whole job: map the image onto a curved plane, a cylinder, a card that tilts on
hover, or a torus. Combined with an HDRI environment and clearcoat, a photo on a slightly
curved plane reads as a physical print.

```js
const geo = new THREE.PlaneGeometry(3, 2, 32, 32);
// gentle cylindrical curve
const pos = geo.attributes.position;
for (let i = 0; i < pos.count; i++) {
  const x = pos.getX(i);
  pos.setZ(i, -0.08 * x * x);
}
geo.computeVertexNormals();
```

### C5. Image → particle system

Sample the image's pixels and position particles by UV, pushing Z by luminance or depth.
Excellent for hero sections, transitions, and "dissolve" effects — and it is genuinely 3D
motion built from a 2D source.

```js
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
canvas.width = img.width; canvas.height = img.height;
ctx.drawImage(img, 0, 0);
const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);

const step = 4;                                   // sample every 4th pixel
const positions = [], colors = [];
for (let y = 0; y < canvas.height; y += step) {
  for (let x = 0; x < canvas.width; x += step) {
    const i = (y * canvas.width + x) * 4;
    const a = data[i + 3]; if (a < 20) continue;
    const lum = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
    positions.push(
      (x / canvas.width - 0.5) * 5,
      -(y / canvas.height - 0.5) * 5 * (canvas.height / canvas.width),
      lum * 0.8
    );
    colors.push(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
  }
}
const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.015, vertexColors: true })));
```

Cap the particle count per tier (`PRESETS[tier].particleCount`) by increasing `step`.

---

## D. Text-to-3D and procedural

With only a description and no image:

- **Geometric, abstract, stylized, or diagrammatic** — build it from primitives. See
  `references/procedural.md`. Sharper, smaller, and fully art-directable.
- **A specific realistic object** — text-to-3D via the same services in section A (they all
  accept a prompt as well as an image), then treat the result as section E.
- **A scene rather than an object** — compose it: procedural ground and atmosphere, one or
  two generated or sourced hero models, instanced background elements.

---

## E. Cleanup pipeline for generated meshes

Generated meshes are typically 20k–300k+ triangles with uneven topology, oversized textures,
and sometimes lighting baked into the albedo. Never load one straight into a page.

```bash
# 1. inspect what came back
gltf-transform inspect raw.glb

# 2. weld duplicate vertices so simplification works properly
gltf-transform weld raw.glb welded.glb

# 3. reduce triangles — check visual quality at each ratio
gltf-transform simplify welded.glb simple.glb --ratio 0.4 --error 0.001

# 4. resize textures to the target tier
gltf-transform resize simple.glb sized.glb --width 1024 --height 1024

# 5. compress for the web
gltf-transform optimize sized.glb web.glb --compress draco --texture-compress ktx2

# 6. confirm the result
gltf-transform inspect web.glb
```

Blender headless decimation, when the simplifier's output is unacceptable:

```python
# decimate.py — blender -b -P decimate.py -- input.glb output.glb
import bpy, sys
argv = sys.argv[sys.argv.index("--") + 1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=argv[0])
for obj in bpy.context.scene.objects:
    if obj.type != 'MESH':
        continue
    mod = obj.modifiers.new(name="Decimate", type='DECIMATE')
    mod.ratio = 0.35
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=mod.name)
bpy.ops.export_scene.gltf(filepath=argv[1], export_format='GLB')
```

Common fixes after generation:
- **Baked-in lighting** in the albedo fights the scene's own lighting. Either accept a flatter
  look with `MeshBasicMaterial`, or repaint/desaturate the albedo.
- **No PBR maps** (some services return albedo only). Author a roughness value manually and
  lean on the environment map.
- **Wrong scale/orientation** — normalize with the framing helper in `references/asset-pipeline.md`.
- **Hollow or malformed backs** — inevitable from a single view. Frame the camera to avoid
  the back, or supply multi-view input.
- **Not animation-ready** — AI topology has evenly distributed quads, not edge loops around
  joints. Deformation will look wrong; retopology is a manual job. For animated characters,
  consider a rigged stock model instead.

---

## F. Choosing, restated

| Input | Goal | Path |
|---|---|---|
| Product photo | interactive 3D viewer | A → E |
| Product photo | eye-catching hero section | C1 or C5 |
| Logo / icon | 3D branded element | C3 |
| Photo of a room or place | immersive walkthrough | B |
| Photo of a real object | AR / measurement / physics | A → E |
| Landscape photograph | scroll parallax | C1 or C2 |
| Concept art of a character | animated character | A → E, expect retopology work |
| Text: "spinning globe with city zoom" | interactive element | procedural (`references/procedural.md`) |
| Text: "worn leather armchair" | realistic prop | text-to-3D → E |
| Text: "low-poly floating island" | stylized scene | procedural |

When in doubt between an AI mesh and an in-engine technique, prototype the in-engine one
first. It takes twenty minutes, costs nothing, and frequently ends the discussion.
