const $ = id => document.getElementById(id);
const settings = await getCompanionSettings();
$('backend').value = settings.backend;
$('token').value = settings.appToken;
if (settings.appToken) $('status').textContent = '后端连接已配置。打开面板后会检查手语模型是否就绪。';
$('save').onclick = async () => {
  try {
    const url = new URL($('backend').value.trim());
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Enter only the backend origin, without a path.');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === '4318')) throw new Error('Use local port 4318 or a secure HTTPS backend.');
    if (url.protocol === 'https:' && !await chrome.permissions.request({ origins: [`${url.origin}/*`] })) throw new Error('Backend access was not granted.');
    await chrome.storage.local.set({ backend: url.origin, appToken: $('token').value.trim() });
    $('status').textContent = '已保存本机后端设置。';
  } catch (e) { $('status').textContent = e.message; }
};
$('open').onclick = async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.startsWith('https://www.youtube.com/watch?')) throw new Error('请先切到 YouTube 视频播放页，再点击打开面板。');
    await chrome.tabs.sendMessage(tab.id, { type: 'companion.open' });
    window.close();
  } catch (e) { $('status').textContent = e.message.includes('Receiving end') ? '请刷新 YouTube 页面后再试。重载扩展后也需要刷新视频页面。' : e.message; }
};
