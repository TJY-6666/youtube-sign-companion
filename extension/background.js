importScripts('connection.js');
let activeTabId = null;
let captureId = null, revision = 0;
const publicMotionAssets = new Set(['avatar/phrases/library.json', 'avatar/demo/timeline.json',
  ...Array.from({ length: 20 }, (_, index) => `avatar/demo/part-${String(index).padStart(2, '0')}.json`)]);
async function loadVideo(url, settings, expectedType = 'video/mp4') {
  if (new URL(url).origin !== new URL(settings.backend).origin) throw new Error('Video must come from the connected backend.');
  const response = await fetch(url, { headers: { Authorization: `Bearer ${settings.appToken}` }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Could not load the signed clip from the backend.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 20 * 1024 * 1024) throw new Error('Signed clip exceeds the prototype playback limit.');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return { mediaBase64: btoa(binary), mediaType: expectedType === 'video/webm' ? 'video/webm' : 'video/mp4' };
}
const tellTab = async (message, tabId = activeTabId) => { if (tabId != null) await chrome.tabs.sendMessage(tabId, message).catch(() => {}); };
async function stopCapture() {
  captureId = null; revision++;
  if ((await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length) await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
  activeTabId = null;
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target === 'offscreen') return;
  (async () => {
    if (message.type === 'companion.offscreen') {
      if (sender.tab) return;
      if (!captureId || message.captureId !== captureId || message.revision !== revision) return { ok: true };
      const expectedCapture = captureId, expectedRevision = revision, target = activeTabId;
      const payload = { ...message.payload };
      if (payload.url) { Object.assign(payload, await loadVideo(payload.url, await getCompanionSettings(), payload.mediaType)); delete payload.url; }
      if (captureId === expectedCapture && revision === expectedRevision) await tellTab({ type: 'companion.update', ...payload }, target);
      return { ok: true };
    }
    if (!sender.tab || !sender.tab.url?.startsWith('https://www.youtube.com/watch?')) throw new Error('Use a normal YouTube watch page.');
    if (message.type === 'companion.asset') {
      const assetPath = message.path;
      if (!publicMotionAssets.has(assetPath)) throw new Error('Only bundled public motion data can be loaded.');
      const response = await fetch(chrome.runtime.getURL(assetPath));
      if (!response.ok) throw new Error('Bundled motion data is missing. Reload the extension and refresh YouTube.');
      return { ok: true, asset: await response.json() };
    }
    const settings = await getCompanionSettings();
    if (message.type === 'companion.health') {
      const response = await fetch(`${settings.backend}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Backend health check failed.');
      return { ok: true, health: await response.json() };
    }
    if (message.type === 'companion.sample') {
      if (sender.tab.id === activeTabId) await stopCapture();
      const response = await fetch(`${settings.backend}/api/sample`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Sample unavailable. Start the local backend first.');
      const sample = await response.json();
      return { ok: true, ...sample, url: undefined, ...await loadVideo(new URL(sample.url, `${settings.backend}/`).href, settings) };
    }
    if (message.type === 'companion.start') {
      if (!settings.appToken) throw new Error('Save the app connection token in the extension settings first.');
      const inputMode = message.inputMode === 'captions' ? 'captions' : 'audio';
      const timed = inputMode === 'captions' && message.timed === true;
      const inputSource = inputMode === 'audio' ? 'tab-audio' : !timed ? 'visible-captions'
        : ['caption-file', 'player-response'].includes(message.inputSource) ? message.inputSource : 'timed-captions';
      const outputMode = ['frames', 'motion', 'transcribe'].includes(message.outputMode) ? message.outputMode : 'video';
      const response = await fetch(`${settings.backend}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Backend health check failed. No input was started.');
      const health = await response.json();
      if (outputMode === 'motion' && !health.motionReady) throw new Error((health.motionStatus || 'Sign model is not ready. Restart the backend and wait for the model.') + ' No input was started.');
      if (outputMode === 'frames' && !health.framegenReady) throw new Error((health.framegenStatus || 'AI video model is not ready.') + ' No input was started.');
      if (outputMode === 'video' && (!health.signapseConfigured || !health.generationEnabled)) throw new Error('Paid signing is disabled. No input was started.');
      if (inputMode === 'audio' && !health.transcriptionReady) throw new Error('Audio transcription is not ready. Enable captions or wait for the speech model.');
      if (activeTabId != null && activeTabId !== sender.tab.id) await tellTab({ type: 'companion.update', error: 'Live translation moved to another tab.' });
      await stopCapture();
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (!contexts.length) await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: inputMode === 'captions' ? ['WORKERS'] : ['USER_MEDIA'], justification: 'Process user-started caption or audio segments in order.' });
      const streamId = inputMode === 'audio' ? await chrome.tabCapture.getMediaStreamId({ targetTabId: sender.tab.id }) : undefined;
      activeTabId = sender.tab.id;
      captureId = crypto.randomUUID();
      const started = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', inputMode, inputSource, streamId, captureId, revision, ...settings,
        outputMode, timed, sourceTime: Number(message.sourceTime) || 0 });
      if (!started?.ok) { activeTabId = null; throw new Error(started?.error || 'Audio capture could not start.'); }
      return { ok: true, captureId, revision };
    }
    if (message.type === 'companion.caption') {
      if (sender.tab.id !== activeTabId || message.captureId !== captureId || message.revision !== revision) return { ok: true, ignored: true };
      if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 4000 || !Number.isFinite(message.sourceTime) || message.sourceTime < 0) throw new Error('Invalid caption input.');
      if (message.timed && (!Number.isFinite(message.sourceEnd) || message.sourceEnd <= message.sourceTime || message.sourceEnd > 86400 || !Number.isInteger(message.cueId) || message.cueId < 0)) throw new Error('Invalid timed caption interval.');
      const result = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'caption', captureId, revision, text: message.text, sourceTime: message.sourceTime,
        timed: message.timed === true, sourceEnd: message.sourceEnd, cueId: message.cueId });
      if (!result?.ok) throw new Error(result?.error || 'Caption processing did not respond.');
      return { ok: true };
    }
    if (message.type === 'companion.stop') { if (sender.tab.id === activeTabId) await stopCapture(); return { ok: true }; }
    if (message.type === 'companion.playback') {
      if (sender.tab.id === activeTabId) {
        if (message.reset) revision++;
        await chrome.runtime.sendMessage({ target: 'offscreen', type: 'playback', paused: message.paused, reset: message.reset, ended: message.ended, sourceTime: message.sourceTime, revision });
      }
      return { ok: true, captureId, revision };
    }
    throw new Error('Unsupported request.');
  })().then(respond).catch(e => respond({ ok: false, error: e.message === 'Failed to fetch' ? 'Cannot reach the backend. Start it and check the extension connection settings.' : e.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(id => { if (id === activeTabId) void stopCapture(); });
