import test from 'node:test';
import assert from 'node:assert/strict';
import './pipeline.js';
const { SegmentQueue, splitText } = globalThis.CompanionPipeline;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('slow processing queues every segment and drains the final tail in order', async () => {
  const first = deferred(), results = [], states = [];
  const queue = new SegmentQueue({ process: async job => { if (job.id === 1) await first.promise; return job.value; },
    result: async (value, job) => results.push([job.id, value]), changed: state => states.push(state) });
  queue.push('first'); queue.push('second'); queue.push('tail'); queue.finish();
  assert.equal(queue.state.pending, 3); assert.equal(queue.state.captured, 3);
  first.resolve(); await tick();
  assert.deepEqual(results, [[1, 'first'], [2, 'second'], [3, 'tail']]);
  assert.deepEqual(queue.state, { captured: 3, completed: 3, failed: 0, canceled: 0, pending: 0, finished: true, closed: false });
  assert.ok(states.some(state => state.pending >= 2));
});
test('seek invalidates in-flight results without preventing the new queue from processing', async () => {
  const old = deferred(), results = [];
  const queue = new SegmentQueue({ process: job => job.value === 'old' ? old.promise : job.value, result: async value => results.push(value) });
  queue.push('old'); queue.push('old pending'); queue.reset(); queue.push('new'); await tick();
  old.resolve('stale'); await tick();
  assert.deepEqual(results, ['new']); assert.equal(queue.state.canceled, 2); assert.equal(queue.state.completed, 1);
});
test('failure names the failed segment and accounts for unprocessed segments', async () => {
  const gate = deferred(); let failure;
  const queue = new SegmentQueue({ process: async () => { await gate.promise; throw new Error('Unavailable'); }, result: () => assert.fail(), failed: (e, job, state) => { failure = { id: job.id, ...state }; } });
  queue.push('first'); queue.push('second'); queue.push('third'); gate.resolve(); await tick();
  assert.equal(failure.id, 1); assert.equal(failure.failed, 1); assert.equal(failure.canceled, 2); assert.equal(failure.closed, true);
  assert.throws(() => queue.push('after failure'), /no longer/);
});
test('bounded queues fail explicitly rather than silently discarding audio', async () => {
  const gate = deferred(); const queue = new SegmentQueue({ process: () => gate.promise, result() {}, maxPending: 2 });
  queue.push('one'); queue.push('two'); assert.throws(() => queue.push('three'), /buffer is full/);
  queue.stop(); gate.resolve(); await tick(); assert.equal(queue.state.canceled, 2);
});
test('transcript splitting preserves every word within per-request limits', () => {
  const text = 'Hello, world. ' + Array.from({ length: 86 }, (_, i) => `word${i}`).join(' ');
  const parts = splitText(text);
  assert.equal(parts.join(' '), text); assert.ok(parts.every(p => p.length <= 280 && p.split(' ').length <= 35));
  assert.deepEqual(splitText('  '), []); assert.throws(() => splitText('a'.repeat(281)), /exceeds/);
});
