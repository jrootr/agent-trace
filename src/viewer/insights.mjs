// Insights panel: scoped stats, opportunities (actionable savings), story, moments, hot spots.
import { escapeHtml, fmtDuration, fmtTokens, fmtClock, icon, INFLECTION_ICONS } from './format.mjs';
import { INFLECTION_KINDS, computeStats, sliceTrace } from '../core/analysis.mjs';
import { findOpportunities, summarizeOpportunities, OPPORTUNITY_KINDS } from '../core/opportunities.mjs';
import { colorVarFor, inflectionItem, categoryStack } from './panels.mjs';

const STORY_MAX = 40;
const MOMENT_GROUPS = [['all', 'All'], ['error', 'Errors'], ['pivot', 'Pivots'], ['thinking', 'Thinking'], ['user', 'User'], ['milestone', 'Milestones']];

function scopeBar(scope) {
  const seg = (mode, label) => `<button class="seg-btn" role="radio" aria-checked="${scope.mode === mode}" data-scope="${mode}">${label}</button>`;
  return `<div class="scope-bar">
    <div class="seg" role="radiogroup" aria-label="Insights scope">${seg('auto', 'Selection')}${seg('session', 'Session')}${seg('view', 'Visible range')}</div>
    <div class="scope-label" title="${escapeHtml(scope.label)}">${escapeHtml(scope.label)}</div>
  </div>`;
}

function opportunitiesHtml(opportunities, gains) {
  if (!opportunities.length) {
    return '<div class="gains is-clean"><b>No obvious savings here.</b><span>No redundant reads, repeated failures, bloated outputs or slow loops in this scope.</span></div>';
  }
  const pills = (o) => [
    o.impact.timeMs >= 1000 ? `<span class="pill">~${fmtDuration(o.impact.timeMs)}</span>` : '',
    o.impact.tokens >= 500 ? `<span class="pill">~${fmtTokens(o.impact.tokens)} tokens</span>` : '',
  ].join('');
  const headline = [
    gains.timeMs >= 1000 ? `up to ~${fmtDuration(gains.timeMs)} (${Math.round(gains.share * 100)}% of active time)` : '',
    gains.tokens >= 500 ? `~${fmtTokens(gains.tokens)} tokens` : '',
  ].filter(Boolean).join(' and ');
  const cards = opportunities.map((o) => `<article class="opp conf-${o.confidence}">
      <div class="opp-icon">${icon(OPPORTUNITY_KINDS[o.kind]?.icon ?? 'spark', 15)}</div>
      <div class="opp-body">
        <div class="opp-kind">${escapeHtml(OPPORTUNITY_KINDS[o.kind]?.label ?? o.kind)}<span class="opp-conf">${o.confidence} confidence</span></div>
        <h4>${escapeHtml(o.title)}</h4>
        <p class="opp-detail">${escapeHtml(o.detail)}</p>
        <p class="opp-action"><b>Try:</b> ${escapeHtml(o.action)}</p>
        <div class="opp-foot">${pills(o)}<button class="btn sm" data-evidence="${o.id}">Show ${o.evidence.length} call${o.evidence.length === 1 ? '' : 's'}</button></div>
      </div></article>`).join('');
  return `<div class="gains">
      <div class="gains-head"><b>${opportunities.length === 1 ? '1 opportunity' : `${opportunities.length} opportunities`}</b>${headline ? `<span>${headline}</span>` : ''}</div>
      <div class="gains-bar" title="Share of active time that could be saved"><i style="width:${(gains.share * 100).toFixed(1)}%"></i></div>
    </div>
    <div class="opp-list">${cards}</div>
    <p class="note">Estimates: a saved round trip counts as a typical model call in this scope; text counts as ~4 characters per token. Overlapping suggestions can double-count.</p>`;
}

function timeSplit(st) {
  const wall = Math.max(1, st.wallTime);
  const waiting = Math.max(0, wall - st.modelTime - st.toolTime);
  const total = Math.max(wall, st.modelTime + st.toolTime);
  const part = (ms, cls, label) => (ms > 0 ? `<i class="${cls}" style="width:${((ms / total) * 100).toFixed(2)}%" title="${label}: ${fmtDuration(ms)}"></i>` : '');
  return `<section class="d-section"><h3>Where the time went</h3>
    <div class="split-bar">${part(st.modelTime, 'sp-model', 'Model')}${part(st.toolTime, 'sp-tools', 'Tools')}${part(waiting, 'sp-wait', 'Waiting / idle')}</div>
    <div class="legend"><span><i class="sp-model"></i>Model <b>${fmtDuration(st.modelTime)}</b></span><span><i class="sp-tools"></i>Tools <b>${fmtDuration(st.toolTime)}</b></span><span><i class="sp-wait"></i>Waiting / idle <b>${fmtDuration(waiting)}</b></span></div>
  </section>`;
}

