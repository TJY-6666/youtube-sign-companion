import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const source = await readFile(new URL('./background.js', import.meta.url), 'utf8');
const connectionSource = await readFile(new URL('./connection.js', import.meta.url), 'utf8');
const sender = id => ({ tab: { id, url: `https://www.youtube.com/watch?v=video-${id}` } });

function harness({ fetchImpl, settingsImpl, startResult = { ok: true }, health = { motionReady: true, framegenReady: true, transcriptionReady: true, signapseConfigured: true, generationEnabled: true } } = {}) {
  let listener;
  const offscreen = [];
  const tabMessages = [];
  let audioCaptureCalls = 0;
  const chrome = {
    runtime: {
      getURL: path => `chrome-extension://unit-test/${path}`,
      onMessage: { addListener(fn) { listener = fn; } },
      getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }],
      sendMessage: async message => { offscreen.push(message); return message.type === 'start' ? startResult : { ok: true }; },
    },
    storage: { local: { get: settingsImpl || (async () => ({ backend: 'http://127.0.0.1:4318', appToken: 'test-app-token' })) } },
    offscreen: { createDocument: async () => {} },
    tabCapture: { getMediaStreamId: async ({ targetTabId }) => { audioCaptureCalls++; return `stream-${targetTabId}`; } },
    tabs: { sendMessage: async (id, message) => tabMessages.push({ id, message }), onRemoved: { addListener() {} } },
  };
  vm.runInNewContext(connectionSource + '\n' + source, {
    importScripts() {},
    chrome, crypto: { randomUUID }, URL, AbortSignal, Uint8Array, btoa,
    fetch: async (url, options) => url.endsWith('/api/health') ? Response.json(health) : fetchImpl ? fetchImpl(url, options) : url.endsWith('/api/sample')
      ? Response.json({ url: '/media/sample.mp4', text: 'Sample', prerecorded: true })
      : new Response(new Uint8Array([1, 2, 3])),
  });
  return {
    offscreen, tabMessages, get audioCaptureCalls() { return audioCaptureCalls; },
    dispatch: (message, from = sender(1)) => new Promise(resolve => {
      const pending = listener(message, from, resolve);
      if (pending !== true) resolve(undefined);
    }),
  };
}

test('bundled motion JSON is read by the worker without backend settings, credentials or capture', async () => {
  const calls = [];
  const h = harness({ settingsImpl: () => assert.fail('Local assets must not read connection tokens.'), fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json({ value: 'bundled public data' }); } });
  for (const path of ['avatar/phrases/library.json', 'avatar/demo/timeline.json', 'avatar/demo/part-00.json', 'avatar/demo/part-19.json']) {
    const result = await h.dispatch({ type: 'companion.asset', path });
    assert.equal(result.ok, true); assert.equal(result.asset.value, 'bundled public data');
    assert.equal(calls.at(-1).url, `chrome-extension://unit-test/${path}`); assert.equal(calls.at(-1).options, undefined);
  }
  assert.equal(h.audioCaptureCalls, 0); assert.deepEqual(h.offscreen, []);
});

test('local asset messages cannot fetch private files, traversal, remote URLs or requests from another site', async () => {
  const h = harness({ settingsImpl: () => assert.fail('Invalid asset must stop before settings lookup.'), fetchImpl: () => assert.fail('Invalid asset must not fetch.') });
  for (const path of ['connection.local.json', '.env.local', 'avatar/demo/../../connection.local.json', 'https://example.org/data.json', 'avatar/demo/part-20.json', 'avatar/demo/part-00.json?extra=1', 'avatar/phrases/library.json#x', 'avatar/demo/timeline.json\n', null]) {
    const result = await h.dispatch({ type: 'companion.asset', path }); assert.equal(result.ok, false);
  }
  assert.equal((await h.dispatch({ type: 'companion.asset', path: 'avatar/phrases/library.json' }, { tab: { id: 3, url: 'https://example.org/watch?v=bad' } })).ok, false);
});

