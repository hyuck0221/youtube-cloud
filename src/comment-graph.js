(() => {
  const namespace = 'http://www.w3.org/2000/svg';
  const binCount = 100;
  const graphWidth = 1000;
  const baseline = 32;
  const kernel = [0.14, 0.52, 1, 0.52, 0.14];

  function densityPoints(density) {
    const peak = Math.max(...density);
    if (!peak) return [];
    return Array.from(density, (count, i) => [
      i * graphWidth / (binCount - 1),
      baseline - (baseline - 2) * count / peak,
    ]);
  }

  function densityCurve(points) {
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

  function densityBars(points) {
    const width = graphWidth / binCount * .32;
    const bars = [];
    for (const [center, top] of points) {
      if (top >= baseline) continue;
      const left = Math.max(0, Math.min(graphWidth - width, center - width / 2));
      bars.push(`M ${left.toFixed(2)} ${baseline} V ${top.toFixed(2)} h ${width} V ${baseline} Z`);
    }
    return bars.join(' ');
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
    const bars = document.createElementNS(namespace, 'path');
    bars.classList.add('yc-density-bars');
    chart.append(area, line, bars);

    const density = new Float64Array(binCount);
    let duration;
    let dirty = false;
    let previousMode;
    let hasDensity = false;

    function setPath(element, path) {
      element.setAttribute('d', path);
      element.style.d = `path("${path}")`;
    }

    function add(time, count = 1) {
      if (!duration || time < 0 || time >= duration) return;
      const bin = Math.round(time / duration * (binCount - 1));
      for (let i = 0; i < kernel.length; i++) {
        const nearby = bin + i - 2;
        if (nearby >= 0 && nearby < binCount) density[nearby] += kernel[i] * count;
      }
      dirty = true;
    }

    return {
      add,
      reset() {
        chart.remove();
        duration = undefined;
        previousMode = undefined;
        hasDensity = false;
      },
      update(player, nextDuration, buckets, mode) {
        if (!Number.isFinite(nextDuration) || nextDuration <= 0 || !buckets.size) {
          chart.remove();
          return;
        }
        const track = player?.querySelector('.ytp-progress-bar-container');
        if (!track) {
          chart.remove();
          return;
        }

        if (duration !== nextDuration) {
          duration = nextDuration;
          density.fill(0);
          for (const { time, events } of buckets.values()) add(time, events.length);
          dirty = true;
        }
        if (dirty || mode !== previousMode) {
          dirty = false;
          previousMode = mode;
          chart.dataset.mode = mode;
          const points = densityPoints(density);
          hasDensity = points.length > 0;
          if (hasDensity && mode === 'bars') {
            setPath(bars, densityBars(points));
          } else if (hasDensity) {
            const curve = densityCurve(points);
            setPath(line, curve);
            setPath(area, `${curve} L ${graphWidth} ${baseline} L 0 ${baseline} Z`);
          }
        }
        if (!hasDensity) chart.remove();
        else if (chart.parentNode !== track) track.prepend(chart);
      },
    };
  }

  globalThis.YoutubeCloudGraph = { create };
})();
