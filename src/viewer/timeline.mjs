// Canvas timeline: lanes for turns, model calls, tools, moments (inflections) and context size.
// Canvas keeps it fast with thousands of spans; all hit-testing is done in JS.
import { fmtDuration, fmtClock, fmtTokens, escapeHtml } from './format.mjs';
import { INFLECTION_KINDS } from '../core/analysis.mjs';
import { CATEGORY_LABELS } from '../core/categories.mjs';

const GUTTER = 92;
const RIGHT_PAD = 14;
const AXIS_H = 24;
const TOOL_ROW_H = 11;
const TOOL_ROW_GAP = 3;
const MAX_TOOL_ROWS = 8;
const MIN_BAR_PX = 2;
const TICK_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5, 72e5, 108e5, 216e5, 432e5, 864e5];
const LANE_KINDS = { turn: 'turns', llm: 'llm', tool: 'tools', agent: 'tools', span: 'tools' };

function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  const cat = {};
  for (const c of Object.keys(CATEGORY_LABELS)) cat[c] = v(`--cat-${c}`);
  return {
    bg: v('--panel'), text: v('--text'), text2: v('--text-2'), text3: v('--text-3'), line: v('--line'), lineStrong: v('--line-strong'),
    accent: v('--accent'), turn: v('--turn'), llm: v('--llm'), error: v('--error'), gap: v('--gap'), context: v('--accent'),
    cat,
    inf: { error: v('--inf-error'), pivot: v('--inf-pivot'), thinking: v('--inf-thinking'), user: v('--inf-user'), milestone: v('--inf-milestone'), system: v('--inf-system') },
    font: `500 11px ${v('--font-ui')}`, fontSmall: `500 10px ${v('--font-ui')}`, fontLabel: `600 10.5px ${v('--font-ui')}`,
  };
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawInflectionShape(ctx, kind, x, y, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  const group = INFLECTION_KINDS[kind]?.group;
  if (group === 'error') {
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y + r * 0.85);
    ctx.lineTo(x - r, y + r * 0.85);
  } else if (group === 'pivot' || group === 'milestone') {
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
  } else {
    ctx.arc(x, y, r * 0.85, 0, Math.PI * 2);
  }
  ctx.closePath();
  ctx.fill();
}

/** Assign overlapping spans to rows (greedy interval packing). */
function packRows(spans, maxRows) {
  const rowEnds = [];
  const rowOf = new Map();
  for (const s of spans) {
    let row = rowEnds.findIndex((end) => end <= s.start);
    if (row < 0) {
      if (rowEnds.length < maxRows) {
        row = rowEnds.length;
        rowEnds.push(0);
      } else {
        row = rowEnds.indexOf(Math.min(...rowEnds));
      }
    }
    rowEnds[row] = Math.max(rowEnds[row], s.end);
    rowOf.set(s.id, row);
  }
  return { rowOf, rows: Math.max(1, rowEnds.length) };
}

