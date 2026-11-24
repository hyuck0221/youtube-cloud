const apiOrigin = 'https://www.googleapis.com/*';
const pacificDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', dateStyle: 'short' });
const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;
const keyPattern = /^[A-Za-z0-9_-]{20,128}$/;
const apiErrors = {
  quotaExceeded: 'quota',
  dailyLimitExceeded: 'quota',
  dailyLimitExceededUnreg: 'quota',
  rateLimitExceeded: 'rate',
  userRateLimitExceeded: 'rate',
  keyInvalid: 'key',
  API_KEY_INVALID: 'key',
  accessNotConfigured: 'access',
  SERVICE_DISABLED: 'access',
  API_KEY_SERVICE_BLOCKED: 'access',
  API_KEY_HTTP_REFERRER_BLOCKED: 'access',
  commentsDisabled: 'commentsDisabled',
  commentNotFound: 'missing',
};
let usageWrites = Promise.resolve();
let pendingQuota = new Map();
let quotaTimer;
const pendingAttachments = new Map();

function isYoutubeTab(sender) {
  return sender?.frameId === 0 && Number.isInteger(sender.tab?.id) &&
    URL.canParse(sender.url) && new URL(sender.url).origin === 'https://www.youtube.com';
}

async function attachPlayer(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const address = tab.pendingUrl ?? tab.url;
  if (!URL.canParse(address)) return;
  const url = new URL(address);
  if (url.origin !== 'https://www.youtube.com' || url.pathname !== '/watch' || !url.searchParams.get('v')) return;

  const status = await chrome.tabs.sendMessage(tabId, { type: 'youtube-cloud:status' }, { frameId: 0 }).catch(() => null);
  if (status) return;

  const scripts = chrome.runtime.getManifest().content_scripts;
  const bridge = scripts.find(script => script.world === 'MAIN');
  const player = scripts.find(script => script.world !== 'MAIN');
  const [{ documentId }] = await chrome.scripting.executeScript({
    target: { tabId }, files: bridge.js, world: 'MAIN',
  });
  // Keep the styles and player in the same document if the tab navigates mid-attach.
  const target = { tabId, documentIds: [documentId] };
  await chrome.scripting.insertCSS({ target, files: player.css });
  await chrome.scripting.executeScript({ target, files: player.js });
}

async function quotaKeyId(key) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function queueQuota(key, change) {
  const day = pacificDate.format(new Date());
  const pending = pendingQuota.get(key);
  const usage = pending?.day === day ? pending : { day, used: 0, exhausted: false };
  if (change === 'call') usage.used++;
  else usage.exhausted = true;
  pendingQuota.set(key, usage);
  quotaTimer ??= setTimeout(() => flushQuota(), 100);
}

function flushQuota() {
  if (!pendingQuota.size) return usageWrites;
  clearTimeout(quotaTimer);
  quotaTimer = undefined;
  const batch = pendingQuota;
  pendingQuota = new Map();
  const write = usageWrites.then(async () => {
    const { ycApiQuota: saved } = await chrome.storage.local.get('ycApiQuota');
    const day = pacificDate.format(new Date());
    const ledger = saved?.day === day ? saved : { day, keys: {} };
    for (const [key, usage] of batch) {
      if (usage.day !== day) continue;
      const id = await quotaKeyId(key);
      const current = ledger.keys[id];
      ledger.keys[id] = {
        used: (current?.used ?? 0) + usage.used,
        exhausted: usage.exhausted || Boolean(current?.exhausted),
      };
    }
    await chrome.storage.local.set({ ycApiQuota: ledger });
  });
  usageWrites = write.catch(() => {});
  return usageWrites;
}

async function quotaFor(key) {
  const [id] = await Promise.all([quotaKeyId(key), flushQuota()]);
  const { ycApiQuota: saved } = await chrome.storage.local.get('ycApiQuota');
  if (saved?.day === pacificDate.format(new Date()) && saved.keys[id]) return saved.keys[id];
  return { used: 0, exhausted: false };
}

function requestParameters(operation, videoId, item = {}) {
  const parameters = new URLSearchParams();
  switch (operation) {
    case 'probe':
      parameters.set('part', 'snippet');
      parameters.set('videoId', videoId);
      parameters.set('maxResults', '1');
      parameters.set('fields', 'items(id)');
      return ['commentThreads', parameters];
    case 'stats':
      parameters.set('part', 'statistics');
      parameters.set('id', videoId);
      parameters.set('fields', 'items(statistics/commentCount)');
      return ['videos', parameters];
    case 'threads':
      parameters.set('part', 'snippet,replies');
      parameters.set('videoId', videoId);
      parameters.set('order', 'time');
      parameters.set('fields', 'nextPageToken,items(snippet(totalReplyCount,topLevelComment(id,snippet(textDisplay,authorDisplayName))),replies/comments(id,snippet(textDisplay,authorDisplayName)))');
      break;
    case 'replies':
      if (typeof item.parentId !== 'string' || !/^[A-Za-z0-9_.-]{1,256}$/.test(item.parentId)) return;
      parameters.set('part', 'snippet');
      parameters.set('parentId', item.parentId);
      parameters.set('fields', 'nextPageToken,items(id,snippet(textDisplay,authorDisplayName))');
      break;
    default:
      return;
  }
  parameters.set('textFormat', 'plainText');
  parameters.set('maxResults', '100');
  if (item.pageToken != null) {
    if (typeof item.pageToken !== 'string' || item.pageToken.length > 8192) return;
    parameters.set('pageToken', item.pageToken);
  }
  return [operation === 'threads' ? 'commentThreads' : 'comments', parameters];
}