test('missing bundled data produces an actionable error rather than trying the backend', async () => {
  const h = harness({ fetchImpl: async () => new Response(null, { status: 404 }) });
  const result = await h.dispatch({ type: 'companion.asset', path: 'avatar/demo/timeline.json' });
  assert.equal(result.ok, false); assert.match(result.error, /Reload the extension/);
});

test('caption start never captures tab audio and seek fences old caption messages', async () => {
  const h = harness();
  const started = await h.dispatch({ type: 'companion.start', outputMode: 'frames', inputMode: 'captions' });
  assert.equal(h.audioCaptureCalls, 0);
  assert.equal(h.offscreen.find(m => m.type === 'start').inputMode, 'captions');
  const caption = { type: 'companion.caption', captureId: started.captureId, revision: started.revision, text: 'Hello there.', sourceTime: 10 };
  assert.equal((await h.dispatch(caption)).ok, true);
  const moved = await h.dispatch({ type: 'companion.playback', reset: true, paused: true, sourceTime: 50 });
  assert.equal((await h.dispatch(caption)).ignored, true);
  assert.equal((await h.dispatch({ ...caption, revision: moved.revision }, sender(2))).ignored, true);
  assert.equal((await h.dispatch({ ...caption, revision: moved.revision, text: 'New caption.' })).ok, true);
  assert.deepEqual(h.offscreen.filter(m => m.type === 'caption').map(m => m.text), ['Hello there.', 'New caption.']);
});

test('unready signing blocks capture without degrading to transcript-only or stopping another session', async () => {
  const health = { motionReady: true, transcriptionReady: true };
  const h = harness({ health });
  assert.equal((await h.dispatch({ type: 'companion.start', outputMode: 'motion', inputMode: 'captions' })).ok, true);
  const before = h.offscreen.length;
  health.motionReady = false; health.motionStatus = 'Motion Python runtime is missing.';
  const failed = await h.dispatch({ type: 'companion.start', outputMode: 'motion', inputMode: 'audio' }, sender(2));
  assert.equal(failed.ok, false); assert.match(failed.error, /Python runtime is missing/);
  assert.equal(h.offscreen.length, before); assert.equal(h.audioCaptureCalls, 0); assert.equal(h.tabMessages.length, 0);
  assert.equal((await h.dispatch({ type: 'companion.playback', paused: true })).ok, true);
  assert.equal(h.offscreen.at(-1).type, 'playback');
});

test('input provenance is constrained to the actual input mode and timed caption source', async () => {
  for (const [inputMode, timed, inputSource, expected] of [
    ['audio', true, 'caption-file', 'tab-audio'],
    ['captions', false, 'caption-file', 'visible-captions'],
    ['captions', true, 'caption-file', 'caption-file'],
    ['captions', true, 'player-response', 'player-response'],
    ['captions', true, '<untrusted>', 'timed-captions'],
  ]) {
    const h = harness();
    assert.equal((await h.dispatch({ type: 'companion.start', outputMode: 'motion', inputMode, timed, inputSource })).ok, true);
    assert.equal(h.offscreen.find(message => message.type === 'start').inputSource, expected);
  }
});

test('unready AI video and disabled paid video never start input', async () => {
  for (const outputMode of ['frames', 'video']) {
    const h = harness({ health: { motionReady: true, transcriptionReady: true, framegenReady: false, generationEnabled: false } });
    assert.equal((await h.dispatch({ type: 'companion.start', outputMode })).ok, false);
    assert.equal(h.offscreen.length, 0); assert.equal(h.audioCaptureCalls, 0);
  }
});

test('stop and sample in an inactive tab leave the other tab capturing', async () => {
  const h = harness();
  assert.equal((await h.dispatch({ type: 'companion.start' })).ok, true);
  const stopsBefore = h.offscreen.filter(message => message.type === 'stop').length;
  assert.equal((await h.dispatch({ type: 'companion.stop' }, sender(2))).ok, true);
  const sample = await h.dispatch({ type: 'companion.sample' }, sender(2));
  assert.equal(sample.ok, true);
  assert.equal(sample.prerecorded, true);
  assert.equal(sample.mediaBase64, 'AQID');
  assert.equal(h.offscreen.filter(message => message.type === 'stop').length, stopsBefore);
  await h.dispatch({ type: 'companion.playback', paused: false, reset: false });
  assert.equal(h.offscreen.at(-1).type, 'playback');
  await h.dispatch({ type: 'companion.stop' });
  assert.equal(h.offscreen.filter(message => message.type === 'stop').length, stopsBefore + 1);
});

