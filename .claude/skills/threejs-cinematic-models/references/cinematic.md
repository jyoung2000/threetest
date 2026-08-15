# Cinematic Rendering and Animation (Three.js r185)

## Contents
1. Color management
2. Tone mapping
3. HDRI environment lighting (IBL)
4. Lighting rigs
5. Shadows
6. PBR material recipes
7. Post-processing — WebGL (pmndrs)
8. Post-processing — WebGPU (node RenderPipeline)
9. AnimationMixer, clips, crossfades
10. Morph targets and skeletons
11. Idle and hero motion
12. Scroll-driven camera with GSAP ScrollTrigger
13. Camera paths, damping, and framing
14. What actually makes it look cinematic

---

## 1. Color management

Get this right first. Every other quality decision is judged against it.

```js
renderer.outputColorSpace = THREE.SRGBColorSpace;      // default since r152
```

Texture tagging:

| Map | colorSpace |
|---|---|
| base color / albedo / diffuse | `THREE.SRGBColorSpace` |
| emissive | `THREE.SRGBColorSpace` |
| normal, roughness, metalness, AO, displacement, alpha | `THREE.NoColorSpace` (linear) |
| HDRI environment (.hdr/.exr) | handled by the loader; do not tag |

GLTFLoader tags these correctly on import. Manual `TextureLoader` use does not — set it
explicitly.

Symptoms of getting it wrong: everything looks washed out and low contrast (linear data
treated as sRGB), or dark and oversaturated (the reverse), or normal maps produce weirdly
soft, wrong-direction lighting.

## 2. Tone mapping

```js
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
```

| Mode | Character | Use for |
|---|---|---|
| `ACESFilmicToneMapping` | contrasty, filmic highlight rolloff, slightly saturated | hero scenes, product film look, most cinematic work |
| `AgXToneMapping` | flatter, gracefully desaturating highlights, better hue retention | bright scenes, strong emissives, neon, sunlight |
| `NeutralToneMapping` | minimal shift, Khronos PBR Neutral | e-commerce, configurators, accurate material color |
| `LinearToneMapping` / `NoToneMapping` | none | when a post-processing pass does the tone mapping instead |

Exposure is the primary look control. Author lighting at exposure 1.0 and adjust exposure
last; raising light intensities to compensate for a dark image usually blows out the PBR
response instead.

Only tone-map once. If the post-processing chain includes a `ToneMappingEffect`, set
`renderer.toneMapping = THREE.NoToneMapping`.

## 3. HDRI environment lighting (IBL)

An HDRI environment is the single biggest realism lever — it gives every material correct
reflections and ambient occlusion-adjacent falloff for free.

```js
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
// import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';   // for .exr

async function loadEnvironment(url, renderer, scene, { asBackground = false } = {}) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  const hdr = await new RGBELoader().loadAsync(url);
  hdr.mapping = THREE.EquirectangularReflectionMapping;

  const envMap = pmrem.fromEquirectangular(hdr).texture;
  scene.environment = envMap;
  scene.environmentIntensity = 1.0;         // dial the IBL without touching lights
  if (asBackground) {
    scene.background = envMap;
    scene.backgroundBlurriness = 0.4;       // blurred backdrop keeps focus on the subject
    scene.backgroundIntensity = 0.8;
  }

  hdr.dispose();
  pmrem.dispose();
  return envMap;
}
```

Sizing: 1–2K HDRI is plenty for the web; 4K+ is wasted bandwidth and VRAM. On mobile, use a
1K file or skip the HDRI entirely in favor of a generated environment:

```js
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;   // ~0 bytes downloaded
```

`RoomEnvironment` is an excellent mobile fallback and a good neutral studio light for
product shots on any tier.

## 4. Lighting rigs

Even with an HDRI, explicit lights give art direction and crisp shadows.

**Three-point rig** — the default for a hero object:

```js
const key = new THREE.DirectionalLight(0xffffff, 3.0);
key.position.set(5, 8, 5);
key.castShadow = true;

const fill = new THREE.DirectionalLight(0xbfd4ff, 0.8);   // cool fill, no shadow
fill.position.set(-6, 3, 4);

const rim = new THREE.DirectionalLight(0xffffff, 2.5);    // separates subject from background
rim.position.set(-2, 5, -8);

scene.add(key, fill, rim);
```

