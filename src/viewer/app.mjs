// Viewer entry point. Layout: timeline on top; below it the Session pane (left: the whole run)
// and the Selection pane (right: a drill-down into one step).
import { parseAny } from '../adapters/registry.mjs';
import { toOtlp } from '../adapters/otlp.mjs';
import { CATEGORY_LABELS } from '../core/categories.mjs';
import { createStore, prepareTrace } from './store.mjs';
import { buildTimeScale } from './timescale.mjs';
import { createTimeline } from './timeline.mjs';
import { createTree } from './tree.mjs';
import { renderDetails, renderSelectionHeader, spanLabel } from './panels.mjs';
import { renderOpportunityList, renderOverview, renderScopedInsights } from './insights.mjs';
import { escapeHtml, fmtDuration, fmtNumber, fmtTokens, fmtClock, icon, debounce, storageGet, storageSet } from './format.mjs';

const THEMES = ['system', 'light', 'dark'];
const LEFT_TABS = ['calls', 'opps', 'overview'];
const LARGE_TRACE = 1500;

function defaultFilters() {
  return { query: '', off: new Set(), errorsOnly: false, momentsOnly: false, evidence: null };
}

export function startApp() {
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;

  const savedLeft = storageGet('leftTab', 'calls');
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
    filters: defaultFilters(),
    leftTab: LEFT_TABS.includes(savedLeft) ? savedLeft : 'calls',
    sideTab: 'details',
    oppExpanded: null,
    infGroup: 'all',
    theme: 0,
    compressIdle: storageGet('compressIdle', true),
    treeOrder: storageGet('treeOrder', 'asc'),
    insightScope: storageGet('insightScope', 'selection') === 'view' ? 'view' : 'selection',
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

  // --- selection ----------------------------------------------------------------------------
  /** Select a step. Clicks inside the panes (lists, evidence, breadcrumbs) open its Details. */
  const select = ({ spanId, inflectionId = null, from = 'timeline' }) => {
    const sideTab = spanId && from === 'panel' ? 'details' : store.get().sideTab;
    store.set({ selectedId: spanId ?? null, selectedInflection: inflectionId, sideTab });
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
    store.set({ traceIndex: index, prepared, scale, collapsed, selectedId: null, selectedInflection: null, hoverId: null, oppExpanded: null });
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
    const stat = (label, value, cls = '') => `<div class="stat ${cls}"><span class="stat-v">${value}</span><span class="stat-l">${label}</span></div>`;
    $('stat-chips').innerHTML =
      stat('active', fmtDuration(stats.activeTime)) +
      stat('turns', fmtNumber(stats.turns)) +
      stat('tool calls', fmtNumber(stats.toolCalls)) +
      stat('output tokens', fmtTokens(stats.tokens.output)) +
      stat('errors', fmtNumber(stats.errors), stats.errors ? 'is-error' : '');
    const cats = Object.keys(stats.byCategory);
    $('tl-legend').innerHTML =
      '<span><i style="background:var(--turn-strong)"></i>Turn</span><span><i style="background:var(--llm)"></i>Model</span>' +
      cats.map((c) => `<span><i style="background:var(--cat-${c})"></i>${escapeHtml(CATEGORY_LABELS[c] ?? c)}</span>`).join('') +
      '<span><i style="background:var(--error)"></i>Error</span>';
  }

  // --- Calls filters ------------------------------------------------------------------------
  function renderChips() {
    const { prepared, filters } = store.get();
    if (!prepared) return;
    const cats = Object.entries(prepared.stats.byCategory).sort((a, b) => b[1].count - a[1].count);
    const chip = (key, label, n, color) =>
      `<button class="chip ${filters.off.has(key) ? '' : 'is-on'}" data-filter="${key}" aria-pressed="${!filters.off.has(key)}" style="--c:${color}" title="Click to show or hide · Shift+click to show only this"><i></i>${escapeHtml(label)}${n != null ? ` <span class="n">${n}</span>` : ''}</button>`;
    const evidence = filters.evidence
      ? `<button class="chip evidence is-on" data-clear-evidence="1" title="Stop highlighting">Highlighting: ${escapeHtml(filters.evidence.title)} ${icon('close', 11)}</button>`
      : '';
    $('filter-chips').innerHTML =
      evidence +
      chip('llm', 'Model', prepared.stats.llmCalls, 'var(--llm)') +
      cats.map(([c, v]) => chip(c, CATEGORY_LABELS[c] ?? c, v.count, `var(--cat-${c})`)).join('') +
      '<span class="chip-sep"></span>' +
      `<button class="chip toggle ${filters.errorsOnly ? 'is-on' : ''}" data-toggle-filter="errorsOnly" aria-pressed="${filters.errorsOnly}" style="--c:var(--error)"><i></i>Errors only</button>` +
      `<button class="chip toggle ${filters.momentsOnly ? 'is-on' : ''}" data-toggle-filter="momentsOnly" aria-pressed="${filters.momentsOnly}" style="--c:var(--inf-pivot)"><i></i>Moments only</button>`;
  }

  function recomputeFilter() {
    const { prepared, filters } = store.get();
    if (!prepared) return;
    const q = filters.query.trim().toLowerCase();
    const active = q || filters.off.size || filters.errorsOnly || filters.momentsOnly || filters.evidence;
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
      if (filters.evidence && !filters.evidence.ids.has(s.id)) continue;
      ids.add(s.id);
    }
    store.set({ matchIds: ids });
  }

  $('filter-chips').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const filters = { ...store.get().filters, off: new Set(store.get().filters.off) };
    if (b.dataset.clearEvidence) {
      filters.evidence = null;
    } else if (b.dataset.filter && e.shiftKey) {
      // solo: show only this category; shift+click it again to bring everything back
      const all = ['llm', ...Object.keys(store.get().prepared.stats.byCategory)];
      const only = b.dataset.filter;
      const isSolo = all.every((k) => (k === only ? !filters.off.has(k) : filters.off.has(k)));
      filters.off = isSolo ? new Set() : new Set(all.filter((k) => k !== only));
    } else if (b.dataset.filter) {
      if (filters.off.has(b.dataset.filter)) filters.off.delete(b.dataset.filter);
      else filters.off.add(b.dataset.filter);
    } else if (b.dataset.toggleFilter) {
      filters[b.dataset.toggleFilter] = !filters[b.dataset.toggleFilter];
    }
    store.set({ filters });
    renderChips();
    recomputeFilter();
  });
  const setQuery = (q) => {
    $('search').value = q;
    store.set({ filters: { ...store.get().filters, query: q } });
    recomputeFilter();
  };
  $('search').addEventListener('input', debounce((e) => setQuery(e.target.value), 120));

  // --- Session pane (left) ------------------------------------------------------------------
  function setLeftTab(tab) {
    storageSet('leftTab', tab);
    store.set({ leftTab: tab });
  }

  function renderLeft() {
    const { prepared, leftTab, oppExpanded, infGroup, treeOrder } = store.get();
    for (const t of LEFT_TABS) {
      $(`ltab-${t}`).setAttribute('aria-selected', String(leftTab === t));
      $(`lpane-${t}`).hidden = leftTab !== t;
    }
    if (!prepared) return;
    $('n-calls').textContent = fmtNumber(prepared.stats.llmCalls + prepared.stats.toolCalls);
    $('n-opps').textContent = prepared.opportunities.length || '';
    if (leftTab === 'opps') $('lpane-opps').innerHTML = renderOpportunityList(prepared, { expandedId: oppExpanded });
    if (leftTab === 'overview') $('lpane-overview').innerHTML = renderOverview(prepared, { group: infGroup, order: treeOrder });
  }

  function openOpportunity(id) {
    store.set({ oppExpanded: id });
    setLeftTab('opps');
    requestAnimationFrame(() => $('lpane-opps').querySelector(`[data-opp-row="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' }));
  }

  function highlightEvidence(oppId) {
    const { prepared } = store.get();
    const opp = prepared?.opportunities.find((o) => o.id === oppId);
    if (!opp) return;
    store.set({ filters: { ...store.get().filters, evidence: { title: `#${opp.rank} ${opp.title}`, ids: new Set(opp.evidence) } } });
    renderChips();
    recomputeFilter();
    const spans = opp.evidence.map((id) => prepared.byId.get(id)).filter(Boolean);
    if (spans.length) timeline.zoomToRange(Math.min(...spans.map((s) => s.start)), Math.max(...spans.map((s) => s.end)));
    toast(`Highlighting ${spans.length} call${spans.length === 1 ? '' : 's'} on the timeline and under Calls.`);
  }

  // --- Selection pane (right) ----------------------------------------------------------------
  let blocks = [];
  let lastSubject = '';

  /** What Insights summarizes: the selected step's turn/subagent, or the visible time range. */
  function resolveScope() {
    const { prepared, selectedId, insightScope, view, scale } = store.get();
    if (insightScope === 'view' && view && scale) {
      const t0 = Math.max(scale.fromV(view.v0), prepared.trace.start);
      const t1 = Math.min(scale.fromV(view.v1), prepared.trace.end);
      return { mode: 'view', t0, t1, label: `Visible range: ${fmtClock(t0)} to ${fmtClock(t1)}` };
    }
    if (!selectedId) return null;
    let s = prepared.byId.get(selectedId);
    while (s && !['turn', 'agent', 'session'].includes(s.kind) && s.parentId) s = prepared.byId.get(s.parentId);
    if (!s || s.kind === 'session') return null;
    const own = s.id === selectedId ? '' : ` (contains the selected ${spanLabel(prepared.byId.get(selectedId)).toLowerCase()})`;
    return { mode: 'selection', rootId: s.id, label: `${spanLabel(s)}: ${s.name}${own}` };
  }

  function renderSelection() {
    const { prepared, selectedId } = store.get();
    $('sel-head').innerHTML = prepared ? renderSelectionHeader(prepared, selectedId) : '';
  }

  function renderSide() {
    const { prepared, selectedId, sideTab, infGroup, treeOrder } = store.get();
    const body = $('side-body');
    $('tab-details').setAttribute('aria-selected', String(sideTab === 'details'));
    $('tab-insights').setAttribute('aria-selected', String(sideTab === 'insights'));
    if (!prepared) {
      body.innerHTML = '';
      return;
    }
    if (sideTab === 'insights') {
      body.innerHTML = renderScopedInsights(prepared, { scope: resolveScope(), order: treeOrder, selectedId, group: infGroup }).html;
      blocks = [];
    } else if (!selectedId) {
      body.innerHTML = '<div class="pane-empty"><p>Details show the inputs, outputs, tokens and timing of one step.</p><p class="note"><kbd>[</kbd> and <kbd>]</kbd> step through moments. <kbd>j</kbd> and <kbd>k</kbd> step through calls.</p></div>';
      blocks = [];
    } else {
      const r = renderDetails(prepared, selectedId);
      body.innerHTML = r.html;
      blocks = r.blocks;
    }
    // keep the reader's place when the same panel just refreshes (e.g. scope follows the timeline)
    const subject = `${sideTab}|${selectedId}`;
    if (subject !== lastSubject) body.scrollTop = 0;
    lastSubject = subject;
  }
  const renderSideSoon = debounce(renderSide, 150);

  // --- one click handler for every pane ------------------------------------------------------
  async function onPaneClick(e) {
    const t = e.target.closest('button, tr[data-tool]');
    if (!t || t.disabled) return;
    const d = t.dataset;
    if (d.scope) {
      storageSet('insightScope', d.scope);
      store.set({ insightScope: d.scope });
    } else if (d.opp) store.set({ oppExpanded: store.get().oppExpanded === d.opp ? null : d.opp });
    else if (d.oppOpen) openOpportunity(d.oppOpen);
    else if (d.evidence) highlightEvidence(d.evidence);
    else if (d.goto) select({ spanId: d.goto, from: 'panel' });
    else if (d.zoom) timeline.zoomToSpan(d.zoom);
    else if (d.inflection) {
      store.set({ selectedInflection: d.inflection });
      if (d.span) {
        select({ spanId: d.span, inflectionId: d.inflection, from: 'panel' });
        timeline.zoomToSpan(d.span);
      }
    } else if (d.infGroup) store.set({ infGroup: d.infGroup });
    else if (d.copy || d.copyText) {
      e.preventDefault();
      try {
        await navigator.clipboard.writeText(d.copyText ?? blocks[Number(d.copy)] ?? '');
        toast('Copied to clipboard');
      } catch {
        toast('Copy failed: clipboard access is blocked here', 'error');
      }
    } else if (d.expand) {
      const pre = $('side-body').querySelector(`pre[data-block="${d.expand}"]`);
      if (pre) pre.textContent = blocks[Number(d.expand)];
      t.remove();
    } else if (d.tool) {
      setQuery(d.tool);
      setLeftTab('calls');
    }
  }
  for (const id of ['lpane-opps', 'lpane-overview', 'side-body', 'sel-head']) $(id).addEventListener('click', onPaneClick);
  for (const t of LEFT_TABS) $(`ltab-${t}`).addEventListener('click', () => setLeftTab(t));
  $('tab-details').addEventListener('click', () => store.set({ sideTab: 'details' }));
  $('tab-insights').addEventListener('click', () => store.set({ sideTab: 'insights' }));

  store.subscribe((state, changed) => {
    const any = (...keys) => keys.some((k) => changed.has(k));
    if (any('prepared', 'leftTab', 'oppExpanded', 'infGroup', 'treeOrder')) renderLeft();
    if (any('prepared', 'selectedId')) renderSelection();
    if (any('prepared', 'selectedId', 'sideTab', 'infGroup', 'insightScope', 'treeOrder')) renderSide();
    else if (changed.has('view') && state.sideTab === 'insights' && state.insightScope === 'view') renderSideSoon();
    if (changed.has('treeOrder')) renderOrderButton();
    if (state.prepared && any('selectedId', 'leftTab', 'sideTab', 'oppExpanded')) writeHash(state);
  });

  // --- deep links: #span=<id>&tab=insights&left=opps&opp=opp-2 ---------------------------------
  function writeHash(state) {
    const p = new URLSearchParams();
    if (state.selectedId) p.set('span', state.selectedId);
    if (state.sideTab !== 'details') p.set('tab', state.sideTab);
    if (state.leftTab !== 'calls') p.set('left', state.leftTab);
    if (state.oppExpanded) p.set('opp', state.oppExpanded);
    const hash = p.toString();
    try {
      history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
    } catch {
      // some file:// contexts refuse history changes; links just won't update
    }
  }
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const { prepared } = store.get();
    if (!prepared) return;
    const span = p.get('span');
    const byCallId = span && !prepared.byId.has(span) ? prepared.trace.spans.find((x) => x.attrs?.['tool.call_id'] === span)?.id : null;
    const patch = {};
    if (LEFT_TABS.includes(p.get('left'))) patch.leftTab = p.get('left');
    if (p.get('opp') && prepared.opportunities.some((o) => o.id === p.get('opp'))) patch.oppExpanded = p.get('opp');
    if (['details', 'insights'].includes(p.get('tab'))) patch.sideTab = p.get('tab');
    store.set(patch);
    const id = byCallId ?? (prepared.byId.has(span) ? span : null);
    if (id) {
      store.set({ selectedId: id });
      timeline.zoomToSpan(id);
    }
  }

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
  function renderOrderButton() {
    const desc = store.get().treeOrder === 'desc';
    const b = $('btn-order');
    b.innerHTML = `${icon('sort', 13)}<span>${desc ? 'Newest first' : 'Oldest first'}</span>`;
    b.setAttribute('aria-pressed', String(desc));
  }
  function toggleOrder() {
    const next = store.get().treeOrder === 'desc' ? 'asc' : 'desc';
    storageSet('treeOrder', next);
    store.set({ treeOrder: next });
  }
  function clearAll() {
    $('search').value = '';
    store.set({ selectedId: null, selectedInflection: null, filters: defaultFilters() });
    renderChips();
    recomputeFilter();
  }
  renderOrderButton();
  $('btn-order').addEventListener('click', toggleOrder);
  $('btn-clear').addEventListener('click', clearAll);
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

  const stepTree = (key) => {
    setLeftTab('calls');
    tree.focus();
    $('tree').querySelector('.tree-viewport').dispatchEvent(new KeyboardEvent('keydown', { key }));
  };
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
      '/': () => {
        setLeftTab('calls');
        $('search').focus();
      },
      1: () => setLeftTab('calls'),
      2: () => setLeftTab('opps'),
      3: () => setLeftTab('overview'),
      t: cycleTheme,
      f: () => timeline.fit(),
      '?': () => help.showModal(),
      ']': () => stepMoment(1),
      '[': () => stepMoment(-1),
      i: () => store.set({ sideTab: 'insights' }),
      d: () => store.set({ sideTab: 'details' }),
      o: toggleOrder,
      c: clearAll,
      j: () => stepTree('ArrowDown'),
      k: () => stepTree('ArrowUp'),
      Enter: () => store.get().selectedId && document.activeElement === document.body && timeline.zoomToSpan(store.get().selectedId),
    };
    if (actions[e.key]) {
      e.preventDefault();
      actions[e.key]();
    }
  });

  applyTheme();
  renderLeft();

  // embedded data from `agent-trace view`
  const embedded = $('agent-trace-data')?.textContent.trim();
  if (embedded && embedded !== 'null') {
    try {
      const payload = JSON.parse(embedded);
      loadTraces(payload.traces ?? [payload]);
      readHash();
    } catch (e) {
      toast(`Could not read the embedded trace: ${e.message}`, 'error');
    }
  }
}
