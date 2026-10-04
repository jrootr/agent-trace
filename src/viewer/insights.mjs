// Session-level panels (left: Opportunities, Overview) and scoped Insights (right).
import { escapeHtml, fmtDuration, fmtTokens, fmtClock, fmtNumber, icon, INFLECTION_ICONS } from './format.mjs';
import { INFLECTION_KINDS, computeStats, sliceTrace } from '../core/analysis.mjs';
import { summarizeOpportunities, OPPORTUNITY_KINDS } from '../core/opportunities.mjs';
import { colorVarFor, inflectionItem, categoryStack, kv, section, spanLabel, opportunityRefs } from './panels.mjs';

const STORY_MAX = 40;
const MOMENT_GROUPS = [['all', 'All'], ['error', 'Errors'], ['pivot', 'Pivots'], ['thinking', 'Thinking'], ['user', 'User'], ['milestone', 'Milestones']];

const impactText = (o) => [
  o.impact.timeMs >= 1000 ? `~${fmtDuration(o.impact.timeMs)}` : '',
  o.impact.tokens >= 500 ? `~${fmtTokens(o.impact.tokens)} tok` : '',
].filter(Boolean).join(' · ') || '–';

function statsGrid(st) {
  const activePct = st.wallTime ? Math.round((st.activeTime / st.wallTime) * 100) : 0;
  return kv([
    ['Active time', `${fmtDuration(st.activeTime)} (${activePct}% of ${fmtDuration(st.wallTime)})`],
    ['Model', `${fmtNumber(st.llmCalls)} calls · ${fmtDuration(st.modelTime)}`],
    ['Tools', `${fmtNumber(st.toolCalls)} calls · ${fmtDuration(st.toolTime)}`],
    ['Errors', fmtNumber(st.errors), { cls: st.errors ? 'is-error' : '' }],
    ['Output tokens', `${fmtNumber(st.tokens.output)} (${fmtTokens(st.tokens.thinking)} thinking)`],
    ['Peak context', `${fmtNumber(st.tokens.peakContext)} tokens`],
    ['Cache reads', `${fmtTokens(st.tokens.cacheRead)} tokens`],
    ['Turns / subagents', `${st.turns} / ${st.subagents}`],
  ]);
}

function timeSplit(st) {
  if (!st.llmCalls && !st.toolCalls) return '';
  const wall = Math.max(1, st.wallTime);
  const waiting = Math.max(0, wall - st.modelTime - st.toolTime);
  const total = Math.max(wall, st.modelTime + st.toolTime);
  const part = (ms, cls, label) => (ms > 0 ? `<i class="${cls}" style="width:${((ms / total) * 100).toFixed(2)}%" title="${label}: ${fmtDuration(ms)}"></i>` : '');
  return section('Where the time went', `<div class="bar split">${part(st.modelTime, 'sp-model', 'Model')}${part(st.toolTime, 'sp-tools', 'Tools')}${part(waiting, 'sp-wait', 'Waiting / idle')}</div>
    <div class="legend small"><span><i class="sp-model"></i>Model <b>${fmtDuration(st.modelTime)}</b></span><span><i class="sp-tools"></i>Tools <b>${fmtDuration(st.toolTime)}</b></span><span><i class="sp-wait"></i>Waiting / idle <b>${fmtDuration(waiting)}</b></span></div>`);
}

function momentsSection(inflections, group, sortTime, title = 'Moments') {
  const counts = {};
  for (const inf of inflections) {
    const g = INFLECTION_KINDS[inf.kind]?.group ?? 'system';
    counts[g] = (counts[g] ?? 0) + 1;
  }
  const shown = inflections.filter((inf) => group === 'all' || INFLECTION_KINDS[inf.kind]?.group === group).sort(sortTime);
  const seg = MOMENT_GROUPS.filter(([g]) => g === 'all' || counts[g])
    .map(([g, label]) => `<button class="seg-btn" role="radio" aria-checked="${group === g}" data-inf-group="${g}">${label}${g === 'all' ? '' : ` <span class="n">${counts[g]}</span>`}</button>`).join('');
  return section(title, `<div class="seg" role="radiogroup" aria-label="Filter moments">${seg}</div>
    <div class="rows">${shown.length ? shown.map((i) => inflectionItem(i)).join('') : '<p class="note">None.</p>'}</div>`, ` <span class="n">${inflections.length}</span>`);
}

