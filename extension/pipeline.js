// Loaded by the offscreen document and the Node regression harness.
(() => {
  function splitText(text) {
    const parts = []; let part = '';
    for (const word of text.trim().split(/\s+/u).filter(Boolean)) {
      if (word.length > 280) throw new Error('A transcript word exceeds the model input limit. Stop and inspect the transcript.');
      if (part && (part.length + word.length + 1 > 280 || part.split(' ').length >= 35)) { parts.push(part); part = ''; }
      part += (part ? ' ' : '') + word;
      if (/[.!?]$/u.test(word)) { parts.push(part); part = ''; }
    }
    if (part) parts.push(part);
    return parts;
  }
  class SegmentQueue {
    constructor({ process, result, changed = () => {}, failed = () => {}, maxPending = 8 }) {
      Object.assign(this, { process, result, changed, failed, maxPending });
      this.jobs = []; this.active = null; this.serial = 0; this.epoch = 0;
      this.counts = { captured: 0, completed: 0, failed: 0, canceled: 0 }; this.finished = false; this.closed = false;
    }
    get state() { return { ...this.counts, pending: this.jobs.length + Number(Boolean(this.active)), finished: this.finished, closed: this.closed }; }
    push(value, metadata = {}) {
      if (this.closed || this.finished) throw new Error('Audio session is no longer accepting segments.');
      if (this.state.pending >= this.maxPending) throw new Error('Audio buffer is full. Capture stopped without silently skipping content.');
      const job = { ...metadata, id: ++this.serial, value };
      this.jobs.push(job); this.counts.captured++; this.changed(this.state); void this.drain(); return job.id;
    }
    finish() { this.finished = true; this.changed(this.state); }
    reset() {
      this.epoch++; this.controller?.abort();
      this.counts.canceled += this.jobs.length + Number(Boolean(this.active));
      this.jobs = []; this.active = null; this.finished = false; this.closed = false;
      this.changed(this.state);
    }
    stop() { this.reset(); this.closed = true; this.changed(this.state); }
    async drain() {
      if (this.active || this.closed) return;
      const epoch = this.epoch;
      while (this.jobs.length && !this.closed && epoch === this.epoch) {
        const job = this.jobs.shift(); this.active = job; this.controller = new AbortController(); this.changed(this.state);
        try {
          const output = await this.process(job, this.controller.signal);
          if (epoch !== this.epoch) return;
          await this.result(output, job);
          if (epoch !== this.epoch) return;
          this.counts.completed++;
        } catch (error) {
          if (epoch !== this.epoch) return;
          this.counts.failed++; this.active = null;
          this.counts.canceled += this.jobs.length; this.jobs = []; this.closed = true;
          this.changed(this.state); this.failed(error, job, this.state); return;
        }
        this.active = null; this.changed(this.state);
      }
    }
  }
  globalThis.CompanionPipeline = { SegmentQueue, splitText };
})();
