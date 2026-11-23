(() => {
  function timestampEvents(text) {
    // A trailing colon can separate the timestamp from its text, as in "1:23: Intro".
    const pattern = /(?<![\d:/])(?:\d{1,3}:[0-5]\d:[0-5]\d|\d{1,4}:[0-5]\d)(?!\d|:[\d:]):?/g;
    const matches = [...text.matchAll(pattern)].filter(match => {
      const wordStart = text.slice(0, match.index).search(/\S*$/);
      return !/^(?:https?:\/\/|www\.)/i.test(text.slice(wordStart, match.index));
    });
    const segments = new Map();
    for (const [index, match] of matches.entries()) {
      const stamp = match[0];
      let body = text;
      if (matches.length > 1 || match.index === 0) {
        body = text.slice(match.index + stamp.length, matches[index + 1]?.index).trim();
      }
      if (!body) continue;

      const time = stamp.replace(/:$/, '').split(':').reduce((total, part) => total * 60 + Number(part), 0);
      const previous = segments.get(time);
      segments.set(time, previous ? previous + '\n' + body : body);
    }
    return Array.from(segments, ([time, body]) => ({ time, text: body }));
  }

  function lowerBound(events, time) {
    let start = 0;
    let end = events.length;
    while (start < end) {
      const middle = Math.floor((start + end) / 2);
      if (events[middle].time < time) start = middle + 1;
      else end = middle;
    }
    return start;
  }

  globalThis.YoutubeCloudTimeline = { timestampEvents, lowerBound };
})();
