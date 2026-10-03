// Side panel content: span details (drill-down) and session insights.
import { escapeHtml, fmtDuration, fmtTokens, fmtNumber, fmtClock, fmtOffset, prettyValue, icon, INFLECTION_ICONS } from './format.mjs';
import { INFLECTION_KINDS } from '../core/analysis.mjs';
import { CATEGORY_LABELS, PHASE_LABELS } from '../core/categories.mjs';
import { ancestorsOf } from './store.mjs';

const PREVIEW_CHARS = 6000;

const KIND_LABELS = { session: 'Session', turn: 'Turn', llm: 'Model call', tool: 'Tool call', agent: 'Subagent', span: 'Span' };

function colorVarFor(s) {
  if (s.kind === 'turn') return 'var(--turn-strong)';
  if (s.kind === 'llm') return 'var(--llm)';
  if (s.kind === 'agent') return 'var(--cat-agent)';
  if (s.kind === 'tool') return `var(--cat-${s.attrs?.['tool.category'] ?? 'other'})`;
  return 'var(--text-3)';
}

/** Collects long text blocks so copy / expand buttons can reach the full content. */
function blockCollector() {
  const blocks = [];
  const add = (title, text, { lang = '', open = true } = {}) => {
    if (text == null || text === '') return '';
    const full = String(text);
    const i = blocks.push(full) - 1;
    const shown = full.length > PREVIEW_CHARS ? full.slice(0, PREVIEW_CHARS) : full;
    const more = full.length > PREVIEW_CHARS
      ? `<button class="btn-link" data-expand="${i}">Show all ${fmtNumber(full.length)} characters</button>` : '';
    return `<details class="d-block" ${open ? 'open' : ''}><summary><span>${escapeHtml(title)}</span>` +
      `<button class="icon-btn sm" data-copy="${i}" title="Copy ${escapeHtml(title.toLowerCase())}" aria-label="Copy ${escapeHtml(title.toLowerCase())}">${icon('copy', 14)}</button></summary>` +
      `<pre class="code ${lang}" data-block="${i}">${escapeHtml(shown)}</pre>${more}</details>`;
  };
  return { blocks, add };
}

function tokenBars(a) {
  const ctx = a['llm.tokens.context'] ?? 0;
  if (!ctx && !a['llm.tokens.output']) return '';
  const read = a['llm.tokens.cache_read'] ?? 0;
  const write = a['llm.tokens.cache_write'] ?? 0;
  const fresh = a['llm.tokens.input'] ?? Math.max(0, ctx - read - write);
  const out = a['llm.tokens.output'] ?? 0;
  const think = Math.min(out, a['llm.tokens.thinking'] ?? 0);
  const pct = (n, d) => (d ? ((n / d) * 100).toFixed(2) : 0);
  const seg = (n, d, cls, label) => (n ? `<i class="${cls}" style="width:${pct(n, d)}%" title="${label}: ${fmtNumber(n)}"></i>` : '');
  return `<div class="tok">
    <div class="tok-row"><span class="tok-label">Context</span><span class="tok-bar">${seg(read, ctx, 'seg-cache', 'Cache read')}${seg(write, ctx, 'seg-write', 'Cache write')}${seg(fresh, ctx, 'seg-fresh', 'Fresh input')}</span><span class="tok-num">${fmtTokens(ctx)}</span></div>
    <div class="tok-row"><span class="tok-label">Output</span><span class="tok-bar">${seg(think, out, 'seg-think', 'Thinking')}${seg(out - think, out, 'seg-out', 'Visible output')}</span><span class="tok-num">${fmtTokens(out)}</span></div>
    <div class="tok-legend"><span><i class="seg-cache"></i>cache read ${fmtTokens(read)}</span><span><i class="seg-write"></i>cache write ${fmtTokens(write)}</span><span><i class="seg-fresh"></i>fresh ${fmtTokens(fresh)}</span><span><i class="seg-think"></i>thinking ${fmtTokens(think)}</span></div>
  </div>`;
}

