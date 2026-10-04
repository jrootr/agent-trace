// Selection panel: the header that names what is selected, and the Details drill-down.
import { escapeHtml, fmtDuration, fmtTokens, fmtNumber, fmtClock, fmtOffset, prettyValue, icon, INFLECTION_ICONS } from './format.mjs';
import { INFLECTION_KINDS } from '../core/analysis.mjs';
import { OPPORTUNITY_KINDS } from '../core/opportunities.mjs';
import { CATEGORY_LABELS, PHASE_LABELS } from '../core/categories.mjs';
import { ancestorsOf } from './store.mjs';

const PREVIEW_CHARS = 6000;

export const KIND_LABELS = { session: 'Session', turn: 'Turn', llm: 'Model call', tool: 'Tool call', agent: 'Subagent', span: 'Span' };

export function colorVarFor(s) {
  if (s.status === 'error') return 'var(--error)';
  if (s.kind === 'turn') return 'var(--turn-strong)';
  if (s.kind === 'llm') return 'var(--llm)';
  if (s.kind === 'agent') return 'var(--cat-agent)';
  if (s.kind === 'tool') return `var(--cat-${s.attrs?.['tool.category'] ?? 'other'})`;
  return 'var(--text-3)';
}

/** "Turn 3", "Model call", "Bash": how a span is named in headers and breadcrumbs. */
export function spanLabel(s) {
  if (s.kind === 'session') return 'Session';
  if (s.kind === 'turn') return `Turn ${s.attrs?.['turn.index'] ?? ''}`.trim();
  if (s.kind === 'llm') return 'Model call';
  return s.name;
}

export function section(title, body, extra = '') {
  return body ? `<section class="sec"><h3>${escapeHtml(title)}${extra}</h3>${body}</section>` : '';
}

/** Key/value grid: [label, value, { mono, cls }] */
export function kv(pairs) {
  const rows = pairs.filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!rows.length) return '';
  return `<dl class="kv">${rows.map(([k, v, o = {}]) => `<div class="${o.cls ?? ''}"><dt>${escapeHtml(k)}</dt><dd class="${o.mono ? 'mono' : ''}" title="${escapeHtml(String(v))}">${escapeHtml(String(v))}</dd></div>`).join('')}</dl>`;
}