**Area lights** — soft, physically plausible softboxes; the most "product photography" look:

```js
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { RectAreaLightHelper } from 'three/addons/helpers/RectAreaLightHelper.js';
RectAreaLightUniformsLib.init();                          // required once, WebGL path

const soft = new THREE.RectAreaLight(0xffffff, 6, 4, 2);  // color, intensity, width, height
soft.position.set(0, 4, 3);
soft.lookAt(0, 0.5, 0);
scene.add(soft);
```

RectAreaLight supports only `MeshStandardMaterial` and `MeshPhysicalMaterial`, and casts no
shadows.

Intensity guidance: with `useLegacyLights` gone, lights use physical units. Directional
lights land around 1–5, point/spot lights need much larger values with `decay = 2`
(hundreds, not single digits) unless `intensity` is set in candela terms.

## 5. Shadows

```js
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;         // VSMShadowMap for very soft

key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);                       // 1024 tablet, 512 or off on mobile
key.shadow.bias = -0.0005;                                // fixes shadow acne
key.shadow.normalBias = 0.02;                             // fixes peter-panning on thin geo
key.shadow.radius = 4;

// tighten the shadow camera to the subject — the biggest shadow quality win
const d = 6;
Object.assign(key.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 0.5, far: 30 });
key.shadow.camera.updateProjectionMatrix();
```

Only one light should cast shadows in most web scenes. A static scene can render shadows
once and then set `renderer.shadowMap.autoUpdate = false` with `needsUpdate = true` on
demand.

Cheaper alternatives worth preferring on mobile: a soft baked shadow plane (a radial-gradient
texture on a `MeshBasicMaterial` under the object) or `ContactShadows`-style render-to-texture.

## 6. PBR material recipes

```js
// brushed metal
new THREE.MeshStandardMaterial({ color: 0xc0c4c8, metalness: 1.0, roughness: 0.35 });

// car paint / lacquer
new THREE.MeshPhysicalMaterial({
  color: 0x1b3a8f, metalness: 0.9, roughness: 0.28,
  clearcoat: 1.0, clearcoatRoughness: 0.06,
});

// glass
new THREE.MeshPhysicalMaterial({
  transmission: 1.0, roughness: 0.05, thickness: 0.6, ior: 1.5,
  metalness: 0, transparent: true,
});

// fabric / velvet
new THREE.MeshPhysicalMaterial({
  color: 0x6b1030, roughness: 0.9, metalness: 0,
  sheen: 1.0, sheenRoughness: 0.4, sheenColor: 0xff8fae,
});

// soap bubble / oil slick
new THREE.MeshPhysicalMaterial({
  metalness: 1, roughness: 0.1,
  iridescence: 1.0, iridescenceIOR: 1.35, iridescenceThicknessRange: [100, 400],
});

// emissive neon
new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x22e0ff, emissiveIntensity: 4 });
```

`transmission` is expensive — it forces an extra render of the scene behind the object.
Limit it to one or two objects and disable it on mobile in favor of a fake glass
(`MeshPhysicalMaterial` with high `roughness: 0.1`, `opacity: 0.4`, `transparent: true`).

Emissive materials only *glow* when a bloom pass is present; the emissive value above 1 is
what bloom picks up.

## 7. Post-processing — WebGL (pmndrs `postprocessing`)

Prefer the pmndrs library over `EffectComposer` from addons: it merges compatible effects
into a single pass, which matters a lot for fill-rate on mobile.

```bash
npm install postprocessing n8ao
```

```js
import {
  EffectComposer, RenderPass, EffectPass,
  BloomEffect, DepthOfFieldEffect, ToneMappingEffect, ToneMappingMode,
  VignetteEffect, NoiseEffect, BlendFunction, SMAAEffect,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';

renderer.toneMapping = THREE.NoToneMapping;          // the pass does it now

const composer = new EffectComposer(renderer, {
  frameBufferType: THREE.HalfFloatType,              // needed for correct HDR bloom
  multisampling: 4,                                  // 0 on mobile
});
composer.addPass(new RenderPass(scene, camera));

const ao = new N8AOPostPass(scene, camera, innerWidth, innerHeight);
ao.configuration.aoRadius = 1.0;
ao.configuration.intensity = 2.0;
ao.configuration.halfRes = true;                     // big win, minimal visible cost
composer.addPass(ao);

const bloom = new BloomEffect({
  intensity: 0.7,
  luminanceThreshold: 0.85,                          // only genuinely bright pixels bloom
  luminanceSmoothing: 0.2,
  mipmapBlur: true,
});

const dof = new DepthOfFieldEffect(camera, {
  focusDistance: 0.02, focalLength: 0.05, bokehScale: 3.0, height: 480,
});

composer.addPass(new EffectPass(camera,
  ao ? bloom : bloom, dof,
  new VignetteEffect({ offset: 0.35, darkness: 0.5 }),
  new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: true }),
  new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }),
  new SMAAEffect(),
));

renderer.setAnimationLoop(() => { mixer?.update(clock.getDelta()); composer.render(); });
```

