let stream, context, recorder, timer, queue, options, epoch = 0, paused = false, finishing = false;
async function notify(payload, required = false) {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'companion.offscreen', captureId: options?.captureId, revision: options?.revision, payload });
    if (required && response?.ok === false) throw new Error(response.error || 'Generated clip could not reach the player.');
    return response;
  } catch (error) { if (required) throw error; }
}
async function releaseAudio() {
  clearTimeout(timer);
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  await context?.close().catch(() => {}); context = null;
}
async function stop() {
  epoch++; queue?.stop(); queue = null; clearTimeout(timer);
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  await releaseAudio(); recorder = null;
}
async function post(route, body, headers, signal) {
  // Wait for a canceled ASR/motion call to finish. Never retry paid generation.
  const deadline = Date.now() + 180000;
  while (true) {
    const response = await fetch(`${options.backend}${route}`, { method: 'POST', body,
      headers: { Authorization: `Bearer ${options.appToken}`, ...headers }, signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]) });
    const data = await response.json();
    if (response.status === 429 && route !== '/api/sign' && Date.now() < deadline) {
      await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(wait); reject(signal.reason); };
        const wait = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 750);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      continue;
    }
    if (!response.ok) throw new Error(data.error || `Backend returned HTTP ${response.status}.`);
    return data;
  }
}
function recordChunk() {
  if (!stream?.active || paused || finishing || recorder?.state === 'recording') return;
  const current = epoch, chunks = [], started = performance.now();
  const sourceTime = options.sourceTime || 0;
  const capture = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' }); recorder = capture;
  capture.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  capture.onerror = () => { void notify({ error: 'Tab audio recording failed. The video was not completely translated.' }); void stop(); };
  capture.onstop = () => {
    if (current !== epoch) return;
    clearTimeout(timer);
    if (recorder === capture) recorder = null;
    const duration = (performance.now() - started) / 1000;
    const blob = new Blob(chunks, { type: 'audio/webm' });
    try { if (blob.size) queue.push(blob, { sourceTime, duration, inputSource: 'tab-audio' }); }
    catch (error) { void notify({ error: error.message }); void stop(); return; }
    options.sourceTime = sourceTime + duration;
    if (finishing) { queue.finish(); void releaseAudio(); }
    else recordChunk();
  };
  capture.start(); timer = setTimeout(() => { if (capture.state === 'recording') capture.stop(); }, 4000);
}
function createQueue() {
  const sessionEpoch = epoch;
  return new CompanionPipeline.SegmentQueue({
    changed(state) {
      if (sessionEpoch !== epoch) return;
      const drained = state.finished && state.pending === 0 && !state.failed;
      void notify({ queue: state, buffer: !options.timed && state.pending >= 2, drained,
        ...(drained ? { status: `Input complete: ${state.completed} of ${state.captured} segments processed. Signing may still be playing.` } : {}) });
    },
    async process(job, signal) {
      if (job.inputMode !== 'captions') await notify({ status: `Transcribing segment ${job.id}…`, segmentId: job.id });
      const transcript = job.inputMode === 'captions' ? { text: job.value } : await post('/api/transcribe', job.value, { 'Content-Type': 'audio/webm' }, signal);
      if (signal.aborted) throw signal.reason;
      const text = transcript.text?.trim() || '';
      await notify({ text, segmentId: job.id, status: options.outputMode === 'transcribe' ? 'Audio test: transcript only. No sign translation is running.' : options.outputMode === 'frames' ? `Generating experimental AI video for segment ${job.id}…` : `Generating ASL for segment ${job.id}…` });
      if (options.outputMode === 'transcribe' || !text) return [];
      const parts = CompanionPipeline.splitText(text);
      let wordsDone = 0;
      const totalWords = text.split(/\s+/u).length;
      for (let index = 0; index < parts.length; index++) {
        const route = options.outputMode === 'frames' ? '/api/framegen' : options.outputMode === 'motion' ? '/api/motion' : '/api/sign';
        const signed = await post(route, JSON.stringify({ text: parts[index] }), { 'Content-Type': 'application/json' }, signal);
        if (signal.aborted || sessionEpoch !== epoch) return [];
        const partWords = parts[index].split(/\s+/u).length, span = job.timed ? job.sourceEnd - job.sourceTime : 0;
        await notify({ ...signed, text: parts[index], inputSource: job.inputSource, segmentId: job.id, part: index, partCount: parts.length,
          sourceTime: job.sourceTime + span * wordsDone / totalWords,
          ...(job.timed ? { timed: true, cueId: job.cueId, sourceEnd: job.sourceTime + span * (wordsDone + partWords) / totalWords } : {}),
          ...(signed.url ? { url: new URL(signed.url, `${options.backend}/`).href } : {}),
          status: options.outputMode === 'frames' ? 'AI video ready. Generated gestures are unverified; keep captions on.' : 'Segment ready. Experimental ASL; keep captions on.' }, true);
        wordsDone += partWords;
      }
      return [];
    },
    async result() {},
    failed(error, job, state) {
      void notify({ error: `${error.message} Segment ${job.id} failed; ${state.canceled} queued segments were not processed.`, queue: state });
      void releaseAudio();
    },
  });
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target !== 'offscreen') return;
  (async () => {
    if (message.type === 'stop') { await stop(); return; }
    if (message.type === 'caption') {
      if (options?.inputMode !== 'captions' || message.captureId !== options.captureId || message.revision !== options.revision) return;
      if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 4000 || !Number.isFinite(message.sourceTime)) throw new Error('Invalid caption input.');
      if (message.timed && (!options.timed || !Number.isFinite(message.sourceEnd) || message.sourceEnd <= message.sourceTime || !Number.isInteger(message.cueId))) throw new Error('Invalid timed caption interval.');
      queue.push(message.text, { inputMode: 'captions', inputSource: options.inputSource || (options.timed ? 'timed-captions' : 'visible-captions'), sourceTime: message.sourceTime, timed: message.timed === true, sourceEnd: message.sourceEnd, cueId: message.cueId });
      return;
    }
    if (message.type === 'playback') {
      paused = message.paused; finishing = Boolean(message.ended);
      if (message.reset) {
        epoch++; queue?.stop();
        if (recorder && recorder.state !== 'inactive') recorder.stop();
        recorder = null; finishing = false;
      }
      if (options) { options.revision = message.revision; options.sourceTime = message.sourceTime; }
      if (message.reset) queue = createQueue();
      clearTimeout(timer);
      if (paused || finishing) {
        if (recorder?.state === 'recording') recorder.stop();
        else if (finishing && !recorder && !options.timed) { queue?.finish(); await releaseAudio(); }
      } else recordChunk();
      return;
    }
    if (message.type === 'start') {
      await stop(); options = message; paused = false; finishing = false;
      if (message.inputMode !== 'captions') {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId } }, video: false });
        context = new AudioContext(); context.createMediaStreamSource(stream).connect(context.destination); await context.resume();
      }
      queue = createQueue(); recordChunk();
      await notify({ status: message.inputMode === 'captions' ? 'Reading visible YouTube captions. Tab audio is not being captured.' : message.outputMode === 'transcribe' ? 'Audio test running. Transcripts only; the sign model is not being used.' : 'Listening continuously. Video buffers when processing needs to catch up.' });
    }
  })().then(() => respond({ ok: true })).catch(async e => { await stop(); await notify({ error: e.message }); respond({ ok: false, error: e.message }); });
  return true;
});
