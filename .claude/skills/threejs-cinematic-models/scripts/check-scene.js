/**
 * check-scene.js — live audit of a Three.js scene against device-tier budgets.
 *
 * Import it, or paste the auditScene function into the browser console with `scene`
 * and `renderer` in scope.
 *
 *   import { auditScene, startAuditOverlay } from './check-scene.js';
 *   auditScene(renderer, scene, 'mobile');        // one-shot report
 *   startAuditOverlay(renderer, scene, 'mobile'); // live on-screen panel
 *
 * Call auditScene immediately AFTER a render — renderer.info resets each frame.
 */

export const BUDGETS = {
  desktop: { drawCalls: 150, triangles: 1_500_000, textures: 40, materials: 30, vramMB: 500 },
  tablet:  { drawCalls: 75,  triangles: 750_000,   textures: 25, materials: 20, vramMB: 250 },
  mobile:  { drawCalls: 50,  triangles: 500_000,   textures: 15, materials: 12, vramMB: 150 },
};

function estimateTextureMB(texture) {
  const img = texture.image;
  const w = img?.width ?? img?.[0]?.width ?? 0;
  const h = img?.height ?? img?.[0]?.height ?? 0;
  if (!w || !h) return 0;
  const bytesPerPixel = texture.isCompressedTexture ? 0.5 : 4;   // rough: ETC1S/BC ~0.5, RGBA 4
  const mipFactor = texture.generateMipmaps === false ? 1 : 1.33;
  const faces = texture.isCubeTexture ? 6 : 1;
  return (w * h * bytesPerPixel * mipFactor * faces) / (1024 * 1024);
}

export function collectSceneStats(renderer, scene) {
  const materials = new Set();
  const textures = new Set();
  const geometries = new Set();
  let meshes = 0;
  let instancedMeshes = 0;
  let sceneTriangles = 0;
  let shadowCasters = 0;
  let shadowCastingLights = 0;
  let transparentMeshes = 0;
  let transmissiveMeshes = 0;
  const oversizedTextures = [];

  scene.traverse((o) => {
    if (o.isLight && o.castShadow) shadowCastingLights++;
    if (!o.isMesh && !o.isPoints && !o.isLine) return;

    if (o.isInstancedMesh) instancedMeshes++; else meshes++;
    if (o.castShadow) shadowCasters++;

    if (o.geometry) {
      geometries.add(o.geometry);
      const attr = o.geometry.attributes?.position;
      if (attr) {
        const verts = o.geometry.index ? o.geometry.index.count : attr.count;
        const instances = o.isInstancedMesh ? o.count : 1;
        if (o.isMesh) sceneTriangles += (verts / 3) * instances;
      }
    }

    for (const m of (Array.isArray(o.material) ? o.material : [o.material]).filter(Boolean)) {
      materials.add(m);
      if (m.transparent) transparentMeshes++;
      if (m.transmission > 0) transmissiveMeshes++;
      for (const key of Object.keys(m)) {
        const v = m[key];
        if (v && v.isTexture) {
          textures.add(v);
          const w = v.image?.width ?? 0;
          if (w >= 4096) oversizedTextures.push(`${m.name || m.type}.${key} (${w}px)`);
        }
      }
    }
  });

  if (scene.environment?.isTexture) textures.add(scene.environment);
  if (scene.background?.isTexture) textures.add(scene.background);

  let vramMB = 0;
  for (const t of textures) vramMB += estimateTextureMB(t);

  return {
    drawCalls: renderer.info.render.calls,
    trianglesRendered: renderer.info.render.triangles,
    sceneTriangles: Math.round(sceneTriangles),
    meshes,
    instancedMeshes,
    geometries: geometries.size,
    materials: materials.size,
    textures: textures.size,
    estimatedTextureVramMB: Math.round(vramMB * 10) / 10,
    shadowCasters,
    shadowCastingLights,
    transparentMeshes,
    transmissiveMeshes,
    oversizedTextures,
    programs: renderer.info.programs?.length ?? null,
    gpuGeometries: renderer.info.memory.geometries,
    gpuTextures: renderer.info.memory.textures,
  };
}

