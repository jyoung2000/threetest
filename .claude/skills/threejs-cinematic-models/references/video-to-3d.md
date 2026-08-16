# Video → 3D: Splats, Meshes, Motion Reference, and Video in the Scene

A video reference means one of four different jobs, and they share almost no pipeline.
Identify which one the user actually wants before doing anything:

| The user's video is... | They want... | Path |
|---|---|---|
| an orbit/walkaround they filmed of a real object or place | a photoreal web 3D version of it | §2 video → Gaussian splat |
| the same kind of capture | a usable mesh (interaction, physics, AR, lighting) | §3 frames → photogrammetry / multi-view AI |
| a clip whose *movement* they like ("make it move like this") | that motion recreated on a model | §4 motion reference |
| content that should play *inside* the scene | video on geometry | §5 VideoTexture |

Three.js cannot ingest a video and produce geometry by itself — §2 and §3 always involve an
external reconstruction step, with Three.js as the delivery end.

## Contents
1. Capture guidance (read before the user films anything)
2. Video → Gaussian splat (photoreal)
3. Video → frames → mesh (usable geometry)
4. Video as motion reference
5. Video inside the scene (VideoTexture)
6. Choosing between §2 and §3, restated

---

## 1. Capture guidance

Reconstruction quality is decided at capture time. If the user hasn't filmed yet, give them
this before they spend an afternoon on unusable footage:

- **Orbit slowly and completely.** One continuous slow lap around the subject, then a
  second lap at a higher or lower angle. Aim for heavy overlap between viewpoints — slow
  panning beats walking speed.
- **Landscape, highest resolution, normal lens.** 4K if available. Avoid ultrawide (distortion)
  and avoid digital zoom.
- **Lock exposure and focus** if the phone allows it — auto-exposure shifts between frames
  confuse reconstruction.
- **Diffuse, even light.** Overcast outdoors or well-lit indoors. Hard shadows bake into the
  result and fight the Three.js scene's own lighting.
- **Keep the world still.** People walking through, foliage in wind, and the subject itself
  moving all produce floaters and ghosting. Reflective, transparent, and thin structures
  (glass, mirrors, fences, wires) remain the known failure cases — warn about them up front.
- **Fill the frame** with the subject; get closer rather than zooming.
- 30–90 seconds of good footage is plenty. More footage of the same angles adds processing
  time, not quality.

Screen-recorded or found footage (a product spin from a website, a clip from a film) can
work for §3 if it genuinely orbits the subject, but licensing is the user's problem to
check, and single-angle footage reconstructs poorly no matter the tool.

## 2. Video → Gaussian splat (photoreal)

The default for "I filmed this place/object, put it on the web looking real." Splat tools
take video directly — they extract frames, solve camera poses, and train the splat, so no
manual frame work is needed.

**Tools (2026):** Polycam, Luma AI, Postshot (desktop, own GPU), KIRI Engine, Scaniverse,
and Nerfstudio (open source, needs a capable NVIDIA GPU — the classic pipeline wants lots
of VRAM; 12 GB cards work for most scenes). Phone apps are the lowest-friction route;
Postshot/Nerfstudio give the most control.

**Pipeline:**

1. Upload the video to the tool → download `.ply` (or `.splat`/`.ksplat`/`.spz`).
2. Clean up in **SuperSplat** (free, browser): delete floaters, crop to the subject,
   recenter. Nearly every raw splat needs this pass.
3. Convert to `.ksplat` for fast web loading (the `@mkkellogg` library ships a converter),
   or keep `.spz` where supported — it's the emerging compressed interchange format.
4. Load it in Three.js exactly as in `references/image-to-3d.md` §B:

```js
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';
const viewer = new GaussianSplats3D.DropInViewer({ gpuAcceleratedSort: true });
await viewer.addSplatScene('/splats/scan.ksplat', { splatAlphaRemovalThreshold: 5 });
scene.add(viewer);
```

**Budgets:** splat count is the dial — roughly 1–2M splats desktop, 300–500k mobile. Crop
hard in SuperSplat; the background sky and floor usually hold most of the splats and none
of the value. Splats don't receive scene lighting or cast shadows, so cinematic treatment
comes from camera work, post-processing, and composition rather than lights.

## 3. Video → frames → mesh (usable geometry)

When the user needs real geometry — collision, AR placement, PBR relighting, animation —
extract frames and feed them to a reconstruction pipeline.

### 3a. Extract sharp, well-spaced frames

`scripts/extract-frames.sh` / `.ps1` wrap this. The core ffmpeg commands:

```bash
# ~2 frames per second, full quality — good default for a 30–60s orbit
ffmpeg -i capture.mp4 -vf "fps=2" -qscale:v 2 frames/frame_%04d.jpg

# steadier spacing for fast footage: one frame per N frames of video
ffmpeg -i capture.mp4 -vf "select='not(mod(n,15))'" -vsync vfr -qscale:v 2 frames/frame_%04d.jpg

# drop blurry frames: keep frames that differ enough from the previous (motion gate)
ffmpeg -i capture.mp4 -vf "select='gt(scene,0.003)',fps=2" -vsync vfr -qscale:v 2 frames/frame_%04d.jpg
```

