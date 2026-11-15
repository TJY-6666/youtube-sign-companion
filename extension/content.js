(() => {
  if (globalThis.__signCompanion) return;
  globalThis.__signCompanion = true;
  const host = document.createElement('div');
  host.id = 'sign-companion-root';
  const root = host.attachShadow({ mode: 'open' });
  const template = `
  <style>
    :host{all:initial;position:fixed;right:24px;bottom:24px;z-index:2147483646;width:376px;max-width:calc(100vw - 32px);color-scheme:dark;font:14px/1.5 system-ui,-apple-system,sans-serif;color:#f5f5f5}
    *{box-sizing:border-box}section{background:#171717;border-radius:12px;overflow:hidden;box-shadow:0 10px 30px #0005} /* taste-skill-ignore: shadow belongs to the floating companion overlay. */
    header{display:flex;align-items:center;gap:12px;padding:14px 16px;background:#222}h2{font-size:17px;font-weight:600;margin:0;flex:1}button,select{font:inherit;color:inherit;min-height:40px;border:1px solid #707070;border-radius:6px;background:#2a2a2a;cursor:pointer;padding:8px 12px}button:hover{background:#393939}button:disabled{opacity:.5;cursor:not-allowed}button:focus-visible,select:focus-visible,input:focus-visible,.caption-copy:focus-visible{outline:3px solid #67dbc5;outline-offset:3px}
    header button{font-size:12px;padding:6px 9px;min-height:36px}.body{padding:16px}.scope{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;font-size:12px;color:#bdbdbd}.mode{color:#f5f5f5;font-weight:600}.stage{aspect-ratio:16/9;background:#080808;display:grid;place-items:center;position:relative;border-radius:4px;overflow:hidden}
    #status{margin:14px 0 8px;min-height:42px;color:#e5e5e5}.caption-comparison{background:#222;border-radius:4px;padding:12px;margin-top:12px}.caption-comparison dl{margin:0}.caption-comparison dt{font-size:12px;color:#bdbdbd;margin:0 0 4px}.caption-comparison dt:not(:first-child){margin-top:12px}.caption-copy{font-size:14px;line-height:1.5;margin:0;min-height:21px;max-height:63px;overflow:auto;overflow-wrap:anywhere;white-space:pre-wrap;scrollbar-width:thin}.caption-empty{color:#bdbdbd}.actions{display:flex;gap:8px;margin-top:12px}.actions button{flex:1}.primary{background:#f5f5f5;color:#171717;border-color:#f5f5f5;font-weight:600}.primary:hover{background:#ddd}.fine{color:#bdbdbd;font-size:12px;margin:12px 0 0}.consent{display:flex;gap:9px;font-size:12px;color:#ccc;align-items:flex-start;margin:14px 0}.consent input{margin:3px 0 0;min-width:16px;min-height:16px;accent-color:#cfcfcf}footer{display:flex;align-items:center;justify-content:space-between;margin-top:16px;gap:8px}footer button,select{font-size:12px;min-height:36px}.position-label{font-size:12px;color:#bdbdbd}.error{color:#ffb8b8!important}::selection{background:#b5f2e4;color:#111}
    @media(max-width:480px){:host{right:16px;bottom:16px;width:calc(100vw - 32px)}header{padding:12px}.body{padding:14px}}
    @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
  </style>
  <section aria-label="手语伴看">
    <header><h2>手语伴看</h2><button id="enlarge" aria-pressed="false">放大</button><button id="close" aria-label="关闭伴看并停止处理">关闭</button></header>
    <div class="body">
      <p id="mode-help" class="fine">实时英文字幕 → ASL Avatar · 实验版</p>
      <p id="availability" class="fine">正在检查手语模型…</p>
      <p id="quick-guide" class="fine">开启英文 CC → 同意处理 → 开始实时翻译</p>
      <label class="consent"><input id="consent" type="checkbox"><span id="consent-text">同意将本视频英文字幕发送到已配置的后端。</span></label>
      <div class="actions main-actions"><button id="start" class="primary" disabled>开始实时翻译</button><button id="stop" hidden>停止翻译</button></div>
      <p id="workflow-message" role="status" aria-live="polite">先开启视频的英文字幕（CC），再点击开始。</p>
      <div class="stage"><iframe id="avatar" title="手语 Avatar 与双手特写"></iframe></div>
      <p class="fine accuracy">模型仍会生成错误手语，尚不能作为可靠翻译。请保留原字幕。</p>
      <div class="caption-comparison" role="group" aria-label="原字幕与动作对照" aria-live="off"><dl>
        <dt id="source-caption-label">视频原字幕</dt><dd id="source-caption" class="caption-copy caption-empty" tabindex="0" aria-labelledby="source-caption-label">开启英文 CC 后显示原文。</dd>
        <dt id="avatar-text-label">当前动作对应内容</dt><dd id="transcript" class="caption-copy caption-empty" tabindex="0" aria-labelledby="avatar-text-label" aria-live="polite" aria-atomic="true">尚未开始。</dd>
      </dl></div>
      <details id="debug"><summary>输入来源与处理路径</summary>
        <div class="scope"><span class="mode" id="mode">ASL · experimental</span><span id="connection">Checking backend…</span></div>
        <p class="fine" id="input-source">Input: waiting for input.</p><p class="fine" id="caption-track">Checking timed captions…</p>
        <p class="fine" id="processing-path">Path: waiting for input.</p><p class="fine" id="source-reason" hidden></p>
        <p id="status">Ready to connect.</p><p id="queue" class="fine"></p><p class="fine" id="visual-note">ASL accuracy is unreviewed.</p>
      </details>
      <details id="extra-options"><summary>重播已生成动作</summary><button id="replay" disabled>重播上一段输出</button></details>
      <footer><span class="fine">ASL 原型 · v0.6.0</span><label class="position-label">面板位置 <select id="position"><option value="right">右侧</option><option value="left">左侧</option></select></label></footer>
    </div>
  </section>`;
  // Only the static template passes this policy; all remote text uses textContent.
  root.innerHTML = globalThis.trustedTypes ? trustedTypes.createPolicy('sign-companion-static', { createHTML: () => template }).createHTML('') : template;
  const $ = id => root.getElementById(id);
  let mode = 'idle', sourceVideo, health = {}, open = false, expanded = false, videoId = '', removed = false;
  let clips = [], playingClip = false, lastOutput = null, avatarReady = false, motionSerial = 0, autoBuffer = false, serverBuffer = false, drained = false, queueState = null;
  let activeSource = 'visible-captions', captionSession = null, captionTimer, starting = false;
  let captionTrack = { videoId: null, state: 'idle', segments: [] }, captionRequest, captionTimeout;
  let timedMode = false, timedIndex = 0, timelineEpoch = 0, timelineReset = false, pumping = false;
  const timedPending = new Set();
  const captionBuffer = new CompanionCaptions.CaptionBuffer();
  const avatarUrl = chrome.runtime.getURL ? chrome.runtime.getURL('avatar/index.html') : new URL('/avatar/index.html', location.href).href;
  $('avatar').src = avatarUrl;
  const avatarMessage = message => { if (avatarReady) $('avatar').contentWindow.postMessage({ target: 'companion.avatar', ...message }, new URL(avatarUrl).origin); };
  const css = document.createElement('style'); css.textContent = '[hidden]{display:none!important}.stage:has(iframe:not([hidden])){aspect-ratio:1}.stage iframe{border:0;width:100%;height:100%;position:absolute;inset:0}.body{max-height:calc(100dvh - 120px);overflow-y:auto;scrollbar-color:#707070 #222}#queue:empty{display:none}#mode-help{margin:8px 0 0}#availability{margin:4px 0 0;color:#d5e8e3}#quick-guide{margin:8px 0}summary{cursor:pointer;min-height:36px;display:list-item;padding:8px 0;font-size:12px;color:#d0d0d0}summary:focus-visible{outline:3px solid #67dbc5;outline-offset:2px}details{margin:6px 0}details p{overflow-wrap:anywhere}.main-actions{margin:8px 0}.main-actions button{min-height:44px;font-size:15px}#workflow-message{margin:8px 0 12px;min-height:42px;font-size:13px;color:#e5e5e5}#workflow-message.error{color:#ffb8b8}.accuracy{margin:8px 0 0;font-size:12px}.caption-comparison{margin:10px 0 6px}#debug .scope{margin-top:8px}#status{min-height:0}#extra-options button{margin:6px 0}footer .fine{margin:0}'; root.append(css);
  const rpc = async message => {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || 'The extension did not respond. Reload the page and try again.');
    return result;
  };
  function status(text, error = false) { if ($('status').textContent !== text) $('status').textContent = text; $('status').classList.toggle('error', error); updateWorkflow(); }
  function updateWorkflow() {
    const running = mode === 'live';
    const copy = (id, text) => { if ($(id).textContent !== text) $(id).textContent = text; };
    $('start').hidden = running; $('stop').hidden = !running;
    $('start').textContent = starting ? '正在启动…' : '开始实时翻译';
    copy('availability', outputReady() ? '手语模型已就绪 · 只读取字幕，不录制音频。' : '手语模型未就绪，请启动后端或检查扩展连接设置。');
    let message;
    if (!outputReady()) message = '先运行 Start-Companion.cmd；使用云端时，在扩展设置里填写后端地址和应用令牌。手语模型就绪后才能开始。';
    else if ($('status').classList.contains('error')) message = `处理失败：${$('status').textContent}`;
    else if (running && document.querySelector('#movie_player.ad-showing')) message = '广告期间暂停处理，正片开始后继续。';
    else if (starting) message = '正在连接字幕与手语模型…';
    else if (!hasCaptions()) message = '请开启视频英文 CC。没有英文字幕时无法开始，不会自动录音。';
    else if (running && autoBuffer) message = '正在生成当前字幕的动作，已暂时暂停视频；准备好后自动继续。';
    else if (running && timedMode) message = sourceVideo?.paused ? '已随视频暂停，后台继续准备后续字幕。' : '正在跟随视频播放，提前生成后续字幕的动作。';
    else if (running) message = '正在读取当前 CC 并生成动作。整份字幕暂不可用，因此会有处理延迟。';
    else if (!$('consent').checked) message = '勾选同意处理字幕，再点击“开始实时翻译”。';
    else message = '点击开始。整份字幕可用时提前生成；否则读取屏幕上的 CC。';
    copy('workflow-message', message);
    $('workflow-message').classList.toggle('error', !outputReady() || $('status').classList.contains('error'));
  }
  function captionText() { return Array.from(document.querySelectorAll('#movie_player .ytp-caption-segment'), node => node.textContent).join(' ').trim(); }
  function hasCaptions() { return captionTrack.state === 'ready' || Boolean(captionText() || document.querySelector('#movie_player .ytp-subtitles-button[aria-pressed="true"]')); }
  function showInputPath() {
    const sources = { 'caption-file': 'YouTube caption file', 'player-response': 'YouTube player caption response', 'timed-captions': 'Timed YouTube captions', 'visible-captions': 'Visible YouTube CC' };
    const source = lastOutput?.inputSource || (mode === 'live' ? activeSource : captionTrack.state === 'ready' ? captionTrack.inputSource : 'visible-captions');
    const name = sources[source] || 'Unreported caption input';
    const poseProfile = lastOutput ? lastOutput.poseProfile : health.motionPoseProfile;
    const renderer = `RoboSTAR${lastOutput?.retrievalUsed ? ' + sign-token hints' : lastOutput?.promptMode === 'official' ? ' (official prompt)' : ''} → ${poseProfile === 'experimental-inverse' ? 'experimental pose correction' : 'approximate joint mapping'} → Avatar`;
    $('input-source').textContent = `Input: ${name} · no audio capture`;
    $('processing-path').textContent = `Path${lastOutput ? ' (shown clip)' : mode === 'live' ? ' (active input)' : ' (after Start)'}: ${name} → ${renderer}`;
    const fallback = captionTrack.state === 'unavailable' ? captionTrack.error : '';
    $('source-reason').hidden = !fallback;
    $('source-reason').textContent = fallback ? `Full-caption fallback: ${fallback}. Reading visible CC only; no audio capture.` : '';
  }
  function showTrackState() {
    $('caption-track').textContent = captionTrack.state === 'ready'
      ? mode === 'live' && !timedMode ? 'Timed captions available. Stop and restart to preload signing.' : `${captionTrack.segments.length} timed segments loaded · ${timedMode ? 'generating up to 30s ahead' : 'prepares ahead after Start'}.`
      : captionTrack.state === 'loading' ? 'Loading full English captions…'
      : 'Full captions unavailable · enable English CC so YouTube can load its track. Visible-only input has delay.';
    $('caption-track').title = captionTrack.error || '';
    showInputPath();
  }
  function prefetchCaptions() {
    if (location.hostname !== 'www.youtube.com') { $('caption-track').textContent = 'Timed caption loading is available on YouTube.'; return; }
    const id = new URL(location.href).searchParams.get('v');
    if (id === captionTrack.videoId) return;
    if (mode === 'live') void stopLive('Video changed. Start again to sign the new video.');
    clearTimeout(captionTimeout); captionRequest = null;
    captionTrack = { videoId: id, state: id ? 'loading' : 'idle', segments: [] }; showTrackState();
    if (!id) return;
    captionRequest = crypto.randomUUID();
    window.postMessage({ type: 'companion.captions.request', id: captionRequest, videoId: id }, location.origin);
    captionTimeout = setTimeout(() => {
      if (captionTrack.videoId !== id || captionTrack.state !== 'loading') return;
      captionTrack.state = 'unavailable'; captionTrack.error = 'Timed caption request timed out.'; showTrackState();
    }, 22000);
  }
  window.addEventListener('message', event => {
    const message = event.data;
    const observed = message?.type === 'companion.captions.available';
    if (event.source !== window || event.origin !== location.origin || (!observed && (message?.type !== 'companion.captions.result' || message.id !== captionRequest)) || message.videoId !== captionTrack.videoId || message.videoId !== new URL(location.href).searchParams.get('v') || observed && captionTrack.state === 'ready') return;
    clearTimeout(captionTimeout);
    captionRequest = null;
    try {
      if (message.error) throw new Error(String(message.error).slice(0, 240));
      const cues = CompanionCaptions.validateCues(message.cues);
      captionTrack = { videoId: message.videoId, state: 'ready', inputSource: ['caption-file', 'player-response'].includes(message.inputSource) ? message.inputSource : 'timed-captions', cues, segments: CompanionCaptions.captionSegments(cues) };
    } catch (error) { captionTrack = { videoId: message.videoId, state: 'unavailable', segments: [], error: error.message }; }
    showTrackState(); if (open) { showSourceCaption(); updateStart(); }
    upgradeToTimed();
  });
  function upgradeToTimed() {
    // A native caption response can arrive before the initial Start RPC settles.
    if (starting || captionTrack.state !== 'ready' || mode !== 'live' || timedMode) return;
    const id = captionTrack.videoId;
    const stopped = stopLive('Full captions loaded. Switching to timed signing…'), switchEpoch = timelineEpoch;
    void stopped.then(() => { if (timelineEpoch === switchEpoch && captionTrack.videoId === id && open && !removed && $('consent').checked) return $('start').onclick(); });
  }
  function setCaptionText(id, text, empty) {
    const element = $(id), value = text || empty;
    if (element.textContent !== value) { element.textContent = value; element.scrollTop = 0; }
    element.classList.toggle('caption-empty', !text);
  }
  function showSourceCaption() {
    const cue = captionTrack.state === 'ready' ? CompanionCaptions.segmentAt(captionTrack.segments, sourceVideo?.currentTime || 0) : null;
    const text = sourceVideo?.seeking ? '' : captionText() || cue?.text || '';
    const empty = sourceVideo?.seeking ? '正在跳转，等待新字幕…' : hasCaptions() ? '等待当前字幕…' : '请开启 YouTube 英文字幕（CC）。';
    setCaptionText('source-caption', text, empty);
    return text;
  }
  async function flushCaptions() {
    const part = captionBuffer.take(), session = captionSession;
    if (!part || !session || mode !== 'live') return;
    try { await rpc({ type: 'companion.caption', ...session, ...part }); }
    catch (e) { if (mode === 'live' && session === captionSession) { await stopLive(e.message, { preserveMedia: true }); status(e.message, true); } }
  }
  function readCaptions(force = false) {
    if (mode !== 'live' || !captionSession || sourceVideo?.seeking || (!force && sourceVideo?.paused)) return;
    try {
      captionBuffer.push(showSourceCaption(), sourceVideo.currentTime, performance.now());
      if (captionBuffer.due(performance.now())) void flushCaptions();
    } catch (e) { void stopLive(e.message, { preserveMedia: true }); }
  }
  function outputReady() { return Boolean(health.motionReady); }
  function updateStart() {
    $('start').disabled = starting || mode === 'live' || !$('consent').checked || !hasCaptions() || !outputReady();
    $('consent').disabled = mode === 'live' || starting;
    $('visual-note').textContent = health.motionPoseProfile === 'experimental-inverse'
      ? 'Pose correction test. ASL meaning is unverified. Keep YouTube captions on.'
      : 'Live signing has processing delay and has not been reviewed by an ASL user. Keep YouTube captions on.';
    showInputPath(); updateWorkflow();
  }
  async function connect() {
    try {
      ({ health } = await rpc({ type: 'companion.health' }));
      $('connection').textContent = 'Backend connected';
      if (health.motionReady) status('Caption-to-Avatar model ready. ASL meaning is unverified.');
      else status((health.motionStatus || 'Sign model is not ready. Start the backend and wait for the motion model.') + ' No sign translation is running.', !/warming up/i.test(health.motionStatus || ''));
    } catch (e) { health = {}; $('connection').textContent = 'Backend offline'; status(e.message, true); updateStart(); return false; }
    updateStart(); return true;
  }
  function clearMedia() {
    clips = []; playingClip = false; lastOutput = null; motionSerial++; avatarMessage({ action: 'reset' });
    setCaptionText('transcript', '', '尚无对应动作。'); $('avatar-text-label').textContent = '当前动作对应内容';
    $('replay').disabled = true;
    showInputPath();
  }
  function showQueue() {
    if (timedMode && queueState) {
      const ahead = clips.filter(clip => clip.sourceEnd > (sourceVideo?.currentTime || 0) && clip !== lastOutput).length;
      $('queue').textContent = `${queueState.completed}/${queueState.captured} caption segments prepared · ${queueState.pending} generating · ${ahead} signed parts ready ahead`; return;
    }
    $('queue').textContent = queueState ? `${queueState.completed}/${queueState.captured} caption segments processed · ${queueState.pending} pending · ${clips.length} signed parts waiting${queueState.failed ? ` · ${queueState.failed} failed` : ''}${queueState.canceled ? ` · ${queueState.canceled} canceled` : ''}` : '';
  }
  function bufferPlayback() {
    showQueue();
    if (mode !== 'live' || !sourceVideo || sourceVideo.ended) return;
    const needed = serverBuffer || clips.length >= 2;
    if (needed && !sourceVideo.paused) { autoBuffer = true; sourceVideo.pause(); status('Buffering the original video so every captured segment can be processed.'); }
    else if (!needed && autoBuffer) { autoBuffer = false; void sourceVideo.play().catch(() => status('Processing caught up. Press Play on YouTube to continue.')); }
  }
  function nextClip() {
    playingClip = false;
    if (clips.length) { const next = clips.shift(); playClip(next, next.text); }
    else if (drained) status('Captured captions processed and signing playback finished. ASL accuracy is unverified.');
    bufferPlayback();
  }
  async function stopLive(message = 'Stopped. No new captions are being sent.', { preserveMedia = false } = {}) {
    const wasLive = mode === 'live'; mode = preserveMedia && lastOutput ? 'review' : 'idle';
    clearInterval(captionTimer); captionSession = null; captionBuffer.reset();
    timedMode = false; timelineEpoch++; timedPending.clear(); pumping = false; timelineReset = false;
    if (wasLive) await rpc({ type: 'companion.stop' }).catch(() => {});
    $('mode').textContent = preserveMedia && lastOutput ? 'Last generated clip' : 'ASL · experimental';
    clips = []; serverBuffer = false; queueState = null; $('queue').textContent = '';
    if (autoBuffer) { autoBuffer = false; void sourceVideo?.play().catch(() => {}); }
    if (!preserveMedia) clearMedia();
    $('replay').disabled = !lastOutput;
    $('connection').textContent = Object.keys(health).length ? 'Backend connected' : 'Backend offline';
    status(message); showTrackState(); updateStart();
  }
  function playClip(clip, text) {
    if (clip.format !== 'motion133') { void stopLive('The model returned no usable sign motion.', { preserveMedia: true }).then(() => status('Expected motion133 from the sign model; no placeholder was substituted.', true)); return; }
    lastOutput = clip; playingClip = true;
    showInputPath();
    setCaptionText('transcript', text, '这段动作没有附带文字。');
    motionSerial++; avatarMessage({ action: 'load', clip, serial: motionSerial, externalClock: Boolean(clip.timed), calibration: Boolean(clip.calibration) });
    if (mode === 'live' && sourceVideo?.paused && !autoBuffer && !sourceVideo.ended) avatarMessage({ action: 'pause' });
    $('replay').disabled = timedMode && mode === 'live';
  }
  async function playback(event) {
    if (mode !== 'live') return;
    if (sourceVideo.playbackRate !== 1) { await stopLive('Live mode supports 1× playback only. Change the video speed and restart.'); return; }
    const reset = event.type === 'seeking';
    if (timedMode) {
      if (reset) { clearMedia(); resetTimeline(); timelineReset = true; autoBuffer = false; }
      const epoch = timelineEpoch;
      const state = await rpc({ type: 'companion.playback', paused: sourceVideo.paused || sourceVideo.seeking, reset, ended: sourceVideo.ended, sourceTime: sourceVideo.currentTime }).catch(() => null);
      if (mode !== 'live' || !timedMode || epoch !== timelineEpoch) return;
      if (state?.captureId) captionSession = { captureId: state.captureId, revision: state.revision };
      if (reset) timelineReset = false;
      return;
    }
    if (reset) captionBuffer.reset();
    else if (sourceVideo.paused || sourceVideo.ended) { readCaptions(true); await flushCaptions(); }
    if (reset) clearMedia();
    if (reset) { drained = false; serverBuffer = false; autoBuffer = false; }
    const state = await rpc({ type: 'companion.playback', paused: sourceVideo.paused || sourceVideo.seeking, reset, ended: sourceVideo.ended, sourceTime: sourceVideo.currentTime }).catch(() => null);
    if (state?.captureId && mode === 'live') captionSession = { captureId: state.captureId, revision: state.revision };
    const hold = sourceVideo.paused && !autoBuffer && !sourceVideo.ended;
    if (hold) { avatarMessage({ action: 'pause' }); status('Paused with YouTube. Recorded segments remain queued.'); }
    else {
      avatarMessage({ action: 'resume' });
    }
    if (sourceVideo.ended) status('Video ended. Processing and playing the remaining captured input…');
    else if (event.type === 'play') status('Reading captions again. Signing follows after processing.');
  }
  function bindVideo() {
    const next = document.querySelector('#movie_player video') || document.querySelector('video');
    if (next === sourceVideo) return;
    if (sourceVideo) for (const name of ['pause', 'play', 'seeking', 'seeked', 'ended', 'ratechange']) sourceVideo.removeEventListener(name, playback);
    sourceVideo = next;
    if (next) for (const name of ['pause', 'play', 'seeking', 'seeked', 'ended', 'ratechange']) next.addEventListener(name, playback);
  }
  function resetTimeline() {
    timelineEpoch++; timedPending.clear(); pumping = false;
    timedIndex = captionTrack.segments.findIndex(segment => segment.sourceEnd > sourceVideo.currentTime);
    if (timedIndex < 0) timedIndex = captionTrack.segments.length;
  }
  async function pumpTimeline() {
    if (pumping || timelineReset || !captionSession || mode !== 'live' || !timedMode || sourceVideo?.seeking) return;
    pumping = true; const epoch = timelineEpoch;
    try {
      clips = clips.filter(clip => clip.sourceEnd > sourceVideo.currentTime || clip === lastOutput);
      while (epoch === timelineEpoch && timedPending.size < 3 && clips.length + timedPending.size < 8 && timedIndex < captionTrack.segments.length && captionTrack.segments[timedIndex].sourceTime <= sourceVideo.currentTime + 30) {
        const segment = captionTrack.segments[timedIndex++]; timedPending.add(segment.cueId);
        await rpc({ type: 'companion.caption', ...captionSession, ...segment, timed: true });
      }
    } catch (error) { if (epoch === timelineEpoch && mode === 'live') { await stopLive(error.message, { preserveMedia: true }); status(error.message, true); } }
    finally { if (epoch === timelineEpoch) pumping = false; }
  }
  function syncTimeline() {
    if (mode !== 'live' || !timedMode || timelineReset || !captionSession || !sourceVideo || sourceVideo.seeking) return;
    if (document.querySelector('#movie_player.ad-showing')) { status('Ad playing. Signing resumes with the main video.'); return; }
    const now = sourceVideo.currentTime, segment = CompanionCaptions.segmentAt(captionTrack.segments, now);
    const ready = clips.find(clip => clip.sourceTime <= now + .001 && clip.sourceEnd > now);
    if (ready) {
      if (ready !== lastOutput) { playClip(ready, ready.text); showSourceCaption(); showQueue(); }
      avatarMessage({ action: 'sync', progress: (now - ready.sourceTime) / (ready.sourceEnd - ready.sourceTime) });
      if (autoBuffer) { autoBuffer = false; void sourceVideo.play().catch(() => status('Ready. Press Play on YouTube to continue.')); }
      status(sourceVideo.paused ? 'Paused with YouTube. Preparing upcoming captions.' : 'Following video timestamps · preparing upcoming signing.');
    } else if (segment) {
      if (!sourceVideo.paused) { autoBuffer = true; sourceVideo.pause(); }
      status('Preparing the current caption. Playback resumes when its signing is ready.');
    } else {
      if (lastOutput?.timed) avatarMessage({ action: 'sync', progress: 1 });
      playingClip = false;
      if (autoBuffer) { autoBuffer = false; void sourceVideo.play().catch(() => {}); }
      status(sourceVideo.ended ? 'Video ended. Loaded caption timeline finished.' : 'Waiting for the next caption · preparing signing ahead.');
    }
    void pumpTimeline();
  }
  let syncPaint = 0;
  function syncFrame(now) { requestAnimationFrame(syncFrame); if (now - syncPaint >= 1000 / 30) { syncPaint = now; syncTimeline(); } }
  requestAnimationFrame(syncFrame);
  function show() { removed = false; open = true; document.documentElement.append(host); bindVideo(); showSourceCaption(); videoId = new URL(location.href).searchParams.get('v') || ''; updateStart(); void connect(); }
  $('consent').onchange = updateStart;
  $('close').onclick = async () => { removed = true; await stopLive(); host.remove(); open = false; };
  $('enlarge').onclick = () => { expanded = !expanded; host.style.width = expanded ? 'min(620px, calc(100vw - 32px))' : ''; $('enlarge').textContent = expanded ? '缩小' : '放大'; $('enlarge').setAttribute('aria-pressed', String(expanded)); };
  $('position').onchange = () => { host.style.left = $('position').value === 'left' ? '24px' : 'auto'; host.style.right = $('position').value === 'left' ? 'auto' : '24px'; };
  $('start').onclick = async () => {
    if (starting || mode === 'live' || !$('consent').checked) return;
    if (document.querySelector('#movie_player.ad-showing')) { status('Wait for the main video to start after the ad.'); return; }
    bindVideo(); if (!sourceVideo || !hasCaptions()) { status('Enable English YouTube CC, then start caption translation.'); return; }
    if (sourceVideo.playbackRate !== 1) { status('Set YouTube playback speed to 1× first.'); return; }
    starting = true; $('start').disabled = true; updateWorkflow();
    try {
      const connected = await connect();
      if (removed || !connected || !outputReady() || !hasCaptions() || !$('consent').checked) return;
      captionBuffer.reset(); captionSession = null;
      timedMode = captionTrack.state === 'ready';
      activeSource = timedMode ? captionTrack.inputSource : 'visible-captions';
      clearMedia(); mode = 'live'; drained = false; serverBuffer = false; autoBuffer = false; queueState = null; showQueue();
      if (timedMode) resetTimeline();
      status('Starting caption input…');
      const started = await rpc({ type: 'companion.start', inputMode: 'captions', inputSource: activeSource, outputMode: 'motion', timed: timedMode, sourceTime: sourceVideo.currentTime });
      if (removed || mode !== 'live') { await rpc({ type: 'companion.stop' }); return; }
      showInputPath();
      captionSession = { captureId: started.captureId, revision: started.revision };
      if (timedMode) void pumpTimeline(); else { readCaptions(); captionTimer = setInterval(readCaptions, 250); }
      $('mode').textContent = 'Captions → Avatar';
      if (timedMode) $('mode').textContent = 'Timed captions → Avatar';
      showTrackState();
    } catch (e) { await stopLive(); status(e.message, true); }
    finally { starting = false; updateStart(); upgradeToTimed(); }
  };
  $('stop').onclick = () => stopLive('Stopped. No new input is being sent. You can replay the last generated clip.', { preserveMedia: true });
  $('replay').onclick = () => { if (lastOutput?.format === 'motion133') { playingClip = true; avatarMessage({ action: 'replay' }); } };
  window.addEventListener('message', event => {
    if (event.source !== $('avatar').contentWindow || event.origin !== new URL(avatarUrl).origin || event.data?.type !== 'companion.avatar') return;
    if (event.data.ready) { avatarReady = true; if (lastOutput?.format === 'motion133') avatarMessage({ action: 'load', clip: lastOutput, serial: motionSerial, externalClock: Boolean(lastOutput.timed && timedMode), calibration: Boolean(lastOutput.calibration) }); }
    if (event.data.ended === motionSerial && playingClip && !timedMode) nextClip();
    if (event.data.error) {
      const message = String(event.data.error).startsWith('Hand calibration is missing.')
        ? 'Hand calibration is missing. Update the backend and extension, restart the model, then reload YouTube.'
        : 'Avatar playback failed. Stop and check the 3D renderer before continuing.';
      if (mode === 'live') void stopLive(message, { preserveMedia: true }).then(() => status(message, true)); else status(message, true);
    }
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type === 'companion.open') { if (!open) show(); else void connect(); respond({ ok: true }); }
    if (message.type !== 'companion.update' || mode !== 'live') return;
    if (message.queue) { queueState = message.queue; serverBuffer = Boolean(message.buffer); drained = Boolean(message.drained); showQueue(); }
    if (message.error) {
      void stopLive(message.error, { preserveMedia: true }).then(() => status(message.error, true)); return;
    }
    if (message.format && message.format !== 'motion133') {
      void stopLive('The model did not return sign motion.', { preserveMedia: true }).then(() => status('Expected motion133 from the sign model; no placeholder was substituted.', true)); return;
    }
    if (message.status && !timedMode) status(message.status);
    if (message.queue) { queueState = message.queue; serverBuffer = Boolean(message.buffer); drained = Boolean(message.drained); if (!timedMode) bufferPlayback(); }
    if (message.format === 'motion133') {
      if (timedMode) {
        if (!message.timed || !Number.isFinite(message.sourceTime) || !Number.isFinite(message.sourceEnd) || message.sourceEnd <= message.sourceTime) { void stopLive('Timed signing returned no usable timestamp interval.', { preserveMedia: true }); return; }
        clips.push(message); clips.sort((a, b) => a.sourceTime - b.sourceTime);
        if (message.part === message.partCount - 1) timedPending.delete(message.cueId);
        showQueue(); syncTimeline(); return;
      }
      if (playingClip) clips.push(message); else playClip(message, message.text);
      bufferPlayback();
    }
  });
  let healthTick = 0;
  setInterval(() => {
    prefetchCaptions();
    if (!open) return;
    const current = new URL(location.href).searchParams.get('v') || '';
    if (location.hostname === 'www.youtube.com' && (current !== videoId || !location.pathname.startsWith('/watch'))) { videoId = current; void stopLive('Video changed. Start again to translate the new video.'); }
    bindVideo();
    showSourceCaption();
    updateStart();
    if ((mode === 'idle' || mode === 'review') && ++healthTick % 5 === 0 && !outputReady()) void connect();
  }, 1000);
  addEventListener('yt-navigate-finish', prefetchCaptions);
  prefetchCaptions();
})();
