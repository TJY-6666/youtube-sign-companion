import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('./caption-page.js', import.meta.url), 'utf8');
function bridge({ baseUrl = 'https://www.youtube.com/api/timedtext?v=testvideo01', language = 'en', body } = {}) {
  let listener; const replies = [], requests = [];
  const location = { href: 'https://www.youtube.com/watch?v=testvideo01', origin: 'https://www.youtube.com', hostname: 'www.youtube.com' };
  const window = { ytInitialPlayerResponse: { videoDetails: { videoId: 'testvideo01' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: language, baseUrl }] } } }, postMessage: value => replies.push(value) };
  const payload = body ?? JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Hello ' }, { utf8: 'there.' }] }] });
  window.fetch = async (url, options) => { requests.push({ url: String(url), options }); return new Response(payload); };
  class XHR {
    addEventListener(_, fn) { this.loaded = fn; }
    open() {}
    deliver() { this.status = 200; this.responseType = 'text'; this.responseText = payload; this.loaded?.(); }
  }
  window.XMLHttpRequest = XHR;
  vm.runInNewContext(source, { window, XMLHttpRequest: XHR, location, document: { getElementById: () => null }, URL, AbortController, AbortSignal, setTimeout, addEventListener: (_, fn) => { listener = fn; },
    fetch: (...args) => window.fetch(...args) });
  return { replies, requests, native: (...args) => window.fetch(...args), xhr: () => new XHR(), send: (changes = {}) => listener({ source: window, origin: location.origin, data: { type: 'companion.captions.request', id: 'request', videoId: 'testvideo01', ...changes } }) };
}
test('page bridge fetches the current English JSON3 track and returns only timed text', async () => {
  const h = bridge(); await h.send();
  assert.equal(h.requests.length, 1); assert.equal(new URL(h.requests[0].url).searchParams.get('fmt'), 'json3');
  assert.equal(h.requests[0].options.credentials, 'same-origin'); assert.equal(h.replies[0].cues[0].text, 'Hello there.');
  assert.equal(h.replies[0].cues[0].start, 1); assert.equal(h.replies[0].cues[0].end, 3); assert.equal(h.replies[0].baseUrl, undefined);
  assert.equal(h.replies[0].inputSource, 'caption-file');
  assert.equal(h.replies.some(value => value.type === 'companion.captions.available'), false, 'An extension fetch is not a native player response.');
});
test('caption bridge rejects foreign, mismatched, unavailable or empty caption tracks', async () => {
  for (const options of [{ baseUrl: 'https://elsewhere.test/api/timedtext?v=testvideo01' }, { baseUrl: 'https://www.youtube.com/api/timedtext?v=another' }, { language: 'fr' }, { body: '' }]) {
    const h = bridge(options); await h.send(); assert.ok(h.replies[0].error);
    if (!('body' in options)) assert.equal(h.requests.length, 0);
  }
});
test('page bridge ignores requests for another video', async () => {
  const h = bridge(); await h.send({ videoId: 'another' }); assert.equal(h.requests.length, 0); assert.equal(h.replies.length, 0);
});
test('native player fetch and XHR caption responses are reused without exposing signed URLs or extra fetches', async () => {
  for (const transport of ['fetch', 'xhr']) {
    const h = bridge(); const url = 'https://www.youtube.com/api/timedtext?v=testvideo01&lang=en&pot=page-only-value';
    if (transport === 'fetch') { const response = await h.native(url); await response.text(); await new Promise(resolve => setImmediate(resolve)); }
    else { const xhr = h.xhr(); xhr.open('GET', url); xhr.deliver(); }
    await h.send();
    assert.ok(h.replies.some(value => value.type === 'companion.captions.available'));
    assert.equal(h.requests.length, transport === 'fetch' ? 1 : 0, 'Cached native captions require no new request.');
    assert.ok(!JSON.stringify(h.replies).includes('page-only-value'));
    assert.equal(h.replies.at(-1).cues[0].text, 'Hello there.');
    assert.equal(h.replies.at(-1).inputSource, 'player-response');
    assert.equal(h.replies[0].inputSource, 'player-response');
  }
});
