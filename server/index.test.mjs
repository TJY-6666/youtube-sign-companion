import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp, parseRange, validateText } from './index.mjs';

const APP_TOKEN = 'local-test-token';
const env = { APP_TOKEN, PORT: '4318' };
const mp4 = Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);

async function withApp(options, run) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'companion-backend-test-'));
  await mkdir(path.join(rootDir, 'output/signapse'), { recursive: true });
  await writeFile(path.join(rootDir, 'output/signapse/asl-test.mp4'), mp4);
  await mkdir(path.join(rootDir, 'public'));
  await writeFile(path.join(rootDir, 'public/index.html'), '<h1>Demo</h1>');
  await writeFile(path.join(rootDir, '.env.local'), 'PRIVATE_SECRET=do-not-expose');
  const app = createApp({ env, rootDir, ...options });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try { await run(base, rootDir); } finally {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.close();
    assert.equal(path.dirname(path.resolve(rootDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(rootDir).startsWith('companion-backend-test-'));
    await rm(rootDir, { recursive: true, force: true });
  }
}

const mutationHeaders = { Authorization: `Bearer ${APP_TOKEN}`, 'Content-Type': 'application/json', Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };

const motionClip = () => ({ format: 'motion133', fps: 20, frames: [Array(133).fill(0)] });
const mockWebm = Buffer.from('1a45dfa300000000', 'hex');
function imageWorker(overrides = {}) {
  return { ready: true, busy: false, generate: async (clip, filename) => {
    await writeFile(filename, mockWebm);
    return { format: 'generated-video', mediaType: 'video/webm', fps: 12, size: 384, frameCount: 1, duration: 1 / 12, renderSeconds: 0.2 };
  }, ...overrides };
}

test('AI video uses real motion contract, private WebM media and no supplier fallback', async () => {
  const motionGenerator = { ready: true, generate: async () => motionClip() };
  await withApp({ motionGenerator, frameGenerator: imageWorker(), fetchImpl() { assert.fail('No paid supplier'); } }, async base => {
    const send = headers => fetch(base + '/api/framegen', { method: 'POST', headers, body: JSON.stringify({ text: 'Hello' }) });
    assert.equal((await send({ 'Content-Type': 'application/json' })).status, 401);
    const video = await (await send(mutationHeaders)).json();
    assert.equal(video.format, 'generated-video'); assert.equal(video.accuracyReviewed, false);
    assert.equal((await fetch(base + video.url)).status, 401);
    const media = await fetch(base + video.url, { headers: { Authorization: `Bearer ${APP_TOKEN}`, Range: 'bytes=0-3' } });
    assert.equal(media.status, 206); assert.equal(media.headers.get('content-type'), 'video/webm');
    assert.equal(Buffer.from(await media.arrayBuffer()).toString('hex'), '1a45dfa3');
    assert.equal((await fetch(base + video.url.replace('.webm', '.mp4'))).status, 404);
    assert.equal((await (await fetch(base + '/api/health')).json()).framegenReady, true);
  });
});

test('AI video readiness, malformed output and GPU overlap are gated without changing modes', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  const worker = imageWorker({ ready: false });
  await withApp({ motionGenerator: { ready: true, generate: async () => motionClip() }, frameGenerator: worker }, async (base, rootDir) => {
    const send = (route = '/api/framegen') => fetch(base + route, { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ text: 'Hello' }) });
    assert.equal((await send()).status, 503);
    worker.ready = true;
    const original = worker.generate;
    worker.generate = async (...args) => { entered(); await gate; return original(...args); };
    const first = send(); await reached;
    assert.equal((await send()).status, 429); assert.equal((await send('/api/motion')).status, 429);
    release(); assert.equal((await first).status, 200);
    worker.generate = async (clip, filename) => ({ ...await original(clip, filename), frameCount: 12, duration: 1 });
    assert.equal((await send()).status, 502);
    const { readdir } = await import('node:fs/promises');
    assert.equal((await readdir(path.join(rootDir, 'output/companion'))).length, 1);
  });
});

test('AI generated cache is bounded and deletes only old generated clips', async () => {
  await withApp({ motionGenerator: { ready: true, generate: async () => motionClip() }, frameGenerator: imageWorker() }, async (base, rootDir) => {
    let first;
    for (let i = 0; i < 33; i++) {
      const response = await fetch(base + '/api/framegen', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ text: 'Hello' }) });
      assert.equal(response.status, 200); const value = await response.json(); first ||= value.url;
    }
    assert.equal((await fetch(base + first, { headers: mutationHeaders })).status, 404);
    assert.deepEqual(await readFile(path.join(rootDir, 'output/signapse/asl-test.mp4')), mp4);
    const { readdir } = await import('node:fs/promises'); assert.equal((await readdir(path.join(rootDir, 'output/companion'))).length, 32);
  });
});

