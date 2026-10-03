// Maps wall-clock time to "virtual" timeline time. Long idle stretches (the user away for
// hours) are squeezed to a fixed width so the activity stays readable.

const ACTIVE_KINDS = new Set(['llm', 'tool', 'agent', 'span']);

export function buildTimeScale(trace, { compressIdle = true, idleThresholdMs = 90000 } = {}) {
  const start = trace.start;
  const end = Math.max(trace.end, start + 1);
  const T = [start];
  const gaps = [];

  if (compressIdle) {
    const intervals = trace.spans
      .filter((s) => ACTIVE_KINDS.has(s.kind))
      .map((s) => [s.start, Math.max(s.end, s.start + 1)])
      .concat(trace.events.map((e) => [e.time, e.time + 1]))
      .sort((a, b) => a[0] - b[0]);
    let busyEnd = start;
    for (const [s, e] of intervals) {
      if (s - busyEnd > idleThresholdMs) gaps.push({ t0: busyEnd, t1: s });
      if (e > busyEnd) busyEnd = e;
    }
    if (end - busyEnd > idleThresholdMs) gaps.push({ t0: busyEnd, t1: end });
  }

  const idleTotal = gaps.reduce((n, g) => n + (g.t1 - g.t0), 0);
  const busyTotal = end - start - idleTotal;
  const gapWidth = Math.min(Math.max(busyTotal * 0.025, 4000), 45000);
  const V = [0];
  for (const g of gaps) {
    if (g.t0 > T[T.length - 1]) {
      V.push(V[V.length - 1] + (g.t0 - T[T.length - 1]));
      T.push(g.t0);
    }
    g.v0 = V[V.length - 1];
    V.push(g.v0 + gapWidth);
    T.push(g.t1);
    g.v1 = V[V.length - 1];
  }
  if (end > T[T.length - 1]) {
    V.push(V[V.length - 1] + (end - T[T.length - 1]));
    T.push(end);
  }
  if (T.length === 1) {
    T.push(end);
    V.push(end - start);
  }

  const seg = (arr, x) => {
    let lo = 0;
    let hi = arr.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (arr[mid] <= x) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const toV = (t) => {
    if (t <= T[0]) return V[0] - (T[0] - t);
    if (t >= T[T.length - 1]) return V[V.length - 1] + (t - T[T.length - 1]);
    const i = seg(T, t);
    const span = T[i + 1] - T[i];
    return span <= 0 ? V[i] : V[i] + ((t - T[i]) * (V[i + 1] - V[i])) / span;
  };
  const fromV = (v) => {
    if (v <= V[0]) return T[0] - (V[0] - v);
    if (v >= V[V.length - 1]) return T[T.length - 1] + (v - V[V.length - 1]);
    const i = seg(V, v);
    const span = V[i + 1] - V[i];
    return span <= 0 ? T[i] : T[i] + ((v - V[i]) * (T[i + 1] - T[i])) / span;
  };
  const inGap = (v) => gaps.some((g) => v > g.v0 && v < g.v1);
  return { start, end, vStart: 0, vEnd: V[V.length - 1], toV, fromV, gaps, inGap, idleTotal };
}
