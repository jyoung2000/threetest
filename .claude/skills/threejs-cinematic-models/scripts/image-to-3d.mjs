#!/usr/bin/env node
/**
 * image-to-3d.mjs
 *
 * Submit an image to an image-to-3D service, poll until the job finishes, and download
 * the resulting GLB. Written against the submit → poll → download shape that Tripo, Meshy,
 * Rodin and similar services all use; adjust ENDPOINTS for the provider in use.
 *
 * Keep API keys server-side. Never ship this pattern to the browser with a real key.
 *
 * Usage:
 *   TRIPO_API_KEY=... node scripts/image-to-3d.mjs --image ./chair.jpg --out ./raw/chair.glb
 *   MESHY_API_KEY=... node scripts/image-to-3d.mjs --provider meshy --image ./chair.jpg
 *   TRIPO_API_KEY=... node scripts/image-to-3d.mjs --prompt "a worn leather armchair"
 *
 * After downloading, run the cleanup pipeline before putting the model on a page:
 *   gltf-transform weld raw.glb w.glb
 *   gltf-transform simplify w.glb s.glb --ratio 0.4 --error 0.001
 *   gltf-transform optimize s.glb web.glb --compress draco --texture-compress ktx2
 * (scripts/optimize-glb.ps1 -Tiers does steps 2-3 and emits per-tier variants.)
 *
 * VERIFY the provider's current API shape and licensing terms before relying on this —
 * these services change their endpoints, model identifiers, and free-tier terms often.
 */

import { writeFile, readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

const PROVIDERS = {
  tripo: {
    base: 'https://api.tripo3d.ai/v2/openapi',
    keyEnv: 'TRIPO_API_KEY',
    submitPath: '/task',
    taskPath: (id) => `/task/${id}`,
    buildImageBody: (imageToken, ext) => ({
      type: 'image_to_model',
      file: { type: ext.replace('.', ''), file_token: imageToken },
      texture: true,
      pbr: true,
    }),
    buildTextBody: (prompt) => ({ type: 'text_to_model', prompt }),
    uploadPath: '/upload',
    readTaskId: (json) => json?.data?.task_id,
    readStatus: (json) => json?.data?.status,
    readModelUrl: (json) =>
      json?.data?.output?.pbr_model ?? json?.data?.output?.model ?? json?.data?.output?.model_url,
    successStatuses: ['success'],
    failureStatuses: ['failed', 'banned', 'expired', 'cancelled'],
  },
  meshy: {
    base: 'https://api.meshy.ai/openapi/v1',
    keyEnv: 'MESHY_API_KEY',
    submitPath: '/image-to-3d',
    taskPath: (id) => `/image-to-3d/${id}`,
    buildImageBody: (dataUri) => ({ image_url: dataUri, enable_pbr: true }),
    buildTextBody: (prompt) => ({ prompt, mode: 'preview' }),
    readTaskId: (json) => json?.result ?? json?.id,
    readStatus: (json) => (json?.status ?? '').toLowerCase(),
    readModelUrl: (json) => json?.model_urls?.glb,
    successStatuses: ['succeeded', 'success'],
    failureStatuses: ['failed', 'canceled', 'expired'],
  },
};

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const next = argv[i + 1];
    args[key.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true;
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv);
  const providerName = (args.provider ?? 'tripo').toLowerCase();
  const provider = PROVIDERS[providerName];
  if (!provider) {
    console.error(`Unknown provider "${providerName}". Available: ${Object.keys(PROVIDERS).join(', ')}`);
    process.exit(1);
  }

  const apiKey = process.env[provider.keyEnv];
  if (!apiKey) {
    console.error(`Missing ${provider.keyEnv} in the environment.`);
    process.exit(1);
  }

  if (!args.image && !args.prompt) {
    console.error('Provide --image <path> or --prompt "<text>".');
    process.exit(1);
  }

  const out = args.out
    ?? (args.image ? `./raw/${basename(args.image, extname(args.image))}.glb` : './raw/generated.glb');
  const timeoutMs = Number(args.timeout ?? 600_000);
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  // --- build the request body -------------------------------------------------
  let body;
  if (args.prompt) {
    body = provider.buildTextBody(String(args.prompt));
  } else {
    const ext = extname(args.image).toLowerCase() || '.jpg';
    const bytes = await readFile(args.image);
    if (providerName === 'tripo') {
      // Tripo takes an uploaded file token
      const form = new FormData();
      form.append('file', new Blob([bytes]), basename(args.image));
      const up = await fetch(`${provider.base}${provider.uploadPath}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (!up.ok) throw new Error(`upload failed: ${up.status} ${await up.text()}`);
      const upJson = await up.json();
      const token = upJson?.data?.image_token;
      if (!token) throw new Error(`no image token in upload response: ${JSON.stringify(upJson)}`);
      body = provider.buildImageBody(token, ext);
    } else {
      const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
      body = provider.buildImageBody(`data:${mime};base64,${bytes.toString('base64')}`);
    }
  }

  // --- submit -----------------------------------------------------------------
  console.log(`submitting to ${providerName}...`);
  const submit = await fetch(`${provider.base}${provider.submitPath}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  if (submit.status === 401 || submit.status === 403) throw new Error('authentication failed — check the API key');
  if (submit.status === 429) throw new Error('rate limited — wait and retry');
  if (!submit.ok) throw new Error(`submit failed: ${submit.status} ${await submit.text()}`);

  const submitJson = await submit.json();
  const taskId = provider.readTaskId(submitJson);
  if (!taskId) throw new Error(`no task id in response: ${JSON.stringify(submitJson)}`);
  console.log(`task ${taskId} queued`);

  // --- poll -------------------------------------------------------------------
  const started = Date.now();
  let modelUrl = null;
  let lastStatus = '';
  while (Date.now() - started < timeoutMs) {
    await sleep(3000);
    const res = await fetch(`${provider.base}${provider.taskPath(taskId)}`, { headers });
    if (!res.ok) {
      console.warn(`poll returned ${res.status}, retrying`);
      continue;
    }
    const json = await res.json();
    const status = provider.readStatus(json);
    if (status !== lastStatus) {
      lastStatus = status;
      process.stdout.write(`\rstatus: ${status}          `);
    }
    if (provider.successStatuses.includes(status)) {
      modelUrl = provider.readModelUrl(json);
      break;
    }
    if (provider.failureStatuses.includes(status)) {
      throw new Error(`generation ${status}${json?.data?.message ? `: ${json.data.message}` : ''}`);
    }
  }
  process.stdout.write('\n');

  if (!modelUrl) throw new Error('timed out waiting for the model');

  // --- download ---------------------------------------------------------------
  console.log('downloading model...');
  const file = await fetch(modelUrl);
  if (!file.ok) throw new Error(`download failed: ${file.status}`);
  const buf = Buffer.from(await file.arrayBuffer());
  await writeFile(out, buf);

  console.log(`saved ${out} (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`
Next: this is a RAW generated mesh — do not load it directly.
  gltf-transform inspect ${out}
  ./scripts/optimize-glb.sh --tiers ${out} ./public/models
`);
}

main().catch((err) => {
  console.error(`\nerror: ${err.message}`);
  process.exit(1);
});
