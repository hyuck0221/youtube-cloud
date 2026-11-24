(() => {
  if (location.origin !== 'https://www.youtube.com' || globalThis.YoutubeCloudPlayerAttached) return;
  globalThis.YoutubeCloudPlayerAttached = true;
  // Chrome can leave the previous overlay in the page after disabling the extension.
  document.querySelectorAll('#movie_player .yc-overlay, #movie_player .yc-density').forEach(node => node.remove());
  const { defaults, normalize } = YoutubeCloudSettings;
  const { timestampEvents, lowerBound } = YoutubeCloudTimeline;
  const graph = YoutubeCloudGraph.create();
  const freshness = 1.1;
  const timedComments = new Set();
  const commentBuckets = new Map();
  const playedCounts = new Map();
  const timeline = [];
  const visible = [];
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const lifetime = new AbortController();
  const lifetimeOptions = { signal: lifetime.signal };

  let settings = defaults;
  let initialized = false;
  let readNodes = new WeakMap();
  let videoId;
  let player;
  let video;
  let listeners;
  let overlay;
  let stage;
  let requestId;
  let apiSource;
  let apiController;
  let loadState = 'idle';
  let commentSource = 'web';
  let progress = null;
  let progressApproximate = false;
  let publishedStatus;
  let commentRoot;
  let needsScan = false;
  let needsSort = false;
  let needsCursorReset = false;
  let cursor = 0;
  let lastTime = null;
  let wasAd = false;
  let playbackTimer;
  let fadeFrame;
  let scanFrame;
  let pageTimer;

  const commentObserver = new MutationObserver(() => {
    needsScan = true;
    if (scanFrame !== undefined) return;
    scanFrame = requestAnimationFrame(() => {
      scanFrame = undefined;
      if (settings.enabled && videoId === watchId()) refreshPage();
    });
  });

  function watchId() {
    return location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null;
  }

  function currentStatus() {
    return { hasVideo: Boolean(videoId), videoId, count: timedComments.size, state: loadState,
      source: commentSource, progress, progressApproximate };
  }

  function publishStatus() {
    const status = currentStatus();
    const serialized = JSON.stringify(status);
    if (serialized === publishedStatus) return;
    publishedStatus = serialized;
    if (chrome.runtime?.id) chrome.runtime.sendMessage({ type: 'youtube-cloud:status-changed', status }).catch(() => {});
  }

  function refreshGraph() {
    const playerVideoId = player?.closest('ytd-watch-flexy')?.getAttribute('video-id');
    if (!settings.enabled || !settings.graphEnabled || !videoId || videoId !== watchId() ||
        (playerVideoId && playerVideoId !== videoId)) {
      graph.reset();
      return;
    }
    if (player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting')) return;
    graph.update(player, video?.duration, commentBuckets, settings.graphMode);
  }

  function addComment({ id, text, author }) {
    if (typeof text !== 'string' || text.length > 20000) return;
    const body = text.trim();
    const name = typeof author === 'string' ? author.trim().slice(0, 100) : '';
    const key = typeof id === 'string' && id ? id : JSON.stringify([name, body]);
    if (timedComments.has(key)) return;
    const events = timestampEvents(body);
    if (!events.length) return;
    timedComments.add(key);
    for (const event of events) {
      let bucket = commentBuckets.get(event.time);
      if (!bucket) {
        bucket = { time: event.time, events: [] };
        commentBuckets.set(event.time, bucket);
        timeline.push(bucket);
        needsSort = true;
      }
      bucket.events.push({ text: event.text, author: name });
      graph.add(event.time);
    }
    needsCursorReset = true;
  }

  document.addEventListener('youtube-cloud:result', event => {
    let result;
    try {
      result = JSON.parse(event.detail);
    } catch {
      return;
    }
    if (!requestId || result?.requestId !== requestId || result.videoId !== videoId || videoId !== watchId()) return;
    applyResult(result);
  }, lifetimeOptions);

  function applyResult(result) {
    const previousCount = timedComments.size;
    for (const comment of Array.isArray(result.comments) ? result.comments : []) {
      if (comment && typeof comment === 'object') addComment(comment);
    }
    loadState = result.state;
    progress = Number.isFinite(result.progress) && result.progress >= 0 && result.progress <= 100 ? result.progress : null;
    progressApproximate = result.progressApproximate === true;
    publishStatus();
    if (timedComments.size !== previousCount) {
      refreshGraph();
      syncPlayback();
    }
  }

  function requestComments() {
    if (!videoId || !settings.enabled) return;
    cancelRequest();
    const id = requestId = crypto.randomUUID();
    const requestedVideo = videoId;
    loadState = 'loading';
    commentSource = apiSource ? 'api' : 'web';
    progress = null;
    progressApproximate = false;
    publishStatus();
    function startWebCollection() {
      if (requestId !== id || watchId() !== requestedVideo) return;
      if (commentSource === 'api') {
        commentSource = 'web-fallback';
        progress = null;
        progressApproximate = false;
        publishStatus();
      }
      document.dispatchEvent(new CustomEvent('youtube-cloud:request', {
        detail: JSON.stringify({ videoId: requestedVideo, requestId: id }),
      }));
    }
    if (apiSource) {
      apiController = new AbortController();
      YoutubeCloudDataApi.collect(apiSource, requestedVideo, apiController.signal, result => {
        if (requestId === id && watchId() === requestedVideo) applyResult(result);
      }).then(handled => {
        if (!handled) startWebCollection();
      }, startWebCollection);
    } else {
      startWebCollection();
    }
  }

  function cancelRequest() {
    apiController?.abort();
    apiController = undefined;
    if (!requestId) return;
    document.dispatchEvent(new CustomEvent('youtube-cloud:request', {
      detail: JSON.stringify({ videoId, requestId, cancel: true }),
    }));
    requestId = undefined;
  }

  function scanComments() {
    const watch = document.querySelector('ytd-watch-flexy:not([hidden])');
    const root = watch?.querySelector('ytd-comments#comments');
    if (root !== commentRoot) {
      commentObserver.disconnect();
      commentRoot = root;
      needsScan = true;
      if (root) commentObserver.observe(root, { subtree: true, childList: true, characterData: true });
    }
    if (!root || !needsScan || watch.getAttribute('video-id') && watch.getAttribute('video-id') !== videoId) return;
    needsScan = false;

    for (const node of root.querySelectorAll('ytd-comment-view-model, ytd-comment-renderer')) {
      const text = node.querySelector('#content-text')?.textContent || '';
      if (!text || readNodes.get(node) === text) continue;
      readNodes.set(node, text);
      const link = node.querySelector('#published-time-text a[href], a#published-time-text[href]');
      const linkedId = new URLSearchParams(link?.search).get('lc');
      const id = linkedId || node.getAttribute('comment-id');
      addComment({ id, text, author: node.querySelector('#author-text')?.textContent });
    }
  }

  function cancelPlaybackUpdates() {
    clearTimeout(playbackTimer);
    cancelAnimationFrame(fadeFrame);
  }

  function clearVisible() {
    cancelPlaybackUpdates();
    stage?.replaceChildren();
    visible.length = 0;
  }

  function renderSettings() {
    if (!overlay) return;
    overlay.dataset.mode = settings.mode;
    overlay.dataset.position = settings.position;
    overlay.dataset.author = settings.showAuthor;
    overlay.style.setProperty('--yc-size', settings.fontSize + 'px');
    overlay.style.setProperty('--yc-opacity', settings.opacity / 100);
  }

  function attachOverlay(parent) {
    overlay?.remove();
    if (!parent) {
      overlay = undefined;
      stage = undefined;
      return;
    }
    overlay = document.createElement('div');
    overlay.className = 'yc-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    stage = document.createElement('div');
    stage.className = 'yc-stage';
    overlay.append(stage);
    renderSettings();
    parent.append(overlay);
  }

  function placeRandomly(node) {
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    const nodeWidth = node.offsetWidth;
    const nodeHeight = node.offsetHeight;
    if (!width || !height || nodeHeight > height || nodeWidth > width) return false;

    const occupied = visible.map(({ node: other, x, y }) => {
      const otherWidth = other.offsetWidth;
      const otherHeight = other.offsetHeight;
      const left = x * (width - otherWidth);
      const top = y * (height - otherHeight);
      return { left, top, right: left + otherWidth, bottom: top + otherHeight };
    });
    // Wide comments favor the left side while keeping every fitting position possible.
    const horizontalBias = 1 + 2 * Math.max(0, (nodeWidth / width - 0.3) / 0.7);
    for (let attempt = 0; attempt < 24; attempt++) {
      const x = Math.random() ** horizontalBias;
      const y = Math.random();
      const left = x * (width - nodeWidth);
      const top = y * (height - nodeHeight);
      const overlaps = occupied.some(other => (
        left < other.right + 7 && left + nodeWidth + 7 > other.left &&
        top < other.bottom + 7 && top + nodeHeight + 7 > other.top
      ));
      if (overlaps) continue;
      node.style.setProperty('--yc-x', x * 100 + '%');
      node.style.setProperty('--yc-y', y * 100 + '%');
      return { x, y };
    }
    return false;
  }

  function showComment(event, time) {
    if (visible.length >= settings.maxVisible) {
      if (settings.mode === 'scatter') return;
      visible.shift().node.remove();
    }

    const node = document.createElement('div');
    node.className = 'yc-comment';
    if (event.author) {
      const author = document.createElement('span');
      author.className = 'yc-author';
      author.textContent = event.author;
      node.append(author);
    }
    const body = document.createElement('span');
    body.className = 'yc-body';
    body.textContent = event.text;
    node.append(body);
    stage.append(node);
    const placement = settings.mode === 'scatter' ? placeRandomly(node) : {};
    if (!placement) {
      node.remove();
      return;
    }
    visible.push({ node, shownAt: time, ...placement });
    if (settings.mode === 'chat') {
      let height = visible.reduce((total, item) => total + item.node.offsetHeight + 4, -4);
      while (visible.length > 1 && height > stage.clientHeight) {
        const oldest = visible.shift().node;
        height -= oldest.offsetHeight + 4;
        oldest.remove();
      }
    }
  }

  function resetPlayback() {
    lastTime = null;
    playedCounts.clear();
    clearVisible();
  }

  function renderFades(time, advancing) {
    if (reducedMotion.matches) return Infinity;

    // Keep a readable hold between the fades even at the shortest display time.
    const fadeIn = Math.min(0.11, settings.duration * 0.25);
    const fadeOut = Math.min(0.16, settings.duration * 0.35);
    let nextFade = Infinity;
    let fading = false;
    for (const item of visible) {
      const age = time - item.shownAt;
      const remaining = settings.duration - age;
      const progress = Math.max(0, Math.min(1, age / fadeIn, remaining / fadeOut));
      if (progress !== item.fadeProgress) {
        const opacity = progress ** 2 * (3 - 2 * progress);
        item.node.style.setProperty('--yc-fade', opacity);
        item.fadeProgress = progress;
      }
      if (progress < 1) fading = true;
      else nextFade = Math.min(nextFade, item.shownAt + settings.duration - fadeOut);
    }
    if (fading && advancing) fadeFrame = requestAnimationFrame(syncPlayback);
    return nextFade;
  }

  function syncPlayback() {
    cancelPlaybackUpdates();
    if (!settings.enabled || !stage || !video || !videoId || videoId !== watchId()) return;
    const playerVideoId = player.closest('ytd-watch-flexy')?.getAttribute('video-id');
    if (playerVideoId && playerVideoId !== videoId) return;
    if (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')) {
      if (!wasAd) clearVisible();
      wasAd = true;
      return;
    }
    if (wasAd) {
      lastTime = null;
      wasAd = false;
    }
    if (video.seeking || video.paused || video.readyState < 2) return;
    const time = video.currentTime;
    if (lastTime !== null && (time < lastTime - 0.1 || time - lastTime > Math.max(2, video.playbackRate * 2))) {
      resetPlayback();
    }

    const minimumTime = Math.min(lastTime ?? time, time - freshness);
    const resetCursor = needsCursorReset || lastTime === null;
    if (needsSort) {
      timeline.sort((a, b) => a.time - b.time);
      needsSort = false;
    }
    needsCursorReset = false;
    const delay = settings.delay;
    if (resetCursor) cursor = lowerBound(timeline, minimumTime - delay);
    lastTime = time;

    while (visible.length && visible[0].shownAt + settings.duration <= time) visible.shift().node.remove();
    while (cursor < timeline.length) {
      const { time: timestamp, events } = timeline[cursor];
      const displayAt = timestamp + delay;
      if (displayAt > time) break;
      cursor++;
      if (displayAt < minimumTime) continue;
      if (Number.isFinite(video.duration) && displayAt >= video.duration) continue;
      const first = playedCounts.get(timestamp) || 0;
      playedCounts.set(timestamp, events.length);
      for (let index = first; index < events.length; index++) {
        if (settings.mode === 'scatter' && visible.length >= settings.maxVisible) break;
        showComment(events[index], time);
      }
    }

    const advancing = video.readyState >= 3 && video.playbackRate > 0;
    const nextFade = renderFades(time, advancing);
    // Use a timer for nearby deadlines between native timeupdate events.
    if (advancing) {
      const nextDisplay = (timeline[cursor]?.time ?? Infinity) + delay;
      const nextExpiry = visible.length ? visible[0].shownAt + settings.duration : Infinity;
      const remaining = Math.min(nextDisplay, nextExpiry, nextFade) - video.currentTime;
      const waitMs = Math.ceil(remaining * 1000 / video.playbackRate);
      if (waitMs <= 1000) playbackTimer = setTimeout(syncPlayback, Math.max(16, waitMs));
    }
  }

  function bindVideo() {
    const nextPlayer = videoId ? document.getElementById('movie_player') : undefined;
    const nextVideo = nextPlayer?.querySelector('video.html5-main-video, video');
    if (nextPlayer === player && nextVideo === video && (!settings.enabled || overlay?.isConnected || !player)) return;
    listeners?.abort();
    resetPlayback();
    player = nextPlayer;
    video = nextVideo;
    attachOverlay(settings.enabled ? player : undefined);
    if (!video) return;
    listeners = new AbortController();
    const options = { signal: listeners.signal };
    for (const event of ['timeupdate', 'playing', 'seeked', 'ratechange', 'pause', 'waiting']) {
      video.addEventListener(event, syncPlayback, options);
    }
    for (const event of ['seeking', 'emptied', 'ended']) video.addEventListener(event, resetPlayback, options);
    for (const event of ['loadedmetadata', 'durationchange', 'emptied']) video.addEventListener(event, refreshGraph, options);
  }

  function refreshPage() {
    if (!chrome.runtime?.id) {
      clearInterval(pageTimer);
      lifetime.abort();
      cancelRequest();
      listeners?.abort();
      commentObserver.disconnect();
      cancelAnimationFrame(scanFrame);
      clearVisible();
      attachOverlay(undefined);
      graph.reset();
      return;
    }
    const nextId = watchId();
    if (nextId !== videoId) {
      cancelRequest();
      videoId = nextId;
      commentObserver.disconnect();
      commentRoot = undefined;
      readNodes = new WeakMap();
      timedComments.clear();
      commentBuckets.clear();
      graph.reset();
      timeline.length = 0;
      needsSort = false;
      needsCursorReset = false;
      resetPlayback();
      loadState = 'idle';
      commentSource = 'web';
      progress = null;
      progressApproximate = false;
      wasAd = false;
      requestComments();
    }
    bindVideo();
    if (videoId && settings.enabled) scanComments();
    refreshGraph();
    publishStatus();
    syncPlayback();
  }

  function updateSettings(values) {
    const previous = settings;
    settings = normalize(values);
    if (previous.delay !== settings.delay) lastTime = null;
    if (previous.enabled !== settings.enabled) {
      clearVisible();
      if (settings.enabled) {
        lastTime = null;
        needsScan = true;
        requestComments();
      } else {
        cancelRequest();
        attachOverlay(undefined);
        commentObserver.disconnect();
        commentRoot = undefined;
      }
    }
    if (previous.mode !== settings.mode) clearVisible();
    while (visible.length > settings.maxVisible) visible.shift().node.remove();
    renderSettings();
    refreshPage();
  }

  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.type !== 'youtube-cloud:reload' && message?.type !== 'youtube-cloud:status') return;
    if (!initialized) {
      const pendingVideo = watchId();
      reply({ hasVideo: Boolean(pendingVideo), videoId: pendingVideo, state: 'idle', count: 0 });
      return;
    }
    if (watchId() !== videoId) refreshPage();
    if (message?.type === 'youtube-cloud:reload') {
      requestComments();
      needsScan = true;
    }
    reply(currentStatus());
  });

  chrome.storage.local.get({ ...defaults, ycApiSource: null }).then(values => {
    settings = normalize(values);
    apiSource = values.ycApiSource;
    initialized = true;
    document.addEventListener('yt-navigate-finish', refreshPage, lifetimeOptions);
    window.navigation?.addEventListener('currententrychange', refreshPage, lifetimeOptions);
    window.addEventListener('popstate', refreshPage, lifetimeOptions);
    reducedMotion.addEventListener('change', syncPlayback, lifetimeOptions);
    pageTimer = setInterval(refreshPage, 650);
    refreshPage();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if ('ycApiSource' in changes) {
        apiSource = changes.ycApiSource.newValue;
        requestComments();
      }
      if (!Object.keys(defaults).some(key => key in changes)) return;
      const values = { ...settings };
      for (const key of Object.keys(defaults)) {
        if (key in changes) values[key] = changes[key].newValue;
      }
      updateSettings(values);
    });
  });
})();