test('self-hosted motion requires auth and readiness and never falls back to paid generation', async () => {
  const motionGenerator = { ready: false, busy: false, error: 'Weights missing', generate: async () => ({ format: 'motion133', fps: 20, frames: [Array(133).fill(0)] }) };
  await withApp({ motionGenerator, fetchImpl() { assert.fail('No supplier requests allowed'); } }, async base => {
    const send = headers => fetch(`${base}/api/motion`, { method: 'POST', headers, body: JSON.stringify({ text: 'Plants grow.' }) });
    assert.equal((await send({ 'Content-Type': 'application/json' })).status, 401);
    assert.equal((await send(mutationHeaders)).status, 503);
    motionGenerator.ready = true; motionGenerator.busy = true;
    assert.equal((await send(mutationHeaders)).status, 429);
    motionGenerator.busy = false;
    const result = await send(mutationHeaders); assert.equal(result.status, 200);
    const clip = await result.json(); assert.equal(clip.format, 'motion133'); assert.equal(clip.accuracyReviewed, false);
    assert.equal((await (await fetch(`${base}/api/health`)).json()).motionReady, true);
    motionGenerator.generate = async () => ({ format: 'motion133', fps: 20, frames: [[0]] });
    assert.equal((await send(mutationHeaders)).status, 502);
  });
});

test('Avatar assets are served from their folder without opening private extension configuration', async () => {
  await withApp({}, async (base, rootDir) => {
    await mkdir(path.join(rootDir, 'extension/avatar'), { recursive: true });
    await writeFile(path.join(rootDir, 'extension/avatar/index.html'), '<title>Avatar</title>');
    await mkdir(path.join(rootDir, 'extension/avatar/assets'), { recursive: true });
    await writeFile(path.join(rootDir, 'extension/avatar/assets/right.glb'), Buffer.from('glTF'));
    await writeFile(path.join(rootDir, 'extension/connection.local.json'), '{"appToken":"private"}');
    assert.match(await (await fetch(`${base}/avatar/index.html`)).text(), /Avatar/);
    const hand = await fetch(`${base}/avatar/assets/right.glb`);
    assert.equal(hand.status, 200); assert.equal(hand.headers.get('content-type'), 'model/gltf-binary');
    assert.equal(await hand.text(), 'glTF');
    for (const route of ['/avatar/%2e%2e%2fconnection.local.json', '/avatar/%5c..%5cconnection.local.json', '/extension/connection.local.json']) assert.equal((await fetch(base + route)).status, 404);
  });
});

test('text validation rejects nonstrings, excessive text, empty strings and excessive words', () => {
  for (const text of [null, '', ' ', 'a'.repeat(301), 'word '.repeat(41)]) assert.throws(() => validateText(text));
  assert.equal(validateText('  Hello, world.  '), 'Hello, world.');
});

