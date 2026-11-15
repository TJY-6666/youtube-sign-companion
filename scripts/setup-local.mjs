import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
let source;
try { source = await readFile('.env.local', 'utf8'); } catch { source = ''; }
if (!/^APP_TOKEN=\S+/m.test(source)) {
  const line = `APP_TOKEN=${randomBytes(32).toString('hex')}`;
  source = /^APP_TOKEN=.*$/m.test(source) ? source.replace(/^APP_TOKEN=.*$/m, line) : `${source}\n${line}\n`;
}
if (!/^ENABLE_GENERATION=/m.test(source)) source += 'ENABLE_GENERATION=0\n';
if (!/^MAX_GENERATIONS=/m.test(source)) source += 'MAX_GENERATIONS=3\n';
await writeFile('.env.local', source);
const token = source.match(/^APP_TOKEN=(.*)$/m)[1].trim();
await mkdir('output', { recursive: true });
await mkdir('extension', { recursive: true });
await writeFile('extension/connection.local.json', `${JSON.stringify({ backend: 'http://127.0.0.1:4318', appToken: token }, null, 2)}\n`);
await writeFile('output/extension-connection.txt', `Backend URL: http://127.0.0.1:4318\nApp connection token (paste in the extension popup):\n${token}\n\nKeep this file local. This is NOT your SignStream secret.\nPaid API generation defaults to disabled. Existing explicit settings are preserved.\n`);
console.log('Local development connection configured for the unpacked extension. Private details were not printed.');
