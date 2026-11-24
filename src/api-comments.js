(() => {
  function openReader(source, videoId, signal) {
    const port = chrome.runtime.connect({ name: 'youtube-cloud:api-reader' });
    const waiting = new Map();
    let nextId = 0;
    let closed = false;

    function close() {
      if (closed) return;
      closed = true;
      signal.removeEventListener('abort', close);
      port.disconnect();
      for (const settle of waiting.values()) settle({ ok: false, code: 'canceled' });
      waiting.clear();
    }

    port.onMessage.addListener(message => {
      const settle = waiting.get(message.id);
      waiting.delete(message.id);
      settle?.(message);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      close();
    });
    signal.addEventListener('abort', close, { once: true });
    if (signal.aborted) close();

    return {
      close,
      request(operation, parentId, pageToken) {
        if (closed) return Promise.resolve({ ok: false, code: 'canceled' });
        return new Promise(resolve => {
          const id = ++nextId;
          waiting.set(id, resolve);
          try {
            port.postMessage({ id, source, videoId, operation, parentId, pageToken });
          } catch {
            close();
          }
        });
      },
    };
  }

  async function collect(source, videoId, signal, publish) {
    const reader = openReader(source, videoId, signal);
    const scanned = new Set();
    let total;
    let gotThreads = false;
    let incomplete = false;

    function update(comments, state) {
      if (signal.aborted) return;
      const fresh = [];
      for (const item of comments) {
        const text = item?.snippet?.textDisplay;
        if (!item?.id || typeof text !== 'string' || scanned.has(item.id)) continue;
        scanned.add(item.id);
        if (/\d:\d{2}/.test(text)) fresh.push({ id: item.id, text, author: item.snippet.authorDisplayName });
      }
      const progress = total ? Math.min(state === 'done' ? 100 : 99.9, scanned.size * 100 / total) : null;
      publish({ comments: fresh, state, progress });
    }

    try {
      let limit = 1;
      let statsPending = true;
      const requests = new Set();
      const replyQueue = [];
      const seen = new Set();
      let nextThread;
      let replyIndex = 0;

      function enqueueReply(parentId, pageToken) {
        const id = JSON.stringify([parentId, pageToken]);
        if (seen.has(id)) return false;
        seen.add(id);
        replyQueue.push({ parentId, pageToken });
        return true;
      }

      function launch(operation, { parentId, pageToken }) {
        const task = reader.request(operation, parentId, pageToken)
          .then(result => ({ task, operation, parentId, result }));
        requests.add(task);
      }

      function startReadyRequests() {
        if (nextThread && requests.size - Number(statsPending) < limit) {
          launch('threads', nextThread);
          nextThread = undefined;
        }
        while (replyIndex < replyQueue.length && requests.size - Number(statsPending) < limit) {
          launch('replies', replyQueue[replyIndex++]);
        }
      }

      launch('stats', {});
      launch('threads', {});
      while (nextThread || replyIndex < replyQueue.length || requests.size) {
        startReadyRequests();
        const { task, operation, parentId, result } = await Promise.race(requests);
        requests.delete(task);
        if (signal.aborted) return true;
        if (operation === 'stats') {
          statsPending = false;
          const count = Number(result.data?.items?.[0]?.statistics?.commentCount);
          if (result.ok && Number.isSafeInteger(count) && count > 0) {
            total = count;
            limit = Math.max(1, Math.min(10, Math.floor(total / 10000)));
            startReadyRequests();
            update([], 'loading');
          }
          continue;
        }
        if (!result.ok) {
          if (operation === 'replies' && result.code === 'missing') {
            incomplete = true;
            continue;
          }
          if (!gotThreads) return false;
          update([], 'partial');
          return true;
        }
        const { items = [], nextPageToken } = result.data;
        const comments = [];
        if (operation === 'threads') {
          gotThreads = true;
          for (const thread of items) {
            const top = thread.snippet?.topLevelComment;
            const replies = thread.replies?.comments || [];
            comments.push(top, ...replies);
            if (top?.id && replies.length < thread.snippet.totalReplyCount) enqueueReply(top.id);
          }
          if (nextPageToken && !seen.has(nextPageToken)) {
            seen.add(nextPageToken);
            nextThread = { pageToken: nextPageToken };
          } else if (nextPageToken) {
            incomplete = true;
          }
        } else {
          comments.push(...items);
          if (nextPageToken && !enqueueReply(parentId, nextPageToken)) incomplete = true;
        }
        startReadyRequests();
        update(comments, 'loading');
      }
      update([], incomplete ? 'partial' : 'done');
      return true;
    } catch {
      if (!gotThreads) return false;
      update([], 'partial');
      return true;
    } finally {
      reader.close();
    }
  }

  globalThis.YoutubeCloudDataApi = { collect };
})();