test('moving capture to a second tab notifies the previous tab', async () => {
  const h = harness();
  await h.dispatch({ type: 'companion.start' });
  await h.dispatch({ type: 'companion.start' }, sender(2));
  assert.equal(h.tabMessages.length, 1);
  assert.equal(h.tabMessages[0].id, 1);
  assert.match(h.tabMessages[0].message.error, /another tab/);
  const before = h.offscreen.length;
  await h.dispatch({ type: 'companion.playback', paused: true, reset: true });
  assert.equal(h.offscreen.length, before);
  await h.dispatch({ type: 'companion.playback', paused: true, reset: true }, sender(2));
  assert.equal(h.offscreen.at(-1).type, 'playback');
});

test('AI video mode carries authenticated WebM bytes and never sends a token to a foreign media host', async () => {
  const calls = [];
  const h = harness({ fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response(new Uint8Array([1, 2, 3])); } });
  await h.dispatch({ type: 'companion.start', outputMode: 'frames' });
  const start = h.offscreen.find(message => message.type === 'start'); assert.equal(start.outputMode, 'frames');
  const message = { type: 'companion.offscreen', captureId: start.captureId, revision: start.revision, payload: { url: 'http://127.0.0.1:4318/media/generated.webm', mediaType: 'video/webm', format: 'generated-video' } };
  assert.equal((await h.dispatch(message, {})).ok, true);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-app-token');
  assert.equal(h.tabMessages[0].message.mediaType, 'video/webm'); assert.equal(h.tabMessages[0].message.mediaBase64, 'AQID');
  assert.equal((await h.dispatch({ ...message, payload: { url: 'https://foreign.example/video.webm' } }, {})).ok, false);
  assert.equal(calls.length, 1);
});

test('media finishing after reset and old revisions cannot update the player', async () => {
  let resolveDownload;
  let reachedDownload;
  const entered = new Promise(resolve => { reachedDownload = resolve; });
  const download = new Promise(resolve => { resolveDownload = resolve; });
  let fetches = 0;
  const h = harness({ fetchImpl: async () => {
    fetches++;
    reachedDownload();
    return download;
  } });
  await h.dispatch({ type: 'companion.start' });
  const start = h.offscreen.find(message => message.type === 'start');
  const message = { type: 'companion.offscreen', captureId: start.captureId, revision: start.revision, payload: { url: 'http://127.0.0.1:4318/media/result.mp4', text: 'Old content' } };
  const pending = h.dispatch(message, {});
  await entered;
  await h.dispatch({ type: 'companion.playback', paused: false, reset: true });
  resolveDownload(new Response(new Uint8Array([1, 2, 3])));
  assert.equal((await pending).ok, true);
  assert.equal(h.tabMessages.length, 0);
  await h.dispatch(message, {});
  assert.equal(fetches, 1);
  assert.equal(h.tabMessages.length, 0);
  await h.dispatch({ ...message, revision: start.revision + 1, payload: { status: 'Fresh segment' } }, {});
  assert.equal(h.tabMessages.length, 1);
  assert.equal(h.tabMessages[0].id, 1);
  assert.equal(h.tabMessages[0].message.status, 'Fresh segment');
});

test('offscreen startup failure reaches the UI and does not leave an active capture', async () => {
  const h = harness({ startResult: { ok: false, error: 'Tab audio access failed.' } });
  const result = await h.dispatch({ type: 'companion.start' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Tab audio access failed.');
  const before = h.offscreen.length;
  await h.dispatch({ type: 'companion.playback', paused: false, reset: true });
  assert.equal(h.offscreen.length, before);
});