export function createTimeline({ canvas, overview, tooltip, store, onSelect }) {
  const ctx = canvas.getContext('2d');
  const octx = overview.getContext('2d');
  let palette = readPalette();
  let layout = null; // lanes, packed rows, per-lane span lists for the current trace
  let frame = 0;
  let width = 0;
  let height = 0;
  let animation = null;
  let overviewCache = null;

  const plotW = () => Math.max(10, width - GUTTER - RIGHT_PAD);
  const xOf = (v, view) => GUTTER + ((v - view.v0) / (view.v1 - view.v0)) * plotW();
  const vOf = (x, view) => view.v0 + ((x - GUTTER) / plotW()) * (view.v1 - view.v0);

  function buildLayout(state) {
    const { prepared } = state;
    if (!prepared) return null;
    const lanes = { turns: [], llm: [], tools: [] };
    for (const s of prepared.trace.spans) {
      const lane = LANE_KINDS[s.kind];
      if (lane) lanes[lane].push(s);
    }
    const packed = packRows(lanes.tools, MAX_TOOL_ROWS);
    const toolsH = packed.rows * (TOOL_ROW_H + TOOL_ROW_GAP) + 8;
    const defs = [
      { id: 'turns', label: 'Turns', h: 26 },
      { id: 'llm', label: 'Model', h: 24 },
      { id: 'tools', label: 'Tools', h: toolsH },
      { id: 'moments', label: 'Moments', h: 26 },
      { id: 'context', label: 'Context', h: 48 },
    ];
    let y = AXIS_H;
    for (const d of defs) {
      d.y = y;
      y += d.h;
    }
    const maxThinking = Math.max(1, ...lanes.llm.map((s) => s.attrs?.['llm.tokens.thinking'] ?? 0));
    const maxContext = Math.max(1, ...lanes.llm.map((s) => s.attrs?.['llm.tokens.context'] ?? 0));
    return { lanes, defs, packed, maxThinking, maxContext, totalH: y + 6 };
  }

  function laneAt(y) {
    return layout?.defs.find((d) => y >= d.y && y < d.y + d.h) ?? null;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    width = canvas.clientWidth;
    height = layout ? layout.totalH : 200;
    canvas.style.height = `${height}px`;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ow = overview.clientWidth;
    overview.width = Math.round(ow * dpr);
    overview.height = Math.round(overview.clientHeight * dpr);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function spanRect(s, lane, view, scale) {
    const x0 = xOf(scale.toV(s.start), view);
    const x1 = xOf(scale.toV(s.end), view);
    let y = lane.y + 5;
    let h = lane.h - 10;
    if (lane.id === 'tools') {
      const row = layout.packed.rowOf.get(s.id) ?? 0;
      y = lane.y + 4 + row * (TOOL_ROW_H + TOOL_ROW_GAP);
      h = TOOL_ROW_H;
    }
    const w = Math.max(MIN_BAR_PX, x1 - x0);
    return { x: x0, y, w, h };
  }

  function colorFor(s) {
    if (s.status === 'error') return palette.error;
    if (s.kind === 'turn') return palette.turn;
    if (s.kind === 'llm') return palette.llm;
    if (s.kind === 'agent') return palette.cat.agent;
    return palette.cat[s.attrs?.['tool.category'] ?? 'other'] || palette.cat.other;
  }

  function niceStep(view) {
    const msPerPx = (view.v1 - view.v0) / plotW();
    return TICK_STEPS.find((s) => s / msPerPx >= 84) ?? TICK_STEPS[TICK_STEPS.length - 1];
  }

  function drawAxis(view, scale) {
    const step = niceStep(view);
    const tA = scale.fromV(view.v0);
    const tB = scale.fromV(view.v1);
    // Busy segments in real time; ticks are round clock times inside them, never inside idle gaps.
    const segments = [];
    let cursor = scale.start;
    for (const g of scale.gaps) {
      segments.push([cursor, g.t0]);
      cursor = g.t1;
    }
    segments.push([cursor, scale.end]);
    ctx.font = palette.fontSmall;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = palette.text3;
    ctx.strokeStyle = palette.line;
    ctx.lineWidth = 1;
    let lastX = -Infinity;
    for (const [s0, s1] of segments) {
      const lo = Math.max(s0, tA);
      const hi = Math.min(s1, tB);
      if (hi <= lo) continue;
      for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) {
        const x = Math.round(xOf(scale.toV(t), view)) + 0.5;
        if (x - lastX < 60) continue;
        lastX = x;
        ctx.beginPath();
        ctx.moveTo(x, AXIS_H - 5);
        ctx.lineTo(x, height);
        ctx.globalAlpha = 0.55;
        ctx.stroke();
        ctx.globalAlpha = 1;
        const d = new Date(t);
        const label = step < 1000
          ? `${d.getSeconds()}.${String(d.getMilliseconds()).padStart(3, '0')}s`
          : step >= 60000
            ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : fmtClock(t);
        ctx.fillText(label, x + 4, AXIS_H / 2);
      }
    }
  }

  function drawGaps(view, scale) {
    for (const g of scale.gaps) {
      const x0 = xOf(g.v0, view);
      const x1 = xOf(g.v1, view);
      if (x1 < GUTTER || x0 > width - RIGHT_PAD) continue;
      const cx0 = Math.max(GUTTER, x0);
      const cx1 = Math.min(width - RIGHT_PAD, x1);
      ctx.fillStyle = palette.gap;
      ctx.fillRect(cx0, AXIS_H, cx1 - cx0, height - AXIS_H);
      if (x1 - x0 < 8) continue; // too narrow for edges: the tint alone reads better
      ctx.strokeStyle = palette.lineStrong;
      ctx.setLineDash([3, 3]);
      for (const x of [x0, x1]) {
        if (x < GUTTER || x > width - RIGHT_PAD) continue;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, AXIS_H);
        ctx.lineTo(Math.round(x) + 0.5, height);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      if (cx1 - cx0 > 46) {
        ctx.save();
        ctx.font = palette.fontSmall;
        ctx.fillStyle = palette.text3;
        ctx.textAlign = 'center';
        ctx.fillText(`${fmtDuration(g.t1 - g.t0)} idle`, (cx0 + cx1) / 2, AXIS_H / 2);
        ctx.restore();
      }
    }
  }

  function draw() {
    frame = 0;
    const state = store.get();
    const { prepared, view, scale, selectedId, hoverId } = state;
    ctx.clearRect(0, 0, width, height);
    if (!prepared || !layout || !view || !scale) return;
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, width, height);

    drawGaps(view, scale);
    drawAxis(view, scale);

    // lane backgrounds and labels
    ctx.font = palette.fontLabel;
    ctx.textBaseline = 'middle';
    for (const lane of layout.defs) {
      ctx.strokeStyle = palette.line;
      ctx.beginPath();
      ctx.moveTo(0, lane.y + 0.5);
      ctx.lineTo(width, lane.y + 0.5);
      ctx.stroke();
      ctx.fillStyle = palette.text2;
      ctx.fillText(lane.label, 14, lane.y + Math.min(lane.h, 26) / 2);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, AXIS_H, plotW(), height - AXIS_H);
    ctx.clip();

    const visible = (r) => r.x + r.w >= GUTTER - 2 && r.x <= width;
    const dimmed = state.matchIds; // Set of ids matching the current filter, or null
    let selRect = null;
    let hoverRect = null;
    for (const lane of layout.defs) {
      const list = layout.lanes[lane.id];
      if (!list) continue;
      const lastPx = new Map(); // row y -> last pixel column filled by a sub-pixel bar
      for (const s of list) {
        const r = spanRect(s, lane, view, scale);
        if (!visible(r)) continue;
        // Zoomed out, thousands of bars share a pixel: draw one per pixel column per row.
        if (r.w <= MIN_BAR_PX && s.id !== selectedId && s.id !== hoverId && s.status !== 'error') {
          const px = Math.floor(r.x);
          if (lastPx.get(r.y) === px) continue;
          lastPx.set(r.y, px);
        }
        let alpha = 1;
        if (s.kind === 'turn') alpha = 0.32;
        else if (s.kind === 'llm') alpha = 0.45 + 0.55 * Math.min(1, (s.attrs?.['llm.tokens.thinking'] ?? 0) / layout.maxThinking);
        if (dimmed && !dimmed.has(s.id)) alpha *= 0.18;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = colorFor(s);
        roundRect(ctx, r.x, r.y, r.w, r.h, 3);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (s.kind === 'turn' && r.w > 60) {
          ctx.font = palette.font;
          ctx.fillStyle = palette.text;
          const label = s.name;
          const maxChars = Math.floor((r.w - 12) / 6.2);
          ctx.fillText(label.length > maxChars ? label.slice(0, Math.max(0, maxChars - 1)) + '…' : label, Math.max(r.x, GUTTER) + 6, r.y + r.h / 2);
        }
        if (s.id === selectedId) selRect = r;
        if (s.id === hoverId) hoverRect = r;
      }
    }

    // moments (inflections)
    const moments = layout.defs.find((d) => d.id === 'moments');
    for (const inf of prepared.inflections) {
      const x = xOf(scale.toV(inf.time), view);
      if (x < GUTTER - 8 || x > width + 8) continue;
      const group = INFLECTION_KINDS[inf.kind]?.group ?? 'system';
      const isSel = state.selectedInflection === inf.id;
      drawInflectionShape(ctx, inf.kind, x, moments.y + moments.h / 2, isSel ? 7 : 5.5, palette.inf[group]);
    }

    // context size: step area over model calls
    const ctxLane = layout.defs.find((d) => d.id === 'context');
    const pts = layout.lanes.llm
      .filter((s) => s.attrs?.['llm.tokens.context'])
      .map((s) => [xOf(scale.toV(s.start), view), s.attrs['llm.tokens.context']]);
    if (pts.length) {
      const base = ctxLane.y + ctxLane.h - 5;
      const yOf = (n) => base - (n / layout.maxContext) * (ctxLane.h - 12);
      ctx.beginPath();
      ctx.moveTo(pts[0][0], base);
      let prevY = base;
      for (const [x, n] of pts) {
        ctx.lineTo(x, prevY);
        prevY = yOf(n);
        ctx.lineTo(x, prevY);
      }
      ctx.lineTo(xOf(scale.toV(prepared.trace.end), view), prevY);
      ctx.lineTo(xOf(scale.toV(prepared.trace.end), view), base);
      ctx.closePath();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = palette.context;
      ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = palette.context;
      ctx.lineWidth = 1.25;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
    }

    if (hoverRect && hoverRect !== selRect) {
      ctx.strokeStyle = palette.text2;
      ctx.lineWidth = 1.5;
      roundRect(ctx, hoverRect.x - 1, hoverRect.y - 1, hoverRect.w + 2, hoverRect.h + 2, 4);
      ctx.stroke();
    }
    if (selRect) {
      ctx.strokeStyle = palette.accent;
      ctx.lineWidth = 2;
      roundRect(ctx, selRect.x - 1.5, selRect.y - 1.5, selRect.w + 3, selRect.h + 3, 4);
      ctx.stroke();
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.7;
      for (const x of [selRect.x, selRect.x + selRect.w]) {
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, AXIS_H);
        ctx.lineTo(Math.round(x) + 0.5, height);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // gutter divider
    ctx.strokeStyle = palette.line;
    ctx.beginPath();
    ctx.moveTo(GUTTER - 6.5, AXIS_H);
    ctx.lineTo(GUTTER - 6.5, height);
    ctx.stroke();

    drawOverview(state);
  }

  function drawOverview(state) {
    const { prepared, view, scale } = state;
    const w = overview.clientWidth;
    const h = overview.clientHeight;
    octx.clearRect(0, 0, w, h);
    if (!prepared || !scale) return;
    const full = { v0: scale.vStart, v1: scale.vEnd };
    const ox = (v) => GUTTER + ((v - full.v0) / (full.v1 - full.v0)) * plotW();
    // The overview content only changes with the trace, size or theme: paint it once, then blit.
    const key = `${w}x${h}`;
    if (!overviewCache || overviewCache.key !== key || overviewCache.layout !== layout || overviewCache.scale !== scale || overviewCache.palette !== palette) {
      const dpr = window.devicePixelRatio || 1;
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * dpr));
      c.height = Math.max(1, Math.round(h * dpr));
      const cc = c.getContext('2d');
      cc.setTransform(dpr, 0, 0, dpr, 0, 0);
      cc.fillStyle = palette.gap;
      for (const g of scale.gaps) cc.fillRect(ox(g.v0), 0, Math.max(1, ox(g.v1) - ox(g.v0)), h);
      cc.globalAlpha = 0.75;
      let lastPx = -1;
      for (const s of layout.lanes.tools) {
        const x = ox(scale.toV(s.start));
        const bw = ox(scale.toV(s.end)) - x;
        if (bw < 1 && Math.floor(x) === lastPx && s.status !== 'error') continue;
        lastPx = Math.floor(x);
        cc.fillStyle = colorFor(s);
        cc.fillRect(x, 6, Math.max(1, bw), h - 12);
      }
      overviewCache = { key, layout, scale, palette, canvas: c };
    }
    octx.drawImage(overviewCache.canvas, 0, 0, w, h);
    const vx0 = ox(view.v0);
    const vx1 = ox(view.v1);
    octx.fillStyle = palette.accent;
    octx.globalAlpha = 0.12;
    octx.fillRect(vx0, 1, vx1 - vx0, h - 2);
    octx.globalAlpha = 1;
    octx.strokeStyle = palette.accent;
    octx.lineWidth = 1.5;
    roundRect(octx, vx0, 1, Math.max(4, vx1 - vx0), h - 2, 3);
    octx.stroke();
    octx.font = palette.fontLabel;
    octx.fillStyle = palette.text3;
    octx.textBaseline = 'middle';
    octx.fillText('Overview', 14, h / 2);
  }

  function requestDraw() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function clampView(v0, v1) {
    const { scale } = store.get();
    const full = scale.vEnd - scale.vStart;
    const pad = full * 0.03;
    let span = Math.min(Math.max(v1 - v0, 20), full + pad * 2);
    let a = v0;
    if (a < scale.vStart - pad) a = scale.vStart - pad;
    if (a + span > scale.vEnd + pad) a = scale.vEnd + pad - span;
    return { v0: a, v1: a + span };
  }

  function setView(v0, v1, animate = false) {
    const target = clampView(v0, v1);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!animate || reduce) {
      animation = null;
      store.set({ view: target });
      return;
    }
    const from = store.get().view;
    const t0 = performance.now();
    const dur = 220;
    animation = { target };
    const step = (now) => {
      if (animation?.target !== target) return;
      const p = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      store.set({ view: { v0: from.v0 + (target.v0 - from.v0) * e, v1: from.v1 + (target.v1 - from.v1) * e } });
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function fit(animate = true) {
    const { scale } = store.get();
    if (!scale) return;
    const pad = (scale.vEnd - scale.vStart) * 0.015;
    setView(scale.vStart - pad, scale.vEnd + pad, animate);
  }

  function zoomToSpan(id) {
    const { prepared, scale } = store.get();
    const s = prepared?.byId.get(id);
    if (!s) return;
    const a = scale.toV(s.start);
    const b = scale.toV(s.end);
    const span = Math.max(b - a, 400);
    setView(a - span * 0.35, a + span * 1.35, true);
  }

  /** Scroll horizontally so a span is visible without changing zoom. */
  function reveal(id) {
    const { prepared, scale, view } = store.get();
    const s = prepared?.byId.get(id);
    if (!s || !view) return;
    const a = scale.toV(s.start);
    const b = scale.toV(s.end);
    if (a >= view.v0 && b <= view.v1) return;
    const w = view.v1 - view.v0;
    if (b - a > w) zoomToSpan(id);
    else setView(a - w * 0.3, a + w * 0.7, true);
  }

  function hitTest(px, py) {
    const { prepared, view, scale } = store.get();
    if (!prepared || px < GUTTER) return null;
    const lane = laneAt(py);
    if (!lane) return null;
    if (lane.id === 'moments') {
      let best = null;
      let bestD = 9;
      for (const inf of prepared.inflections) {
        const d = Math.abs(xOf(scale.toV(inf.time), view) - px);
        if (d < bestD) {
          bestD = d;
          best = inf;
        }
      }
      return best ? { inflection: best } : null;
    }
    if (lane.id === 'context') {
      const t = scale.fromV(vOf(px, view));
      const prev = layout.lanes.llm.filter((s) => s.start <= t && s.attrs?.['llm.tokens.context']).pop();
      return prev ? { span: prev, context: true } : null;
    }
    const list = layout.lanes[lane.id] ?? [];
    let best = null;
    for (const s of list) {
      const r = spanRect(s, lane, view, scale);
      if (py < r.y - 2 || py > r.y + r.h + 2) continue;
      if (px >= r.x - 3 && px <= r.x + r.w + 3) {
        if (!best || r.w < best.w) best = { span: s, w: r.w };
      }
    }
    return best ? { span: best.span } : null;
  }

  function showTooltip(hit, clientX, clientY) {
    if (!hit) {
      tooltip.hidden = true;
      return;
    }
    let html;
    if (hit.inflection) {
      const inf = hit.inflection;
      html = `<div class="tt-kicker">${escapeHtml(INFLECTION_KINDS[inf.kind]?.label ?? inf.kind)}</div><div class="tt-title">${escapeHtml(inf.label)}</div><div class="tt-meta">${fmtClock(inf.time)}</div>`;
    } else {
      const s = hit.span;
      const a = s.attrs ?? {};
      const lines = [];
      if (hit.context) lines.push(`Context ${fmtTokens(a['llm.tokens.context'])} tokens`);
      if (s.kind === 'llm') {
        lines.push(`${fmtTokens(a['llm.tokens.context'] ?? 0)} in · ${fmtTokens(a['llm.tokens.output'] ?? 0)} out` + (a['llm.tokens.thinking'] ? ` · ${fmtTokens(a['llm.tokens.thinking'])} thinking` : ''));
      }
      if (s.kind === 'tool' && a['tool.summary']) lines.push(escapeHtml(a['tool.summary']));
      if (s.status === 'error') lines.push(`<span class="tt-error">Failed: ${escapeHtml(a['error.message'] ?? 'error')}</span>`);
      const kicker = s.kind === 'tool' ? CATEGORY_LABELS[a['tool.category']] ?? 'Tool' : s.kind === 'llm' ? 'Model call' : s.kind === 'turn' ? 'Turn' : s.kind;
      html = `<div class="tt-kicker">${escapeHtml(kicker)}</div><div class="tt-title">${escapeHtml(s.name)}</div>` +
        `<div class="tt-meta">${fmtDuration(s.end - s.start)} · ${fmtClock(s.start)}</div>` +
        lines.map((l) => `<div class="tt-line">${l}</div>`).join('');
    }
    tooltip.innerHTML = html;
    tooltip.hidden = false;
    const pad = 14;
    const r = tooltip.getBoundingClientRect();
    let x = clientX + pad;
    let y = clientY + pad;
    if (x + r.width > window.innerWidth - 8) x = clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = clientY - r.height - pad;
    tooltip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  // --- interaction -----------------------------------------------------------------------
  let drag = null;
  const localXY = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, view: store.get().view, moved: false };
  });
  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = localXY(e);
    if (drag) {
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 3) drag.moved = true;
      if (drag.moved) {
        const dv = (dx / plotW()) * (drag.view.v1 - drag.view.v0);
        setView(drag.view.v0 - dv, drag.view.v1 - dv);
        canvas.classList.add('is-panning');
        tooltip.hidden = true;
      }
      return;
    }
    const hit = hitTest(x, y);
    store.set({ hoverId: hit?.span?.id ?? null });
    canvas.style.cursor = hit ? 'pointer' : 'grab';
    showTooltip(hit, e.clientX, e.clientY);
  });
  canvas.addEventListener('pointerup', (e) => {
    canvas.classList.remove('is-panning');
    if (drag && !drag.moved) {
      const [x, y] = localXY(e);
      const hit = hitTest(x, y);
      if (hit?.inflection) onSelect({ spanId: hit.inflection.spanId, inflectionId: hit.inflection.id });
      else if (hit?.span) onSelect({ spanId: hit.span.id });
      else onSelect({ spanId: null });
    }
    drag = null;
  });
  canvas.addEventListener('pointerleave', () => {
    tooltip.hidden = true;
    if (store.get().hoverId) store.set({ hoverId: null });
  });
  canvas.addEventListener('dblclick', (e) => {
    const [x, y] = localXY(e);
    const hit = hitTest(x, y);
    if (hit?.span) zoomToSpan(hit.span.id);
    else fit();
  });
  canvas.addEventListener('wheel', (e) => {
    const { view } = store.get();
    if (!view) return;
    e.preventDefault();
    const w = view.v1 - view.v0;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const d = ((e.shiftKey ? e.deltaY : e.deltaX) / plotW()) * w;
      setView(view.v0 + d, view.v1 + d);
      return;
    }
    const [x] = localXY(e);
    const anchor = vOf(Math.max(GUTTER, x), view);
    const factor = Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
    const nw = w * factor;
    const ratio = (anchor - view.v0) / w;
    setView(anchor - nw * ratio, anchor + nw * (1 - ratio));
  }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    const { view } = store.get();
    if (!view) return;
    const w = view.v1 - view.v0;
    const mid = (view.v0 + view.v1) / 2;
    const keys = {
      '+': () => setView(mid - w * 0.35, mid + w * 0.35, true),
      '=': () => setView(mid - w * 0.35, mid + w * 0.35, true),
      '-': () => setView(mid - w * 0.7, mid + w * 0.7, true),
      '0': () => fit(),
      ArrowLeft: () => setView(view.v0 - w * 0.15, view.v1 - w * 0.15),
      ArrowRight: () => setView(view.v0 + w * 0.15, view.v1 + w * 0.15),
    };
    if (keys[e.key]) {
      e.preventDefault();
      keys[e.key]();
    }
  });

  let odrag = null;
  const overviewV = (e) => {
    const { scale } = store.get();
    const r = overview.getBoundingClientRect();
    const x = e.clientX - r.left;
    return scale.vStart + ((x - GUTTER) / plotW()) * (scale.vEnd - scale.vStart);
  };
  overview.addEventListener('pointerdown', (e) => {
    const { view, scale } = store.get();
    if (!scale) return;
    overview.setPointerCapture(e.pointerId);
    const v = overviewV(e);
    const w = view.v1 - view.v0;
    if (v < view.v0 || v > view.v1) setView(v - w / 2, v + w / 2);
    const cur = store.get().view;
    odrag = { v, view: cur };
  });
  overview.addEventListener('pointermove', (e) => {
    if (!odrag) return;
    const dv = overviewV(e) - odrag.v;
    setView(odrag.view.v0 + dv, odrag.view.v1 + dv);
  });
  overview.addEventListener('pointerup', () => {
    odrag = null;
  });

  const ro = new ResizeObserver(() => {
    resize();
    requestDraw();
  });
  ro.observe(canvas);
  ro.observe(overview);

  store.subscribe((state, changed) => {
    if (changed.has('prepared') || changed.has('scale')) {
      layout = buildLayout(state);
      resize();
    }
    if (changed.has('theme')) palette = readPalette();
    requestDraw();
  });

  function zoomBy(factor) {
    const { view } = store.get();
    if (!view) return;
    const mid = (view.v0 + view.v1) / 2;
    const half = ((view.v1 - view.v0) * factor) / 2;
    setView(mid - half, mid + half, true);
  }

  return {
    fit,
    zoomBy,
    zoomToSpan,
    reveal,
    refreshPalette() {
      palette = readPalette();
      requestDraw();
    },
  };
}
