import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMotion } from '../extension/avatar/motion.js';
export { validateMotion } from '../extension/avatar/motion.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function createMotionGenerator({ env = process.env, spawnImpl = spawn, onDiagnostic = () => {} } = {}) {
  let ready = false, poseProfile = null, error = 'Motion model is not configured. No weights have been downloaded.', child, pending, serial = 0, closed = false;
  const enabled = env.ENABLE_MOTION === '1';
  function fail(message) {
    ready = false; error = message;
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error(message)); pending = null; }
  }
  if (enabled && env.MOTION_PYTHON && env.MOTION_MODEL_DIR && env.MOTION_BASE_DIR) {
    error = 'Motion model is warming up.';
    child = spawnImpl(env.MOTION_PYTHON, ['-u', resolve(root, 'motion/worker.py')], {
      cwd: root, env: { ...env, PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.on('data', bytes => {
      const text = bytes.toString('utf8'); onDiagnostic(text);
      if (/No Python at/i.test(text)) fail('Motion Python runtime is missing. Restore Python 3.10 and restart the backend.');
    }); child.stdin.on('error', () => fail('Motion worker connection closed.'));
    createInterface({ input: child.stdout }).on('line', line => {
      let value; try { value = JSON.parse(line); } catch { return; }
      if (value.type === 'ready') {
        poseProfile = value.poseProfile ?? 'smplx-offsets';
        if (!['smplx-offsets', 'experimental-inverse'].includes(poseProfile)) { fail('Unknown motion worker pose profile.'); return; }
        ready = true; error = null; return;
      }
      if (value.type === 'error') { fail(value.error); return; }
      if (!pending || value.id !== pending.id) return;
      const task = pending; clearTimeout(task.timer); pending = null;
      if (value.error) task.reject(new Error(value.error));
      else { try { task.resolve(validateMotion(value)); } catch (e) { task.reject(e); } }
    });
    child.on('error', () => fail('Could not start the motion worker. Check the Python environment.'));
    child.on('exit', (code, signal) => {
      if (closed) return;
      const message = `Motion worker exited before completing the request (code ${code ?? signal ?? 'unknown'}). Check diagnostics and memory.`;
      onDiagnostic(message + '\n');
      fail(error && !error.includes('warming up') ? error : message);
    });
  } else if (enabled) error = 'Set MOTION_PYTHON, MOTION_MODEL_DIR and MOTION_BASE_DIR before enabling the model.';
  return {
    get ready() { return ready && !closed; }, get error() { return error; },
    get poseProfile() { return poseProfile; },
    get busy() { return Boolean(pending); },
    generate(text) {
      if (!ready || closed) return Promise.reject(new Error(error || 'Motion model is not ready.'));
      if (pending) return Promise.reject(new Error('Motion worker is busy.'));
      return new Promise((resolveTask, reject) => {
        const id = ++serial;
        const timer = setTimeout(() => { fail('Motion inference timed out. Restart the backend.'); child.kill(); }, 180000);
        pending = { id, resolve: resolveTask, reject, timer };
        child.stdin.write(JSON.stringify({ id, text }) + '\n');
      });
    },
    close() { closed = true; fail('Motion worker stopped.'); child?.stdin.end(); child?.kill(); },
  };
}
