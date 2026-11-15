import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const worker = resolve(root, 'transcription/worker.py');
const mimes = new Set(['audio/webm', 'video/webm', 'audio/wav', 'audio/x-wav', 'audio/ogg']);

export function createTranscriber({ env = process.env } = {}) {
  const localPython = resolve(root, process.platform === 'win32' ? '.venv-asr/Scripts/python.exe' : '.venv-asr/bin/python');
  const python = env.ASR_PYTHON || (existsSync(localPython) ? localPython : null);
  let ready = false, error = python ? 'Speech model is warming up' : 'Install transcription dependencies first', child, pending, serial = 0, closed = false;
  function fail(message) {
    ready = false;
    error = message;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      pending = null;
    }
  }
  function stopWorker() {
    if (child?.pid && child.exitCode === null && !child.killed) child.kill();
  }
  if (python) {
    child = spawn(python, ['-u', worker], { cwd: root, env: { ...env, PYTHONIOENCODING: 'utf-8' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    // Keep model-loader warnings off the API response; never log captured speech or credentials.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => fail('Speech worker connection closed'));
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let value;
      try { value = JSON.parse(line); } catch { return; }
      if (value.type === 'ready') { ready = true; error = null; return; }
      if (value.type === 'error') { fail(value.error); return; }
      if (!pending || value.id !== pending.id) return;
      clearTimeout(pending.timer);
      const task = pending;
      pending = null;
      if (value.error) task.reject(new Error(value.error));
      else if (typeof value.text === 'string' && typeof value.seconds === 'number') task.resolve({ text: value.text, seconds: value.seconds });
      else task.reject(new Error('Speech worker returned an invalid response'));
    });
    child.on('error', () => fail('Could not start Python speech worker'));
    child.on('exit', () => fail(closed ? 'Speech worker stopped' : 'Speech worker exited; check transcription setup'));
  }
  return {
    get ready() { return ready && !closed; },
    get error() { return error; },
    async transcribe(buffer, mime) {
      if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 5 * 1024 * 1024) throw new Error('Audio must be between 1 byte and 5 MiB');
      if (!mimes.has(String(mime).split(';')[0].trim().toLowerCase())) throw new Error('Unsupported audio type');
      if (!ready || closed) throw new Error(error || 'Speech model is not ready');
      if (pending) throw new Error('Speech worker is busy; wait for the current clip');
      return new Promise((resolveTask, reject) => {
        const id = ++serial;
        const timer = setTimeout(() => { fail('Speech recognition timed out; restart the backend'); stopWorker(); }, 90_000);
        pending = { id, resolve: resolveTask, reject, timer };
        child.stdin.write(JSON.stringify({ id, mime, audio: buffer.toString('base64') }) + '\n');
      });
    },
    close() { closed = true; fail('Speech worker stopped'); stopWorker(); },
  };
}