function inflectionItem(inf, { showTime = true } = {}) {
  const group = INFLECTION_KINDS[inf.kind]?.group ?? 'system';
  return `<button class="inf-item" data-inflection="${escapeHtml(inf.id)}" data-span="${escapeHtml(inf.spanId ?? '')}" style="--c: var(--inf-${group})">` +
    `<span class="inf-icon">${icon(INFLECTION_ICONS[inf.kind] ?? 'spark', 14)}</span>` +
    `<span class="inf-text"><span class="inf-kind">${escapeHtml(INFLECTION_KINDS[inf.kind]?.label ?? inf.kind)}</span><span class="inf-label">${escapeHtml(inf.label)}</span></span>` +
    (showTime ? `<span class="inf-time">${fmtClock(inf.time)}</span>` : '') +
    '</button>';
}

function categoryStack(byCategory, total) {
  const entries = Object.entries(byCategory).sort((a, b) => b[1].count - a[1].count);
  if (!entries.length) return '';
  return `<div class="stack" role="img" aria-label="Tool calls by category">${entries.map(([c, v]) => `<i style="width:${((v.count / total) * 100).toFixed(2)}%;background:var(--cat-${c})" title="${escapeHtml(CATEGORY_LABELS[c] ?? c)}: ${v.count}"></i>`).join('')}</div>` +
    `<div class="legend">${entries.map(([c, v]) => `<span><i style="background:var(--cat-${c})"></i>${escapeHtml(CATEGORY_LABELS[c] ?? c)} <b>${v.count}</b></span>`).join('')}</div>`;
}

function childSummary(prepared, s) {
  const all = [];
  const walk = (id) => {
    for (const c of prepared.children.get(id) ?? []) {
      all.push(c);
      walk(c.id);
    }
  };
  walk(s.id);
  const tools = all.filter((c) => c.kind === 'tool');
  const llms = all.filter((c) => c.kind === 'llm');
  if (!all.length) return '';
  const byCategory = {};
  for (const t of tools) {
    const c = t.attrs?.['tool.category'] ?? 'other';
    byCategory[c] ??= { count: 0 };
    byCategory[c].count++;
  }
  const out = llms.reduce((n, l) => n + (l.attrs?.['llm.tokens.output'] ?? 0), 0);
  const errors = tools.filter((t) => t.status === 'error').length;
  return `<section class="d-section"><h3>Inside this ${s.kind === 'turn' ? 'turn' : 'span'}</h3>
    <div class="mini-stats"><div><b>${llms.length}</b><span>model calls</span></div><div><b>${tools.length}</b><span>tool calls</span></div><div><b>${fmtTokens(out)}</b><span>output tokens</span></div><div class="${errors ? 'has-error' : ''}"><b>${errors}</b><span>errors</span></div></div>
    ${tools.length ? categoryStack(byCategory, tools.length) : ''}</section>`;
}

