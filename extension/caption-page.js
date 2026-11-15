// MAIN world: read only the current video's English captions. No app tokens enter this world.
(() => {
  if (window.__companionCaptionBridge) return;
  window.__companionCaptionBridge = true;
  let controller, cached;
  function captionUrl(value) {
    try {
      const url = new URL(typeof value === 'string' ? value : value?.url, location.href);
      return url.origin === location.origin && url.pathname === '/api/timedtext' && url.searchParams.get('v') === new URL(location.href).searchParams.get('v') && /^en(?:-|$)/i.test(url.searchParams.get('tlang') || url.searchParams.get('lang') || '') ? url : null;
    } catch { return null; }
  }
  function parseCaptions(body) {
    if (!body.trim() || body.length > 8000000) return [];
    if (body.trimStart().startsWith('<')) {
      const xml = new DOMParser().parseFromString(body, 'text/xml');
      return Array.from(xml.querySelectorAll('text[start],p[t]'), node => {
        const milliseconds = node.hasAttribute('t'), start = Number(node.getAttribute(milliseconds ? 't' : 'start')) / (milliseconds ? 1000 : 1);
        return { start, end: start + Number(node.getAttribute(milliseconds ? 'd' : 'dur') || (milliseconds ? 2000 : 2)) / (milliseconds ? 1000 : 1), text: node.textContent.trim() };
      }).filter(cue => cue.text);
    }
    const json = JSON.parse(body);
    return (json.events || []).filter(value => Array.isArray(value.segs) && value.dDurationMs > 0).map(value => ({
      start: value.tStartMs / 1000, end: (value.tStartMs + value.dDurationMs) / 1000,
      text: value.segs.map(segment => typeof segment.utf8 === 'string' ? segment.utf8 : '').join('').trim(),
    })).filter(value => value.text);
  }
  function received(url, body) {
    try {
      const cues = parseCaptions(body); if (!cues.length || cues.length > 30000) return;
      const videoId = url.searchParams.get('v'); if (videoId !== new URL(location.href).searchParams.get('v')) return;
      cached = { videoId, cues, inputSource: 'player-response' };
      window.postMessage({ type: 'companion.captions.available', ...cached }, location.origin);
    } catch { /* A failed/native empty response remains unavailable, never a fabricated transcript. */ }
  }
  // Observe only the player's own English timed-text responses. Keep its signed URL and headers in this page.
  const nativeFetch = window.fetch;
  if (nativeFetch) window.fetch = async function(...args) {
    const response = await nativeFetch.apply(this, args), url = captionUrl(args[0]);
    if (url && response.ok) void response.clone().text().then(body => received(url, body)).catch(() => {});
    return response;
  };
  if (window.XMLHttpRequest) {
    const nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, address, ...rest) {
      const url = captionUrl(address);
      if (url) this.addEventListener('load', () => {
        if (this.status === 200 && (!this.responseType || this.responseType === 'text')) received(url, this.responseText);
      }, { once: true });
      return nativeOpen.call(this, method, address, ...rest);
    };
  }
  addEventListener('message', async event => {
    const request = event.data;
    if (event.source !== window || event.origin !== location.origin || request?.type !== 'companion.captions.request' || typeof request.id !== 'string') return;
    if (location.hostname !== 'www.youtube.com' || new URL(location.href).searchParams.get('v') !== request.videoId) return;
    controller?.abort(); const active = controller = new AbortController();
    const reply = value => { if (!active.signal.aborted) window.postMessage({ type: 'companion.captions.result', id: request.id, videoId: request.videoId, ...value }, location.origin); };
    try {
      if (cached?.videoId === request.videoId) { reply({ cues: cached.cues, language: 'en', inputSource: cached.inputSource }); return; }
      let player;
      for (let attempt = 0; attempt < 20; attempt++) {
        if (active.signal.aborted) return;
        const candidate = document.getElementById('movie_player')?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
        if (candidate?.videoDetails?.videoId === request.videoId) { player = candidate; break; }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      const track = tracks.filter(value => /^en(?:-|$)/i.test(value.languageCode || '')).sort((a, b) => Number(a.kind === 'asr') - Number(b.kind === 'asr'))[0];
      if (!track) throw new Error('This video did not expose an English caption track.');
      const url = new URL(track.baseUrl);
      if (url.origin !== location.origin || url.pathname !== '/api/timedtext' || url.searchParams.get('v') !== request.videoId) throw new Error('Caption URL does not belong to this video.');
      url.searchParams.set('fmt', 'json3');
      const response = await nativeFetch(url, { credentials: 'same-origin', signal: AbortSignal.any([active.signal, AbortSignal.timeout(10000)]) });
      if (!response.ok) throw new Error(`YouTube captions returned HTTP ${response.status}.`);
      const body = await response.text();
      if (!body.trim()) throw new Error('YouTube returned an empty caption track.');
      if (body.length > 8000000) throw new Error('Caption track exceeds the local limit.');
      const cues = parseCaptions(body);
      if (!cues.length) throw new Error('YouTube returned no timed caption text.');
      reply({ cues, language: track.languageCode, inputSource: 'caption-file' });
    } catch (error) { reply({ error: error instanceof SyntaxError ? 'YouTube did not return JSON timed captions.' : error.message }); }
  });
})();
