import http from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile, readFile, unlink } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN_URL = 'https://token.api.production.signapsesolutions.com/token';
const GENERATE_URL = 'https://ai.api.production.signapsesolutions.com/v2/generate';
const SAMPLE_TEXT = 'Today we will learn how plants use sunlight to grow.';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.glb': 'model/gltf-binary', '.zip': 'application/zip' };

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function authenticated(req, token) {
  const actual = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return token && actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function body(req, max) {
  const parts = [];
  let length = 0;
  for await (const part of req) {
    length += part.length;
    if (length > max) throw new ApiError(413, 'Request body is too large.');
    parts.push(part);
  }
  return Buffer.concat(parts);
}

export function validateText(value) {
  if (typeof value !== 'string') throw new ApiError(400, 'Text must be a string.');
  const text = value.trim();
  if (!text || text.length > 300 || text.split(/\s+/u).length > 40) {
    throw new ApiError(400, 'Use 1–40 words and at most 300 characters.');
  }
  return text;
}

export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw new ApiError(416, 'Invalid byte range.');
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) throw new ApiError(416, 'Invalid byte range.');
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    throw new ApiError(416, 'Requested range is unavailable.');
  }
  return { start, end };
}

async function sendFile(req, res, filename, contentType) {
  let info;
  try { info = await stat(filename); } catch { throw new ApiError(404, 'File not found.'); }
  if (!info.isFile()) throw new ApiError(404, 'File not found.');
  let range;
  try { range = parseRange(req.headers.range, info.size); } catch (error) {
    res.setHeader('Content-Range', `bytes */${info.size}`);
    throw error;
  }
  const headers = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${info.size}`;
    headers['Content-Length'] = range.end - range.start + 1;
  } else headers['Content-Length'] = info.size;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = createReadStream(filename, range || {});
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

export function createApp({ env = process.env, fetchImpl = fetch, transcriber = null, motionGenerator = null, frameGenerator = null, rootDir = ROOT, onDiagnostic = () => {} } = {}) {
  const port = Number(env.PORT || 4318);
  const host = env.HOST || '127.0.0.1';
  const publicOrigin = env.PUBLIC_ORIGIN || '';
  if (publicOrigin) {
    let parsed;
    try { parsed = new URL(publicOrigin); } catch { throw new Error('PUBLIC_ORIGIN must be an origin URL.'); }
    if (parsed.origin !== publicOrigin || (parsed.protocol !== 'https:' && !LOOPBACK.has(parsed.hostname))) {
      throw new Error('PUBLIC_ORIGIN must be an exact HTTPS origin (HTTP is allowed only on loopback).');
    }
  }
  if (!LOOPBACK.has(host) && !publicOrigin.startsWith('https://')) {
    throw new Error('External binding requires PUBLIC_ORIGIN=https://... and an HTTPS reverse proxy.');
  }
  const localOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, publicOrigin].filter(Boolean));
  const token = env.APP_TOKEN || '';
  const configured = Boolean(env.SIGNSTREAM_PUBLISHABLE_KEY?.trim() && env.SIGNSTREAM_SECRET_KEY?.trim());
  const generationEnabled = env.ENABLE_GENERATION === '1';
  const maxGenerations = Math.max(0, Math.min(10, Number.parseInt(env.MAX_GENERATIONS || '3', 10) || 0));
  const cacheDir = path.join(rootDir, 'output', 'companion');
  const mediaFiles = new Map();
  let generationCount = Math.max(0, Math.min(maxGenerations, Number.parseInt(env.GENERATION_COUNT_START || '0', 10) || 0));
  let generating = false;
  let transcribing = false;
  let localGenerationBusy = false;
  let cachedToken = null;
  let lastProviderError = null;

  async function providerFetch(url, options, stage) {
    try { return await fetchImpl(url, options); }
    catch (error) {
      const code = error.cause?.code || error.code;
      const certificateError = ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code);
      lastProviderError = { stage, code: certificateError ? 'TLS_VERIFICATION_FAILED' : 'NETWORK_ERROR' };
      throw new ApiError(502, certificateError
        ? `SignStream ${stage}: TLS certificate verification failed. Try a trusted different network; no automatic retry was made.`
        : `SignStream ${stage}: network connection failed. No automatic retry was made; check account usage before retrying.`);
    }
  }

  async function accessToken() {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
    const form = new FormData();
    form.set('client_id', env.SIGNSTREAM_PUBLISHABLE_KEY.trim());
    form.set('client_secret', env.SIGNSTREAM_SECRET_KEY.trim());
    form.set('grant_type', 'client_credentials');
    const response = await providerFetch(TOKEN_URL, { method: 'POST', body: form, redirect: 'manual', signal: AbortSignal.timeout(30_000) }, 'authentication');
    if (!response.ok) throw new ApiError(502, `SignStream authentication failed (HTTP ${response.status}).`);
    const data = await response.json();
    if (typeof data.access_token !== 'string' || !data.access_token) throw new ApiError(502, 'SignStream returned no access token.');
    cachedToken = { value: data.access_token, expiresAt: Date.now() + Math.min(Number(data.expires_in) || 0, 900) * 1000 };
    return cachedToken.value;
  }

  async function sign(text) {
    if (!generationEnabled) throw new ApiError(409, 'Live generation is off. Set ENABLE_GENERATION=1 on the backend to use existing SignStream credits.');
    if (!configured) throw new ApiError(503, 'SignStream credentials are not configured.');
    if (generating) throw new ApiError(429, 'Another translation is running. Wait before sending another.');
    if (generationCount >= maxGenerations) throw new ApiError(429, 'This server run has reached its generation limit.');
    generating = true;
    const started = performance.now();
    try {
      const bearer = await accessToken();
      generationCount++;
      // No retries: even a failed or timed-out generation may have consumed credits.
      const response = await providerFetch(GENERATE_URL, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(180_000),
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: { type: 'text', data: text }, output: { format: 'mp4', delivery: { method: 'download', config: { language: 'ASL', digitalSigner: 'MAX', quality: 'low', codec: 'h264' } } }, context: { application: 'hackglobal-youtube-sign-companion' } }),
      }, 'generation');
      if (response.status !== 303) throw new ApiError(502, `SignStream generation returned HTTP ${response.status}. No retry was made.`);
      let url;
      try { url = new URL(response.headers.get('location') || ''); } catch { throw new ApiError(502, 'SignStream returned no valid video URL.'); }
      if (url.protocol !== 'https:') throw new ApiError(502, 'SignStream returned an insecure video URL.');
      const download = await providerFetch(url.href, { signal: AbortSignal.timeout(120_000) }, 'video download');
      if (!download.ok || !download.body) throw new ApiError(502, 'Generated video could not be downloaded. No generation retry was made.');
      const parts = [];
      let size = 0;
      for await (const chunk of download.body) {
        size += chunk.length;
        if (size > 50 * 1024 * 1024) throw new ApiError(502, 'Generated video exceeded the test size limit.');
        parts.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(parts);
      if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new ApiError(502, 'Generated media was not an MP4 file.');
      await mkdir(cacheDir, { recursive: true });
      const id = randomUUID();
      const filename = path.join(cacheDir, `${id}.mp4`);
      await writeFile(filename, bytes);
      mediaFiles.set(id, filename);
      lastProviderError = null;
      return { url: `/media/${id}.mp4`, text, language: 'ASL', prerecorded: false, seconds: Number(((performance.now() - started) / 1000).toFixed(2)), generationCount, remainingRequests: maxGenerations - generationCount };
    } finally { generating = false; }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const origin = req.headers.origin;
      const extensionOrigin = origin && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
      if (origin && !localOrigins.has(origin) && !extensionOrigin) throw new ApiError(403, 'This origin is not allowed.');
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' });
        res.end(); return;
      }
      const url = new URL(req.url, 'http://localhost');
      if (['GET', 'HEAD'].includes(req.method) && url.pathname.startsWith('/avatar/')) {
        const folder = path.resolve(rootDir, 'extension/avatar');
        let decoded; try { decoded = decodeURIComponent(url.pathname.slice('/avatar/'.length)); } catch { throw new ApiError(400, 'Invalid path.'); }
        const filename = path.resolve(folder, decoded);
        if (!filename.startsWith(folder + path.sep) || decoded.includes('\\') || !TYPES[path.extname(filename)]) throw new ApiError(404, 'Not found.');
        await sendFile(req, res, filename, TYPES[path.extname(filename)]); return;
      }
      if (['GET', 'HEAD'].includes(req.method) && ['/extension/content.js', '/extension/captions.js'].includes(url.pathname)) {
        await sendFile(req, res, path.join(rootDir, url.pathname.slice(1)), TYPES['.js']); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        json(res, 200, { ok: true, signapseConfigured: configured, generationEnabled, transcriptionReady: Boolean(transcriber?.ready), motionConfigured: env.ENABLE_MOTION === '1', motionReady: Boolean(motionGenerator?.ready), motionPoseProfile: motionGenerator?.poseProfile ?? null, motionStatus: motionGenerator?.ready ? 'Ready · experimental motion133' : motionGenerator?.error || 'Motion model is not configured.', framegenConfigured: env.ENABLE_FRAMEGEN === '1', framegenReady: Boolean(motionGenerator?.ready && frameGenerator?.ready), framegenStatus: frameGenerator?.error || (frameGenerator?.ready ? 'Ready · AI visuals, gestures unverified' : 'AI video is not configured.'), authenticatedRequestsRequired: true, generationCount, maxGenerations, lastProviderError }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/sample') {
        let available = false;
        try { available = (await stat(path.join(rootDir, 'output/signapse/asl-test.mp4'))).isFile(); } catch {}
        json(res, 200, { url: '/media/sample.mp4', text: SAMPLE_TEXT, prerecorded: true, available, language: 'ASL', accuracy: 'Experimental output; not reviewed by an ASL signer.' }); return;
      }
      if (req.method === 'POST' && ['/api/sign', '/api/motion', '/api/framegen', '/api/transcribe'].includes(url.pathname)) {
        if (!authenticated(req, token)) throw new ApiError(401, 'A valid app token is required.');
        const type = (req.headers['content-type'] || '').split(';')[0].trim();
        if (['/api/sign', '/api/motion', '/api/framegen'].includes(url.pathname)) {
          if (type !== 'application/json') throw new ApiError(415, 'Send JSON text.');
          let data;
          try { data = JSON.parse((await body(req, 8192)).toString('utf8')); } catch (error) {
            if (error instanceof ApiError) throw error;
            throw new ApiError(400, 'Invalid JSON.');
          }
          const text = validateText(data?.text);
          if (url.pathname === '/api/motion' || url.pathname === '/api/framegen') {
            if (!motionGenerator?.ready) throw new ApiError(503, motionGenerator?.error || 'Self-hosted motion model is not ready.');
            if (url.pathname === '/api/framegen' && !frameGenerator?.ready) throw new ApiError(503, frameGenerator?.error || 'AI video is not ready.');
            if (localGenerationBusy || motionGenerator.busy || frameGenerator?.busy) throw new ApiError(429, 'The local GPU is processing another segment.');
            localGenerationBusy = true;
            let filename, stage = 'motion generation';
            try {
              const started = performance.now();
              const { validateMotion } = await import('../motion/bridge.mjs');
              const clip = validateMotion(await motionGenerator.generate(text));
              if (url.pathname === '/api/motion') { json(res, 200, { ...clip, text, language: 'ASL', accuracyReviewed: false }); return; }
              const id = randomUUID();
              await mkdir(cacheDir, { recursive: true });
              filename = path.join(cacheDir, `${id}.webm`);
              stage = 'rig rendering or AI video generation';
              const { validateVideo } = await import('../framegen/bridge.mjs');
              const video = validateVideo(await frameGenerator.generate(clip, filename, `http://127.0.0.1:${server.address().port}`));
              if (video.frameCount !== Math.ceil(clip.frames.length / clip.fps * video.fps)) throw new Error('Generated video did not cover the complete motion clip.');
              const info = await stat(filename);
              if (info.size < 4 || info.size > 20 * 1024 * 1024) throw new Error('Invalid generated-video size.');
              const bytes = await readFile(filename);
              if (bytes.subarray(0, 4).toString('hex') !== '1a45dfa3') throw new Error('Generated video is not WebM.');
              mediaFiles.set(id, filename);
              // Generated clips are fetched into the extension promptly; bound temporary disk use.
              while (mediaFiles.size > 32) {
                const [oldId, oldFile] = mediaFiles.entries().next().value;
                mediaFiles.delete(oldId); await unlink(oldFile).catch(() => {});
              }
              json(res, 200, { ...video, url: `/media/${id}.webm`, text, language: 'ASL', accuracyReviewed: false,
                experimental: true, motionSeconds: clip.seconds, seconds: Number(((performance.now() - started) / 1000).toFixed(2)) });
              return;
            } catch (error) {
              if (filename) await unlink(filename).catch(() => {});
              onDiagnostic({ type: 'local-generation-failed', stage, error: error.message });
              throw new ApiError(502, `Local ${stage} failed. Check the backend diagnostics before restarting this session.`);
            }
            finally { localGenerationBusy = false; }
          }
          json(res, 200, await sign(text)); return;
        }
        if (!['audio/webm', 'audio/wav', 'audio/x-wav', 'audio/ogg'].includes(type)) throw new ApiError(415, 'Send WebM, Ogg or WAV audio.');
        if (!transcriber?.ready) throw new ApiError(503, 'Local transcription is not ready. Complete the transcription setup first.');
        if (transcribing) throw new ApiError(429, 'Another audio segment is being transcribed.');
        transcribing = true;
        try {
          const audio = await body(req, 5 * 1024 * 1024);
          if (!audio.length) throw new ApiError(400, 'Audio is empty.');
          const result = await transcriber.transcribe(audio, type);
          json(res, 200, { text: result.text, seconds: result.seconds });
        } finally { transcribing = false; }
        return;
      }
      if (['GET', 'HEAD'].includes(req.method) && url.pathname.startsWith('/media/')) {
        const match = /^\/media\/([0-9a-f-]{36}|sample)\.(mp4|webm)$/.exec(url.pathname);
        const id = match?.[1], extension = match?.[2];
        if (extension === 'webm' && !authenticated(req, token)) throw new ApiError(401, 'A valid app token is required.');
        const filename = id === 'sample' ? path.join(rootDir, 'output/signapse/asl-test.mp4') : mediaFiles.get(id);
        if (!filename || path.extname(filename) !== `.${extension}`) throw new ApiError(404, 'Video not found.');
        await sendFile(req, res, filename, extension === 'webm' ? 'video/webm' : 'video/mp4'); return;
      }
      if (['GET', 'HEAD'].includes(req.method)) {
        let decoded;
        try { decoded = decodeURIComponent(url.pathname); } catch { throw new ApiError(400, 'Invalid path.'); }
        const publicDir = path.resolve(rootDir, 'public');
        const filename = path.resolve(publicDir, `.${decoded === '/' ? '/index.html' : decoded}`);
        if (!filename.startsWith(`${publicDir}${path.sep}`) || decoded.includes('\\')) throw new ApiError(404, 'Not found.');
        const type = TYPES[path.extname(filename)];
        if (!type) throw new ApiError(404, 'Not found.');
        await sendFile(req, res, filename, type); return;
      }
      throw new ApiError(404, 'Not found.');
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      json(res, error.status || 502, { error: error instanceof ApiError ? error.message : 'The request failed. Check the local backend and provider availability before trying again.' });
    }
  });
  return { server, host, port, close: () => { transcriber?.close?.(); motionGenerator?.close?.(); frameGenerator?.close?.(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let transcriber = null;
  try {
    const { createTranscriber } = await import('../transcription/bridge.mjs');
    transcriber = await createTranscriber();
  } catch { console.log('Transcription is unavailable; sample playback remains available.'); }
  const { createMotionGenerator } = await import('../motion/bridge.mjs');
  const { createFrameGenerator } = await import('../framegen/bridge.mjs');
  const { appendFile } = await import('node:fs/promises');
  await mkdir(path.join(ROOT, 'output'), { recursive: true });
  const motionGenerator = createMotionGenerator({ onDiagnostic: text => { void appendFile(path.join(ROOT, 'output/motion-worker.log'), text).catch(() => {}); } });
  const app = createApp({ transcriber, motionGenerator, onDiagnostic: value => { void appendFile(path.join(ROOT, 'output/local-inference.jsonl'), JSON.stringify(value) + '\n').catch(() => {}); },
    frameGenerator: createFrameGenerator({ waitForReady: () => motionGenerator.ready, onDiagnostic: text => { void appendFile(path.join(ROOT, 'output/framegen-worker.log'), text).catch(() => {}); } }) });
  app.server.listen(app.port, app.host, () => console.log(`Companion backend: http://${app.host}:${app.port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { app.close(); app.server.close(() => process.exit(0)); });
}
