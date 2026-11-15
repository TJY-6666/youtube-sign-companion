import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../server/index.mjs';

const output = path.resolve('output/submission');
await mkdir(path.join(output, 'screenshots'), { recursive: true });
await mkdir('public/downloads', { recursive: true });
await copyFile('output/youtube-sign-companion-extension.zip', 'public/downloads/youtube-sign-companion-extension.zip');
const upstream = 'http://127.0.0.1:4318';
const health = await (await fetch(upstream + '/api/health')).json();
assert.equal(health.motionReady, true, 'Start the existing resident motion model first; this check never loads a second copy.');
const privateEnv = await readFile('.env.local', 'utf8');
const upstreamToken = privateEnv.match(/^APP_TOKEN=(.*)$/m)?.[1].trim().replace(/^['"]|['"]$/g, '');
assert.ok(upstreamToken, 'Local app token missing.');
const appToken = 'submission-browser-test-token';
const calls = [];
const motionGenerator = {
  ready: true, poseProfile: health.motionPoseProfile,
  async generate(text) {
    const response = await fetch(upstream + '/api/motion', { method: 'POST', headers: { Authorization: `Bearer ${upstreamToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(180000) });
    const result = await response.json();
    assert.equal(response.status, 200, 'The real resident model request must succeed.');
    calls.push({ text, frames: result.frames?.length, fps: result.fps, poseProfile: result.poseProfile, seconds: result.seconds, accuracyReviewed: result.accuracyReviewed });
    return result;
  },
};
const app = createApp({ env: { HOST: '127.0.0.1', PORT: '4324', APP_TOKEN: appToken, ENABLE_MOTION: '1' }, motionGenerator });
app.server.listen(4324, '127.0.0.1'); await once(app.server, 'listening');
const base = 'http://127.0.0.1:4324';
const cachedChrome = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright/chromium-1228/chrome-win64/chrome.exe');
const executablePath = process.env.CHROME_EXECUTABLE || (existsSync(cachedChrome) ? cachedChrome : chromium.executablePath());
const browser = await chromium.launch({ executablePath, headless: true });
const errors = [];
let currentPage;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(); currentPage = page; page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message));
  console.log('Checking workspace readiness…');
  await page.goto(base + '/demo.html');
  await page.getByText('Motion model ready · experimental', { exact: true }).waitFor();
  await page.frameLocator('#avatar').getByText('Avatar 待机 · 请在上方开始翻译', { exact: true }).waitFor();
  console.log('Avatar ready; checking consent and rejected token…');
  assert.equal(await page.locator('#generate').isEnabled(), false);
  await page.locator('#caption').fill('Please open the book.');
  await page.locator('#token').fill('wrong-demo-token');
  assert.equal(await page.locator('#generate').isEnabled(), false, 'Consent is required.');
  await page.locator('#consent').check(); await page.locator('#generate').click();
  await page.locator('#status').filter({ hasText: 'Access token not accepted' }).waitFor();
  assert.equal(calls.length, 0, 'A rejected token must not reach the model.');
  console.log('Calling the existing real model…');
  await page.locator('#token').fill(appToken); await page.locator('#generate').click();
  await page.locator('#shown-caption').filter({ hasText: 'Please open the book.' }).waitFor({ timeout: 180000 });
  await page.locator('#status').filter({ hasText: 'Motion finished' }).waitFor();
  console.log('Actual model output played; checking replay and responsive states…');
  await page.screenshot({ path: path.join(output, 'screenshots/workspace-desktop.png'), fullPage: true });
  const count = calls.length;
  await page.locator('#replay').click(); await page.locator('#pause').click();
  assert.equal(await page.locator('#pause').textContent(), 'Resume');
  await page.waitForTimeout(300);
  await page.locator('#pause').click();
  await page.locator('#status').filter({ hasText: 'Motion finished' }).waitFor();
  assert.equal(calls.length, count, 'Replay and pause do not generate again.');
  await page.locator('#caption').fill(Array(41).fill('word').join(' '));
  assert.equal(await page.locator('#generate').isEnabled(), false, 'Model word limit enforced before a request.');
  await page.locator('#caption').fill('Please open the book.');
  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No overflow at ${width}px`);
    await page.screenshot({ path: path.join(output, `screenshots/workspace-${width}.png`), fullPage: true });
  }
  const download = await context.request.get(base + '/downloads/youtube-sign-companion-extension.zip');
  assert.equal(download.status(), 200); assert.equal(download.headers()['content-type'], 'application/zip');
  assert.equal(Buffer.from(await download.body()).subarray(0, 4).toString('hex'), '504b0304');
  await page.route('**/api/health', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, motionReady: false }) }));
  await page.locator('#refresh').click();
  await page.locator('#connection').filter({ hasText: 'Motion model unavailable' }).waitFor();
  assert.equal(await page.locator('#generate').isEnabled(), false);
  await page.screenshot({ path: path.join(output, 'screenshots/workspace-model-unavailable.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();

  const recorded = await browser.newContext({ viewport: { width: 1440, height: 1000 }, recordVideo: { dir: path.join(output, 'raw-video'), size: { width: 1440, height: 1000 } } });
  console.log('Recording actual local model demonstration…');
  const demo = await recorded.newPage(); currentPage = demo; demo.setDefaultTimeout(30000); const video = demo.video();
  await demo.goto(base + '/demo.html');
  await demo.frameLocator('#avatar').getByText('Avatar 待机 · 请在上方开始翻译', { exact: true }).waitFor();
  await demo.evaluate(() => {
    const note = document.createElement('p'); note.textContent = 'Recorded locally · actual model inference · Vultr deployment pending · ASL unverified';
    note.style.cssText = 'margin:0;padding:10px 32px;background:#242424;color:#f5f5f5;font:13px system-ui';
    document.body.prepend(note);
  });
  await demo.waitForTimeout(1800);
  await demo.locator('#caption').fill('Please open the book.');
  await demo.locator('#token').fill(appToken);
  await demo.locator('#consent').check();
  await demo.waitForTimeout(1800); await demo.locator('#generate').click();
  await demo.locator('#status').filter({ hasText: 'Motion finished' }).waitFor({ timeout: 180000 });
  await demo.waitForTimeout(1800); await demo.locator('#replay').click(); await demo.locator('#pause').click();
  await demo.waitForTimeout(1800); await demo.locator('#pause').click();
  await demo.locator('#status').filter({ hasText: 'Motion finished' }).waitFor();
  await demo.locator('#caption').fill('Thank you.'); await demo.locator('#generate').click();
  await demo.locator('#status').filter({ hasText: 'Motion finished' }).waitFor({ timeout: 180000 });
  await demo.waitForTimeout(1800);
  await demo.locator('#youtube-heading').scrollIntoViewIfNeeded(); await demo.waitForTimeout(2200);
  await demo.goto(base + '/architecture.svg'); await demo.waitForTimeout(3200);
  await recorded.close();
  await video.saveAs(path.join(output, 'local-product-demo.webm'));
  const result = { passed: true, scope: 'Current public workspace and actual existing local RoboSTAR reached through an authenticated loopback test proxy. No second model loaded. No paid API. Recording is explicitly local; it does not prove Vultr deployment, live YouTube support, ASL accuracy or whole-video coverage.', checks: ['Missing consent blocks inference', 'Wrong token rejected before model execution', 'Actual sentence-to-motion response played in real WebGL Avatar', 'Pause/resume and replay issue no new model request', '40-word gate', 'Desktop/tablet/mobile screenshots and overflow', 'Download is a sanitized extension ZIP', 'Unready model blocks Start'], negativeStateFixture: 'Only the model-unavailable health state is simulated.', calls, browserErrors: errors };
  await writeFile(path.join(output, 'browser-check.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`PASS: submission workspace, real model, download, error states and local recording; ${calls.length} actual requests.`);
} catch (error) {
  if (currentPage && !currentPage.isClosed()) {
    await currentPage.screenshot({ path: path.join(output, 'screenshots/browser-check-failed.png'), fullPage: true }).catch(() => {});
    console.error((await currentPage.locator('body').innerText().catch(() => '')).replace(/submission-browser-test-token/g, '[test token]').slice(0, 2600));
  }
  throw error;
} finally { await browser.close(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); }
