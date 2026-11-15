import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createMotionGenerator, validateMotion } from './bridge.mjs';
import { JOINTS } from '../extension/avatar/motion.js';
const clip = () => ({ format: 'motion133', fps: 20, frames: [Array(133).fill(0)] });
test('motion is disabled by default without spawning a process or downloading weights', async () => {
  const generator = createMotionGenerator({ env: {}, spawnImpl() { assert.fail(); } });
  assert.equal(generator.ready, false); await assert.rejects(generator.generate('Hello'), /not configured/); generator.close();
});
test('motion contract maps 40 joint rotations plus jaw and rejects malformed/oversized output', () => {
  assert.equal(JOINTS.length, 41); assert.equal(JOINTS[10], 'L_Index1'); assert.equal(JOINTS[25], 'R_Index1'); assert.equal(JOINTS[40], 'Jaw');
  assert.equal(validateMotion(clip()).frames.length, 1);
  assert.equal(validateMotion({ ...clip(), handPose: 'smplx-absolute' }).handPose, 'smplx-absolute');
  assert.throws(() => validateMotion({ ...clip(), handPose: 'unknown' }), /Unknown hand pose/);
  assert.equal(validateMotion({ ...clip(), poseProfile: 'experimental-inverse' }).poseProfile, 'experimental-inverse');
  assert.throws(() => validateMotion({ ...clip(), poseProfile: 'unknown' }), /Unknown motion pose profile/);
  for (const bad of [{}, { ...clip(), fps: 30 }, { ...clip(), frames: [[NaN]] }, { ...clip(), frames: Array(401).fill(Array(133).fill(0)) }]) assert.throws(() => validateMotion(bad));
});
test('resident bridge gates readiness, serializes requests and validates worker output', async () => {
  const child = new EventEmitter(); Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { this.emit('exit'); } });
  const requests = [], diagnostics = []; child.stdin.on('data', bytes => requests.push(JSON.parse(bytes.toString())));
  const generator = createMotionGenerator({ env: { ENABLE_MOTION: '1', MOTION_PYTHON: 'python', MOTION_MODEL_DIR: '/models', MOTION_BASE_DIR: '/base' }, spawnImpl: () => child, onDiagnostic: text => diagnostics.push(text) });
  child.stderr.write('Model diagnostic'); assert.deepEqual(diagnostics, ['Model diagnostic']);
  await assert.rejects(generator.generate('Hello'), /warming up/);
  child.stdout.write(JSON.stringify({ type: 'ready', poseProfile: 'experimental-inverse' }) + '\n'); assert.equal(generator.ready, true);
  assert.equal(generator.poseProfile, 'experimental-inverse');
  const first = generator.generate('Hello'); assert.equal(generator.busy, true); await assert.rejects(generator.generate('Overlap'), /busy/);
  child.stdout.write(JSON.stringify({ id: requests[0].id, ...clip() }) + '\n'); assert.equal((await first).fps, 20);
  const malformed = generator.generate('Again'); child.stdout.write(JSON.stringify({ id: requests[1].id, format: 'wrong' }) + '\n');
  await assert.rejects(malformed, /Invalid motion133/); generator.close();
});

test('native worker failure during loading cannot remain stuck in warming-up state', async () => {
  const child = new EventEmitter(); Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
  const generator = createMotionGenerator({ env: { ENABLE_MOTION: '1', MOTION_PYTHON: 'python', MOTION_MODEL_DIR: '/models', MOTION_BASE_DIR: '/base' }, spawnImpl: () => child });
  child.emit('exit', 3221225477, null);
  assert.equal(generator.ready, false);
  await assert.rejects(generator.generate('Hello'), /exited.*3221225477/);
  assert.doesNotMatch(generator.error, /warming up/);
  generator.close();
});

test('missing base Python reports the runtime problem instead of suggesting a memory failure', async () => {
  const child = new EventEmitter(); Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
  const generator = createMotionGenerator({ env: { ENABLE_MOTION: '1', MOTION_PYTHON: 'python', MOTION_MODEL_DIR: '/models', MOTION_BASE_DIR: '/base' }, spawnImpl: () => child });
  child.stderr.write('No Python at a missing base interpreter path.'); child.emit('exit', 103, null);
  assert.match(generator.error, /Python runtime is missing/); assert.doesNotMatch(generator.error, /memory/);
  await assert.rejects(generator.generate('Hello'), /Python runtime is missing/); generator.close();
});