Focus the depth of field on the subject each frame for a real rack-focus effect:

```js
dof.target = subject.position;                       // or update cocMaterial.worldFocusDistance
```

Effect discipline: subtle bloom, shallow-but-not-silly DoF, half-res AO, faint grain. Heavy
post is the most common reason a beautiful desktop scene runs at 12 fps on a phone — gate
the whole composer behind the device tier.

## 8. Post-processing — WebGPU (node RenderPipeline)

`EffectComposer` passes do not work on WebGPU. Use the node stack instead.

```js
import * as THREE from 'three/webgpu';
import { pass, mrt, output, emissive } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';

const post = new THREE.PostProcessing(renderer);     // exposed as RenderPipeline in r183+
const scenePass = pass(scene, camera);
scenePass.setMRT(mrt({ output, emissive }));

const color = scenePass.getTextureNode('output');
const emis  = scenePass.getTextureNode('emissive');
const depth = scenePass.getTextureNode('depth');

const bloomed = color.add(bloom(emis, 0.8, 0.4, 0.6));
post.outputNode = dof(bloomed, depth, 3.0, 0.5, 2.0);

renderer.setAnimationLoop(async () => { await post.renderAsync(); });
```

Do not also call `renderer.render()` when a `PostProcessing` output node is active — that
renders the scene twice.

## 9. AnimationMixer, clips, crossfades

```js
const clock = new THREE.Clock();
const mixer = new THREE.AnimationMixer(gltf.scene);

const actions = {};
for (const clip of gltf.animations) {
  const action = mixer.clipAction(clip);
  actions[clip.name] = action;
}

actions.Idle?.play();

function crossfade(fromName, toName, duration = 0.35) {
  const from = actions[fromName], to = actions[toName];
  if (!to) return;
  to.reset().setEffectiveWeight(1).play();
  from?.crossFadeTo(to, duration, false);
}

// one-shot animation that holds its last frame
function playOnce(name) {
  const a = actions[name];
  a.reset();
  a.setLoop(THREE.LoopOnce, 1);
  a.clampWhenFinished = true;
  a.play();
}
mixer.addEventListener('finished', (e) => { /* return to idle */ });

renderer.setAnimationLoop(() => {
  mixer.update(clock.getDelta());
  renderer.render(scene, camera);
});
```

Scrub a clip from scroll position instead of playing it in real time:

```js
const action = mixer.clipAction(clip);
action.play();
action.paused = true;
// in a ScrollTrigger onUpdate:
action.time = clip.duration * progress;
mixer.update(0);
```

This is the technique behind most "model assembles as you scroll" pages.

## 10. Morph targets and skeletons

```js
// morph targets (blend shapes)
const idx = mesh.morphTargetDictionary['smile'];
mesh.morphTargetInfluences[idx] = 0.7;

// skeletal access
const bone = gltf.scene.getObjectByName('Head');
bone.rotation.y = lookAtAmount;      // apply AFTER mixer.update() to override the clip

// visualize while debugging
import { SkeletonHelper } from 'three';
scene.add(new SkeletonHelper(gltf.scene));
```

Bone overrides applied before `mixer.update()` are simply overwritten — order matters.

## 11. Idle and hero motion

Small continuous motion is what separates a "3D image" from a living scene.

```js
const t0 = performance.now();
function idleMotion(obj, now) {
  const t = (now - t0) * 0.001;
  obj.rotation.y = t * 0.15;                       // slow turntable
  obj.position.y = baseY + Math.sin(t * 1.2) * 0.04;   // float
  obj.rotation.z = Math.sin(t * 0.7) * 0.015;      // subtle sway
  obj.scale.setScalar(baseScale * (1 + Math.sin(t * 1.8) * 0.006));  // breathing
}
```

