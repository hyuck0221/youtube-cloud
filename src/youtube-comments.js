(() => {
  const REQUEST = 'youtube-cloud:request';
  const RESULT = 'youtube-cloud:result';
  const commentTargets = new Set(['comments-section', 'comment-item-section', 'engagement-panel-comments-section']);
  const pageLimit = 12;
  let active;

  function watchId() {
    return location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null;
  }

  function continuation(renderer) {
    return (renderer?.continuationEndpoint || renderer?.button?.buttonRenderer?.command)
      ?.continuationCommand?.token;
  }

  function initialToken(data) {
    const sections = data?.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
    const panels = (data?.engagementPanels || [])
      .map(panel => panel.engagementPanelSectionListRenderer)
      .filter(panel => commentTargets.has(panel?.targetId) || commentTargets.has(panel?.panelIdentifier))
      .flatMap(panel => panel.content?.sectionListRenderer?.contents || []);

    for (const entry of [...sections, ...panels]) {
      const section = entry.itemSectionRenderer;
      if (!commentTargets.has(section?.targetId) && !commentTargets.has(section?.sectionIdentifier)) continue;
      for (const item of section.contents || []) {
        const token = continuation(item.continuationItemRenderer);
        if (token) return token;
      }
    }
  }

  function unpack(response, root = false) {
    const comments = new Map();
    for (const mutation of response.frameworkUpdates?.entityBatchUpdate?.mutations || []) {
      const payload = mutation.payload?.commentEntityPayload;
      const id = payload?.properties?.commentId;
      const text = payload?.properties?.content?.content;
      if (id && typeof text === 'string') {
        comments.set(id, { id, text, author: payload.author?.displayName });
      }
    }

    const items = [];
    for (const endpoint of [
      ...(response.onResponseReceivedEndpoints || []),
      ...(response.onResponseReceivedActions || []),
      ...(response.onResponseReceivedCommands || []),
    ]) {
      const action = endpoint.reloadContinuationItemsCommand || endpoint.appendContinuationItemsAction;
      if (!action || (root && !commentTargets.has(action.targetId))) continue;
      items.push(...(action.continuationItems || []));
    }
    const legacy = response.continuationContents?.itemSectionContinuation;
    items.push(...(legacy?.contents || []));

    let next = legacy?.continuations?.[0]?.nextContinuationData?.continuation;
    for (const entry of items) {
      const thread = entry.commentThreadRenderer;
      const comment = thread?.comment?.commentRenderer || entry.commentRenderer;
      if (comment?.commentId) {
        const body = comment.contentText;
        const author = comment.authorText;
        comments.set(comment.commentId, {
          id: comment.commentId,
          text: body?.simpleText ?? body?.runs?.map(run => run.text || '').join(''),
          author: author?.simpleText ?? author?.runs?.map(run => run.text || '').join(''),
        });
      }
      next = continuation(entry.continuationItemRenderer) || next;
    }
    return { comments: [...comments.values()], next };
  }

  async function getNext(payload, signal) {
    const config = window.ytcfg;
    const context = config?.get?.('INNERTUBE_CONTEXT');
    if (!context?.client) throw new Error('YouTube client config is unavailable');
    const headers = { 'Content-Type': 'application/json' };
    const clientName = config.get('INNERTUBE_CONTEXT_CLIENT_NAME');
    const clientVersion = config.get('INNERTUBE_CONTEXT_CLIENT_VERSION');
    const visitor = config.get('VISITOR_DATA');
    if (clientName) headers['X-YouTube-Client-Name'] = String(clientName);
    if (clientVersion) headers['X-YouTube-Client-Version'] = clientVersion;
    if (visitor) headers['X-Goog-Visitor-Id'] = visitor;
    const endpoint = new URL('/youtubei/v1/next?prettyPrint=false', location.origin);
    const key = config.get('INNERTUBE_API_KEY');
    if (key) endpoint.searchParams.set('key', key);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ context, ...payload }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    });
    if (!response.ok) throw new Error('YouTube comment request failed');
    return response.json();
  }

  async function collect({ videoId, requestId }, signal) {
    function publish(comments, state) {
      if (signal.aborted || watchId() !== videoId) return;
      const timedCandidates = comments.filter(comment => (
        typeof comment.text === 'string' && /\d:\d{2}/.test(comment.text)
      ));
      document.dispatchEvent(new CustomEvent(RESULT, {
        detail: JSON.stringify({ videoId, requestId, comments: timedCandidates, state }),
      }));
    }

    try {
      const app = document.querySelector('ytd-app');
      const appResponse = app?.data?.response ?? app?.__data?.data?.response;
      const initial = [appResponse, window.ytInitialData].find(data => (
        data?.currentVideoEndpoint?.watchEndpoint?.videoId === videoId
      )) || await getNext({ videoId }, signal);
      const first = unpack(initial, true);
      let token = first.next || initialToken(initial);
      publish(first.comments, token ? 'loading' : 'done');

      const seen = new Set();
      for (let page = 0; token && page < pageLimit && !seen.has(token); page++) {
        if (signal.aborted || watchId() !== videoId) return;
        seen.add(token);
        const { comments, next } = unpack(await getNext({ continuation: token }, signal));
        token = next;
        publish(comments, 'loading');
      }
      if (seen.size) publish([], token ? 'partial' : 'done');
    } catch {
      publish([], 'fallback');
    }
  }

  document.addEventListener(REQUEST, event => {
    let request;
    try {
      request = JSON.parse(event.detail);
    } catch {
      return;
    }
    if (!request || typeof request.requestId !== 'string') return;
    if (request.cancel) {
      if (active?.requestId === request.requestId) active.controller.abort();
      return;
    }
    if (request.videoId !== watchId()) return;
    active?.controller.abort();
    const controller = new AbortController();
    active = { controller, requestId: request.requestId };
    collect(request, controller.signal);
  });
})();
