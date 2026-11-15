import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('./pipeline.js', import.meta.url), 'utf8') + '\n' + await readFile(new URL('./offscreen.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(fetchImpl, relayImpl = () => ({ ok: true })) {
  let listener, audioCaptureCalls = 0; const records = [], updates = [];
  const stream = { active: true, getTracks: () => [{ stop() { stream.active = false; } }] };
  class Recorder {
    constructor() { this.state = 'inactive'; this.id = records.length; records.push(this); }
    start() { this.state = 'recording'; }
    stop() { if (this.state === 'inactive') return; this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable({ data: new Blob([`audio-${this.id}`]) }); this.onstop(); }); }
  }
  const chrome = { runtime: { sendMessage: async value => { updates.push(value); return relayImpl(value); }, onMessage: { addListener(fn) { listener = fn; } } } };
  vm.runInNewContext(source, { chrome, navigator: { mediaDevices: { getUserMedia: async () => { audioCaptureCalls++; return stream; } } },
    MediaRecorder: Recorder, AudioContext: class { createMediaStreamSource() { return { connect() {} }; } async resume() {} async close() {} },
    Blob, URL, AbortController, AbortSignal, performance, setTimeout, clearTimeout, fetch: fetchImpl });
  const dispatch = message => new Promise(resolve => listener({ target: 'offscreen', ...message }, {}, resolve));
  return { records, updates, dispatch, get audioCaptureCalls() { return audioCaptureCalls; }, start: (outputMode = 'transcribe', inputMode = 'audio') => dispatch({ type: 'start', backend: 'http://localhost', appToken: 'test', outputMode, inputMode, captureId: 'session', revision: 1 }) };
}

test('caption input bypasses audio and Whisper and publishes the first part while later parts generate', async t => {
  const routes = []; let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { entered = resolve; });
  const h = harness(async url => {
    routes.push(url); if (routes.length === 2) { entered(); await gate; }
    return Response.json({ url: '/media/clip.webm', format: 'generated-video', mediaType: 'video/webm' });
  });
  t.after(() => h.dispatch({ type: 'stop' })); await h.start('frames', 'captions');
  await h.dispatch({ type: 'caption', captureId: 'session', revision: 1, sourceTime: 10, text: 'First phrase. Second phrase.' });
  await reached;
  assert.equal(h.audioCaptureCalls, 0); assert.equal(h.records.length, 0);
  assert.ok(h.updates.some(m => m.payload.format === 'generated-video' && m.payload.text === 'First phrase.'));
  release(); await tick(); await tick();
  assert.deepEqual(routes, ['http://localhost/api/framegen', 'http://localhost/api/framegen']);
  assert.deepEqual(h.updates.filter(m => m.payload.format === 'generated-video').map(m => m.payload.text), ['First phrase.', 'Second phrase.']);
});

test('timed caption generation preserves source slots and future work does not request video buffering', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = harness(async () => { await gate; return Response.json({ format: 'motion133', fps: 20, frames: [Array(133).fill(0)] }); });
  t.after(() => h.dispatch({ type: 'stop' }));
  await h.dispatch({ type: 'start', backend: 'http://localhost', appToken: 'test', outputMode: 'motion', inputMode: 'captions', inputSource: 'player-response', timed: true, captureId: 'session', revision: 1 });
  await h.dispatch({ type: 'caption', captureId: 'session', revision: 1, sourceTime: 5, sourceEnd: 10, cueId: 7, timed: true, text: 'First phrase. Second phrase.' });
  await h.dispatch({ type: 'caption', captureId: 'session', revision: 1, sourceTime: 10, sourceEnd: 12, cueId: 8, timed: true, text: 'Next.' });
  assert.ok(h.updates.some(m => m.payload.queue?.pending === 2)); assert.ok(h.updates.every(m => !m.payload.buffer));
  release(); await tick(); await tick(); await tick();
  const parts = h.updates.filter(m => m.payload.format === 'motion133').map(m => m.payload);
  assert.equal(parts.length, 3); assert.equal(parts[0].sourceTime, 5); assert.equal(parts[0].sourceEnd, 7.5);
  assert.equal(parts[1].sourceTime, 7.5); assert.equal(parts[1].sourceEnd, 10); assert.equal(parts[1].partCount, 2);
  assert.equal(parts[0].cueId, 7); assert.equal(parts[2].cueId, 8); assert.equal(h.audioCaptureCalls, 0);
  assert.ok(parts.every(part => part.inputSource === 'player-response'), 'Every split part carries the source that produced it.');
});