function toolsTable(st) {
  if (!st.toolCalls) return '';
  const maxCount = Math.max(1, ...st.topTools.map((x) => x.count));
  const rows = st.topTools.slice(0, 15).map((x) => `<tr data-tool="${escapeHtml(x.name)}" title="Search the call list for ${escapeHtml(x.name)}">
      <td><span class="sw" style="--c:var(--cat-${x.category})"></span>${escapeHtml(x.name)}</td>
      <td class="num"><span class="mini"><i style="width:${((x.count / maxCount) * 100).toFixed(1)}%"></i></span>${x.count}</td>
      <td class="num">${fmtDuration(x.time)}</td>
      <td class="num ${x.errors ? 'is-error' : ''}">${x.errors || ''}</td></tr>`).join('');
  return section('Tools', `${categoryStack(st.byCategory, st.toolCalls)}
    <table class="table"><thead><tr><th>Tool</th><th class="num">Calls</th><th class="num">Time</th><th class="num">Errors</th></tr></thead><tbody>${rows}</tbody></table>`);
}

/** Left panel → Opportunities: the session's ranked list. Rows expand to their evidence. */
export function renderOpportunityList(prepared, { expandedId = null } = {}) {
  const opps = prepared.opportunities;
  if (!opps.length) {
    return '<div class="pane-empty"><b>No opportunities found.</b><p class="note">No redundant reads, repeated failures, bloated outputs or slow loops in this session.</p></div>';
  }
  const gains = summarizeOpportunities(opps, prepared.stats.activeTime);
  const head = `<div class="opp-summary">
    <div><b>${opps.length}</b> ranked by estimated impact. Combined: ${[
      gains.timeMs >= 1000 ? `up to ~${fmtDuration(gains.timeMs)} (${Math.round(gains.share * 100)}% of active time)` : '',
      gains.tokens >= 500 ? `~${fmtTokens(gains.tokens)} tokens` : '',
    ].filter(Boolean).join(', ') || 'small'}.</div>
    <div class="bar"><i class="sp-gain" style="width:${(gains.share * 100).toFixed(1)}%"></i></div>
  </div>`;
  const rows = opps.map((o) => {
    const open = o.id === expandedId;
    const evidence = open
      ? o.evidence.map((id) => prepared.byId.get(id)).filter(Boolean).map((s) => `<button class="row-btn ev" data-goto="${escapeHtml(s.id)}">
          <span class="sw" style="--c:${colorVarFor(s)}"></span><span class="row-kind">${escapeHtml(spanLabel(s))}</span>
          <span class="row-text mono">${escapeHtml(s.attrs?.['tool.summary'] ?? s.name)}</span><span class="row-time">${fmtDuration(s.end - s.start)}</span></button>`).join('')
      : '';
    return `<div class="opp ${open ? 'is-open' : ''}" data-opp-row="${escapeHtml(o.id)}">
      <button class="opp-head" data-opp="${escapeHtml(o.id)}" aria-expanded="${open}">
        <span class="rank">#${o.rank}</span>
        <span class="opp-main"><span class="opp-kind">${escapeHtml(OPPORTUNITY_KINDS[o.kind]?.label ?? o.kind)}</span><span class="opp-title">${escapeHtml(o.title)}</span></span>
        <span class="opp-impact">${impactText(o)}</span>
        <span class="opp-conf conf-${o.confidence}" title="Confidence">${o.confidence}</span>
        <span class="chev">${icon('chevron', 13)}</span>
      </button>
      ${open ? `<div class="opp-body">
        <p>${escapeHtml(o.detail)}</p>
        <p><span class="label">Suggested fix</span> ${escapeHtml(o.action)}</p>
        <div class="opp-actions"><button class="btn sm" data-evidence="${escapeHtml(o.id)}">Highlight ${o.evidence.length} call${o.evidence.length === 1 ? '' : 's'} on timeline</button></div>
        <div class="sub-head">Evidence</div>
        <div class="rows">${evidence}</div>
      </div>` : ''}
    </div>`;
  }).join('');
  return `${head}<div class="opp-list">${rows}</div>
    <p class="note pad">Estimates: a saved round trip counts as this session's median model call; text counts as ~4 characters per token. Overlapping items can double-count.</p>`;
}

/** Left panel → Overview: session-wide numbers. */
export function renderOverview(prepared, { group = 'all', order = 'asc' } = {}) {
  const st = prepared.stats;
  const sortTime = (a, b) => (order === 'desc' ? b.time - a.time : a.time - b.time);
  return `<div class="overview">
    ${section('Totals', statsGrid(st))}
    ${timeSplit(st)}
    ${momentsSection(prepared.inflections, group, sortTime)}
    ${toolsTable(st)}
    ${st.models.length ? `<p class="note pad">Models: ${st.models.map(escapeHtml).join(', ')}</p>` : ''}
  </div>`;
}

/**
 * Right panel → Insights for the selection's turn/subagent, or the visible time range.
 * scope: { mode: 'selection' | 'view', rootId?, t0?, t1?, label } or null when there's nothing to scope to.
 */
