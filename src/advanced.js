(async () => {
  const form = document.getElementById('api-form');
  const enabled = document.getElementById('api-enabled');
  const key = document.getElementById('api-key');
  const test = document.getElementById('api-test');
  const save = document.getElementById('api-save');
  const status = document.getElementById('api-status');
  const quota = document.getElementById('api-usage');
  const defaultLimit = 10000;
  const origins = ['https://www.googleapis.com/*'];
  const reasons = {
    key: 'YouTube Data API 키를 확인해 주세요.',
    permission: 'API 연결에 필요한 사이트 권한을 허용해 주세요.',
    quota: 'Google Cloud 프로젝트의 일일 쿼터를 모두 사용했습니다.',
    rate: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
    access: 'Google Cloud에서 YouTube Data API v3 사용 설정과 키 제한을 확인해 주세요.',
    network: 'API에 연결할 수 없습니다.',
  };
  let busy = true;
  let appliedEnabled = false;
  let savedKey = '';
  let usage = { used: 0, exhausted: false };
  let usageRequest = 0;

  function renderUsage() {
    quota.textContent = usage.used.toLocaleString('ko-KR') + ' / ' + defaultLimit.toLocaleString('ko-KR');
    quota.classList.toggle('quota-exceeded', usage.used >= defaultLimit || usage.exhausted);
    quota.setAttribute('aria-label', quota.textContent + (usage.exhausted ? ' · 프로젝트 쿼터 소진' : ' 유닛'));
  }

  function renderForm() {
    key.required = enabled.checked;
    enabled.disabled = busy;
    test.disabled = busy;
    save.disabled = busy;
  }

  function notify(message, error = false) {
    status.textContent = message;
    status.classList.toggle('api-error', error);
  }

  async function send(type, fields) {
    try {
      return await chrome.runtime.sendMessage({ type: 'youtube-cloud:api-' + type, ...fields });
    } catch {
      return { ok: false, code: 'network' };
    }
  }

  async function refreshUsage() {
    const request = ++usageRequest;
    const result = await send('settings', { key: key.value.trim() });
    if (result?.ok && request === usageRequest) {
      usage = result.usage;
      renderUsage();
    }
  }

  async function useApi(testOnly, fromToggle = false) {
    if (busy) return;
    const mode = enabled.checked;
    const input = fromToggle && !mode ? savedKey : key.value.trim();
    if ((testOnly || mode) && !input) {
      if (fromToggle) enabled.checked = appliedEnabled;
      renderForm();
      notify('API 키를 입력해 주세요.', true);
      key.focus();
      return;
    }
    busy = true;
    renderForm();
    notify(testOnly ? '연결 확인 중…' : '저장 중…');
    let result;
    try {
      const allowed = !(testOnly || mode) || await chrome.permissions.request({ origins });
      result = allowed ? await send(testOnly ? 'test' : 'save', { key: input, enabled: mode })
        : { ok: false, code: 'permission' };
    } catch {
      result = { ok: false, code: 'permission' };
    }
    if (!testOnly) {
      if (result?.ok) {
        appliedEnabled = mode;
        savedKey = input;
      }
      enabled.checked = appliedEnabled;
    }
    busy = false;
    renderForm();
    if (result?.usage && input === key.value.trim()) {
      usage = result.usage;
      renderUsage();
    }
    if (result?.ok) {
      notify(testOnly ? 'YouTube Data API 연결에 성공했습니다.'
        : mode ? '저장했습니다. YouTube Data API를 사용합니다.' : '저장했습니다. 기본 수집 방식을 사용합니다.');
    } else {
      notify(reasons[result?.code] || 'API 요청을 처리할 수 없습니다.', true);
    }
    refreshUsage();
  }

  renderForm();
  const saved = await send('settings');
  if (saved?.ok) {
    appliedEnabled = enabled.checked = saved.enabled;
    savedKey = key.value = saved.key;
    usage = saved.usage;
  } else {
    notify('저장된 설정을 불러올 수 없습니다.', true);
  }
  busy = false;
  renderForm();
  renderUsage();

  enabled.addEventListener('change', () => useApi(false, true));
  key.addEventListener('input', refreshUsage);
  test.addEventListener('click', () => useApi(true));
  form.addEventListener('submit', event => {
    event.preventDefault();
    useApi(false);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'ycApiQuota' in changes) refreshUsage();
  });
})();