Also very effective: a light that drifts slowly across the subject, and a mouse-parallax
camera offset of a few centimeters.

```js
const mouse = new THREE.Vector2();
addEventListener('pointermove', (e) => {
  mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
});
// per frame:
camera.position.x += (baseX + mouse.x * 0.3 - camera.position.x) * 0.05;
camera.position.y += (baseY + mouse.y * 0.2 - camera.position.y) * 0.05;
camera.lookAt(target);
```

## 12. Scroll-driven camera with GSAP ScrollTrigger

Animate a plain proxy object, not the camera's properties directly — it keeps the camera
update in one place and plays nicely with damping and mouse parallax.

```js
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
gsap.registerPlugin(ScrollTrigger);

const cam = { x: 0, y: 1.2, z: 6 };
const look = { x: 0, y: 0.8, z: 0 };
let needsRender = true;

function applyCamera() {
  camera.position.set(cam.x, cam.y, cam.z);
  camera.lookAt(look.x, look.y, look.z);
  needsRender = true;
}

const tl = gsap.timeline({
  scrollTrigger: {
    trigger: '#scroll-container',
    start: 'top top',
    end: 'bottom bottom',
    scrub: 1,                 // number = smoothing seconds; true = instant
    invalidateOnRefresh: true,
  },
  onUpdate: applyCamera,
});

tl.to(cam,  { z: 3.2, y: 1.6, ease: 'none' })
  .to(look, { y: 1.1, ease: 'none' }, '<')
  .to(cam,  { x: -2.4, z: 4.0, ease: 'power2.inOut' })
  .to(look, { x: 0.6, ease: 'power2.inOut' }, '<');

// section-triggered discrete moves
ScrollTrigger.create({
  trigger: '#section-2',
  start: 'top center',
  onEnter: () => gsap.to(cam, { x: 2, z: 3, duration: 1.2, ease: 'power3.inOut', onUpdate: applyCamera }),
});
```

Pair this with on-demand rendering (see `references/performance.md`) so a static scroll page
does not burn battery rendering identical frames.

`ScrollTrigger.refresh()` after fonts, images, or the model finish loading — otherwise the
scroll distances are computed against the wrong page height.

## 13. Camera paths, damping, and framing

```js
// smooth path through authored waypoints
const path = new THREE.CatmullRomCurve3([
  new THREE.Vector3(0, 1.2, 6),
  new THREE.Vector3(4, 2.0, 2),
  new THREE.Vector3(2, 1.0, -4),
  new THREE.Vector3(-3, 2.4, -1),
], false, 'catmullrom', 0.4);

function cameraAlongPath(t) {           // t in 0..1
  camera.position.copy(path.getPointAt(t));
  camera.lookAt(subject.position);
}

// visualize while authoring
scene.add(new THREE.Line(
  new THREE.BufferGeometry().setFromPoints(path.getPoints(100)),
  new THREE.LineBasicMaterial({ color: 0xff0066 })
));
```

Frame-rate-independent damping — use this instead of a raw `lerp(x, 0.1)`, which moves
faster on high-refresh displays:

```js
function damp(current, target, lambda, dt) {
  return THREE.MathUtils.damp(current, target, lambda, dt);
}
camera.position.x = damp(camera.position.x, targetX, 4, dt);
// vectors:
camera.position.lerp(targetVec, 1 - Math.exp(-4 * dt));
```

Cinematic camera habits worth applying by default:
- narrow FOV (30–40°)
- move the camera *and* the look-at target, never just one
- ease in and out; linear camera motion reads as machinery
- hold still for a beat at the end of a move before the next one starts
- keep the subject slightly off-center

## 14. What actually makes it look cinematic

In rough order of payoff per unit of effort:

1. Correct color space and a filmic tone map
2. HDRI environment lighting with a visible key light
3. A rim/back light separating subject from background
4. Soft contact shadow grounding the object
5. Narrow FOV with an eased, damped camera move
6. Restrained bloom on genuinely emissive surfaces
7. Shallow depth of field focused on the subject
8. Slow continuous idle motion (float, drift, breathing)
9. A vignette and a whisper of film grain
10. Material variation — nothing in reality has uniform roughness; add a roughness map or
    subtle noise even to simple materials