async function readApi(key, operation, videoId, item, signal) {
  const request = requestParameters(operation, videoId, item);
  if (!request) return { ok: false, code: 'request' };
  if (signal?.aborted) return { ok: false, code: 'canceled' };
  const [resource, parameters] = request;
  // Persist quota in batches without delaying responses that carry the next page token.
  queueQuota(key, 'call');
  const url = new URL('https://www.googleapis.com/youtube/v3/' + resource);
  url.search = parameters.toString();
  try {
    const timeout = AbortSignal.timeout(10000);
    const response = await fetch(url, {
      headers: { 'X-Goog-Api-Key': key },
      credentials: 'omit',
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const data = await response.json();
    if (response.ok && !data?.error) return { ok: true, data };
    const codes = [...(data?.error?.errors || []), ...(data?.error?.details || [])]
      .map(error => apiErrors[error.reason]).filter(Boolean);
    const code = codes[0] || (response.status === 429 ? 'rate' : response.status === 403 ? 'access' : 'api');
    if (code === 'quota') queueQuota(key, 'quota');
    return { ok: false, code };
  } catch {
    return { ok: false, code: signal?.aborted ? 'canceled' : 'network' };
  }
}

async function handleSettings(message) {
  const saved = await chrome.storage.local.get(['ycApiSettings', 'ycApiSource']);
  const current = saved.ycApiSettings || {};
  if (message.type === 'youtube-cloud:api-settings') {
    const key = typeof message.key === 'string' ? message.key : current.key;
    return {
      ok: true,
      enabled: Boolean(saved.ycApiSource),
      key: current.key || '',
      usage: keyPattern.test(key) ? await quotaFor(key) : { used: 0, exhausted: false },
    };
  }
  const key = typeof message.key === 'string' ? message.key.trim() : '';
  const allowed = await chrome.permissions.contains({ origins: [apiOrigin] });
  if (message.type === 'youtube-cloud:api-test') {
    if (!keyPattern.test(key)) return { ok: false, code: 'key' };
    if (!allowed) return { ok: false, code: 'permission' };
    const result = await readApi(key, 'probe', 'jNQXAC9IVRw');
    return { ok: result.ok, code: result.code, usage: await quotaFor(key) };
  }
  if (message.type === 'youtube-cloud:api-save') {
    const enabled = message.enabled === true;
    if ((enabled || key) && !keyPattern.test(key)) return { ok: false, code: 'key' };
    if (enabled && !allowed) return { ok: false, code: 'permission' };
    const source = enabled && current.key === key && saved.ycApiSource ? saved.ycApiSource
      : enabled ? crypto.randomUUID() : null;
    await chrome.storage.local.set({ ycApiSettings: { key }, ycApiSource: source });
    if (!enabled && allowed) await chrome.permissions.remove({ origins: [apiOrigin] }).catch(() => {});
    return { ok: true, usage: key ? await quotaFor(key) : { used: 0, exhausted: false } };
  }
  return { ok: false, code: 'request' };
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type === 'youtube-cloud:attach' && sender.url === chrome.runtime.getURL('src/popup.html') &&
      Number.isInteger(message.tabId)) {
    const { tabId } = message;
    if (!pendingAttachments.has(tabId)) {
      pendingAttachments.set(tabId, attachPlayer(tabId).finally(() => pendingAttachments.delete(tabId)));
    }
    pendingAttachments.get(tabId).then(() => reply({ ok: true }), () => reply({ ok: false }));
    return true;
  }
  if (sender.url?.split(/[?#]/, 1)[0] !== chrome.runtime.getURL('src/advanced.html')) return;
  if (!['youtube-cloud:api-settings', 'youtube-cloud:api-test', 'youtube-cloud:api-save'].includes(message?.type)) return;
  handleSettings(message).then(reply, () => reply({ ok: false, code: 'network' }));
  return true;
});

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'youtube-cloud:api-reader' || !isYoutubeTab(port.sender)) return;
  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());
  port.onMessage.addListener(async message => {
    let result = { ok: false, code: 'configuration' };
    try {
      const saved = await chrome.storage.local.get(['ycApiSettings', 'ycApiSource']);
      const key = saved.ycApiSettings?.key;
      if (saved.ycApiSource && saved.ycApiSource === message.source && keyPattern.test(key) &&
          typeof message.videoId === 'string' && videoIdPattern.test(message.videoId) &&
          ['stats', 'threads', 'replies'].includes(message.operation) &&
          await chrome.permissions.contains({ origins: [apiOrigin] })) {
        result = await readApi(key, message.operation, message.videoId, message, controller.signal);
      }
    } catch {
      result = { ok: false, code: 'network' };
    }
    if (!controller.signal.aborted) {
      try {
        port.postMessage({ id: message.id, ok: result.ok, code: result.code, data: result.data });
      } catch {
        controller.abort();
      }
    }
  });
});
