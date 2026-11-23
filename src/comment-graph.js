(() => {
  const namespace = 'http://www.w3.org/2000/svg';
  const binCount = 100;
  const graphWidth = 1000;
  const baseline = 32;
  const kernel = [0.14, 0.52, 1, 0.52, 0.14];

  function densityCurve(comments, duration) {
    const density = new Float64Array(binCount);
    for (const events of comments.values()) {
      for (const { time } of events) {
        if (time < 0 || time >= duration) continue;
        const bin = Math.round(time / duration * (binCount - 1));
        for (let i = 0; i < kernel.length; i++) {
          const nearby = bin + i - 2;
          if (nearby >= 0 && nearby < binCount) density[nearby] += kernel[i];
        }
      }
    }

    const peak = Math.max(...density);
    if (!peak) return '';
    const points = Array.from(density, (count, i) => [
      i * graphWidth / (binCount - 1),
      baseline - (baseline - 2) * count / peak,
    ]);
    const [firstX, firstY] = points[0];
    const parts = [`M ${firstX} ${firstY.toFixed(2)}`];
    for (let i = 0; i < points.length - 1; i++) {
      const [x, y] = points[i];
      const [nextX, nextY] = points[i + 1];
      parts.push(`Q ${x.toFixed(2)} ${y.toFixed(2)} ${((x + nextX) / 2).toFixed(2)} ${((y + nextY) / 2).toFixed(2)}`);
    }
    parts.push(`L ${graphWidth} ${points.at(-1)[1].toFixed(2)}`);
    return parts.join(' ');
  }

  function create() {
    const chart = document.createElementNS(namespace, 'svg');
    chart.classList.add('yc-density');
    chart.setAttribute('viewBox', `0 0 ${graphWidth} ${baseline + 1}`);
    chart.setAttribute('preserveAspectRatio', 'none');
    chart.setAttribute('role', 'img');
    chart.setAttribute('aria-label', '타임스탬프 댓글 분포');
    const area = document.createElementNS(namespace, 'path');
    area.classList.add('yc-density-area');
    const line = document.createElementNS(namespace, 'path');
    line.classList.add('yc-density-line');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    chart.append(area, line);

    let previousDuration;
    let previousCount;
    let curve = '';

    function setPath(element, path) {
      element.setAttribute('d', path);
      element.style.d = `path("${path}")`;
    }

    return {
      reset() {
        chart.remove();
        previousDuration = undefined;
        previousCount = undefined;
        curve = '';
      },
      update(player, duration, comments) {
        if (!Number.isFinite(duration) || duration <= 0 || !comments.size) {
          chart.remove();
          return;
        }
        const track = player?.querySelector('.ytp-progress-bar-container');
        if (!track) {
          chart.remove();
          return;
        }

        if (duration !== previousDuration || comments.size !== previousCount) {
          previousDuration = duration;
          previousCount = comments.size;
          curve = densityCurve(comments, duration);
          if (curve) {
            setPath(line, curve);
            setPath(area, `${curve} L ${graphWidth} ${baseline} L 0 ${baseline} Z`);
          }
        }
        if (!curve) chart.remove();
        else if (chart.parentNode !== track) track.prepend(chart);
      },
    };
  }

  globalThis.YoutubeCloudGraph = { create };
})();
