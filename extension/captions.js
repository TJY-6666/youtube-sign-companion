// Rolling on-screen captions repeat words as the line grows and scrolls.
(() => {
  class CaptionBuffer {
    constructor() { this.reset(); }
    reset() { this.previous = []; this.pending = []; this.since = null; this.sourceTime = 0; }
    push(text, sourceTime, now) {
      if (typeof text !== 'string' || text.length > 4000 || !Number.isFinite(sourceTime)) throw new Error('Caption input is invalid or too large.');
      const words = text.trim().split(/\s+/u).filter(Boolean);
      if (!words.length) { this.previous = []; return; }
      const before = this.previous.map(word => word.toLowerCase()), after = words.map(word => word.toLowerCase());
      let overlap = Math.min(before.length, after.length);
      while (overlap && !before.slice(-overlap).every((word, index) => word === after[index])) overlap--;
      const added = words.slice(overlap); this.previous = words;
      if (!added.length) return;
      if (this.since === null) { this.since = now; this.sourceTime = sourceTime; }
      this.pending.push(...added);
      if (this.pending.join(' ').length > 4000) throw new Error('Caption buffer is full. Stop and restart instead of silently dropping text.');
    }
    due(now) { return this.pending.length && (this.pending.length >= 12 || /[.!?]$/u.test(this.pending.at(-1)) || now - this.since >= 1200); }
    take() {
      if (!this.pending.length) return null;
      const value = { text: this.pending.join(' '), sourceTime: this.sourceTime };
      this.pending = []; this.since = null; return value;
    }
  }
  function validateCues(cues) {
    if (!Array.isArray(cues) || !cues.length || cues.length > 30000) throw new Error('No usable timed captions returned.');
    let size = 0;
    const result = cues.map(cue => {
      if (typeof cue.text !== 'string' || cue.text.length > 4000 || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start || cue.end > 86400) throw new Error('Invalid timed caption.');
      const text = cue.text.replace(/\s+/gu, ' ').trim(); size += text.length;
      if (size > 2000000) throw new Error('Timed caption track is too large.');
      return { text, start: cue.start, end: cue.end };
    }).filter(cue => cue.text).sort((a, b) => a.start - b.start);
    if (!result.length) throw new Error('No usable timed captions returned.');
    return result;
  }
  function captionSegments(cues) {
    const ordered = [];
    for (const cue of validateCues(cues)) {
      const last = ordered.at(-1);
      if (last?.start === cue.start) { if (last.text !== cue.text) last.text += ' ' + cue.text; last.end = Math.max(last.end, cue.end); }
      else ordered.push({ ...cue });
    }
    for (let i = 0; i < ordered.length - 1; i++) ordered[i].end = Math.min(ordered[i].end, ordered[i + 1].start);
    const segments = []; let current = null;
    for (const cue of ordered) {
      const words = cue.text.split(' '); let offset = 0;
      while (offset < words.length) {
        const part = []; let length = 0;
        while (offset + part.length < words.length && part.length < 30) {
          const word = words[offset + part.length];
          if (word.length > 280) throw new Error('Caption word exceeds the motion input limit.');
          if (part.length && length + word.length + 1 > 250) break;
          part.push(word); length += word.length + Number(part.length > 1);
        }
        const start = cue.start + (cue.end - cue.start) * offset / words.length;
        offset += part.length;
        const end = cue.start + (cue.end - cue.start) * offset / words.length, text = part.join(' ');
        if (current && (start > current.sourceEnd + .5 || end - current.sourceTime > 6 || (current.text + ' ' + text).length > 250 || (current.text + ' ' + text).split(' ').length > 30)) { segments.push(current); current = null; }
        if (!current) current = { text, sourceTime: start, sourceEnd: end };
        else { current.text += ' ' + text; current.sourceEnd = Math.max(current.sourceEnd, end); }
        if (/[.!?]$/u.test(text)) { segments.push(current); current = null; }
      }
    }
    if (current) segments.push(current);
    // Overlapping caption windows share time; each signing segment gets a non-overlapping slot.
    for (let i = 0; i < segments.length - 1; i++) {
      if (segments[i + 1].sourceTime <= segments[i].sourceTime) {
        throw new Error('Overlapping caption timestamps cannot be scheduled reliably.');
      }
      segments[i].sourceEnd = Math.min(segments[i].sourceEnd, segments[i + 1].sourceTime);
    }
    return segments.map((segment, cueId) => ({ ...segment, cueId }));
  }
  function segmentAt(segments, time) {
    let low = 0, high = segments.length - 1, found = -1;
    while (low <= high) { const middle = (low + high) >> 1; if (segments[middle].sourceTime <= time) { found = middle; low = middle + 1; } else high = middle - 1; }
    return found >= 0 && segments[found].sourceEnd > time ? segments[found] : null;
  }
  globalThis.CompanionCaptions = { CaptionBuffer, validateCues, captionSegments, segmentAt };
})();
