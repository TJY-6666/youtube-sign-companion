import { validateMotion } from '/avatar/motion.js';

const $ = id => document.getElementById(id);
const frame = $('avatar');
let ready = false, avatarReady = false, busy = false, lastClip = null, paused = false, ended = false, request = null, serial = 0;
const words = value => value.trim() ? value.trim().split(/\s+/u).length : 0;

function status(message, error = false) { $('status').textContent = message; $('status').dataset.error = String(error); }
function controls() {
  const count = words($('caption').value);
  $('word-count').textContent = `${count} / 40 words`;
  $('generate').disabled = busy || !ready || !avatarReady || !count || count > 40 || !$('token').value.trim() || !$('consent').checked;
  $('generate').textContent = busy ? 'Generating motion…' : 'Generate motion';
  $('cancel').hidden = !busy;
  $('pause').disabled = !lastClip || busy || ended;
  $('replay').disabled = !lastClip || busy;
}
function tell(action, extra = {}) { frame.contentWindow.postMessage({ target: 'companion.avatar', action, ...extra }, location.origin); }

async function refresh() {
  try {
    const response = await fetch('/api/health', { signal: AbortSignal.timeout(8000), cache: 'no-store' });
    if (!response.ok) throw new Error('The backend health check failed.');
    const health = await response.json();
    ready = health.motionReady === true;
    $('connection').textContent = ready ? 'Motion model ready · experimental' : 'Motion model unavailable';
    $('connection').dataset.ready = String(ready);
    if (!ready && !busy) status('The model is not ready. Select Check connection after the project owner starts it.', true);
  } catch {
    ready = false; $('connection').textContent = 'Backend unavailable'; $('connection').dataset.ready = 'false';
    if (!busy) status('Cannot reach the backend. Check the server, then select Check connection.', true);
  }
  controls();
}

window.addEventListener('message', event => {
  if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== 'companion.avatar') return;
  if (event.data.ready) { avatarReady = true; controls(); }
  if (event.data.error) { avatarReady = false; status('The Avatar could not display the motion. Refresh the page to try again.', true); controls(); }
  if (event.data.ended === serial && lastClip && !busy) { paused = false; ended = true; controls(); status('Motion finished. Replay it or enter another sentence. ASL meaning is unverified.'); }
});
for (const id of ['caption', 'token', 'consent']) $(id).addEventListener('input', controls);
$('refresh').onclick = refresh;
$('caption-form').addEventListener('submit', async event => {
  event.preventDefault();
  controls();
  if ($('generate').disabled) return;
  const text = $('caption').value.trim();
  const controller = new AbortController();
  request = controller; busy = true; controls();
  tell('reset'); lastClip = null; $('shown-caption').textContent = 'Waiting for this request.';
  status('Sending this sentence to the model…');
  const timeout = setTimeout(() => controller.abort('timeout'), 180000), started = performance.now();
  try {
    const response = await fetch('/api/motion', { method: 'POST', headers: { Authorization: `Bearer ${$('token').value.trim()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: controller.signal });
    if (!response.ok) {
      if (response.status === 401) throw new Error('Access token not accepted. Ask the project owner for the demo app token.');
      if (response.status === 429) throw new Error('The model is processing another segment. Wait for it to finish, then try again.');
      if (response.status === 503) throw new Error('The motion model is not ready. Check connection and try again.');
      throw new Error(`Motion generation failed (HTTP ${response.status}). Check the backend logs before retrying.`);
    }
    const clip = validateMotion(await response.json());
    if (controller.signal.aborted || request !== controller) return;
    if (clip.handPose !== 'smplx-absolute' || clip.text !== text) throw new Error('The result does not match this request or the expected hand convention.');
    lastClip = clip; paused = false; ended = false; serial++;
    $('shown-caption').textContent = clip.text;
    $('latency').textContent = `${((performance.now() - started) / 1000).toFixed(2)} s`;
    $('duration').textContent = `${(clip.frames.length / clip.fps).toFixed(2)} s · ${clip.frames.length} frames`;
    $('provenance').textContent = `Your sentence → RoboSTAR → ${clip.poseProfile === 'experimental-inverse' ? 'experimental pose correction' : 'approximate mapping'} → Avatar`;
    $('pause').textContent = 'Pause';
    tell('load', { clip, serial });
    status('Playing actual model output. Handshape and ASL meaning have not been verified.');
  } catch (error) {
    if (controller.signal.aborted) status(controller.signal.reason === 'timeout' ? 'The request timed out. Check the model logs before retrying.' : 'Request cancelled. The server may still be finishing the current inference.', controller.signal.reason === 'timeout');
    else status(error.message, true);
  } finally {
    clearTimeout(timeout);
    if (request === controller) { request = null; busy = false; controls(); }
  }
});
$('cancel').onclick = () => request?.abort('cancel');
$('pause').onclick = () => { paused = !paused; tell(paused ? 'pause' : 'resume'); $('pause').textContent = paused ? 'Resume' : 'Pause'; status(paused ? 'Playback paused.' : 'Playing actual model output.'); };
$('replay').onclick = () => { if (!lastClip) return; paused = false; ended = false; $('pause').textContent = 'Pause'; controls(); tell('replay'); status('Replaying the last generated result. No new inference request.'); };
window.addEventListener('pagehide', () => request?.abort('leave'));
void refresh();
setInterval(() => { if (!document.hidden && !busy) void refresh(); }, 15000);
