(async () => {
  const { defaults, ranges, normalize } = YoutubeCloudSettings;
  const inputs = Object.fromEntries(Object.keys(defaults).filter(key => key !== 'mode')
    .map(key => [key, document.getElementById(key)]));
  const modes = [...document.querySelectorAll('[name="mode"]')];
  const positionRow = document.getElementById('position-row');
  const status = document.getElementById('status');
  const commentSource = document.getElementById('comment-source');
  const sources = { api: 'YouTube Data API', web: '기본 수집', 'web-fallback': 'API 연결 실패 · 기본 수집' };
  const reload = document.getElementById('reload');
  const units = { maxVisible: '개', duration: '초', delay: '초', fontSize: 'px', opacity: '%' };
  let settings = defaults;
  let activeTabId;
  let activeVideoId;
  let statusRequest = 0;
  let pushedStatusVersion = 0;
  let statusRetry;

  for (const [key, [min, max, step = 1]] of Object.entries(ranges)) {
    inputs[key].min = min;
    inputs[key].max = max;
    inputs[key].step = step;
  }

  function render() {
    for (const [key, input] of Object.entries(inputs)) {
      if (input.type === 'checkbox') input.checked = settings[key];
      else input.value = settings[key];
      const output = document.getElementById(key + '-value');
      if (output) {
        const number = units[key] === '초' ? settings[key].toFixed(1) : settings[key];
        const value = number + units[key];
        output.value = value;
        input.setAttribute('aria-valuetext', value);
      }
    }
    for (const radio of modes) radio.checked = radio.value === settings.mode;
    positionRow.hidden = settings.mode !== 'chat';
    inputs.graphMode.disabled = !settings.graphEnabled;
  }

  function watchVideoId(address) {
    if (!address || !URL.canParse(address)) return null;
    const url = new URL(address);
    return url.origin === 'https://www.youtube.com' && url.pathname === '/watch'
      ? url.searchParams.get('v') : null;
  }

  async function contactPlayer(tabId, type) {
    try {
      return await chrome.tabs.sendMessage(tabId, { type }, { frameId: 0 });
    } catch {
      return null;
    }
  }

  function renderStatus(info) {
    let message = '유튜브 영상 페이지에서 작동합니다.';
    if (info?.hasVideo) {
      const count = (info.count || 0).toLocaleString('ko-KR');
      const ratio = info.progress === 100 ? 100 : Math.min(info.progress, 99.9);
      const progress = Number.isFinite(info.progress) ? `${info.progressApproximate ? '약 ' : ''}${ratio.toLocaleString('ko-KR', {
        maximumFractionDigits: ratio < 1 ? 4 : 1,
      })}% · ` : '';
      if (!settings.enabled) message = '댓글 표시가 꺼져 있습니다.';
      else if (info.state === 'connecting') message = '영상 연결 중…';
      else if (info.state === 'loading' || info.state === 'idle') {
        message = `수집 중 · ${progress}타임스탬프 ${count}개`;
      }
      else if (info.state === 'fallback') message = `${progress}댓글 ${count}개 · 댓글란에서 추가 수집`;
      else if (info.state === 'partial') message = `일부 수집 · ${progress}타임스탬프 ${count}개`;
      else if (progress) message = `수집 종료 · ${progress}타임스탬프 ${count}개`;
      else if (info.count) message = `타임스탬프 댓글 ${count}개`;
      else message = '타임스탬프 댓글을 찾지 못했습니다.';
    }
    if (status.textContent !== message) status.textContent = message;
    const source = info?.hasVideo && settings.enabled ? sources[info.source] : '';
    commentSource.hidden = !source;
    if (source && commentSource.textContent !== source) commentSource.textContent = source;
    reload.disabled = !info?.hasVideo || !settings.enabled || ['connecting', 'loading', 'idle'].includes(info.state);
  }

  async function refreshStatus(type = 'youtube-cloud:status') {
    clearTimeout(statusRetry);
    const request = ++statusRequest;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (request !== statusRequest) return;
    const videoId = watchVideoId(tab?.pendingUrl ?? tab?.url);
    if (tab?.id !== activeTabId || videoId !== activeVideoId || !videoId) {
      activeTabId = tab?.id;
      activeVideoId = videoId;
      renderStatus(videoId ? { hasVideo: true, state: 'connecting' } : null);
    }
    if (!videoId || typeof activeTabId !== 'number') return;

    const version = pushedStatusVersion;
    const info = await contactPlayer(activeTabId, type);
    if (request !== statusRequest || version !== pushedStatusVersion) return;
    if (info?.videoId === videoId) {
      renderStatus(info);
    } else {
      renderStatus({ hasVideo: true, state: 'connecting' });
      if (!info && settings.enabled) {
        await chrome.runtime.sendMessage({ type: 'youtube-cloud:attach', tabId: activeTabId }).catch(() => {});
        if (request !== statusRequest || version !== pushedStatusVersion) return;
      }
      statusRetry = setTimeout(refreshStatus, 500);
    }
  }

  function save(key, value) {
    settings = normalize({ ...settings, [key]: value });
    render();
    chrome.storage.local.set({ [key]: settings[key] });
  }

  settings = normalize(await chrome.storage.local.get(defaults));
  render();
  for (const [key, input] of Object.entries(inputs)) {
    input.addEventListener('input', () => {
      const value = input.type === 'checkbox' ? input.checked
        : input.type === 'range' ? input.valueAsNumber : input.value;
      save(key, value);
    });
  }
  for (const radio of modes) {
    radio.addEventListener('change', () => { if (radio.checked) save('mode', radio.value); });
  }
  reload.addEventListener('click', () => refreshStatus('youtube-cloud:reload'));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !Object.keys(defaults).some(key => key in changes)) return;
    const values = { ...settings };
    for (const key of Object.keys(defaults)) {
      if (key in changes) values[key] = changes[key].newValue;
    }
    settings = normalize(values);
    render();
    if ('enabled' in changes) refreshStatus();
  });

  chrome.tabs.onActivated.addListener(() => refreshStatus());
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (tabId === activeTabId && (change.url || change.status)) refreshStatus();
  });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== 'youtube-cloud:status-changed' || sender.tab?.id !== activeTabId) return;
    if (message.status?.videoId !== activeVideoId) {
      refreshStatus();
      return;
    }
    pushedStatusVersion++;
    clearTimeout(statusRetry);
    renderStatus(message.status);
  });
  refreshStatus();
})();
