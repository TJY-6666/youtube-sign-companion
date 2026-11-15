import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const base = 'http://127.0.0.1:4318';
const nativeResponse = process.argv.includes('--native-response');
const motionHealth = await (await fetch(base + '/api/health')).json();
assert.equal(motionHealth.motionReady, true, 'Resident model must be ready.');
const profile = await mkdtemp(path.resolve('output/timed-caption-extension-'));
const cachedChrome = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright/chromium-1228/chrome-win64/chrome.exe');
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_EXECUTABLE || (existsSync(cachedChrome) ? cachedChrome : chromium.executablePath()), headless: true,
  viewport: { width: 1440, height: 960 }, args: [`--disable-extensions-except=${path.resolve('extension')}`, `--load-extension=${path.resolve('extension')}`],
});
const source = (await readFile('tests/fixtures/timeline.mp4')).toString('base64');
const errors = []; let captionFetches = 0;
try {
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.route('https://www.youtube.com/**', route => {
    if (new URL(route.request().url()).pathname === '/api/timedtext') {
      captionFetches++;
      if (nativeResponse && !new URL(route.request().url()).searchParams.has('native')) return route.fulfill({ contentType: 'application/json', body: '' });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ events: [
        { tStartMs: 0, dDurationMs: 1800, segs: [{ utf8: 'Hello there.' }] },
        { tStartMs: 1800, dDurationMs: 2000, segs: [{ utf8: 'Please open the book.' }] },
        { tStartMs: 4000, dDurationMs: 1700, segs: [{ utf8: 'Thank you.' }] },
      ] }) });
    }
    return route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': "require-trusted-types-for 'script'" }, body: `<!doctype html><html lang="en"><title>Timed caption integration fixture</title><body style="background:#111;color:white;font:18px system-ui"><h1>Timed caption fixture · synthetic source</h1><div id="movie_player"><video muted controls width="640" src="data:video/mp4;base64,${source}"></video>${nativeResponse ? '<span class="ytp-caption-segment">Hello there.</span>' : ''}</div><script>window.ytInitialPlayerResponse={videoDetails:{videoId:'timedtest01'},captions:{playerCaptionsTracklistRenderer:{captionTracks:[{languageCode:'en',baseUrl:'https://www.youtube.com/api/timedtext?v=timedtest01'}]}}};</script></body></html>` });
  });
  await page.goto('https://www.youtube.com/watch?v=timedtest01');
  await page.waitForFunction(() => document.querySelector('#sign-companion-root') === null);
  await page.waitForTimeout(1500);
  assert.equal(captionFetches, 1, 'Fetch begins on entering the video, before opening the panel or starting generation.');
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(async () => { const tabs = await chrome.tabs.query({}); await chrome.tabs.sendMessage(tabs.at(-1).id, { type: 'companion.open' }); });
  const panel = page.locator('#sign-companion-root');
  await panel.locator('#debug').evaluate(node => { node.open = true; });
  await panel.locator('#extra-options').evaluate(node => { node.open = true; });
  await panel.locator('#caption-track').filter({ hasText: nativeResponse ? 'Full captions unavailable' : '3 timed segments loaded' }).waitFor();
  assert.equal(await panel.locator('#start').textContent(), '开始实时翻译');
  assert.equal(await panel.locator('#usage-mode, #phrases, #demo, #sample, #visual').count(), 0);
  if (nativeResponse) assert.match(await panel.locator('#source-reason').textContent(), /empty caption track/);
  await panel.locator('#consent').check();
  assert.equal(await page.locator('#movie_player video').evaluate(video => video.paused), true);
  if (nativeResponse) await page.locator('#movie_player video').evaluate(video => video.play());
  await panel.locator('#start').click();
  if (nativeResponse) {
    await page.locator('#movie_player video').evaluate(video => video.pause());
    await page.evaluate(() => fetch('/api/timedtext?v=timedtest01&lang=en&native=1').then(response => response.text()));
  }
  await panel.locator('#mode').filter({ hasText: 'Timed captions' }).waitFor().catch(async error => {
    console.error('Caption startup state:', await panel.locator('#status, #workflow-message, #availability, #mode, #caption-track').allTextContents());
    await mkdir('output/screenshots', { recursive: true });
    await page.screenshot({ path: 'output/screenshots/timed-caption-start-failed.png' });
    throw error;
  });
  if (nativeResponse) await page.locator('.ytp-caption-segment').evaluate(node => node.remove());
  await panel.locator('#transcript').filter({ hasText: 'Hello there.' }).waitFor({ timeout: 120000 });
  await panel.locator('#queue').filter({ hasText: '3/3' }).waitFor({ timeout: 120000 });
  assert.equal(await panel.locator('#transcript').textContent(), 'Hello there.', 'Future prepared segments wait for their timestamps.');
  const shownPath = await panel.locator('#processing-path').textContent();
  assert.match(shownPath, nativeResponse ? /YouTube player caption response/ : /YouTube caption file/);
  assert.match(shownPath, motionHealth.motionPoseProfile === 'experimental-inverse' ? /shown clip.*RoboSTAR \+ sign-token hints → experimental pose correction → Avatar/ : /shown clip.*RoboSTAR \+ sign-token hints → approximate joint mapping → Avatar/);
  assert.equal(await panel.locator('#source-reason').isHidden(), true);
  const pausedTime = await page.locator('#movie_player video').evaluate(video => video.currentTime);
  const avatar = page.frameLocator('#sign-companion-root >> iframe');
  if (motionHealth.motionPoseProfile === 'experimental-inverse') await avatar.getByText('姿态实验 · 手语含义未核验', { exact: true }).waitFor();
  await avatar.locator('canvas').evaluate(() => { window.__clock = []; window.addEventListener('message', event => { if (event.data?.action === 'sync') window.__clock.push(event.data.progress); }); });
  await page.waitForTimeout(600);
  assert.ok(await avatar.locator('canvas').evaluate((_, progress) => window.__clock.length > 0 && window.__clock.every(value => Math.abs(value - progress) < .001), pausedTime / 1.8), 'Paused video holds the Avatar clock.');
  await page.locator('#movie_player video').evaluate(video => video.play());
  await panel.locator('#transcript').filter({ hasText: 'Please open the book.' }).waitFor();
  const secondTime = await page.locator('#movie_player video').evaluate(video => video.currentTime);
  assert.ok(secondTime >= 1.8 && secondTime < 3.8, `Second segment appeared at ${secondTime}.`);
  await page.locator('#movie_player video').evaluate(video => video.pause());
  await mkdir('output/screenshots', { recursive: true });
  await panel.locator('.body').evaluate(node => { node.scrollTop = 0; });
  await panel.screenshot({ path: `output/screenshots/companion-timed-captions${nativeResponse ? '-native' : ''}.png` });
  assert.ok(await avatar.locator('canvas').evaluate(() => window.__clock.some(value => value > 0)), 'Avatar receives video-clock progress.');
  await page.locator('#movie_player video').evaluate(video => { video.currentTime = 4.2; });
  await panel.locator('#transcript').filter({ hasText: 'Thank you.' }).waitFor({ timeout: 120000 });
  assert.equal(await page.locator('#movie_player video').evaluate(video => video.paused), true, 'A user seek while paused does not resume playback.');
  await panel.locator('#stop').click();
  assert.equal(await panel.locator('#replay').isEnabled(), true);
  assert.equal(await panel.locator('#processing-path').textContent(), shownPath, 'Review keeps the actual clip provenance.');
  assert.deepEqual(errors, []);
  const result = { passed: true, scope: 'Real MV3 MAIN-world caption bridge, timed JSON3 fixture, actual resident RoboSTAR and actual Avatar. This is not a live YouTube caption-availability or ASL accuracy test.', nativeResponse, checks: [nativeResponse ? 'Empty direct response falls back; a later native player response upgrades the active session automatically' : 'Full captions fetched before panel open with no visible CC needed', 'Three upcoming segments generated while paused', 'Future results wait for their source timestamps', 'Displayed path identifies the real caption source, prompt hints and approximate mapping', 'Avatar follows the video clock and holds on pause', 'Seek discards old work and loads the new timestamp without resuming a manual pause', 'Stop permits replay and retains clip provenance'], captionFetches, secondTime, shownPath, paidGeneration: false };
  await writeFile(`output/timed-caption${nativeResponse ? '-native' : ''}-report.json`, JSON.stringify(result, null, 2) + '\n');
  console.log('PASS: early full-caption fetch → rolling preparation → video-clock Avatar, including pause and seek.');
} finally { await context.close(); }