function storyHtml(slice, inflections, sortTime, selectedId) {
  const items = [
    ...slice.spans.filter((s) => s.kind === 'llm' && typeof s.output === 'string' && s.output.trim()).map((span) => ({ time: span.start, span })),
    ...inflections.filter((i) => i.kind !== 'thinking').map((inf) => ({ time: inf.time, inf })),
  ].sort(sortTime);
  const body = items.length
    ? `<ol class="story">${items.slice(0, STORY_MAX).map((item) => {
      if (item.inf) {
        const g = INFLECTION_KINDS[item.inf.kind]?.group ?? 'system';
        return `<li class="story-moment" style="--c: var(--inf-${g})"><button data-inflection="${escapeHtml(item.inf.id)}" data-span="${escapeHtml(item.inf.spanId ?? '')}">${icon(INFLECTION_ICONS[item.inf.kind] ?? 'spark', 13)}<span>${escapeHtml(item.inf.label)}</span><time>${fmtClock(item.time)}</time></button></li>`;
      }
      const s = item.span;
      const text = s.output.replace(/\s+/g, ' ').trim();
      const thought = s.attrs?.['llm.tokens.thinking'] ? `<span class="story-think">${fmtTokens(s.attrs['llm.tokens.thinking'])} thinking</span>` : '';
      return `<li class="story-say${s.id === selectedId ? ' is-current' : ''}"><button data-goto="${escapeHtml(s.id)}"><span class="story-text">${escapeHtml(text.length > 220 ? text.slice(0, 219) + '…' : text)}</span><span class="story-meta"><time>${fmtClock(s.start)}</time>${thought}</span></button></li>`;
    }).join('')}</ol>${items.length > STORY_MAX ? `<p class="note">Showing ${STORY_MAX} of ${items.length}. Narrow the scope to see the rest.</p>` : ''}`
    : '<p class="note">The agent said nothing in this scope; it only called tools.</p>';
  return `<section class="d-section"><h3>Story <span class="count">${items.length}</span></h3><p class="note section-note">What the agent said as it went, with the moments in between. Click to inspect.</p>${body}</section>`;
}

function slowestHtml(slice) {
  const slowest = slice.spans.filter((s) => s.kind === 'llm' || s.kind === 'tool').sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 5);
  if (!slowest.length) return '';
  const max = Math.max(1, ...slowest.map((s) => s.end - s.start));
  const rows = slowest.map((s) => {
    const sub = s.kind === 'tool' ? s.attrs?.['tool.summary'] ?? '' : s.attrs?.['llm.tokens.thinking'] ? `${fmtTokens(s.attrs['llm.tokens.thinking'])} thinking` : '';
    return `<button class="rank-row" data-goto="${escapeHtml(s.id)}">
      <span class="dot" style="background:${colorVarFor(s)}"></span>
      <span class="rank-name">${escapeHtml(s.kind === 'llm' ? 'Model call' : s.name)}<small>${escapeHtml(sub)}</small></span>
      <span class="bar-cell"><i style="width:${(((s.end - s.start) / max) * 100).toFixed(1)}%;background:${colorVarFor(s)}"></i></span>
      <span class="rank-val">${fmtDuration(s.end - s.start)}</span></button>`;
  }).join('');
  return `<section class="d-section"><h3>Slowest calls</h3><div class="rank">${rows}</div></section>`;
}

function momentsHtml(inflections, group, sortTime) {
  const counts = {};
  for (const inf of inflections) {
    const g = INFLECTION_KINDS[inf.kind]?.group ?? 'system';
    counts[g] = (counts[g] ?? 0) + 1;
  }
  const shown = inflections.filter((inf) => group === 'all' || INFLECTION_KINDS[inf.kind]?.group === group).sort(sortTime);
  const chips = MOMENT_GROUPS.map(([g, label]) => `<button class="chip ${group === g ? 'is-on' : ''}" data-inf-group="${g}" ${g !== 'all' ? `style="--c: var(--inf-${g})"` : ''}>${label}${g === 'all' ? '' : ` <span class="chip-n">${counts[g] ?? 0}</span>`}</button>`).join('');
  return `<section class="d-section">
    <h3>Moments <span class="count">${inflections.length}</span></h3>
    <div class="chips" role="group" aria-label="Filter moments">${chips}</div>
    <div class="inf-list">${shown.length ? shown.map((i) => inflectionItem(i)).join('') : '<p class="note">Nothing in this group.</p>'}</div>
  </section>`;
}

