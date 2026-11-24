(() => {
  if (location.origin !== 'https://www.youtube.com') return;
  const bridgeSlot = Symbol.for('youtube-cloud:comment-bridge');
  const REQUEST = 'youtube-cloud:request';
  const RESULT = 'youtube-cloud:result';
  const commentTargets = new Set(['comments-section', 'comment-item-section', 'engagement-panel-comments-section']);
  const smallVideo = { mainSpacing: 350, replySpacing: 350 };
  const largeVideo = { mainSpacing: 225, replySpacing: 220 };
  const veryLargeVideo = { mainSpacing: 100, replySpacing: 180 };
  const compactUnits = { k: 1000, m: 1e6, b: 1e9, t: 1e12, 천: 1000, 만: 10000, 억: 1e8, 조: 1e12, 万: 10000, 萬: 10000, 億: 1e8, 亿: 1e8, 兆: 1e12 };
  let active;

  function watchId() {
    return location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null;
  }

  function continuation(renderer) {
    return renderer?.continuationEndpoint?.continuationCommand?.token
      ?? renderer?.button?.buttonRenderer?.command?.continuationCommand?.token;
  }

  function legacyContinuation(renderer) {
    return renderer?.continuations?.[0]?.nextContinuationData?.continuation;
  }

  function commentTotal(value, bare = false) {
    const text = value?.simpleText ?? value?.runs?.map(run => run.text || '').join('');
    if (typeof text !== 'string') return;
    const matches = text.match(/\d+(?:[., \u00a0\u202f'’]\d+)*/g);
    if (matches?.length !== 1) return;
    const [digits] = matches;
    const suffix = text.slice(text.indexOf(digits) + digits.length);
    const unit = suffix.trimStart().match(/^(?:[kmbt]\b|천|만|억|조|[万萬億亿兆])/i)?.[0].toLowerCase();
    if (bare && !unit && text.trim() !== digits) return;
    const grouped = /^(?:\d+|\d{1,3}(?:[., \u00a0\u202f'’]\d{3})+)$/.test(digits);
    const amount = grouped ? Number(digits.replace(/\D/g, '')) : Number(digits.replace(',', '.'));
    if (!grouped && !(unit && /^\d+[.,]\d{1,2}$/.test(digits))) return;
    const count = Math.round(amount * (compactUnits[unit] || 1));
    if (Number.isSafeInteger(count) && count > 0) return { count, approximate: Boolean(unit) };
  }

  function betterTotal(current, candidate) {
    return !current || (current.approximate && candidate && !candidate.approximate) ? candidate : current;
  }

  function initialComments(data) {
    const sections = data?.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
    const panels = (data?.engagementPanels || [])
      .map(panel => panel.engagementPanelSectionListRenderer)
      .filter(panel => commentTargets.has(panel?.targetId) || commentTargets.has(panel?.panelIdentifier));
    let token;
    let total;
    for (const panel of panels) {
      total = betterTotal(total, commentTotal(panel.header?.engagementPanelTitleHeaderRenderer?.contextualInfo, true));
    }

    for (const entry of [...sections, ...panels.flatMap(panel => panel.content?.sectionListRenderer?.contents || [])]) {
      const section = entry.itemSectionRenderer;
      const commentSection = commentTargets.has(section?.targetId) || commentTargets.has(section?.sectionIdentifier);
      for (const item of section?.contents || []) {
        total = betterTotal(total, commentTotal(item.commentsEntryPointHeaderRenderer?.commentCount));
        if (commentSection) token ||= continuation(item.continuationItemRenderer);
      }
    }
    return { token, total };
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
    let readable = comments.size > 0;
    for (const endpoint of [
      ...(response.onResponseReceivedEndpoints || []),
      ...(response.onResponseReceivedActions || []),
      ...(response.onResponseReceivedCommands || []),
    ]) {
      const action = endpoint.reloadContinuationItemsCommand || endpoint.appendContinuationItemsAction;
      if (!Array.isArray(action?.continuationItems) || (root && !commentTargets.has(action.targetId))) continue;
      readable = true;
      items.push(...action.continuationItems);
    }
    const legacy = response.continuationContents?.itemSectionContinuation
      || response.continuationContents?.commentRepliesContinuation;
    if (legacy) readable = true;
    items.push(...(legacy?.contents || []));

    const replies = [];
    let next = legacyContinuation(legacy);
    let newest;
    let total;
    for (const entry of items) {
      const header = entry.commentsHeaderRenderer;
      if (header) total = betterTotal(total, betterTotal(
        commentTotal(header.countText), commentTotal(header.commentsCount, true),
      ));
      const sort = header?.sortMenu?.sortFilterSubMenuRenderer?.subMenuItems;
      // YouTube's two-item menu lists Top comments first and Newest first second.
      if (sort?.length === 2 && !sort[1].selected) {
        newest = sort[1].serviceEndpoint?.continuationCommand?.token;
      }
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
      const replyList = thread?.replies?.commentRepliesRenderer;
      if (replyList) {
        const legacyToken = legacyContinuation(replyList);
        const viewToken = replyList.viewReplies?.buttonRenderer?.command?.continuationCommand?.token;
        if (legacyToken) replies.push(legacyToken);
        if (viewToken) replies.push(viewToken);
        for (const item of [...(replyList.contents || []), ...(replyList.subThreads || [])]) {
          const token = continuation(item.continuationItemRenderer);
          if (token) replies.push(token);
          else items.push(item);
        }
      }
      next = continuation(entry.continuationItemRenderer) || next;
    }
    return { comments: [...comments.values()], next, newest, replies, readable, total };
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
    if (!response.ok) {
      const error = new Error('YouTube comment request failed');
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  async function collect({ videoId, requestId }, signal) {
    let readPage = false;
    let total;
    let nextMainAt = 0;
    let nextReplyAt = 0;
    const scanned = new Set();
    const pendingRequests = new AbortController();
    const requestSignal = AbortSignal.any([signal, pendingRequests.signal]);

    function requestProfile() {
      const size = total?.count ?? scanned.size;
      if (size >= 100000) return veryLargeVideo;
      if (size >= 10000) return largeVideo;
      return smallVideo;
    }

    async function nextPage(payload, readMain = true) {
      requestSignal.throwIfAborted();
      let wait = (readMain ? nextMainAt : nextReplyAt) - performance.now();
      // Recheck after waking so delayed browser timers cannot make requests start in a burst.
      while (wait > 0) {
        await new Promise(resolve => setTimeout(resolve, Math.ceil(wait)));
        requestSignal.throwIfAborted();
        wait = (readMain ? nextMainAt : nextReplyAt) - performance.now();
      }
      if (watchId() !== videoId) throw new Error('Video changed');
      const { mainSpacing, replySpacing } = requestProfile();
      const now = performance.now();
      if (readMain) nextMainAt = now + mainSpacing;
      else nextReplyAt = now + replySpacing;
      try {
        return await getNext(payload, requestSignal);
      } catch (error) {
        if (error?.status === 429) pendingRequests.abort(error);
        throw error;
      }
    }

    function publish(comments, state) {
      if (signal.aborted || watchId() !== videoId) return;
      for (const { id } of comments) scanned.add(id);
      // The header count is a progress estimate. Exhausting all cursors confirms completion.
      const progress = state === 'done' ? 100 : total ? Math.min(99.9, scanned.size * 100 / total.count) : null;
      const timedCandidates = comments.filter(comment => (
        typeof comment.text === 'string' && /\d:\d{2}/.test(comment.text)
      ));
      document.dispatchEvent(new CustomEvent(RESULT, {
        detail: JSON.stringify({
          videoId, requestId, comments: timedCandidates, state, progress,
          progressApproximate: state !== 'done' && Boolean(total?.approximate),
        }),
      }));
    }

    try {
      const app = document.querySelector('ytd-app');
      const appResponse = app?.data?.response ?? app?.__data?.data?.response;
      const initial = [appResponse, window.ytInitialData].find(data => (
        data?.currentVideoEndpoint?.watchEndpoint?.videoId === videoId
      )) || await nextPage({ videoId });
      const first = unpack(initial, true);
      const initialInfo = initialComments(initial);
      let topLevel = first.newest || first.next || initialInfo.token;
      let mayChooseNewest = !first.newest;
      readPage = first.readable;
      total = betterTotal(initialInfo.total, first.total);
      const seenTop = new Set();
      const seenReplies = new Set();
      const replyQueue = [];
      const running = new Set();
      let nextReply = 0;
      let mainPending = false;
      let incomplete = false;

      function enqueueReplies(tokens) {
        for (const token of tokens) {
          if (seenReplies.has(token)) continue;
          seenReplies.add(token);
          replyQueue.push(token);
        }
      }

      function launch(token, readMain) {
        const job = nextPage({ continuation: token }, readMain).then(
          response => ({ job, token, readMain, response }),
          error => ({ job, token, readMain, error }),
        );
        running.add(job);
      }

      enqueueReplies(first.replies);
      if (first.comments.length || total) publish(first.comments, 'loading');

      function startReadyRequests() {
        const size = total?.count ?? scanned.size;
        const maxConcurrent = Math.min(10, Math.max(1, Math.floor(size / 10000)));
        // The main feed has one cursor. Separate reply threads can load alongside it.
        if (topLevel && !mainPending && running.size < maxConcurrent) {
          launch(topLevel, true);
          topLevel = undefined;
          mainPending = true;
        }
        while (nextReply < replyQueue.length && running.size < maxConcurrent) {
          launch(replyQueue[nextReply++], false);
        }
      }

      while (topLevel || nextReply < replyQueue.length || running.size) {
        startReadyRequests();
        const { job, token, readMain, response, error } = await Promise.race(running);
        running.delete(job);
        if (readMain) mainPending = false;
        requestSignal.throwIfAborted();
        if (error) {
          if (readMain || error.status !== 404) throw error;
          incomplete = true;
          continue;
        }

        const page = unpack(response);
        if (!page.readable) {
          if (readMain) throw new Error('Unrecognized comment page');
          incomplete = true;
          continue;
        }
        readPage = true;
        if (readMain) total = betterTotal(total, page.total);
        enqueueReplies(page.replies);

        if (readMain) {
          seenTop.add(token);
          topLevel = (mayChooseNewest && page.newest) || page.next;
          mayChooseNewest = false;
          if (seenTop.has(topLevel)) {
            incomplete = true;
            topLevel = undefined;
          }
        } else if (page.next) {
          if (seenReplies.has(page.next)) incomplete = true;
          enqueueReplies([page.next]);
        }
        startReadyRequests();
        publish(page.comments, 'loading');
      }
      publish([], !readPage ? 'fallback' : incomplete ? 'partial' : 'done');
    } catch {
      pendingRequests.abort();
      publish([], readPage ? 'partial' : 'fallback');
    }
  }

  function onRequest(event) {
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
  }

  globalThis[bridgeSlot]?.();
  document.addEventListener(REQUEST, onRequest);
  globalThis[bridgeSlot] = () => {
    document.removeEventListener(REQUEST, onRequest);
    active?.controller.abort();
  };
})();
