(() => {
  const defaults = Object.freeze({
    enabled: true,
    mode: 'scatter',
    position: 'bottom-right',
    maxVisible: 10,
    duration: 2,
    delay: 0.2,
    fontSize: 18,
    opacity: 100,
    showAuthor: false,
    graphEnabled: true,
    graphMode: 'line',
  });

  const ranges = Object.freeze({
    maxVisible: [1, 30],
    duration: [0.1, 10, 0.1],
    delay: [0, 5, 0.1],
    fontSize: [12, 32],
    opacity: [30, 100],
  });

  const choices = {
    mode: ['scatter', 'chat'],
    position: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
    graphMode: ['line', 'bars'],
  };

  globalThis.YoutubeCloudSettings = {
    defaults,
    ranges,
    normalize(values = {}) {
      const settings = { ...defaults };
      for (const key of Object.keys(settings)) {
        const value = values[key];
        if (ranges[key] && Number.isFinite(value)) {
          const [min, max, step = 1] = ranges[key];
          const scale = 1 / step;
          const rounded = Math.round(value * scale) / scale;
          settings[key] = Math.min(max, Math.max(min, rounded));
        } else if (choices[key]?.includes(value) || (typeof value === 'boolean' && typeof defaults[key] === 'boolean')) {
          settings[key] = value;
        }
      }
      return settings;
    },
  };
})();
