# Procedural Scenes from a Text Description

When the user describes something rather than supplying an asset, building it from
primitives is usually the best answer: it loads in kilobytes, runs at 60 fps anywhere, is
fully art-directable in code, and never needs a cleanup pass.

## Contents
1. When procedural wins
2. Primitive vocabulary
3. Composing an object from primitives
4. Custom geometry from math
5. Globes and world maps
6. Terrain and landscapes
7. Particles and fields
8. Text and typography in 3D
9. Making procedural look designed, not default

---

## 1. When procedural wins

Reach for it when the description is:
- geometric or architectural — buildings, packaging, devices, abstract forms
- stylized — low-poly, wireframe, isometric, flat-shaded
- data-driven — charts, graphs, network diagrams, timelines
- environmental — terrain, clouds, water, starfields, particle fields
- an interactive element — globes, carousels, sliders, product cards
- anything that needs to change at runtime based on data or user input

Reach for a generated or sourced model when the description is a specific organic object
whose realism is the point ("a weathered oak barrel", "a golden retriever").

## 2. Primitive vocabulary

```js
new THREE.BoxGeometry(w, h, d, wSeg, hSeg, dSeg);
new THREE.SphereGeometry(r, widthSeg, heightSeg, phiStart, phiLength, thetaStart, thetaLength);
new THREE.CylinderGeometry(rTop, rBottom, h, radialSeg, heightSeg, openEnded);
new THREE.ConeGeometry(r, h, radialSeg);
new THREE.TorusGeometry(r, tube, radialSeg, tubularSeg, arc);
new THREE.TorusKnotGeometry(r, tube, tubularSeg, radialSeg, p, q);
new THREE.PlaneGeometry(w, h, wSeg, hSeg);
new THREE.CircleGeometry(r, segments);
new THREE.RingGeometry(inner, outer, thetaSeg);
new THREE.CapsuleGeometry(r, length, capSeg, radialSeg);
new THREE.IcosahedronGeometry(r, detail);      // detail 0–2 for low-poly, 4+ for a smooth ball
new THREE.LatheGeometry(points, segments);      // revolve a profile: vases, bottles, lamps
new THREE.ExtrudeGeometry(shape, options);      // extrude a 2D Shape: logos, letters, panels
new THREE.TubeGeometry(curve, tubularSeg, r, radialSeg, closed);   // pipes, cables, paths
new THREE.ShapeGeometry(shape);                 // flat filled 2D shape
```

Segment counts are a direct performance dial. A sphere at 64×32 is 4,096 triangles; at
32×16 it is 1,024 and nearly indistinguishable at typical viewing distance.

Rounded boxes read as far more designed than sharp `BoxGeometry` and are worth the extra
step — either bevel an extruded rounded `Shape`, or use `RoundedBoxGeometry`:

```js
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
const geo = new RoundedBoxGeometry(1, 1, 1, 4, 0.08);
```

## 3. Composing an object from primitives

Build a parts list from the description, then assemble with groups so the whole thing can be
transformed and animated as a unit.

```js
function createDesk() {
  const group = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.7 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x2a2d33, metalness: 1, roughness: 0.4 });

  const top = new THREE.Mesh(new RoundedBoxGeometry(2.4, 0.06, 1.1, 3, 0.02), wood);
  top.position.y = 0.75;
  group.add(top);

  const legGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.75, 12);
  for (const [x, z] of [[-1.1, -0.48], [1.1, -0.48], [-1.1, 0.48], [1.1, 0.48]]) {
    const leg = new THREE.Mesh(legGeo, metal);      // shared geometry AND material
    leg.position.set(x, 0.375, z);
    group.add(leg);
  }
  return group;
}
```

Two habits keep procedural scenes fast:
- **Share geometry and material instances** across repeated parts, as above. Four legs from
  one `legGeo` and one `metal` is far cheaper than four of each.
- **Instance when the count grows.** Past a few dozen repeats, switch to `InstancedMesh`.

```js
const trees = new THREE.InstancedMesh(treeGeo, treeMat, 500);
const m = new THREE.Matrix4();
for (let i = 0; i < 500; i++) {
  m.makeRotationY(Math.random() * Math.PI * 2);
  m.setPosition((Math.random() - 0.5) * 80, 0, (Math.random() - 0.5) * 80);
  trees.setMatrixAt(i, m);
}
trees.instanceMatrix.needsUpdate = true;
```

