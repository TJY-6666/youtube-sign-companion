import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { createTranscriber } from './bridge.mjs';

test('missing Python degrades to unavailable without crashing the server', async () => {
  const asr = createTranscriber({ env: { ASR_PYTHON: 'signcompanion-python-not-installed-test' } });
  try {
    await setTimeout(100);
    assert.equal(asr.ready, false);
    assert.match(asr.error, /Could not start Python/);
    await assert.rejects(asr.transcribe(Buffer.from('data'), 'audio/webm'), /Could not start Python/);
  } finally { asr.close(); }
});

test('untrusted audio size and MIME are rejected before worker submission', async () => {
  const asr = createTranscriber({ env: { ASR_PYTHON: 'signcompanion-python-not-installed-test' } });
  try {
    await assert.rejects(asr.transcribe(Buffer.alloc(0), 'audio/webm'), /Audio must be/);
    await assert.rejects(asr.transcribe(Buffer.alloc(5 * 1024 * 1024 + 1), 'audio/webm'), /Audio must be/);
    await assert.rejects(asr.transcribe(Buffer.from('data'), 'text/html'), /Unsupported audio/);
  } finally { asr.close(); }
});