/** Collects long text blocks so copy / expand buttons can reach the full content. */
function blockCollector() {
  const blocks = [];
  const add = (title, text, { open = true } = {}) => {
    if (text == null || text === '') return '';
    const full = String(text);
    const i = blocks.push(full) - 1;
    const shown = full.length > PREVIEW_CHARS ? full.slice(0, PREVIEW_CHARS) : full;
    const more = full.length > PREVIEW_CHARS
      ? `<button class="link-btn more" data-expand="${i}">Show all ${fmtNumber(full.length)} characters</button>` : '';
    return `<details class="block" ${open ? 'open' : ''}><summary><span>${escapeHtml(title)}</span>` +
      `<span class="block-meta">${fmtNumber(full.length)} chars</span>` +
      `<button class="icon-btn xs" data-copy="${i}" title="Copy ${escapeHtml(title.toLowerCase())}" aria-label="Copy ${escapeHtml(title.toLowerCase())}">${icon('copy', 13)}</button></summary>` +
      `<pre class="code" data-block="${i}">${escapeHtml(shown)}</pre>${more}</details>`;
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
    <div class="tok-row"><span class="tok-label">Input</span><span class="bar">${seg(read, ctx, 'seg-cache', 'Cache read')}${seg(write, ctx, 'seg-write', 'Cache write')}${seg(fresh, ctx, 'seg-fresh', 'Fresh input')}</span><span class="tok-num">${fmtNumber(ctx)}</span></div>
    <div class="tok-row"><span class="tok-label">Output</span><span class="bar">${seg(think, out, 'seg-think', 'Thinking')}${seg(out - think, out, 'seg-out', 'Visible output')}</span><span class="tok-num">${fmtNumber(out)}</span></div>
    <div class="legend small"><span><i class="seg-cache"></i>cache read ${fmtTokens(read)}</span><span><i class="seg-write"></i>cache write ${fmtTokens(write)}</span><span><i class="seg-fresh"></i>fresh ${fmtTokens(fresh)}</span><span><i class="seg-think"></i>thinking ${fmtTokens(think)}</span><span><i class="seg-out"></i>visible ${fmtTokens(out - think)}</span></div>
  </div>`;
}

export function inflectionItem(inf, { showTime = true } = {}) {
  const group = INFLECTION_KINDS[inf.kind]?.group ?? 'system';
  return `<button class="row-btn inf-row" data-inflection="${escapeHtml(inf.id)}" data-span="${escapeHtml(inf.spanId ?? '')}" style="--c: var(--inf-${group})">` +
    `<span class="glyph">${icon(INFLECTION_ICONS[inf.kind] ?? 'spark', 13)}</span>` +
    `<span class="row-kind">${escapeHtml(INFLECTION_KINDS[inf.kind]?.label ?? inf.kind)}</span>` +
    `<span class="row-text">${escapeHtml(inf.label)}</span>` +
    (showTime ? `<span class="row-time">${fmtClock(inf.time)}</span>` : '') +
    '</button>';
}

/** Compact links to session opportunities (ranked) that involve a span or scope. */
export function opportunityRefs(opps) {
  if (!opps.length) return '';
  return `<div class="rows">${opps.map((o) => `<button class="row-btn opp-ref" data-opp-open="${escapeHtml(o.id)}" title="Open in Session → Opportunities">` +
    `<span class="rank">#${o.rank}</span><span class="row-kind">${escapeHtml(OPPORTUNITY_KINDS[o.kind]?.label ?? o.kind)}</span>` +
    `<span class="row-text">${escapeHtml(o.title)}</span><span class="row-time">${icon('chevron', 12)}</span></button>`).join('')}</div>`;
}

export function categoryStack(byCategory, total) {
  const entries = Object.entries(byCategory).sort((a, b) => b[1].count - a[1].count);
  if (!entries.length) return '';
  return `<div class="bar stack" role="img" aria-label="Tool calls by category">${entries.map(([c, v]) => `<i style="width:${((v.count / total) * 100).toFixed(2)}%;background:var(--cat-${c})" title="${escapeHtml(CATEGORY_LABELS[c] ?? c)}: ${v.count}"></i>`).join('')}</div>` +
    `<div class="legend small">${entries.map(([c, v]) => `<span><i style="background:var(--cat-${c})"></i>${escapeHtml(CATEGORY_LABELS[c] ?? c)} <b>${v.count}</b></span>`).join('')}</div>`;
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
  if (!all.length) return '';
  const tools = all.filter((c) => c.kind === 'tool');
  const llms = all.filter((c) => c.kind === 'llm');
  const byCategory = {};
  for (const t of tools) {
    const c = t.attrs?.['tool.category'] ?? 'other';
    byCategory[c] ??= { count: 0 };
    byCategory[c].count++;
  }
  const out = llms.reduce((n, l) => n + (l.attrs?.['llm.tokens.output'] ?? 0), 0);
  const errors = tools.filter((t) => t.status === 'error').length;
  return kv([
    ['Model calls', llms.length],
    ['Tool calls', tools.length],
    ['Output tokens', fmtNumber(out)],
    ['Errors', errors, { cls: errors ? 'is-error' : '' }],
  ]) + (tools.length ? categoryStack(byCategory, tools.length) : '');
}

/** Always-visible header naming exactly what the right panel applies to. */
export function renderSelectionHeader(prepared, spanId) {
  const s = spanId ? prepared.byId.get(spanId) : null;
  if (!s) {
    return '<div class="sel is-empty"><span>Nothing selected.</span> <span class="muted">Click a bar on the timeline, or a row under <b>Session → Calls</b>.</span></div>';
  }
  const a = s.attrs ?? {};
  const sub = s.kind === 'tool' || s.kind === 'agent' ? a['tool.summary'] : s.kind === 'llm' ? a['llm.model'] : s.kind === 'turn' ? s.name : '';
  const category = s.kind === 'tool' ? CATEGORY_LABELS[a['tool.category']] : '';
  const status = s.status === 'error' ? '<span class="status is-error">Failed</span>' : '';
  const id = a['tool.call_id'] ?? s.id;
  const path = ancestorsOf(prepared, s.id)
    .map((p) => `<button class="crumb" data-goto="${escapeHtml(p.id)}" title="${escapeHtml(p.name)}">${escapeHtml(p.kind === 'turn' ? `${spanLabel(p)}: ${p.name}` : spanLabel(p))}</button>`)
    .concat(`<span class="crumb is-current">${escapeHtml(spanLabel(s))}</span>`)
    .join(`<span class="crumb-sep">/</span>`);
  const siblings = (prepared.children.get(s.parentId && prepared.byId.has(s.parentId) ? s.parentId : null) ?? []).filter((x) => x.kind !== 'session');
  const idx = siblings.indexOf(s);
  const prev = siblings[idx - 1];
  const next = siblings[idx + 1];
  return `<div class="sel">
    <div class="sel-top">
      <span class="sw" style="--c:${colorVarFor(s)}"></span>
      <span class="sel-kind">${escapeHtml(KIND_LABELS[s.kind] ?? s.kind)}${category ? ` · ${escapeHtml(category)}` : ''}</span>${status}
      <span class="sel-nav">
        <button class="icon-btn xs" ${prev ? `data-goto="${escapeHtml(prev.id)}"` : 'disabled'} title="Previous sibling" aria-label="Previous sibling"><span class="flip">${icon('chevron', 13)}</span></button>
        <button class="icon-btn xs" ${next ? `data-goto="${escapeHtml(next.id)}"` : 'disabled'} title="Next sibling" aria-label="Next sibling">${icon('chevron', 13)}</button>
        <button class="icon-btn xs" data-zoom="${escapeHtml(s.id)}" title="Zoom timeline to this (Enter)" aria-label="Zoom timeline to this">${icon('fit', 13)}</button>
      </span>
    </div>
    <div class="sel-title">${escapeHtml(s.kind === 'turn' ? spanLabel(s) : s.kind === 'llm' ? 'Model call' : s.name)}${sub ? `<span class="sel-sub">${escapeHtml(sub)}</span>` : ''}</div>
    <div class="sel-path">${path}</div>
    <div class="sel-id"><span class="muted">ID</span> <code>${escapeHtml(id)}</code><button class="icon-btn xs" data-copy-text="${escapeHtml(id)}" title="Copy ID" aria-label="Copy ID">${icon('copy', 12)}</button></div>
  </div>`;
}

export function renderDetails(prepared, spanId) {
  const s = prepared.byId.get(spanId);
  if (!s) return { html: '', blocks: [] };
  const a = s.attrs ?? {};
  const { blocks, add } = blockCollector();
  const timing = [
    ['Started', fmtClock(s.start, true)],
    ['Offset', fmtOffset(s.start - prepared.trace.start)],
    ['Duration', fmtDuration(s.end - s.start)],
  ];
  if (s.kind === 'llm') {
    timing.push(['Model', a['llm.model']], ['Stop reason', a['llm.stop_reason']], ['Tool calls', a['llm.tool_calls']]);
  }
  if (s.kind === 'tool') {
    timing.push(['Category', CATEGORY_LABELS[a['tool.category']] ?? a['tool.category']], ['Phase', PHASE_LABELS[a['tool.phase']]]);
  }
  const infs = prepared.inflectionsBySpan.get(s.id) ?? [];
  const opps = prepared.opportunitiesBySpan?.get(s.id) ?? [];

  let io = '';
  if (s.kind === 'turn' || s.kind === 'session') io += add('Prompt', s.input);
  if (s.kind === 'llm') {
    io += add('Response', s.output);
    if (a['llm.thinking']) io += add('Reasoning', a['llm.thinking'], { open: false });
    else if (a['llm.thinking_blocks']) io += '<p class="note">The model reasoned here, but the transcript doesn\'t store reasoning text. The token count above shows how much.</p>';
  }
  if (s.kind === 'tool' || s.kind === 'agent' || s.kind === 'span') {
    io += add('Input', prettyValue(s.input));
    io += add(s.status === 'error' ? 'Error output' : 'Output', prettyValue(s.output));
  }

  const attrRows = Object.entries(a)
    .filter(([k]) => k !== 'llm.thinking')
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(typeof v === 'string' ? v : JSON.stringify(v))}</td></tr>`)
    .join('');

  const html = `<div class="details">
    ${s.status === 'error' && a['error.message'] ? `<div class="callout is-error">${icon('alert', 13)}<span>${escapeHtml(a['error.message'])}</span></div>` : ''}
    ${section('Timing', kv(timing))}
    ${s.kind === 'llm' ? section('Tokens', tokenBars(a)) : ''}
    ${section('Opportunities involving this step', opportunityRefs(opps))}
    ${section('Moments', infs.length ? `<div class="rows">${infs.map((i) => inflectionItem(i, { showTime: false })).join('')}</div>` : '')}
    ${io ? `<section class="sec">${io}</section>` : ''}
    ${s.kind === 'turn' || s.kind === 'agent' || s.kind === 'session' ? section(`Inside this ${s.kind === 'agent' ? 'subagent' : s.kind}`, childSummary(prepared, s)) : ''}
    ${attrRows ? `<details class="block attrs"><summary><span>All attributes</span><span class="block-meta">${Object.keys(a).length}</span></summary><table>${attrRows}</table></details>` : ''}
  </div>`;
  return { html, blocks };
}