Use a seeded random function rather than `Math.random()` so a layout the user likes can be
reproduced:

```js
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(1337);
```

## 4. Custom geometry from math

```js
// parametric surface
import { ParametricGeometry } from 'three/addons/geometries/ParametricGeometry.js';
const geo = new ParametricGeometry((u, v, target) => {
  const x = (u - 0.5) * 10;
  const z = (v - 0.5) * 10;
  target.set(x, Math.sin(x * 0.8) * Math.cos(z * 0.8) * 0.8, z);
}, 80, 80);

// raw buffer geometry
const positions = new Float32Array(count * 3);
const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
geometry.computeVertexNormals();

// deform an existing geometry
const pos = geo.attributes.position;
for (let i = 0; i < pos.count; i++) {
  const v = new THREE.Vector3().fromBufferAttribute(pos, i);
  v.multiplyScalar(1 + noise3D(v.x, v.y, v.z) * 0.1);
  pos.setXYZ(i, v.x, v.y, v.z);
}
pos.needsUpdate = true;
geo.computeVertexNormals();
```

## 5. Globes and world maps

A very common request. The recipe:

```js
// 1. the sphere
const globe = new THREE.Mesh(
  new THREE.SphereGeometry(1, 96, 64),
  new THREE.MeshStandardMaterial({
    map: earthColor,              // 2k equirectangular, sRGB
    roughnessMap: earthRough,     // oceans glossy, land matte
    metalness: 0,
    roughness: 1,
  })
);

// 2. atmosphere — a slightly larger sphere with backside fresnel
const atmosphere = new THREE.Mesh(
  new THREE.SphereGeometry(1.03, 64, 48),
  new THREE.MeshBasicMaterial({ color: 0x3a7bd5, transparent: true, opacity: 0.12,
    side: THREE.BackSide, blending: THREE.AdditiveBlending })
);

// 3. lat/lon → position on the sphere
function latLonToVector3(lat, lon, radius = 1) {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
     radius * Math.cos(phi),
     radius * Math.sin(phi) * Math.sin(theta)
  );
}

// 4. markers as one instanced mesh, not one mesh per city
const markers = new THREE.InstancedMesh(
  new THREE.SphereGeometry(0.006, 8, 6),
  new THREE.MeshBasicMaterial({ color: 0xffcc44 }),
  cities.length
);
const m = new THREE.Matrix4();
cities.forEach((c, i) => { m.setPosition(latLonToVector3(c.lat, c.lon, 1.005)); markers.setMatrixAt(i, m); });
markers.instanceMatrix.needsUpdate = true;
globe.add(markers);
```

**Zooming to a location** — rotate the globe so the target faces the camera, and dolly in.
Rotating the globe is more robust than orbiting the camera because it keeps the lighting rig
and background fixed:

```js
function focusLatLon(lat, lon, { duration = 2 } = {}) {
  // rotation that brings this lat/lon to face +Z
  const targetY = -(lon + 180) * (Math.PI / 180) - Math.PI / 2;
  const targetX = lat * (Math.PI / 180);
  gsap.to(globe.rotation, { x: targetX, y: targetY, duration, ease: 'power3.inOut' });
  gsap.to(camera.position, { z: 1.6, duration, ease: 'power3.inOut' });
}
```

Take the shortest rotation path so the globe does not spin the long way around:

```js
const current = globe.rotation.y;
let delta = (targetY - current) % (Math.PI * 2);
if (delta > Math.PI) delta -= Math.PI * 2;
if (delta < -Math.PI) delta += Math.PI * 2;
gsap.to(globe.rotation, { y: current + delta, duration, ease: 'power3.inOut' });
```

**Nearest city to the visitor**, without asking for geolocation permission: use a coarse
IP-based lookup or a timezone heuristic, then find the minimum great-circle distance:

```js
function haversine(a, b) {
  const R = 6371, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const nearest = cities.reduce((best, c) =>
  haversine(user, c) < haversine(user, best) ? c : best);
```

For scroll-driven zoom, drive `globe.rotation` and `camera.position.z` from a ScrollTrigger
timeline (see `references/cinematic.md` §12). The seam between "spinning globe" and "zoomed
into a city" is best hidden by fading in a higher-resolution local texture or a labeled
overlay as the camera closes in, rather than by trying to hold detail all the way down.