test('AI video mode routes each captured phrase to frame generation and preserves its WebM contract', async t => {
  const routes = [];
  const h = harness(async (url, options) => {
    routes.push(url);
    assert.equal(options.headers.Authorization, 'Bearer test');
    return Response.json(url.endsWith('/api/transcribe') ? { text: 'Hello there.' } : { url: '/media/clip.webm', format: 'generated-video', mediaType: 'video/webm' });
  });
  t.after(() => h.dispatch({ type: 'stop' })); await h.start('frames');
  await h.dispatch({ type: 'playback', paused: true, ended: true, revision: 1, sourceTime: 2 });
  await tick(); await tick();
  assert.deepEqual(routes, ['http://localhost/api/transcribe', 'http://localhost/api/framegen']);
  const result = h.updates.find(message => message.payload.format === 'generated-video').payload;
  assert.equal(result.mediaType, 'video/webm'); assert.equal(result.url, 'http://localhost/media/clip.webm');
  assert.equal(result.segmentId, 1); assert.match(result.status, /unverified/);
  assert.equal(result.inputSource, 'tab-audio');
});

test('media relay errors fail the segment instead of silently counting an unplayed clip as complete', async t => {
  const h = harness(async () => Response.json({ url: '/media/clip.webm', format: 'generated-video', mediaType: 'video/webm' }),
    message => message.payload.format === 'generated-video' ? { ok: false, error: 'Clip download failed.' } : { ok: true });
  t.after(() => h.dispatch({ type: 'stop' })); await h.start('frames', 'captions');
  await h.dispatch({ type: 'caption', captureId: 'session', revision: 1, text: 'Hello.', sourceTime: 0 });
  await tick(); await tick();
  const failure = h.updates.find(message => message.payload.error)?.payload;
  assert.match(failure.error, /Clip download failed/); assert.equal(failure.queue.failed, 1); assert.equal(failure.queue.completed, 0);
});
test('offscreen keeps busy audio and flushes the short final recording at video end', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); const received = [];
  const h = harness(async (url, options) => { const body = await options.body.text(); received.push(body); if (received.length === 1) await gate; return Response.json({ text: body, seconds: 0.1 }); });
  t.after(() => h.dispatch({ type: 'stop' })); await h.start();
  h.records[0].stop(); await tick(); h.records[1].stop(); await tick();
  assert.ok(h.updates.some(message => message.payload.queue?.captured === 2 && message.payload.buffer));
  await h.dispatch({ type: 'playback', paused: true, ended: true, revision: 1, sourceTime: 16.2 }); await tick();
  release(); await tick(); await tick();
  assert.deepEqual(received, ['audio-0', 'audio-1', 'audio-2']);
  const final = h.updates.findLast(message => message.payload.drained)?.payload;
  assert.equal(final.queue.completed, 3); assert.equal(final.queue.captured, 3);
});
test('pause preserves a partial recording and resumes with a fresh complete WebM', async t => {
  const received = []; const h = harness(async (url, options) => { received.push(await options.body.text()); return Response.json({ text: 'Speech', seconds: 0.1 }); });
  t.after(() => h.dispatch({ type: 'stop' })); await h.start();
  await h.dispatch({ type: 'playback', paused: true, revision: 1, sourceTime: 2 }); await tick();
  assert.equal(received.length, 1); assert.equal(h.records.length, 1);
  await h.dispatch({ type: 'playback', paused: false, revision: 1, sourceTime: 2 });
  await h.dispatch({ type: 'playback', paused: true, ended: true, revision: 1, sourceTime: 3 }); await tick();
  assert.deepEqual(received, ['audio-0', 'audio-1']);
});
test('seek rejects stale in-flight text and discards only the explicitly canceled recording', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = harness(async (url, options) => { const body = await options.body.text(); if (body === 'audio-0') await gate; return Response.json({ text: body, seconds: 0.1 }); });
  t.after(() => h.dispatch({ type: 'stop' })); await h.start(); h.records[0].stop(); await tick();
  await h.dispatch({ type: 'playback', paused: true, reset: true, revision: 2, sourceTime: 50 }); await tick();
  await h.dispatch({ type: 'playback', paused: false, revision: 2, sourceTime: 50 });
  await h.dispatch({ type: 'playback', paused: true, ended: true, revision: 2, sourceTime: 51 }); await tick();
  release(); await tick(); await tick();
  const texts = h.updates.filter(m => m.revision === 2 && m.payload.text).map(m => m.payload.text);
  assert.deepEqual(texts, ['audio-2']);
});
