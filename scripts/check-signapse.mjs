import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const TOKEN_URL = 'https://token.api.production.signapsesolutions.com/token';
const GENERATE_URL = 'https://ai.api.production.signapsesolutions.com/v2/generate';
const SAMPLE = 'Today we will learn how plants use sunlight to grow.';

// Source: https://docs.signapse.com/signstream/api/generate
export function generationRequest() {
  return {
    content: { type: 'text', data: SAMPLE },
    output: {
      format: 'mp4',
      delivery: {
        method: 'download',
        config: { language: 'ASL', digitalSigner: 'MAX', quality: 'low', codec: 'h264' },
      },
    },
    context: { application: 'hackglobal-youtube-sign-companion-smoke-test' },
  };
}

export async function checkSignapse({
  env = process.env,
  generate = false,
  fetchImpl = fetch,
  outputDir = path.resolve('output/signapse'),
} = {}) {
  const clientId = env.SIGNSTREAM_PUBLISHABLE_KEY?.trim();
  const secret = env.SIGNSTREAM_SECRET_KEY?.trim();
  if (!clientId || !secret) {
    throw new Error('Fill both SIGNSTREAM keys in .env.local first. Keep them out of chat.');
  }

  const form = new FormData();
  form.set('client_id', clientId);
  form.set('client_secret', secret);
  form.set('grant_type', 'client_credentials');
  let auth;
  try {
    auth = await fetchImpl(TOKEN_URL, {
      method: 'POST', body: form, redirect: 'manual', signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const tlsErrors = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']);
    if (tlsErrors.has(error.cause?.code)) {
      throw new Error('Authentication TLS certificate verification failed. Keep certificate verification enabled; no generation requested.');
    }
    throw new Error('Could not connect to the authentication server; credentials remain unverified and no generation was requested.');
  }
  if (!auth.ok) throw new Error(`Authentication failed (HTTP ${auth.status}); no generation requested.`);
  const token = await auth.json();
  if (typeof token.access_token !== 'string' || !token.access_token) {
    throw new Error('Authentication returned no access token; no generation requested.');
  }
  const result = { authenticated: true, tokenExpiresInSeconds: token.expires_in ?? null, generated: false };
  if (!generate) return result;

  const started = performance.now();
  // No generation retries: a repeated request can consume credits twice.
  const response = await fetchImpl(GENERATE_URL, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(180_000),
    headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(generationRequest()),
  });
  if (response.status !== 303) {
    throw new Error(`Generation returned HTTP ${response.status}, expected 303 for MP4. No retry made; check account usage before repeating.`);
  }
  const location = response.headers.get('location');
  if (!location) throw new Error('Generation returned no media location; no retry made.');
  const mediaUrl = new URL(location, GENERATE_URL);
  if (mediaUrl.protocol !== 'https:') throw new Error('Refusing a non-HTTPS media URL.');
  const generationResponseSeconds = (performance.now() - started) / 1000;

  // Never forward the Bearer token to the signed media URL.
  const media = await fetchImpl(mediaUrl.href, { signal: AbortSignal.timeout(120_000) });
  if (!media.ok || !media.body) throw new Error(`Media download failed (HTTP ${media.status}); no retry made.`);
  const parts = [];
  let size = 0;
  for await (const chunk of media.body) {
    size += chunk.length;
    if (size > 50 * 1024 * 1024) throw new Error('Test media exceeded the 50 MiB download limit.');
    parts.push(Buffer.from(chunk));
  }
  const data = Buffer.concat(parts);
  if (data.length < 12 || data.toString('ascii', 4, 8) !== 'ftyp') {
    throw new Error('Downloaded content is not an expected MP4 file; not saved.');
  }
  await mkdir(outputDir, { recursive: true });
  const videoPath = path.join(outputDir, 'asl-test.mp4');
  await writeFile(videoPath, data);
  Object.assign(result, {
    generated: true,
    language: 'ASL', signer: 'MAX', text: SAMPLE,
    generationResponseSeconds: Number(generationResponseSeconds.toFixed(2)),
    totalSeconds: Number(((performance.now() - started) / 1000).toFixed(2)),
    bytes: data.length, videoPath,
    accuracy: 'Not reviewed by an ASL signer. Playback still needs manual verification.',
  });
  await writeFile(path.join(outputDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--generate')) {
    console.error('Usage: node --env-file=.env.local scripts/check-signapse.mjs [--generate]');
    process.exitCode = 1;
  } else {
    try {
      if (args.includes('--generate')) console.log('One generation request will consume SignStream API credits.');
      const result = await checkSignapse({ generate: args.includes('--generate') });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