Target **40–150 frames** for photogrammetry of a single object; more frames slow the solve
without improving it. Delete visibly blurred or duplicate frames — one bad frame can damage
the pose solve more than a missing angle.

### 3b. Reconstruct

Two routes, by fidelity vs effort:

- **Photogrammetry (highest fidelity to the real object):** RealityScan (free tier),
  Meshroom (open source), Polycam/KIRI photo mode, or Agisoft Metashape. Feed the frame
  set, get a textured mesh (usually OBJ/FBX/GLB), expect very high polycounts and a large
  diffuse texture with baked lighting.
- **Multi-view AI image-to-3D (faster, cleaner topology, less faithful):** pick 3–6 frames
  covering front/sides/back and feed them to a multi-view-capable service from
  `references/image-to-3d.md` §A (Tripo, Meshy, Rodin all accept multi-image input;
  TRELLIS 2 / Hunyuan3D self-hosted). This is the right route when the object matters more
  than millimeter accuracy — a product, a prop, a character.

### 3c. Clean up — mandatory either way

Photogrammetry output is routinely 500k–5M triangles with a 8k baked texture. Run the full
cleanup pipeline from `references/image-to-3d.md` §E (weld → simplify → resize → optimize),
and expect a more aggressive `--ratio` (0.1–0.3) than for AI meshes. De-light the albedo if
the capture had directional shadows, or the mesh will carry two suns once lit in-scene.

## 4. Video as motion reference

"Make the model move like this clip" — no reconstruction involved; the video informs
animation.

- **Rigid/camera motion** (a product spin, a drone arc, a bounce): watch the clip, note the
  timing and easing, and recreate it as keyframes or GSAP timelines
  (`references/cinematic.md` §12–13). Describe what you extracted ("2.4s per rotation,
  ease-in-out, slight vertical bob at the turn") so the user can correct the read.
- **Human/creature motion**: video-to-mocap tools (Rokoko Video, Plask, Move One, DeepMotion)
  turn footage into skeletal animation (FBX/BVH). Retarget onto a rigged model in Blender,
  export GLB, play through `AnimationMixer` (`references/cinematic.md` §9). Single-camera
  mocap is approximate — feet slide and hands are rough; budget cleanup time or choose
  stylized motion where it won't show.
- **Physics-like motion** (cloth, bounce, float): usually cheaper to simulate or fake in
  code than to extract — match the *feel* (frequency, damping) by eye against the clip.

## 5. Video inside the scene (VideoTexture)

When the video itself is the content — a screen in a 3D device mockup, a projected clip, a
video-textured hero plane:

```js
const video = document.createElement('video');
video.src = '/media/clip.mp4';
video.loop = true;
video.muted = true;                 // required for autoplay everywhere
video.playsInline = true;           // required on iOS
video.play();                       // must follow a user gesture on iOS if unmuted

const tex = new THREE.VideoTexture(video);
tex.colorSpace = THREE.SRGBColorSpace;

const screen = new THREE.Mesh(
  new THREE.PlaneGeometry(1.6, 0.9),
  new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })
);
scene.add(screen);
```

Notes: `MeshBasicMaterial` with `toneMapped: false` keeps the footage looking like footage
instead of being re-graded by the scene's tone mapping; use `MeshStandardMaterial` only if
the video surface should receive scene lighting. A playing video forces continuous
rendering — exempt it from on-demand rendering, and pause the video (and the loop) when
off-screen via `IntersectionObserver`. Keep web video at 1080p or below; a 4K video texture
is a fill-rate and decode tax on mobile. Compress with H.264/H.265 MP4 for compatibility.

Depth-style pseudo-3D from a single video frame also works: grab a still
(`ffmpeg -i clip.mp4 -vf "select=eq(n\,120)" -frames:v 1 still.jpg`) and run the depth
displacement technique from `references/image-to-3d.md` §C1.

## 6. Choosing between §2 and §3, restated

| Need | Pick |
|---|---|
| Photoreal walkthrough / scan of a place | §2 splat |
| Product viewer with orbit controls, real look | §2 splat (or §3 if configurator features needed) |
| AR placement, physics, collisions | §3 mesh |
| Relight the object in a designed scene | §3 mesh (splats ignore scene lights) |
| Animate/deform the captured object | §3 mesh, expect retopology |
| Fastest path from phone footage to web | §2 via Polycam/Luma |
| Full local control, no cloud service | §2 via Postshot/Nerfstudio or §3 via Meshroom |

When the user is unsure, ask one question: **"Do you need to touch it or just look at
it?"** Look → splat. Touch → mesh.
