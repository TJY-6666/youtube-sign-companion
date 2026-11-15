import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

test('local setup defaults paid generation off, keeps tokens private and preserves explicit settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sign-setup-'));
  try {
    const run = () => promisify(execFile)(process.execPath, [fileURLToPath(new URL('./setup-local.mjs', import.meta.url))], { cwd: directory });
    const first = await run();
    const env = await readFile(join(directory, '.env.local'), 'utf8');
    const token = env.match(/^APP_TOKEN=(.+)$/m)[1];
    assert.match(env, /^ENABLE_GENERATION=0$/m);
    assert.ok(token.length >= 32);
    assert.equal(first.stdout.includes(token), false);
    const connection = JSON.parse(await readFile(join(directory, 'extension/connection.local.json'), 'utf8'));
    assert.equal(connection.appToken, token);
    await writeFile(join(directory, '.env.local'), env.replace('ENABLE_GENERATION=0', 'ENABLE_GENERATION=1'));
    await run();
    const next = await readFile(join(directory, '.env.local'), 'utf8');
    assert.match(next, /^ENABLE_GENERATION=1$/m);
    assert.ok(next.includes(`APP_TOKEN=${token}`));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