test('ranges support video seek and reject malformed or out-of-bounds ranges', () => {
  assert.deepEqual(parseRange('bytes=1-4', 10), { start: 1, end: 4 });
  assert.deepEqual(parseRange('bytes=7-', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=0-99', 10), { start: 0, end: 9 });
  for (const range of ['bytes=10-', 'bytes=4-1', 'bytes=0-1,4-5', 'bytes=-0', 'bytes=-', 'bytes=9007199254740992-']) assert.throws(() => parseRange(range, 10));
});

test('external cleartext bindings and malformed public origins are rejected', () => {
  assert.throws(() => createApp({ env: { HOST: '0.0.0.0' } }), /HTTPS/);
  assert.throws(() => createApp({ env: { PUBLIC_ORIGIN: 'http://example.com' } }), /HTTPS/);
  assert.throws(() => createApp({ env: { PUBLIC_ORIGIN: 'https://example.com/path' } }), /exact HTTPS origin/);
});

test('health and sample do not expose secrets and sample is clearly prerecorded', async () => {
  await withApp({}, async base => {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.generationEnabled, false);
    assert.equal(health.transcriptionReady, false);
    assert.doesNotMatch(JSON.stringify(health), /local-test-token|PRIVATE_SECRET/);
    const sample = await (await fetch(`${base}/api/sample`)).json();
    assert.equal(sample.prerecorded, true);
    assert.equal(sample.available, true);
    assert.equal(sample.url, '/media/sample.mp4');
  });
});

test('sample supports range playback, invalid ranges and HEAD', async () => {
  await withApp({}, async base => {
    const response = await fetch(`${base}/media/sample.mp4`, { headers: { Range: 'bytes=4-7' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes 4-7/${mp4.length}`);
    assert.equal(await response.text(), 'ftyp');
    const head = await fetch(`${base}/media/sample.mp4`, { method: 'HEAD' });
    assert.equal(head.headers.get('content-length'), String(mp4.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const invalid = await fetch(`${base}/media/sample.mp4`, { headers: { Range: 'bytes=999-' } });
    assert.equal(invalid.status, 416);
  });
});

test('server serves public assets but never root secrets or traversal', async () => {
  await withApp({}, async base => {
    assert.match(await (await fetch(base)).text(), /Demo/);
    for (const route of ['/.env.local', '/%2e%2e%2f.env.local', '/%5c..%5c.env.local', '/media/../../.env.local', '/media/unknown.mp4']) {
      const response = await fetch(base + route);
      assert.equal(response.status, 404);
      assert.doesNotMatch(await response.text(), /PRIVATE_SECRET/);
    }
  });
});

test('public extension download supports HEAD and ranges without opening root files', async () => {
  await withApp({}, async (base, rootDir) => {
    const bytes = Buffer.from('504b030400000000', 'hex');
    await mkdir(path.join(rootDir, 'public/downloads'));
    await writeFile(path.join(rootDir, 'public/downloads/extension.zip'), bytes);
    const response = await fetch(base + '/downloads/extension.zip');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/zip');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal((await fetch(base + '/downloads/extension.zip', { method: 'HEAD' })).headers.get('content-length'), String(bytes.length));
    const range = await fetch(base + '/downloads/extension.zip', { headers: { Range: 'bytes=0-3' } });
    assert.equal(range.status, 206);
    assert.equal(Buffer.from(await range.arrayBuffer()).toString('hex'), '504b0304');
    assert.equal((await fetch(base + '/downloads/%2e%2e%2f%2e%2e%2f.env.local')).status, 404);
  });
});

test('foreign origins and missing app token cannot generate', async () => {
  await withApp({ fetchImpl: () => assert.fail('No provider calls allowed') }, async base => {
    const foreign = await fetch(`${base}/api/sign`, { method: 'POST', headers: { ...mutationHeaders, Origin: 'https://evil.example' }, body: JSON.stringify({ text: 'Hello' }) });
    assert.equal(foreign.status, 403);
    const missing = await fetch(`${base}/api/sign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hello' }) });
    assert.equal(missing.status, 401);
    const disabled = await fetch(`${base}/api/sign`, { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ text: 'Hello' }) });
    assert.equal(disabled.status, 409);
  });
});

test('extension preflight allows only required methods and headers', async () => {
  await withApp({}, async base => {
    const origin = mutationHeaders.Origin;
    const response = await fetch(`${base}/api/sign`, { method: 'OPTIONS', headers: { Origin: origin } });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('access-control-allow-headers'), 'Authorization, Content-Type');
  });
});

test('sign request sends explicit ASL, caches auth, never forwards credentials to media and stops at run limit', async () => {
  let authCalls = 0;
  let signCalls = 0;
  const config = { ...env, ENABLE_GENERATION: '1', MAX_GENERATIONS: '2', SIGNSTREAM_PUBLISHABLE_KEY: 'pk_mock', SIGNSTREAM_SECRET_KEY: 'sk_mock' };
  await withApp({ env: config, fetchImpl: async (url, options) => {
    if (url.includes('/token')) {
      authCalls++;
      assert.equal(options.body.get('client_secret'), 'sk_mock');
      assert.equal(options.body.get('grant_type'), 'client_credentials');
      return Response.json({ access_token: 'mock-bearer', expires_in: 900 });
    }
    if (url.endsWith('/v2/generate')) {
      signCalls++;
      assert.equal(options.headers.Authorization, 'Bearer mock-bearer');
      assert.equal(options.redirect, 'manual');
      const body = JSON.parse(options.body);
      assert.equal(body.output.delivery.config.language, 'ASL');
      assert.equal(body.output.delivery.config.digitalSigner, 'MAX');
      assert.ok(body.context.application);
      return new Response(null, { status: 303, headers: { Location: 'https://media.example.test/video.mp4?secret-signature=private' } });
    }
    assert.equal(url, 'https://media.example.test/video.mp4?secret-signature=private');
    assert.equal(options.headers, undefined);
    return new Response(mp4);
  } }, async (base, rootDir) => {
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${base}/api/sign`, { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ text: 'Hello' }) });
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.prerecorded, false);
      assert.doesNotMatch(JSON.stringify(data), /mock-bearer|sk_mock|secret-signature/);
      const media = await fetch(base + data.url);
      assert.deepEqual(Buffer.from(await media.arrayBuffer()), mp4);
      assert.deepEqual(await readFile(path.join(rootDir, 'output/companion', path.basename(data.url))), mp4);
    }
    const limit = await fetch(`${base}/api/sign`, { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ text: 'Hello' }) });
    assert.equal(limit.status, 429);
    assert.equal(authCalls, 1);
    assert.equal(signCalls, 2);
  });
});

test('provider failure is not retried and upstream secrets are omitted', async () => {
  let count = 0;
  await withApp({ env: { ...env, ENABLE_GENERATION: '1', SIGNSTREAM_PUBLISHABLE_KEY: 'pk_mock', SIGNSTREAM_SECRET_KEY: 'sk_mock' }, fetchImpl: async url => {
    count++;
    return url.includes('/token') ? Response.json({ access_token: 'private', expires_in: 900 }) : new Response('private key sk_mock', { status: 402 });
  } }, async base => {
    const response = await fetch(`${base}/api/sign`, { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ text: 'Hello' }) });
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /sk_mock|private key/);
    assert.equal(count, 2);
  });
});

test('TLS errors identify the failed stage without exposing secrets or retrying generation', async () => {
  for (const stage of ['authentication', 'generation', 'video download']) {
    let calls = 0;
    const config = { ...env, ENABLE_GENERATION: '1', SIGNSTREAM_PUBLISHABLE_KEY: 'pk_mock', SIGNSTREAM_SECRET_KEY: 'sk_mock' };
    await withApp({ env: config, fetchImpl: async url => {
      calls++;
      if ((stage === 'authentication' && url.includes('/token')) ||
          (stage === 'generation' && url.endsWith('/generate')) ||
          (stage === 'video download' && url.includes('media.example'))) {
        throw new TypeError('private sk_mock secret URL', { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } });
      }
      if (url.includes('/token')) return Response.json({ access_token: 'private', expires_in: 900 });
      return new Response(null, { status: 303, headers: { Location: 'https://media.example/video.mp4' } });
    } }, async base => {
      const response = await fetch(`${base}/api/sign`, { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ text: 'Hello' }) });
      assert.equal(response.status, 502);
      const data = await response.json();
      assert.ok(data.error.includes(`SignStream ${stage}: TLS certificate verification failed`));
      assert.doesNotMatch(data.error, /sk_mock|private|secret URL/);
      const health = await (await fetch(`${base}/api/health`)).json();
      assert.deepEqual(health.lastProviderError, { stage, code: 'TLS_VERIFICATION_FAILED' });
      assert.equal(calls, ['authentication', 'generation', 'video download'].indexOf(stage) + 1);
    });
  }
});

test('overlapping generations cannot multiply spend', async () => {
  let entered;
  let release;
  const reached = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  let generations = 0;
  await withApp({ env: { ...env, ENABLE_GENERATION: '1', SIGNSTREAM_PUBLISHABLE_KEY: 'pk_mock', SIGNSTREAM_SECRET_KEY: 'sk_mock' }, fetchImpl: async url => {
    if (url.includes('/token')) return Response.json({ access_token: 'private', expires_in: 900 });
    generations++;
    entered();
    await pending;
    return new Response(null, { status: 402 });
  } }, async base => {
    const options = { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ text: 'Hello' }) };
    const first = fetch(`${base}/api/sign`, options);
    await reached;
    try {
      const second = await fetch(`${base}/api/sign`, options);
      assert.equal(second.status, 429);
      assert.equal(generations, 1);
    } finally { release(); }
    assert.equal((await first).status, 502);
  });
});

test('restored generation count preserves spent attempts when changing the test allowance', async () => {
  await withApp({ env: { ...env, MAX_GENERATIONS: '3', GENERATION_COUNT_START: '2' }, fetchImpl: () => assert.fail('No supplier request') }, async base => {
    const h = await (await fetch(`${base}/api/health`)).json();
    assert.equal(h.generationCount, 2);
    assert.equal(h.maxGenerations, 3);
  });
});

test('transcription is separately authenticated, validates media, and follows live readiness', async () => {
  const transcriber = { ready: false, transcribe: async (audio, mime) => {
    assert.equal(audio.toString(), 'mock-audio');
    assert.equal(mime, 'audio/webm');
    return { text: 'Hello', seconds: 0.2 };
  } };
  await withApp({ transcriber }, async base => {
    const send = type => fetch(`${base}/api/transcribe`, { method: 'POST', headers: { Authorization: `Bearer ${APP_TOKEN}`, 'Content-Type': type }, body: 'mock-audio' });
    assert.equal((await send('audio/webm')).status, 503);
    transcriber.ready = true;
    assert.equal((await (await fetch(`${base}/api/health`)).json()).transcriptionReady, true);
    assert.equal((await send('text/plain')).status, 415);
    const response = await send('audio/webm;codecs=opus');
    assert.deepEqual(await response.json(), { text: 'Hello', seconds: 0.2 });
  });
});