Texture sizing for globes: a 2048×1024 equirectangular color map is the sweet spot; 4096
wide is only worth it if the user zooms to street level, in which case tiles are a better
answer than one giant texture.

## 6. Terrain and landscapes

```js
// heightmap from noise
import { createNoise2D } from 'simplex-noise';
const noise2D = createNoise2D();

const geo = new THREE.PlaneGeometry(60, 60, 200, 200);
geo.rotateX(-Math.PI / 2);
const pos = geo.attributes.position;
for (let i = 0; i < pos.count; i++) {
  const x = pos.getX(i), z = pos.getZ(i);
  const h = noise2D(x * 0.03, z * 0.03) * 3
          + noise2D(x * 0.09, z * 0.09) * 0.9
          + noise2D(x * 0.25, z * 0.25) * 0.25;      // octaves
  pos.setY(i, h);
}
geo.computeVertexNormals();
```

Color by height for instant readability:

```js
const colors = [];
for (let i = 0; i < pos.count; i++) {
  const h = pos.getY(i);
  const c = h < 0.1 ? new THREE.Color(0x3b6ea5)      // water
          : h < 1.2 ? new THREE.Color(0x4e7c3f)      // grass
          : h < 2.4 ? new THREE.Color(0x8a7a5c)      // rock
                    : new THREE.Color(0xf2f4f7);     // snow
  colors.push(c.r, c.g, c.b);
}
geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true });
```

`flatShading: true` gives the low-poly look with no extra cost and hides low segment counts.

## 7. Particles and fields

```js
const count = PRESETS[tier].particleCount;
const positions = new Float32Array(count * 3);
for (let i = 0; i < count; i++) {
  const r = 8 * Math.cbrt(Math.random());          // cbrt = uniform volume distribution
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  positions.set([
    r * Math.sin(phi) * Math.cos(theta),
    r * Math.sin(phi) * Math.sin(theta),
    r * Math.cos(phi),
  ], i * 3);
}
const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

const mat = new THREE.PointsMaterial({
  size: 0.03, sizeAttenuation: true, transparent: true, opacity: 0.8,
  depthWrite: false, blending: THREE.AdditiveBlending,
  map: circleTexture, alphaTest: 0.01,
});
scene.add(new THREE.Points(geo, mat));
```

`depthWrite: false` with additive blending is what makes particle fields glow rather than
punch holes in each other. On WebGPU, move the per-particle motion into TSL or a compute
shader so the CPU is not updating a large buffer every frame.

## 8. Text and typography in 3D

```js
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';

const font = await new FontLoader().loadAsync('/fonts/inter_bold.typeface.json');
const geo = new TextGeometry('Hello', {
  font, size: 1, depth: 0.2, curveSegments: 8,
  bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.015, bevelSegments: 3,
});
geo.center();
```

`TextGeometry` is expensive per character — cache the geometry rather than rebuilding per
frame, and keep `curveSegments` low. For crisp UI-style labels, an HTML overlay positioned
by projecting a 3D point to screen space is cheaper and more legible than 3D text:

```js
const v = worldPos.clone().project(camera);
label.style.transform =
  `translate(-50%,-50%) translate(${(v.x * 0.5 + 0.5) * innerWidth}px, ${(-v.y * 0.5 + 0.5) * innerHeight}px)`;
label.style.opacity = v.z < 1 ? 1 : 0;
```

## 9. Making procedural look designed, not default

Procedural scenes fail aesthetically in predictable ways. Counter each one:

- **Default colors.** Pick a palette of three to five hues with intent; never leave
  `0x00ff00` or unmodified primaries in a deliverable.
- **Uniform materials.** Vary roughness across parts. Real objects have fingerprints, wear,
  and different finishes. Even a subtle noise-based roughness map transforms a scene.
- **No environment.** A `RoomEnvironment` or HDRI gives primitives reflections and instantly
  removes the "untextured render" look.
- **Perfect regularity.** Add small random rotation and position offsets to repeated
  elements — 1–3° is enough to break the CG grid feel.
- **Sharp edges everywhere.** Bevel or round anything meant to look manufactured; real edges
  catch light.
- **Flat composition.** Vary object scale deliberately, leave negative space, and place the
  focal object slightly off-center.
- **Static.** Add slow idle motion and a drifting light (see `references/cinematic.md` §11).
- **No ground.** A subtle shadow or reflective floor plane grounds objects and does more for
  believability than another 10k triangles.
