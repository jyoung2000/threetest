# Asset Pipeline: Loading and Optimizing Models (Three.js r185)

## Contents
1. Format decisions
2. Compression: Draco vs Meshopt vs KTX2
3. CLI optimization commands
4. Decoder files
5. GLTFLoader wired for everything
6. LoadingManager and progressive loading
7. Framing and normalizing a loaded model
8. Instancing, merging, LOD
9. Texture handling
10. Blender export settings

---

## 1. Format decisions

Ship **GLB** (binary glTF). It bundles geometry, materials, textures, and animation into one
file, loads directly, and is the only format with a real web compression story.

Convert anything else before use:

```bash
# FBX / OBJ / DAE → GLB
blender -b -P convert.py -- input.fbx output.glb     # headless Blender
# or use Blender GUI: File → Export → glTF 2.0 (.glb), Format = glTF Binary
```

Never ship `.fbx`, `.obj`, or `.blend` to a browser. FBXLoader and OBJLoader exist for
prototyping but the files are large, uncompressed, and slow to parse.

## 2. Compression: Draco vs Meshopt vs KTX2

These solve different problems and are used together.

| | What it compresses | Typical saving | Cost |
|---|---|---|---|
| **Draco** | geometry (vertices, indices) | 80–90% of geometry bytes | slower decode, ~100 KB decoder |
| **Meshopt** | geometry + animation | similar ratio | much faster decode, tiny decoder |
| **KTX2 / Basis** | textures, stays GPU-compressed | 4–8× less VRAM | slight quality loss, transcoder needed |
| **WebP** | textures, decompresses in VRAM | smaller download only | no VRAM saving |

The VRAM point matters more than download size on mobile. A 2048² PNG occupies ~16 MB of
VRAM regardless of its file size; the same texture as KTX2/ETC1S stays compressed on the
GPU at a fraction of that. Mobile scenes that crash iOS are almost always texture-VRAM
problems, not download problems.

Rules of thumb:
- Static geometry, download size is the priority → **Draco**
- Animated meshes, many models, or decode time matters → **Meshopt**
- Any scene with more than a couple of textures → **KTX2** (use `--texture-compress webp` if
  KTX2 transcoding proves problematic on a target device)

## 3. CLI optimization commands

```bash
npm install -g @gltf-transform/cli

# one-pass, broad compatibility
gltf-transform optimize in.glb out.glb --compress draco --texture-compress webp

# one-pass, maximum VRAM savings
gltf-transform optimize in.glb out.glb --compress meshopt --texture-compress ktx2

# granular steps
gltf-transform resize    in.glb out.glb --width 1024 --height 1024
gltf-transform simplify  in.glb out.glb --ratio 0.5 --error 0.001   # decimate geometry
gltf-transform weld      in.glb out.glb                             # merge duplicate verts
gltf-transform prune     in.glb out.glb                             # drop unused data
gltf-transform dedup     in.glb out.glb                             # dedupe accessors/textures
gltf-transform draco     in.glb out.glb
gltf-transform meshopt   in.glb out.glb --level medium
gltf-transform etc1s     in.glb out.glb                             # small KTX2
gltf-transform uastc     in.glb out.glb                             # high-quality KTX2
gltf-transform inspect   in.glb                                     # report meshes, tris, textures
```

`gltf-transform inspect` before and after is the fastest way to show the user what changed
and to catch a model whose triangle count blows the budget.

Alternative single binary:

```bash
gltfpack -i in.glb -o out.glb -cc        # meshopt + quantization
gltfpack -i in.glb -o out.glb -cc -tc    # plus KTX2 textures
```

**Windows PowerShell**: the npm CLI resolves as `gltf-transform.cmd`. Quote paths, and use
single quotes when the path contains `$`:

```powershell
gltf-transform.cmd optimize '.\public\models\hero.glb' '.\public\models\hero.opt.glb' `
  --compress draco --texture-compress webp
```

`scripts/optimize-glb.ps1` wraps this and prints before/after sizes.

## 4. Decoder files

Draco and KTX2 need decoder/transcoder files served alongside the site. Missing decoders =
silent failure, blank scene.

```bash
# from node_modules after `npm install three`
cp -r node_modules/three/examples/jsm/libs/draco/  public/draco/
cp -r node_modules/three/examples/jsm/libs/basis/  public/basis/
```

`scripts/fetch-decoders.mjs` does this cross-platform. For a CDN-only page, point the paths
at the matching pinned version:

```js
draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/libs/draco/');
ktx2.setTranscoderPath('https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/libs/basis/');
```

## 5. GLTFLoader wired for everything

```js
import { GLTFLoader }     from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader }    from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader }     from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const draco = new DRACOLoader().setDecoderPath('/draco/');
draco.setDecoderConfig({ type: 'js' });     // 'js' is safer; wasm is faster where supported

const ktx2 = new KTX2Loader()
  .setTranscoderPath('/basis/')
  .detectSupport(renderer);                 // needs the renderer to pick a GPU format

const loader = new GLTFLoader()
  .setDRACOLoader(draco)
  .setKTX2Loader(ktx2)
  .setMeshoptDecoder(MeshoptDecoder);

const gltf = await loader.loadAsync('/models/hero.glb');
scene.add(gltf.scene);

