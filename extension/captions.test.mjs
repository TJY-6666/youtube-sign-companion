import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('./captions.js', import.meta.url), 'utf8');
function buffer() { const scope = {}; vm.runInNewContext(source, scope); return new scope.CompanionCaptions.CaptionBuffer(); }
function api() { const scope = {}; vm.runInNewContext(source, scope); return scope.CompanionCaptions; }

test('timed captions group ahead without dropping words and retain bounded non-overlapping intervals', () => {
  const { captionSegments, segmentAt } = api();
  const segments = captionSegments([{ start: 2, end: 6, text: 'the book.' }, { start: 0, end: 4, text: 'Please open' }, { start: 8, end: 9, text: 'Thank you.' }]);
  assert.equal(segments.map(s => s.text).join(' '), 'Please open the book. Thank you.');
  assert.equal(segments[0].sourceTime, 0); assert.equal(segments[0].sourceEnd, 6);
  assert.equal(segmentAt(segments, 0).text, 'Please open the book.'); assert.equal(segmentAt(segments, 6), null);
  assert.equal(segmentAt(segments, 8).text, 'Thank you.');
  assert.ok(segments.every(s => s.text.length <= 280 && s.text.split(' ').length <= 30));
});

test('long captions split within model limits and same-time lines combine', () => {
  const { captionSegments } = api();
  const text = Array.from({ length: 92 }, (_, i) => `word${i}`).join(' ');
  const parts = captionSegments([{ start: 0, end: 15, text }]);
  assert.equal(parts.map(p => p.text).join(' '), text); assert.ok(parts.length > 2);
  for (let i = 0; i < parts.length - 1; i++) assert.ok(parts[i].sourceEnd <= parts[i + 1].sourceTime);
  assert.equal(captionSegments([{ start: 0, end: 3, text: 'Hello' }, { start: 0, end: 4, text: 'world.' }])[0].text, 'Hello world.');
  assert.equal(captionSegments([{ start: 0, end: 1, text: 'x'.repeat(275) }])[0].text.length, 275);
});

test('timed caption trust boundary rejects malformed, unbounded or empty input', () => {
  const { validateCues, captionSegments } = api();
  for (const cues of [[], null, [{ text: 'x', start: 1, end: 0 }], [{ text: 'x', start: NaN, end: 2 }], [{ text: 'x'.repeat(4001), start: 0, end: 1 }], [{ text: '', start: 0, end: 1 }]]) assert.throws(() => validateCues(cues));
  assert.throws(() => captionSegments([{ start: 0, end: 1, text: 'x'.repeat(281) }]), /limit/);
});

test('rolling captions preserve new words without retranslating growing or scrolling lines', () => {
  const b = buffer();
  b.push('Today we', 5, 0); b.push('Today we learn', 5.2, 200); b.push('we learn about plants.', 5.5, 500);
  assert.equal(b.due(500), true);
  const value = b.take(); assert.equal(value.text, 'Today we learn about plants.'); assert.equal(value.sourceTime, 5);
  b.push('we learn about plants.', 6, 1000); assert.equal(b.take(), null);
  b.push('about plants. Next lesson', 6.5, 1500); assert.equal(b.take().text, 'Next lesson');
});

test('caption buffer flushes short tails and seek reset removes old text', () => {
  const b = buffer(); b.push('Please open', 2, 0); assert.equal(b.due(500), false); assert.equal(b.due(1200), true);
  b.reset(); assert.equal(b.take(), null); b.push('Please open', 50, 2000); assert.equal(b.take().sourceTime, 50);
  b.push('', 51, 2100); b.push('Please open', 52, 2200); assert.equal(b.take().text, 'Please open');
});

test('caption buffer rejects unbounded or malformed page input', () => {
  const b = buffer(); for (const [text, time] of [[null, 0], ['x'.repeat(4001), 0], ['Hello', NaN]]) assert.throws(() => b.push(text, time, 0));
});