export function auditScene(renderer, scene, tier = 'desktop') {
  const stats = collectSceneStats(renderer, scene);
  const budget = BUDGETS[tier] ?? BUDGETS.desktop;

  const rows = [
    ['draw calls',            stats.drawCalls,                budget.drawCalls],
    ['triangles (rendered)',  stats.trianglesRendered,        budget.triangles],
    ['triangles (scene)',     stats.sceneTriangles,           budget.triangles],
    ['unique materials',      stats.materials,                budget.materials],
    ['unique textures',       stats.textures,                 budget.textures],
    ['est. texture VRAM MB',  stats.estimatedTextureVramMB,   budget.vramMB],
  ];

  const table = {};
  const warnings = [];
  for (const [label, value, limit] of rows) {
    const ok = value <= limit;
    table[label] = { value, budget: limit, status: ok ? 'ok' : 'OVER' };
    if (!ok) warnings.push(`${label}: ${value} exceeds the ${tier} budget of ${limit}`);
  }

  console.group(`%cscene audit — ${tier} tier`, 'font-weight:bold');
  console.table(table);
  console.log('meshes', stats.meshes, '| instanced', stats.instancedMeshes,
              '| geometries', stats.geometries, '| programs', stats.programs);
  console.log('shadow casters', stats.shadowCasters, '| shadow lights', stats.shadowCastingLights,
              '| transparent', stats.transparentMeshes, '| transmissive', stats.transmissiveMeshes);

  if (stats.oversizedTextures.length) {
    warnings.push(`textures at 4096px or larger: ${stats.oversizedTextures.join(', ')}`);
  }
  if (stats.shadowCastingLights > 1) {
    warnings.push(`${stats.shadowCastingLights} shadow-casting lights — each re-renders the scene`);
  }
  if (tier === 'mobile' && stats.transmissiveMeshes > 0) {
    warnings.push('transmission materials on the mobile tier — each forces an extra scene render');
  }
  if (stats.drawCalls > budget.drawCalls && stats.instancedMeshes === 0 && stats.meshes > 40) {
    warnings.push('many separate meshes and no instancing — instance or merge repeated geometry');
  }

  if (warnings.length) {
    console.groupCollapsed(`%c${warnings.length} issue(s)`, 'color:#e0a000;font-weight:bold');
    warnings.forEach((w) => console.warn(w));
    console.groupEnd();
  } else {
    console.log('%cwithin budget', 'color:#3aa03a;font-weight:bold');
  }
  console.groupEnd();

  return { stats, budget, warnings };
}

/** Live on-screen panel. Returns a stop() function. */
export function startAuditOverlay(renderer, scene, tier = 'desktop', intervalMs = 1000) {
  const el = document.createElement('div');
  Object.assign(el.style, {
    position: 'fixed', bottom: '8px', left: '8px', zIndex: 99999,
    font: '11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
    background: 'rgba(0,0,0,.78)', color: '#e8e8e8', padding: '8px 10px',
    borderRadius: '6px', pointerEvents: 'none', whiteSpace: 'pre',
  });
  document.body.appendChild(el);

  const budget = BUDGETS[tier] ?? BUDGETS.desktop;
  let frames = 0, last = performance.now(), fps = 0;

  const onFrame = () => { frames++; };
  const raf = () => { onFrame(); id = requestAnimationFrame(raf); };
  let id = requestAnimationFrame(raf);

  const timer = setInterval(() => {
    const now = performance.now();
    fps = Math.round((frames * 1000) / (now - last));
    frames = 0; last = now;

    const s = collectSceneStats(renderer, scene);
    const mark = (v, b) => (v <= b ? ' ' : '!');
    el.textContent =
      `${tier}  ${fps} fps\n` +
      `${mark(s.drawCalls, budget.drawCalls)}calls   ${s.drawCalls}/${budget.drawCalls}\n` +
      `${mark(s.trianglesRendered, budget.triangles)}tris    ${s.trianglesRendered.toLocaleString()}\n` +
      `${mark(s.textures, budget.textures)}tex     ${s.textures}  ~${s.estimatedTextureVramMB} MB\n` +
      ` mats    ${s.materials}   geo ${s.gpuGeometries}`;
  }, intervalMs);

  return function stop() {
    cancelAnimationFrame(id);
    clearInterval(timer);
    el.remove();
  };
}
