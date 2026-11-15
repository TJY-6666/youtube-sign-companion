import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createFrameGenerator, createRigRenderer, validateVideo } from './bridge.mjs';

const result = { format: 'generated-video', mediaType: 'video/webm', fps: 12, size: 384, frameCount: 12, duration: 1, renderSeconds: 2 };

test('rig renderer reuses its isolated browser across phrases and rejects foreign origins', async () => {
  let launches = 0, navigations = 0, captures = 0, closed = 0;
  const renderer = createRigRenderer({ env: {}, launchImpl: async () => {
    launches++; let connected = true;
    return { isConnected: () => connected, close: async () => { connected = false; closed++; }, newPage: async () => ({
      isClosed: () => false, goto: async () => { navigations++; }, waitForFunction: async () => {}, evaluate: async () => { captures++; return ['jpeg']; },
    }) };
  } });
  await renderer.capture({}, 'http://127.0.0.1:4318'); await renderer.capture({}, 'http://127.0.0.1:4318');
  assert.deepEqual([launches, navigations, captures], [1, 1, 2]);
  await assert.rejects(renderer.capture({}, 'https://foreign.example'), /loopback/);
  await renderer.close(); assert.equal(closed, 1);
});
function harness(captureImpl = async () => ['test-image']) {
  const child = new EventEmitter(); Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
  const requests = []; child.stdin.on('data', bytes => requests.push(JSON.parse(bytes.toString())));
  const worker = createFrameGenerator({ env: { ENABLE_FRAMEGEN: '1', FRAMEGEN_PYTHON: 'python' }, spawnImpl: () => child, captureImpl });
  return { child, requests, worker };
}

test('image generation stays off by default and rejects invalid video contracts', async () => {
  const worker = createFrameGenerator({ env: {}, spawnImpl() { assert.fail(); } });
  await assert.rejects(worker.generate({}, 'file', 'http://localhost'), /not configured/);
  assert.equal(validateVideo(result), result);
  for (const changes of [{ mediaType: 'text/html' }, { frameCount: 241 }, { fps: 20 }, { duration: NaN }, { duration: 2 }, { renderSeconds: -1 }]) assert.throws(() => validateVideo({ ...result, ...changes }));
  worker.close();
});

test('image bridge reserves the whole capture/generation job and ignores stale replies', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const { child, requests, worker } = harness(async () => { await gate; return ['test']; });
  child.stdout.write('{"type":"ready"}\n');
  const pending = worker.generate({}, '/cache/video.webm', 'http://localhost');
  assert.equal(worker.busy, true);
  await assert.rejects(worker.generate({}, 'other', 'http://localhost'), /busy/);
  release(); await new Promise(resolve => setImmediate(resolve));
  child.stdout.write(JSON.stringify({ id: 999, ...result }) + '\n'); assert.equal(worker.busy, true);
  child.stdout.write(JSON.stringify({ id: requests[0].id, ...result }) + '\n');
  assert.equal((await pending).mediaType, 'video/webm'); assert.equal(worker.busy, false);
  worker.close();
});

test('a worker crash fails the pending image request and clears readiness', async () => {
  const { child, worker } = harness(); child.stdout.write('{"type":"ready"}\n');
  const pending = worker.generate({}, 'video', 'http://localhost');
  await new Promise(resolve => setImmediate(resolve)); child.emit('exit', 3221225477);
  await assert.rejects(pending, /exited.*3221225477/);
  assert.equal(worker.ready, false); assert.equal(worker.busy, false); worker.close();
});

test('image worker waits for the motion model before allocating its GPU weights', async () => {
  let canStart = false, spawned = 0;
  const child = new EventEmitter(); Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
  const worker = createFrameGenerator({ env: { ENABLE_FRAMEGEN: '1', FRAMEGEN_PYTHON: 'python' }, waitForReady: () => canStart, spawnImpl: () => { spawned++; return child; } });
  assert.equal(spawned, 0); assert.match(worker.error, /Waiting for motion/);
  canStart = true; await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(spawned, 1); child.stdout.write('{"type":"ready"}\n'); assert.equal(worker.ready, true); worker.close();
});
