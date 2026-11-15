// Optional private bootstrap for this machine's unpacked development extension.
// Distribution packages omit connection.local.json; supplier keys never belong here.
let companionLocalConfig;
async function getCompanionSettings() {
  const stored = await chrome.storage.local.get({ backend: 'http://127.0.0.1:4318', appToken: '' });
  if (stored.appToken || !['http://127.0.0.1:4318', 'http://localhost:4318'].includes(stored.backend)) return stored;
  companionLocalConfig ??= fetch(chrome.runtime.getURL('connection.local.json'))
    .then(response => response.ok ? response.json() : null).catch(() => null);
  const local = await companionLocalConfig;
  if (!local || local.backend !== 'http://127.0.0.1:4318' || !/^[a-f0-9]{64}$/.test(local.appToken)) return stored;
  await chrome.storage.local.set({ backend: local.backend, appToken: local.appToken });
  return { backend: local.backend, appToken: local.appToken };
}