// clean up decoder workers when the scene is torn down
// draco.dispose(); ktx2.dispose();
```

`detectSupport(renderer)` must be called after the renderer exists and, on WebGPU, after
`renderer.init()`. Skipping it makes KTX2 textures fail to transcode.

## 6. LoadingManager and progressive loading

```js
const manager = new THREE.LoadingManager();
manager.onStart    = ()             => showLoader();
manager.onProgress = (url, n, total) => setProgress(n / total);
manager.onLoad     = ()             => hideLoader();
manager.onError    = (url)          => console.error('failed:', url);

const loader = new GLTFLoader(manager).setDRACOLoader(draco);
```

Load in priority order so first paint happens early:

```js
// 1. environment + hero, awaited
const [envTex, hero] = await Promise.all([
  loadEnvironment('/hdr/studio_1k.hdr'),
  loader.loadAsync('/models/hero.glb'),
]);
scene.environment = envTex;
scene.add(hero.scene);
startRenderLoop();

// 2. secondary assets after the user can already see something
const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 200));
idle(async () => {
  const props = await loader.loadAsync('/models/props.glb');
  scene.add(props.scene);
});
```

For a scroll-driven page, load the model for section N+1 while the user reads section N.

## 7. Framing and normalizing a loaded model

Imported models arrive at arbitrary scale and offset. Normalize instead of hand-tuning
magic numbers.

```js
function frameObject(object, camera, controls, fill = 1.2) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  // recenter on the origin, sit on the ground plane
  object.position.sub(center);
  object.position.y += size.y / 2;

  // frame it
  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = camera.fov * (Math.PI / 180);
  const distance = (maxDim / 2 / Math.tan(fov / 2)) * fill;
  camera.position.set(distance * 0.6, size.y * 0.7, distance);
  camera.near = distance / 100;
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  controls?.target.set(0, size.y / 2, 0);
  controls?.update();
}
```

Also fix up materials and shadows on import:

```js
gltf.scene.traverse((o) => {
  if (!o.isMesh) return;
  o.castShadow = true;
  o.receiveShadow = true;
  o.frustumCulled = true;
  if (o.material.map) o.material.map.anisotropy = Math.min(4, renderer.capabilities?.getMaxAnisotropy?.() ?? 4);
});
```

## 8. Instancing, merging, LOD

**InstancedMesh** — many copies of one geometry+material in one draw call:

```js
const count = 2000;
const mesh = new THREE.InstancedMesh(geometry, material, count);
mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);   // only if updating per frame
const m = new THREE.Matrix4();
const q = new THREE.Quaternion();
const s = new THREE.Vector3(1, 1, 1);
for (let i = 0; i < count; i++) {
  m.compose(randomPosition(), q.setFromEuler(randomEuler()), s);
  mesh.setMatrixAt(i, m);
  mesh.setColorAt?.(i, randomColor());     // per-instance color
}
mesh.instanceMatrix.needsUpdate = true;
scene.add(mesh);
```

**Merging** — static meshes sharing a material collapse to one draw call:

```js
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
const merged = mergeGeometries([g1, g2, g3], false);
scene.add(new THREE.Mesh(merged, sharedMaterial));
```

Merged geometry loses individual transforms and per-object culling — apply transforms into
the geometry first (`g.applyMatrix4(obj.matrixWorld)`) and only merge things that are always
visible together.

**LOD** — swap detail by camera distance automatically:

```js
const lod = new THREE.LOD();
lod.addLevel(highMesh, 0);
lod.addLevel(midMesh, 12);
lod.addLevel(lowMesh, 35);
lod.addLevel(new THREE.Object3D(), 120);   // cull entirely past this distance
scene.add(lod);
```

Generate the LOD meshes with `gltf-transform simplify --ratio 0.5` / `0.15` rather than
authoring them by hand.

## 9. Texture handling

```js
tex.colorSpace = THREE.SRGBColorSpace;   // base color, emissive
tex.colorSpace = THREE.NoColorSpace;     // normal, roughness, metalness, AO, displacement
tex.anisotropy = 4;                      // 4 is a good quality/cost point; 16 is wasteful
tex.generateMipmaps = true;              // keep on for anything viewed at varying distance
tex.minFilter = THREE.LinearMipmapLinearFilter;
tex.flipY = false;                       // glTF textures are already correctly oriented
```

Texture budget discipline:
- Combine roughness/metalness/AO into one ORM texture (glTF does this by default).
- Atlas small textures so multiple meshes share one material.
- Power-of-two dimensions; 2048 desktop / 1024 tablet / 512–1024 mobile.
- Ship a second smaller texture set for mobile rather than downscaling at runtime.

## 10. Blender export settings

When the user is exporting from Blender:

- Format: **glTF Binary (.glb)**
- Include: Selected Objects if isolating; enable Custom Properties only if needed
- Transform: **+Y Up** (checked — this is Three's convention)
- Geometry: Apply Modifiers on, UVs on, Normals on, Tangents on **only if** using normal maps
- Compression: leave off in Blender; do it with `gltf-transform` for better control
- Animation: Export Deformation Bones Only, Always Sample Animations off unless needed
- Bake or discard procedural Blender materials — glTF only carries PBR channels, so anything
  built from Blender shader nodes must be baked to textures first

Before exporting: apply transforms (Ctrl+A → All Transforms), remove unused modifiers,
decimate any multi-million-triangle sculpt, and delete hidden geometry.