export function renderDetails(prepared, spanId) {
  const s = prepared.byId.get(spanId);
  if (!s) return { html: '', blocks: [] };
  const a = s.attrs ?? {};
  const { blocks, add } = blockCollector();
  const crumbs = ancestorsOf(prepared, s.id)
    .map((p) => `<button class="crumb" data-goto="${escapeHtml(p.id)}">${escapeHtml(p.kind === 'session' ? 'Session' : p.kind === 'llm' ? 'Model' : p.name)}</button>`)
    .join(`<span class="crumb-sep">${icon('chevron', 12)}</span>`);
  const facts = [
    ['Started', fmtClock(s.start, true)],
    ['Offset', fmtOffset(s.start - prepared.trace.start)],
    ['Duration', fmtDuration(s.end - s.start)],
  ];
  if (s.kind === 'llm') {
    if (a['llm.model']) facts.push(['Model', a['llm.model']]);
    if (a['llm.stop_reason']) facts.push(['Stopped', a['llm.stop_reason']]);
    if (a['llm.tool_calls']) facts.push(['Tool calls', a['llm.tool_calls']]);
  }
  if (s.kind === 'tool') {
    facts.push(['Category', CATEGORY_LABELS[a['tool.category']] ?? a['tool.category'] ?? '–']);
    if (a['tool.phase']) facts.push(['Phase', PHASE_LABELS[a['tool.phase']]]);
  }
  const infs = prepared.inflectionsBySpan.get(s.id) ?? [];
  const status = s.status === 'error' ? '<span class="status is-error">Failed</span>' : s.status === 'ok' ? '<span class="status is-ok">OK</span>' : '';

  const siblings = (prepared.children.get(s.parentId && prepared.byId.has(s.parentId) ? s.parentId : null) ?? []).filter((x) => x.kind !== 'session');
  const idx = siblings.indexOf(s);
  const prev = siblings[idx - 1];
  const next = siblings[idx + 1];

  let body = '';
  if (s.kind === 'turn' || s.kind === 'session') body += add('Prompt', s.input);
  if (s.kind === 'llm') {
    body += tokenBars(a);
    body += add('Response', s.output);
    if (a['llm.thinking']) body += add('Thinking', a['llm.thinking'], { open: false });
    else if (a['llm.thinking_blocks']) body += '<p class="note">Reasoning happened here, but its text isn\'t stored in the transcript. The token count above shows how much.</p>';
  }
  if (s.kind === 'tool' || s.kind === 'agent' || s.kind === 'span') {
    body += add('Input', prettyValue(s.input), { lang: 'json' });
    body += add(s.status === 'error' ? 'Error' : 'Output', prettyValue(s.output));
  }
  if (s.kind === 'turn' || s.kind === 'agent' || s.kind === 'session') body += childSummary(prepared, s);

  const attrRows = Object.entries(a)
    .filter(([k]) => k !== 'llm.thinking')
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(typeof v === 'string' ? v : JSON.stringify(v))}</td></tr>`)
    .join('');

  const html = `<div class="details">
    <div class="d-head">
      <span class="kind-pill" style="--c:${colorVarFor(s)}">${escapeHtml(KIND_LABELS[s.kind] ?? s.kind)}</span>${status}
      <span class="d-nav">
        <button class="icon-btn sm" ${prev ? `data-goto="${escapeHtml(prev.id)}"` : 'disabled'} title="Previous sibling (k)" aria-label="Previous sibling"><span class="flip">${icon('chevron', 14)}</span></button>
        <button class="icon-btn sm" ${next ? `data-goto="${escapeHtml(next.id)}"` : 'disabled'} title="Next sibling (j)" aria-label="Next sibling">${icon('chevron', 14)}</button>
        <button class="icon-btn sm" data-zoom="${escapeHtml(s.id)}" title="Zoom timeline to this span (Enter)" aria-label="Zoom timeline to this span">${icon('fit', 14)}</button>
      </span>
    </div>
    <h2 class="d-title">${escapeHtml(s.kind === 'llm' ? `Model call · ${a['llm.model'] ?? s.name}` : s.name)}</h2>
    ${a['tool.summary'] && s.kind !== 'turn' ? `<p class="d-sub">${escapeHtml(a['tool.summary'])}</p>` : ''}
    ${crumbs ? `<nav class="crumbs" aria-label="Ancestors">${crumbs}</nav>` : ''}
    ${s.status === 'error' && a['error.message'] ? `<div class="callout is-error">${icon('alert', 14)}<span>${escapeHtml(a['error.message'])}</span></div>` : ''}
    <dl class="facts">${facts.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</dl>
    ${infs.length ? `<section class="d-section"><h3>Moments</h3><div class="inf-list">${infs.map((i) => inflectionItem(i, { showTime: false })).join('')}</div></section>` : ''}
    ${body}
    ${attrRows ? `<details class="d-block attrs"><summary><span>All attributes</span></summary><table>${attrRows}</table></details>` : ''}
  </div>`;
  return { html, blocks };
}

export function renderInsights(prepared, groupFilter = 'all') {
  const st = prepared.stats;
  const t = st.tokens;
  const card = (label, value, sub = '', cls = '') => `<div class="card ${cls}"><span class="card-label">${label}</span><b class="card-value">${value}</b>${sub ? `<span class="card-sub">${sub}</span>` : ''}</div>`;
  const activePct = st.wallTime ? Math.round((st.activeTime / st.wallTime) * 100) : 0;
  const groups = [['all', 'All'], ['error', 'Errors'], ['pivot', 'Pivots'], ['thinking', 'Thinking'], ['user', 'User'], ['milestone', 'Milestones']];
  const counts = {};
  for (const inf of prepared.inflections) {
    const g = INFLECTION_KINDS[inf.kind]?.group ?? 'system';
    counts[g] = (counts[g] ?? 0) + 1;
  }
  const shown = prepared.inflections.filter((inf) => groupFilter === 'all' || INFLECTION_KINDS[inf.kind]?.group === groupFilter);
  const maxCount = Math.max(1, ...st.topTools.map((x) => x.count));
  const toolRows = st.topTools.slice(0, 12).map((x) => `<tr data-tool="${escapeHtml(x.name)}">
      <td><span class="dot" style="background:var(--cat-${x.category})"></span>${escapeHtml(x.name)}</td>
      <td class="num"><span class="bar-cell"><i style="width:${((x.count / maxCount) * 100).toFixed(1)}%;background:var(--cat-${x.category})"></i></span>${x.count}</td>
      <td class="num">${fmtDuration(x.time)}</td>
      <td class="num ${x.errors ? 'has-error' : ''}">${x.errors || ''}</td></tr>`).join('');

  return `<div class="insights">
    <section class="cards">
      ${card('Active time', fmtDuration(st.activeTime), `${activePct}% of ${fmtDuration(st.wallTime)} wall time`)}
      ${card('Model time', fmtDuration(st.modelTime), `${st.llmCalls} calls`)}
      ${card('Tool time', fmtDuration(st.toolTime), `${st.toolCalls} calls`)}
      ${card('Errors', st.errors, st.errors ? 'failed tool calls' : 'none', st.errors ? 'has-error' : '')}
      ${card('Output', fmtTokens(t.output), `${fmtTokens(t.thinking)} thinking`)}
      ${card('Peak context', fmtTokens(t.peakContext), `${fmtTokens(t.cacheRead)} read from cache`)}
    </section>
    <section class="d-section">
      <h3>Moments <span class="count">${prepared.inflections.length}</span></h3>
      <div class="chips" role="group" aria-label="Filter moments">${groups.map(([g, label]) => `<button class="chip ${groupFilter === g ? 'is-on' : ''}" data-inf-group="${g}" ${g !== 'all' ? `style="--c: var(--inf-${g})"` : ''}>${label}${g === 'all' ? '' : ` <span class="chip-n">${counts[g] ?? 0}</span>`}</button>`).join('')}</div>
      <div class="inf-list">${shown.length ? shown.map((i) => inflectionItem(i)).join('') : '<p class="note">Nothing in this group.</p>'}</div>
    </section>
    ${st.toolCalls ? `<section class="d-section">
      <h3>Tools</h3>
      ${categoryStack(st.byCategory, st.toolCalls)}
      <table class="tools-table"><thead><tr><th>Tool</th><th class="num">Calls</th><th class="num">Time</th><th class="num">Errors</th></tr></thead><tbody>${toolRows}</tbody></table>
    </section>` : ''}
    ${st.models.length ? `<p class="note">Models: ${st.models.map(escapeHtml).join(', ')}</p>` : ''}
  </div>`;
}