function toolsHtml(st) {
  if (!st.toolCalls) return '';
  const maxCount = Math.max(1, ...st.topTools.map((x) => x.count));
  const rows = st.topTools.slice(0, 12).map((x) => `<tr data-tool="${escapeHtml(x.name)}">
      <td><span class="dot" style="background:var(--cat-${x.category})"></span>${escapeHtml(x.name)}</td>
      <td class="num"><span class="bar-cell"><i style="width:${((x.count / maxCount) * 100).toFixed(1)}%;background:var(--cat-${x.category})"></i></span>${x.count}</td>
      <td class="num">${fmtDuration(x.time)}</td>
      <td class="num ${x.errors ? 'has-error' : ''}">${x.errors || ''}</td></tr>`).join('');
  return `<section class="d-section"><h3>Tools</h3>${categoryStack(st.byCategory, st.toolCalls)}
    <table class="tools-table"><thead><tr><th>Tool</th><th class="num">Calls</th><th class="num">Time</th><th class="num">Errors</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

/**
 * Insights for a scope: the whole session, one turn/subagent subtree, or a time window.
 * scope: { mode: 'auto' | 'session' | 'view', label, rootId?, t0?, t1? }
 * Returns the HTML and the opportunities shown (so "Show calls" can resolve their evidence).
 */
export function renderInsights(prepared, { scope = { mode: 'session', label: 'Whole session' }, group = 'all', order = 'asc', selectedId = null } = {}) {
  const slice = sliceTrace(prepared.trace, { rootId: scope.rootId ?? null, t0: scope.t0 ?? null, t1: scope.t1 ?? null });
  const st = computeStats(slice);
  const ids = new Set(slice.spans.map((s) => s.id));
  const inflections = prepared.inflections.filter((inf) =>
    scope.rootId ? ids.has(inf.spanId) : scope.t0 != null ? inf.time >= scope.t0 && inf.time <= scope.t1 : true);
  const opportunities = findOpportunities(slice);
  const gains = summarizeOpportunities(opportunities, st.activeTime);
  const sortTime = (a, b) => (order === 'desc' ? b.time - a.time : a.time - b.time);
  const card = (label, value, sub = '', cls = '') => `<div class="card ${cls}"><span class="card-label">${label}</span><b class="card-value">${value}</b>${sub ? `<span class="card-sub">${sub}</span>` : ''}</div>`;
  const activePct = st.wallTime ? Math.round((st.activeTime / st.wallTime) * 100) : 0;

  const html = `<div class="insights">
    ${scopeBar(scope)}
    <section class="d-section"><h3>Opportunities</h3>${opportunitiesHtml(opportunities, gains)}</section>
    <section class="cards">
      ${card('Active time', fmtDuration(st.activeTime), `${activePct}% of ${fmtDuration(st.wallTime)}`)}
      ${card('Model calls', st.llmCalls, fmtDuration(st.modelTime))}
      ${card('Tool calls', st.toolCalls, fmtDuration(st.toolTime))}
      ${card('Errors', st.errors, st.errors ? 'failed tool calls' : 'none', st.errors ? 'has-error' : '')}
      ${card('Output', fmtTokens(st.tokens.output), `${fmtTokens(st.tokens.thinking)} thinking`)}
      ${card('Peak context', fmtTokens(st.tokens.peakContext), `${fmtTokens(st.tokens.cacheRead)} read from cache`)}
    </section>
    ${st.llmCalls + st.toolCalls ? timeSplit(st) : ''}
    ${storyHtml(slice, inflections, sortTime, selectedId)}
    ${momentsHtml(inflections, group, sortTime)}
    ${slowestHtml(slice)}
    ${toolsHtml(st)}
    ${st.models.length ? `<p class="note">Models: ${st.models.map(escapeHtml).join(', ')}</p>` : ''}
  </div>`;
  return { html, opportunities, stats: st };
}
