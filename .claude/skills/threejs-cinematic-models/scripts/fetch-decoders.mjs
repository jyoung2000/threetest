#!/usr/bin/env node
/**
 * fetch-decoders.mjs
 *
 * Copies the Draco decoder and KTX2/Basis transcoder out of node_modules into the site's
 * public directory. Without these files, GLTFLoader configured for Draco or KTX2 fails
 * silently and the scene renders blank.
 *
 * Usage:
 *   node scripts/fetch-decoders.mjs                # copies into ./public
 *   node scripts/fetch-decoders.mjs ./static       # custom destination
 *
 * Run this after `npm install three` and again after upgrading three — the decoders are
 * version-matched to the library.
 */

import { cp, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';

const dest = resolve(process.argv[2] ?? 'public');
const libs = resolve('node_modules/three/examples/jsm/libs');

const jobs = [
  { from: join(libs, 'draco'), to: join(dest, 'draco'), label: 'Draco decoder' },
  { from: join(libs, 'basis'), to: join(dest, 'basis'), label: 'KTX2/Basis transcoder' },
];

async function exists(path) {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

if (!(await exists(libs))) {
  console.error('Could not find node_modules/three/examples/jsm/libs.');
  console.error('Run `npm install three` from the project root first.');
  process.exit(1);
}

await mkdir(dest, { recursive: true });

for (const job of jobs) {
  if (!(await exists(job.from))) {
    console.warn(`skip  ${job.label} — not found at ${job.from}`);
    continue;
  }
  await cp(job.from, job.to, { recursive: true });
  console.log(`copy  ${job.label} -> ${job.to}`);
}

console.log(`
Wire them up in your loader setup:

  const draco = new DRACOLoader().setDecoderPath('/draco/');
  const ktx2  = new KTX2Loader().setTranscoderPath('/basis/').detectSupport(renderer);

Call detectSupport after the renderer exists (and after renderer.init() on WebGPU).
`);
