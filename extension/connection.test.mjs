import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('./connection.js', import.meta.url), 'utf8');
function settings(stored, response) {
  let saved, fetches = 0;
  const context = vm.createContext({
    chrome: { storage: { local: { get: async defaults => ({ ...defaults, ...stored }), set: async value => { saved = value; } } }, runtime: { getURL: value => `chrome-extension://test/${value}` } },
    fetch: async () => { fetches++; return response; },
  });
  vm.runInContext(source, context);
  return { get: () => vm.runInContext('getCompanionSettings()', context), saved: () => saved, fetches: () => fetches };
}
test('missing local token is bootstrapped without supplier secrets or user copying', async () => {
  const token = 'a'.repeat(64);
  const h = settings({}, Response.json({ backend: 'http://127.0.0.1:4318', appToken: token }));
  assert.equal((await h.get()).appToken, token);
  assert.equal(h.saved().appToken, token);
  assert.deepEqual(Object.keys(h.saved()).sort(), ['appToken', 'backend']);
});
test('existing settings and remote backends are never silently overwritten', async () => {
  for (const saved of [{ appToken: 'existing' }, { backend: 'https://example.org' }]) {
    const h = settings(saved);
    await h.get();
    assert.equal(h.fetches(), 0);
    assert.equal(h.saved(), undefined);
  }
});
test('distributed extension without private bootstrap stays unconfigured', async () => {
  const h = settings({}, new Response(null, { status: 404 }));
  assert.equal((await h.get()).appToken, '');
  assert.equal(h.saved(), undefined);
});
test('bootstrap cannot redirect the app token to a remote backend', async () => {
  const h = settings({}, Response.json({ backend: 'https://example.org', appToken: 'a'.repeat(64) }));
  assert.equal((await h.get()).appToken, '');
  assert.equal(h.saved(), undefined);
});
