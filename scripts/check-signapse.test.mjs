import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkSignapse } from './check-signapse.mjs';

const env = { SIGNSTREAM_PUBLISHABLE_KEY: 'pk_test_example', SIGNSTREAM_SECRET_KEY: 'sk_test_example' };
const authResponse = () => Response.json({ access_token: 'mock-private-token', expires_in: 900 });

test('missing credentials make no network request', async () => {
  await assert.rejects(checkSignapse({ env: {}, fetchImpl: () => assert.fail('Unexpected network call') }), /Fill both/);
});

test('default mode only exchanges credentials as multipart and exposes no secrets', async () => {
  let calls = 0;
  const report = await checkSignapse({ env, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://token.api.production.signapsesolutions.com/token');
    assert.equal(options.body.get('client_id'), env.SIGNSTREAM_PUBLISHABLE_KEY);
    assert.equal(options.body.get('client_secret'), env.SIGNSTREAM_SECRET_KEY);
    assert.equal(options.body.get('grant_type'), 'client_credentials');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers, undefined);
    return authResponse();
  } });
  assert.equal(calls, 1);
  assert.equal(report.authenticated, true);
  assert.equal(report.generated, false);
  assert.doesNotMatch(JSON.stringify(report), /mock-private-token|sk_test_example/);
});

test('authentication failure blocks generation without exposing error-body secrets', async () => {
  let calls = 0;
  await assert.rejects(checkSignapse({ env, generate: true, fetchImpl: async () => {
    calls++;
    return new Response('sk_test_example', { status: 401 });
  } }), /^Error: Authentication failed \(HTTP 401\); no generation requested\.$/);
  assert.equal(calls, 1);
});

test('TLS failure stops before generation and keeps credentials out of diagnostics', async () => {
  let calls = 0;
  await assert.rejects(checkSignapse({ env, generate: true, fetchImpl: async () => {
    calls++;
    throw new TypeError('sk_test_example', { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } });
  } }), /^Error: Authentication TLS certificate verification failed\. Keep certificate verification enabled; no generation requested\.$/);
  assert.equal(calls, 1);
});

test('MP4 redirect uses explicit ASL settings and never forwards the token to media', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'signapse-smoke-'));
  const mp4 = Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
  let calls = 0;
  try {
    const report = await checkSignapse({ env, generate: true, outputDir: dir, fetchImpl: async (url, options) => {
      calls++;
      if (calls === 1) return authResponse();
      if (calls === 2) {
        assert.equal(url, 'https://ai.api.production.signapsesolutions.com/v2/generate');
        assert.equal(options.redirect, 'manual');
        assert.equal(options.headers.Authorization, 'Bearer mock-private-token');
        const body = JSON.parse(options.body);
        assert.equal(body.content.type, 'text');
        assert.equal(body.output.format, 'mp4');
        assert.equal(body.output.delivery.config.language, 'ASL');
        assert.equal(body.output.delivery.config.digitalSigner, 'MAX');
        assert.ok(body.context.application);
        return new Response(null, { status: 303, headers: { Location: 'https://cdn.example.test/asl.mp4?signature=example' } });
      }
      assert.equal(calls, 3);
      assert.equal(url, 'https://cdn.example.test/asl.mp4?signature=example');
      assert.equal(options.headers, undefined);
      return new Response(mp4, { headers: { 'Content-Type': 'video/mp4' } });
    } });
    assert.deepEqual(await readFile(report.videoPath), mp4);
    assert.equal(report.generated, true);
    const saved = await readFile(path.join(dir, 'result.json'), 'utf8');
    assert.doesNotMatch(saved, /mock-private-token|sk_test_example|signature=example/);
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('signapse-smoke-'));
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed generation is not retried', async () => {
  let calls = 0;
  await assert.rejects(checkSignapse({ env, generate: true, fetchImpl: async () => {
    calls++;
    return calls === 1 ? authResponse() : new Response(null, { status: 402 });
  } }), /HTTP 402.*No retry/);
  assert.equal(calls, 2);
});