export function renderScopedInsights(prepared, { scope, order = 'asc', selectedId = null, group = 'all' } = {}) {
  const seg = (mode, label) => `<button class="seg-btn" role="radio" aria-checked="${scope?.mode === mode}" data-scope="${mode}">${label}</button>`;
  const bar = `<div class="scope"><span class="label">Scope</span><div class="seg" role="radiogroup" aria-label="Insights scope">${seg('selection', 'Selected turn')}${seg('view', 'Visible range')}</div></div>`;
  if (!scope) {
    return { stats: null, opportunities: [], html: `${bar}<div class="pane-empty"><p>Select a step to see insights for its turn, or switch to <b>Visible range</b>.</p><p class="note">Session-wide numbers are under <b>Session → Overview</b>; ranked savings under <b>Session → Opportunities</b>.</p></div>` };
  }
  const slice = sliceTrace(prepared.trace, { rootId: scope.rootId ?? null, t0: scope.t0 ?? null, t1: scope.t1 ?? null });
  const st = computeStats(slice);
  const ids = new Set(slice.spans.map((s) => s.id));
  const inflections = prepared.inflections.filter((inf) => (scope.rootId ? ids.has(inf.spanId) : inf.time >= scope.t0 && inf.time <= scope.t1));
  const opps = prepared.opportunities.filter((o) => o.evidence.some((id) => ids.has(id)));
  const sortTime = (a, b) => (order === 'desc' ? b.time - a.time : a.time - b.time);

  const story = [
    ...slice.spans.filter((s) => s.kind === 'llm' && typeof s.output === 'string' && s.output.trim()).map((span) => ({ time: span.start, span })),
    ...inflections.filter((i) => i.kind !== 'thinking').map((inf) => ({ time: inf.time, inf })),
  ].sort(sortTime);
  const storyRows = story.slice(0, STORY_MAX).map((item) => {
    if (item.inf) {
      const g = INFLECTION_KINDS[item.inf.kind]?.group ?? 'system';
      return `<button class="row-btn msg is-moment" style="--c: var(--inf-${g})" data-inflection="${escapeHtml(item.inf.id)}" data-span="${escapeHtml(item.inf.spanId ?? '')}"><span class="row-time">${fmtClock(item.time)}</span><span class="glyph">${icon(INFLECTION_ICONS[item.inf.kind] ?? 'spark', 12)}</span><span class="row-text">${escapeHtml(item.inf.label)}</span></button>`;
    }
    const s = item.span;
    const text = s.output.replace(/\s+/g, ' ').trim();
    return `<button class="row-btn msg${s.id === selectedId ? ' is-current' : ''}" data-goto="${escapeHtml(s.id)}"><span class="row-time">${fmtClock(s.start)}</span><span class="row-text">${escapeHtml(text.length > 240 ? text.slice(0, 239) + '…' : text)}</span></button>`;
  }).join('');

  const slowest = slice.spans.filter((s) => s.kind === 'llm' || s.kind === 'tool').sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 5);
  const slowMax = Math.max(1, ...slowest.map((s) => s.end - s.start));
  const slowRows = slowest.map((s) => `<button class="row-btn" data-goto="${escapeHtml(s.id)}">
      <span class="sw" style="--c:${colorVarFor(s)}"></span><span class="row-kind">${escapeHtml(spanLabel(s))}</span>
      <span class="row-text mono">${escapeHtml(s.kind === 'tool' ? s.attrs?.['tool.summary'] ?? '' : s.attrs?.['llm.tokens.thinking'] ? `${fmtTokens(s.attrs['llm.tokens.thinking'])} thinking tokens` : '')}</span>
      <span class="mini"><i style="width:${(((s.end - s.start) / slowMax) * 100).toFixed(1)}%"></i></span><span class="row-time">${fmtDuration(s.end - s.start)}</span></button>`).join('');

  const html = `<div class="insights">
    ${bar}
    <div class="scope-label">${escapeHtml(scope.label)}</div>
    ${section('Summary', statsGrid(st))}
    ${section('Opportunities involving this scope', opps.length ? opportunityRefs(opps) : '<p class="note">None of the session\'s opportunities involve this scope.</p>', ` <span class="n">${opps.length}</span>`)}
    ${timeSplit(st)}
    ${section('Agent messages', story.length ? `<div class="rows">${storyRows}</div>${story.length > STORY_MAX ? `<p class="note">Showing ${STORY_MAX} of ${story.length}.</p>` : ''}` : '<p class="note">The agent sent no messages in this scope; it only called tools.</p>', ` <span class="n">${story.length}</span>`)}
    ${momentsSection(inflections, group, sortTime)}
    ${slowest.length ? section('Slowest steps', `<div class="rows">${slowRows}</div>`) : ''}
  </div>`;
  return { html, stats: st, opportunities: opps };
}
