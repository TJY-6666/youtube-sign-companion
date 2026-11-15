import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function validateVideo(value) {
  if (value?.format !== 'generated-video' || value.mediaType !== 'video/webm' || value.fps !== 12 || value.size !== 384 ||
      !Number.isInteger(value.frameCount) || value.frameCount < 1 || value.frameCount > 240 ||
      !Number.isFinite(value.duration) || Math.abs(value.duration - value.frameCount / 12) > 0.001 ||
      !Number.isFinite(value.renderSeconds) || value.renderSeconds < 0) throw new Error('Invalid generated-video response.');
  return value;
}

export function createRigRenderer({ env = process.env, launchImpl } = {}) {
  let browser, page, currentOrigin, idleTimer;
  async function close() { clearTimeout(idleTimer); const previous = browser; browser = page = currentOrigin = null; await previous?.close().catch(() => {}); }
  return {
    async capture(clip, origin) {
      if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new Error('Rig renderer accepts loopback only.');
      clearTimeout(idleTimer);
      try {
        if (!browser?.isConnected() || page?.isClosed()) {
          await close();
          const launch = launchImpl || (await import('playwright')).chromium.launch.bind((await import('playwright')).chromium);
          browser = await launch({ headless: true,
            ...(env.FRAMEGEN_BROWSER_EXECUTABLE ? { executablePath: env.FRAMEGEN_BROWSER_EXECUTABLE } : process.platform === 'win32' ? { channel: 'chrome' } : {}),
            // Synthetic rig rendering stays off CUDA so it does not compete with the two models.
            args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : [])],
          });
          page = await browser.newPage({ viewport: { width: 384, height: 384 }, deviceScaleFactor: 1 });
        }
        if (currentOrigin !== origin) {
          await page.goto(`${origin}/avatar/index.html?export=1`);
          await page.waitForFunction(() => typeof window.captureCompanionFrames === 'function');
          currentOrigin = origin;
        }
        const frames = await page.evaluate(clip => window.captureCompanionFrames(clip), clip);
        idleTimer = setTimeout(() => { void close(); }, 15000); idleTimer.unref();
        return frames;
      } catch (error) { await close(); throw error; }
    }, close,
  };
}

export function createFrameGenerator({ env = process.env, spawnImpl = spawn, captureImpl, onDiagnostic = () => {}, waitForReady = () => true } = {}) {
  const renderer = captureImpl ? null : createRigRenderer({ env });
  let ready = false, busy = false, closed = false, child, pending, serial = 0, startupTimer;
  let error = 'AI video is not configured.';
  function fail(message) {
    ready = false; error = message;
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error(message)); pending = null; }
  }
  function start() {
    error = 'AI video model is warming up.';
    child = spawnImpl(env.FRAMEGEN_PYTHON, ['-u', resolve(root, 'framegen/worker.py')], {
      cwd: root, env: { ...env, PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.on('data', bytes => onDiagnostic(bytes.toString('utf8')));
    child.stdin.on('error', () => fail('AI video worker connection closed.'));
    createInterface({ input: child.stdout }).on('line', line => {
      let value; try { value = JSON.parse(line); } catch { return; }
      if (value.type === 'ready') { ready = true; error = null; return; }
      if (value.type === 'error') { fail(value.error); return; }
      if (!pending || value.id !== pending.id) return;
      const task = pending; clearTimeout(task.timer); pending = null;
      if (value.error) task.reject(new Error(value.error));
      else { try { task.resolve(validateVideo(value)); } catch (e) { task.reject(e); } }
    });
    child.on('error', () => fail('Could not start the AI video worker.'));
    child.on('exit', code => { if (!closed) fail(`AI video worker exited (code ${code}). Check diagnostics and GPU memory.`); });
  }
  if (env.ENABLE_FRAMEGEN === '1' && env.FRAMEGEN_PYTHON) {
    if (waitForReady()) start();
    else {
      error = 'Waiting for motion model before loading AI video.';
      startupTimer = setInterval(() => { if (!closed && waitForReady()) { clearInterval(startupTimer); start(); } }, 250);
      startupTimer.unref();
    }
  }
  return {
    get ready() { return ready && !closed; }, get busy() { return busy; }, get error() { return error; },
    async generate(clip, output, origin) {
      if (!ready || closed) throw new Error(error || 'AI video is not ready.');
      if (busy) throw new Error('AI video worker is busy.');
      busy = true;
      try {
        const started = performance.now();
        let frames;
        try { frames = await (captureImpl ? captureImpl(clip, origin, env) : renderer.capture(clip, origin)); }
        catch (error) { onDiagnostic(`Rig capture failed: ${error.stack || error.message}\n`); throw new Error('Rig frame rendering failed. Check framegen-worker.log.'); }
        const sourceCaptureSeconds = (performance.now() - started) / 1000;
        if (!Array.isArray(frames) || frames.length < 1 || frames.length > 240 || frames.some(frame => typeof frame !== 'string' || frame.length > 256000)) throw new Error('Invalid source rig frames.');
        if (!ready || closed) throw new Error(error || 'AI video stopped.');
        const result = await new Promise((resolveTask, reject) => {
          const id = ++serial;
          const timer = setTimeout(() => { fail('AI video timed out. Restart the backend.'); child.kill(); }, 180000);
          pending = { id, resolve: resolveTask, reject, timer };
          child.stdin.write(JSON.stringify({ id, frames, output }) + '\n');
        });
        return { ...result, sourceCaptureSeconds };
      } finally { busy = false; }
    },
    close() { closed = true; clearInterval(startupTimer); fail('AI video worker stopped.'); child?.stdin.end(); child?.kill(); void renderer?.close(); },
  };
}
