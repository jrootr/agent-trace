// Viewer entry point: wires the store, timeline, tree and side panel together.
import { parseAny } from '../adapters/registry.mjs';
import { toOtlp } from '../adapters/otlp.mjs';
import { CATEGORY_LABELS } from '../core/categories.mjs';
import { createStore, prepareTrace } from './store.mjs';
import { buildTimeScale } from './timescale.mjs';
import { createTimeline } from './timeline.mjs';
import { createTree } from './tree.mjs';
import { renderDetails, renderInsights } from './panels.mjs';
import { escapeHtml, fmtDuration, fmtTokens, fmtClock, icon, debounce, storageGet, storageSet } from './format.mjs';

const THEMES = ['system', 'light', 'dark'];
const LARGE_TRACE = 1500;

export function startApp() {
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;

  const store = createStore({
    traces: [],
    traceIndex: 0,
    prepared: null,
    scale: null,
    view: null,
    selectedId: null,
    selectedInflection: null,
    hoverId: null,
    collapsed: new Set(),
    matchIds: null,
    filters: { query: '', off: new Set(), errorsOnly: false, momentsOnly: false },
    sideTab: 'insights',
    infGroup: 'all',
    theme: 0,
    compressIdle: storageGet('compressIdle', true),
  });

  // --- theme ------------------------------------------------------------------------------
  // ?theme=dark|light|system overrides the saved preference for this page view (handy for sharing)
  const themeParam = new URLSearchParams(location.search).get('theme');
  let themeMode = THEMES.includes(themeParam) ? themeParam : storageGet('theme', 'system');
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    if (themeMode === 'system') delete root.dataset.theme;
    else root.dataset.theme = themeMode;
    const resolved = themeMode === 'system' ? (media.matches ? 'dark' : 'light') : themeMode;
    $('btn-theme').innerHTML = icon(themeMode === 'system' ? 'auto' : resolved === 'dark' ? 'moon' : 'sun', 16);
    $('btn-theme').title = `Theme: ${themeMode} (t)`;
    $('btn-theme').setAttribute('aria-label', `Theme: ${themeMode}. Click to change.`);
    store.set({ theme: store.get().theme + 1 });
  }
  media.addEventListener?.('change', () => themeMode === 'system' && applyTheme());
  function cycleTheme() {
    themeMode = THEMES[(THEMES.indexOf(themeMode) + 1) % THEMES.length];
    storageSet('theme', themeMode);
    applyTheme();
  }

  // --- components -------------------------------------------------------------------------
  const select = ({ spanId, inflectionId = null, from = 'timeline' }) => {
    store.set({ selectedId: spanId ?? null, selectedInflection: inflectionId, sideTab: spanId ? 'details' : store.get().sideTab });
    if (spanId && from !== 'timeline') timeline.reveal(spanId);
  };
  const timeline = createTimeline({ canvas: $('timeline'), overview: $('overview'), tooltip: $('tooltip'), store, onSelect: select });
  const tree = createTree({ root: $('tree'), store, onSelect: select, onActivate: (id) => timeline.zoomToSpan(id) });

  // --- loading ----------------------------------------------------------------------------
  function toast(message, kind = 'info') {
    const t = $('toast');
    t.textContent = message;
    t.className = `toast is-${kind}`;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), kind === 'error' ? 7000 : 3000);
  }

  function showTrace(index) {
    const { traces } = store.get();
    const trace = traces[index];
    if (!trace) return;
    const prepared = prepareTrace(trace);
    const scale = buildTimeScale(trace, { compressIdle: store.get().compressIdle });
    const collapsed = trace.spans.length > LARGE_TRACE
      ? new Set(trace.spans.filter((s) => s.kind === 'turn' || s.kind === 'agent').map((s) => s.id))
      : new Set();
    store.set({ traceIndex: index, prepared, scale, collapsed, selectedId: null, selectedInflection: null, hoverId: null, sideTab: 'insights' });
    recomputeFilter();
    renderHeader();
    renderChips();
    document.title = `${trace.title ?? 'Trace'} · agent-trace`;
    $('app').dataset.state = 'ready';
    timeline.fit(false);
  }

  function loadTraces(traces) {
    store.set({ traces });
    const picker = $('trace-picker');
    picker.hidden = traces.length < 2;
    picker.innerHTML = traces.map((t, i) => `<option value="${i}">${escapeHtml(t.title ?? t.id)} (${t.spans.length} spans)</option>`).join('');
    showTrace(0);
  }

  async function openFile(file) {
    try {
      const text = await file.text();
      const { traces } = parseAny(text, { fileName: file.name });
      loadTraces(traces);
      toast(`Opened ${file.name}`);
    } catch (e) {
      toast(e.message || String(e), 'error');
    }
  }

  // --- header -----------------------------------------------------------------------------
  function renderHeader() {
    const { prepared } = store.get();
    if (!prepared) return;
    const { trace, stats } = prepared;
    $('trace-title').textContent = trace.title ?? trace.id;
    $('trace-title').title = trace.title ?? trace.id;
    const meta = [trace.source === 'claude-code' ? 'Claude Code' : trace.source, fmtClock(trace.start, true)];
    if (trace.meta?.cwd) meta.push(trace.meta.cwd);
    $('trace-meta').textContent = meta.filter(Boolean).join(' · ');
    const chip = (label, value, cls = '') => `<div class="stat ${cls}"><b>${value}</b><span>${label}</span></div>`;
    $('stat-chips').innerHTML =
      chip('active', fmtDuration(stats.activeTime)) +
      chip('turns', stats.turns) +
      chip('tool calls', stats.toolCalls) +
      chip('output tokens', fmtTokens(stats.tokens.output)) +
      chip('errors', stats.errors, stats.errors ? 'has-error' : '');
    const cats = Object.keys(stats.byCategory);
    $('tl-legend').innerHTML =
      '<span><i style="background:var(--turn-strong)"></i>Turn</span><span><i style="background:var(--llm)"></i>Model</span>' +
      cats.map((c) => `<span><i style="background:var(--cat-${c})"></i>${escapeHtml(CATEGORY_LABELS[c] ?? c)}</span>`).join('') +
      '<span><i style="background:var(--error)"></i>Error</span>';
  }

  // --- filters ----------------------------------------------------------------------------
  function renderChips() {
    const { prepared, filters } = store.get();
    if (!prepared) return;
    const cats = Object.entries(prepared.stats.byCategory).sort((a, b) => b[1].count - a[1].count);
    const chip = (key, label, n, color) =>
      `<button class="chip ${filters.off.has(key) ? '' : 'is-on'}" data-filter="${key}" aria-pressed="${!filters.off.has(key)}" style="--c:${color}">${escapeHtml(label)}${n != null ? ` <span class="chip-n">${n}</span>` : ''}</button>`;
    $('filter-chips').innerHTML =
      chip('llm', 'Model', prepared.stats.llmCalls, 'var(--llm)') +
      cats.map(([c, v]) => chip(c, CATEGORY_LABELS[c] ?? c, v.count, `var(--cat-${c})`)).join('') +
      `<span class="chip-sep"></span>` +
      `<button class="chip toggle ${filters.errorsOnly ? 'is-on' : ''}" data-toggle-filter="errorsOnly" aria-pressed="${filters.errorsOnly}" style="--c:var(--error)">Errors only</button>` +
      `<button class="chip toggle ${filters.momentsOnly ? 'is-on' : ''}" data-toggle-filter="momentsOnly" aria-pressed="${filters.momentsOnly}" style="--c:var(--inf-pivot)">Moments only</button>`;
  }

  function recomputeFilter() {
    const { prepared, filters } = store.get();
    if (!prepared) return;
    const q = filters.query.trim().toLowerCase();
    const active = q || filters.off.size || filters.errorsOnly || filters.momentsOnly;
    if (!active) {
      store.set({ matchIds: null });
      return;
    }
    const ids = new Set();
    for (const s of prepared.trace.spans) {
      if (s.kind === 'llm' && filters.off.has('llm')) continue;
      if ((s.kind === 'tool' || s.kind === 'agent' || s.kind === 'span') && filters.off.has(s.attrs?.['tool.category'] ?? 'other')) continue;
      if (filters.errorsOnly && s.status !== 'error') continue;
      if (filters.momentsOnly && !prepared.inflectionsBySpan.has(s.id)) continue;
      if (q && !prepared.textFor(s).includes(q)) continue;
      ids.add(s.id);
    }
    store.set({ matchIds: ids });
  }

  $('filter-chips').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const filters = { ...store.get().filters, off: new Set(store.get().filters.off) };
    if (b.dataset.filter) {
      if (filters.off.has(b.dataset.filter)) filters.off.delete(b.dataset.filter);
      else filters.off.add(b.dataset.filter);
    } else if (b.dataset.toggleFilter) {
      filters[b.dataset.toggleFilter] = !filters[b.dataset.toggleFilter];
    }
    store.set({ filters });
    renderChips();
    recomputeFilter();
  });
  $('search').addEventListener('input', debounce((e) => {
    store.set({ filters: { ...store.get().filters, query: e.target.value } });
    recomputeFilter();
  }, 120));

  // --- side panel -------------------------------------------------------------------------
  let blocks = [];
  function renderSide() {
    const { prepared, selectedId, sideTab, infGroup } = store.get();
    const body = $('side-body');
    $('tab-details').setAttribute('aria-selected', String(sideTab === 'details'));
    $('tab-insights').setAttribute('aria-selected', String(sideTab === 'insights'));
    if (!prepared) {
      body.innerHTML = '';
      return;
    }
    if (sideTab === 'insights') {
      body.innerHTML = renderInsights(prepared, infGroup);
      blocks = [];
    } else if (!selectedId) {
      body.innerHTML = `<div class="placeholder">${icon('layers', 28)}<p>Select a span in the timeline or the tree to see its inputs, outputs, tokens and timing.</p><p class="note">Tip: <kbd>[</kbd> and <kbd>]</kbd> jump between moments.</p></div>`;
      blocks = [];
    } else {
      const r = renderDetails(prepared, selectedId);
      body.innerHTML = r.html;
      blocks = r.blocks;
    }
    body.scrollTop = 0;
  }
  $('tab-details').addEventListener('click', () => store.set({ sideTab: 'details' }));
  $('tab-insights').addEventListener('click', () => store.set({ sideTab: 'insights' }));
  $('side-body').addEventListener('click', async (e) => {
    const t = e.target.closest('button, tr[data-tool]');
    if (!t) return;
    if (t.dataset.goto) select({ spanId: t.dataset.goto, from: 'panel' });
    else if (t.dataset.zoom) timeline.zoomToSpan(t.dataset.zoom);
    else if (t.dataset.inflection) {
      const span = t.dataset.span || null;
      store.set({ selectedInflection: t.dataset.inflection });
      if (span) {
        select({ spanId: span, inflectionId: t.dataset.inflection, from: 'panel' });
        timeline.zoomToSpan(span);
      }
    } else if (t.dataset.infGroup) store.set({ infGroup: t.dataset.infGroup });
    else if (t.dataset.copy) {
      e.preventDefault();
      try {
        await navigator.clipboard.writeText(blocks[Number(t.dataset.copy)] ?? '');
        toast('Copied to clipboard');
      } catch {
        toast('Copy failed: clipboard access is blocked here', 'error');
      }
    } else if (t.dataset.expand) {
      const pre = $('side-body').querySelector(`pre[data-block="${t.dataset.expand}"]`);
      if (pre) pre.textContent = blocks[Number(t.dataset.expand)];
      t.remove();
    } else if (t.dataset.tool) {
      $('search').value = t.dataset.tool;
      store.set({ filters: { ...store.get().filters, query: t.dataset.tool } });
      recomputeFilter();
    }
  });

  store.subscribe((state, changed) => {
    if (['prepared', 'selectedId', 'sideTab', 'infGroup'].some((k) => changed.has(k))) renderSide();
  });

  // --- moments navigation -----------------------------------------------------------------
  function stepMoment(dir) {
    const { prepared, selectedInflection, selectedId } = store.get();
    if (!prepared?.inflections.length) return;
    const list = prepared.inflections;
    let i = list.findIndex((x) => x.id === selectedInflection);
    if (i < 0) {
      const t = selectedId ? prepared.byId.get(selectedId)?.start ?? 0 : dir > 0 ? -Infinity : Infinity;
      i = dir > 0 ? list.findIndex((x) => x.time > t) - 1 : list.findIndex((x) => x.time >= t);
      if (dir < 0 && i < 0) i = list.length;
    }
    const next = list[Math.max(0, Math.min(list.length - 1, i + dir))];
    if (next.spanId) {
      select({ spanId: next.spanId, inflectionId: next.id, from: 'moments' });
      timeline.zoomToSpan(next.spanId);
    } else store.set({ selectedInflection: next.id });
  }

  // --- toolbar & global events --------------------------------------------------------------
  $('btn-open').addEventListener('click', () => $('file-input').click());
  $('empty-open').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) openFile(f);
    e.target.value = '';
  });
  $('trace-picker').addEventListener('change', (e) => showTrace(Number(e.target.value)));
  $('btn-theme').addEventListener('click', cycleTheme);
  $('btn-fit').addEventListener('click', () => timeline.fit());
  $('btn-zoom-in').addEventListener('click', () => timeline.zoomBy(0.6));
  $('btn-zoom-out').addEventListener('click', () => timeline.zoomBy(1 / 0.6));
  $('btn-expand').addEventListener('click', () => tree.expandAll());
  $('btn-collapse').addEventListener('click', () => tree.collapseAll());
  const compress = $('opt-compress');
  compress.checked = store.get().compressIdle;
  compress.addEventListener('change', () => {
    storageSet('compressIdle', compress.checked);
    const { prepared } = store.get();
    store.set({ compressIdle: compress.checked });
    if (prepared) {
      store.set({ scale: buildTimeScale(prepared.trace, { compressIdle: compress.checked }) });
      timeline.fit(false);
    }
  });

  const exportMenu = $('export-menu');
  $('btn-export').addEventListener('click', (e) => {
    e.stopPropagation();
    exportMenu.hidden = !exportMenu.hidden;
    $('btn-export').setAttribute('aria-expanded', String(!exportMenu.hidden));
  });
  document.addEventListener('click', () => {
    exportMenu.hidden = true;
  });
  exportMenu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-export]');
    const { prepared } = store.get();
    if (!b || !prepared) return;
    const base = (prepared.trace.title ?? 'trace').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'trace';
    const payload = b.dataset.export === 'otlp'
      ? toOtlp(prepared.trace, { inflections: prepared.inflections })
      : prepared.trace;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${base}.${b.dataset.export === 'otlp' ? 'otlp' : 'trace'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    exportMenu.hidden = true;
  });

  const help = $('help');
  $('btn-help').addEventListener('click', () => help.showModal());
  help.addEventListener('click', (e) => {
    if (e.target === help || e.target.closest('[data-close]')) help.close();
  });

  // drag & drop anywhere
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    dragDepth++;
    $('drop').hidden = false;
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('drop').hidden = true;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('drop').hidden = true;
    const f = e.dataTransfer?.files?.[0];
    if (f) openFile(f);
  });

  // resizable timeline
  const splitter = $('splitter');
  const setTimelineHeight = (h) => {
    const clamped = Math.max(120, Math.min(window.innerHeight * 0.7, h));
    root.style.setProperty('--tl-h', `${Math.round(clamped)}px`);
    return clamped;
  };
  setTimelineHeight(storageGet('timelineHeight', 300));
  splitter.addEventListener('pointerdown', (e) => {
    splitter.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = parseFloat(getComputedStyle(root).getPropertyValue('--tl-h')) || 300;
    const move = (ev) => setTimelineHeight(startH + ev.clientY - startY);
    const up = (ev) => {
      storageSet('timelineHeight', setTimelineHeight(startH + ev.clientY - startY));
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
  });
  splitter.addEventListener('keydown', (e) => {
    const cur = parseFloat(getComputedStyle(root).getPropertyValue('--tl-h')) || 300;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      storageSet('timelineHeight', setTimelineHeight(cur + (e.key === 'ArrowDown' ? 24 : -24)));
    }
  });

  document.addEventListener('keydown', (e) => {
    const typing = e.target.matches?.('input, textarea, select, [contenteditable]');
    if (e.key === 'Escape') {
      if (typing) e.target.blur();
      else if (store.get().selectedId) store.set({ selectedId: null, selectedInflection: null });
      exportMenu.hidden = true;
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey || !store.get().prepared) return;
    const actions = {
      '/': () => $('search').focus(),
      t: cycleTheme,
      f: () => timeline.fit(),
      '?': () => help.showModal(),
      ']': () => stepMoment(1),
      '[': () => stepMoment(-1),
      i: () => store.set({ sideTab: 'insights' }),
      d: () => store.set({ sideTab: 'details' }),
      j: () => tree.focus() || $('tree').querySelector('.tree-viewport').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })),
      k: () => tree.focus() || $('tree').querySelector('.tree-viewport').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' })),
      Enter: () => store.get().selectedId && document.activeElement === document.body && timeline.zoomToSpan(store.get().selectedId),
    };
    if (actions[e.key]) {
      e.preventDefault();
      actions[e.key]();
    }
  });

  applyTheme();

  // embedded data from `agent-trace view`
  const embedded = $('agent-trace-data')?.textContent.trim();
  if (embedded && embedded !== 'null') {
    try {
      const payload = JSON.parse(embedded);
      loadTraces(payload.traces ?? [payload]);
    } catch (e) {
      toast(`Could not read the embedded trace: ${e.message}`, 'error');
    }
  }
}
