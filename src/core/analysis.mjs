// Analysis over a normalized trace: summary statistics and "inflection points", the moments
// where the agent's course changed. They're inferred from behavior (errors, pivots, heavy
// thinking, user steering) because raw reasoning text is usually not available.
import { PHASE_LABELS } from './categories.mjs';
import { percentile } from './util.mjs';
import { indexTrace } from './model.mjs';

export const INFLECTION_KINDS = {
  recovery: { label: 'Recovered from error', group: 'error' },
  retry: { label: 'Retried after error', group: 'error' },
  error: { label: 'Unresolved error', group: 'error' },
  pivot: { label: 'Changed phase', group: 'pivot' },
  thinking: { label: 'Heavy thinking', group: 'thinking' },
  slow: { label: 'Slow model call', group: 'thinking' },
  interjection: { label: 'User steered', group: 'user' },
  interrupt: { label: 'User interrupted', group: 'user' },
  milestone: { label: 'Milestone', group: 'milestone' },
  compaction: { label: 'Context compacted', group: 'system' },
};

const byStart = (a, b) => a.start - b.start;

/** Tool input as an object; imported traces (e.g. via OTLP) carry it as a JSON string. */
function inputObject(span) {
  const v = span.input;
  if (v && typeof v === 'object') return v;
  if (typeof v === 'string' && v.trim().startsWith('{')) {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return null;
}

function sameInput(a, b) {
  return JSON.stringify(a.input ?? null) === JSON.stringify(b.input ?? null);
}

function groupByParent(spans) {
  const map = new Map();
  for (const s of spans) {
    const k = s.parentId ?? '';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(s);
  }
  return map;
}

function errorInflections(tools, out) {
  for (const [, list] of groupByParent(tools)) {
    list.sort(byStart);
    list.forEach((s) => {
      if (s.status !== 'error') return;
      // what the agent did once it saw the failure (calls already running in parallel don't count)
      const next = list.find((x) => x !== s && x.start >= s.end);
      const detail = s.attrs?.['error.message'];
      if (next && next.name === s.name && sameInput(next, s)) {
        out.push({ kind: 'retry', spanId: next.id, time: next.start, label: `Retried ${s.name}${next.status === 'error' ? ' (failed again)' : ''}`, detail });
      } else if (next) {
        out.push({ kind: 'recovery', spanId: s.id, time: s.end, label: `${s.name} failed, then ${next.name}`, detail });
      } else {
        out.push({ kind: 'error', spanId: s.id, time: s.end, label: `${s.name} failed`, detail });
      }
    });
  }
}

/** Runs of explore/build/verify per turn, smoothed so a single stray call isn't a "pivot". */
function pivotInflections(tools, out) {
  for (const [, list] of groupByParent(tools)) {
    const phased = list.sort(byStart).filter((s) => s.attrs?.['tool.phase']);
    const runs = [];
    for (const s of phased) {
      const p = s.attrs['tool.phase'];
      const last = runs[runs.length - 1];
      if (last && last.phase === p) last.spans.push(s);
      else runs.push({ phase: p, spans: [s] });
    }
    // drop 1-call blips between runs of the same phase, then merge neighbours again
    const smooth = runs.filter((r, i) => !(r.spans.length === 1 && runs[i - 1] && runs[i + 1] && runs[i - 1].phase === runs[i + 1].phase));
    const merged = [];
    for (const r of smooth) {
      const last = merged[merged.length - 1];
      if (last && last.phase === r.phase) last.spans.push(...r.spans);
      else merged.push({ phase: r.phase, spans: [...r.spans] });
    }
    for (let i = 1; i < merged.length; i++) {
      const from = merged[i - 1];
      const to = merged[i];
      if (from.spans.length < 2 && i - 1 > 0) continue;
      const first = to.spans[0];
      out.push({ kind: 'pivot', spanId: first.id, time: first.start, label: `${PHASE_LABELS[from.phase]} → ${PHASE_LABELS[to.phase]}` });
    }
  }
}

function thinkingInflections(llms, out) {
  const thinking = llms.map((s) => s.attrs?.['llm.tokens.thinking'] ?? 0).filter((n) => n > 0);
  if (thinking.length) {
    const threshold = Math.max(1500, percentile(thinking, 90));
    for (const s of llms) {
      const n = s.attrs?.['llm.tokens.thinking'] ?? 0;
      if (n >= threshold) out.push({ kind: 'thinking', spanId: s.id, time: s.start, label: `Thought for ${n.toLocaleString('en-US')} tokens`, value: n });
    }
    return;
  }
  // No reasoning-token data (e.g. imported traces): fall back to unusually slow calls.
  const durations = llms.map((s) => s.end - s.start);
  const threshold = Math.max(30000, percentile(durations, 90) * 1.5);
  for (const s of llms) {
    const d = s.end - s.start;
    if (d >= threshold) out.push({ kind: 'slow', spanId: s.id, time: s.start, label: `Model call took ${Math.round(d / 1000)}s`, value: d });
  }
}

export function findInflections(trace) {
  const out = [];
  const tools = trace.spans.filter((s) => s.kind === 'tool');
  const llms = trace.spans.filter((s) => s.kind === 'llm');
  errorInflections(tools, out);
  pivotInflections(tools, out);
  thinkingInflections(llms, out);
  for (const e of trace.events) {
    if (e.kind === 'interjection' || e.kind === 'interrupt' || e.kind === 'compaction') {
      out.push({ kind: e.kind, spanId: e.spanId ?? null, time: e.time, label: e.label, detail: e.detail });
    }
  }
  for (const s of tools) {
    const input = inputObject(s);
    if (/mark_chapter$/.test(s.name) && input) {
      out.push({ kind: 'milestone', spanId: s.id, time: s.start, label: String(input.title ?? 'Chapter'), detail: input.summary });
    } else if (s.name === 'ExitPlanMode') {
      out.push({ kind: 'milestone', spanId: s.id, time: s.start, label: 'Plan presented' });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out.map((inf, i) => ({ id: `inf-${i + 1}`, ...inf }));
}

/** Total length of the union of [start, end) intervals. */
export function unionDuration(intervals) {
  const sorted = intervals.filter((iv) => iv.end > iv.start).sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = null;
  let curEnd = null;
  for (const iv of sorted) {
    if (curEnd === null || iv.start > curEnd) {
      if (curEnd !== null) total += curEnd - curStart;
      curStart = iv.start;
      curEnd = iv.end;
    } else if (iv.end > curEnd) curEnd = iv.end;
  }
  if (curEnd !== null) total += curEnd - curStart;
  return total;
}

export function computeStats(trace) {
  const spans = trace.spans;
  const llms = spans.filter((s) => s.kind === 'llm');
  const tools = spans.filter((s) => s.kind === 'tool');
  const sum = (key) => llms.reduce((n, s) => n + (Number(s.attrs?.[key]) || 0), 0);
  const byCategory = {};
  const byTool = {};
  for (const t of tools) {
    const c = t.attrs?.['tool.category'] ?? 'other';
    const d = t.end - t.start;
    byCategory[c] ??= { count: 0, time: 0, errors: 0 };
    byCategory[c].count++;
    byCategory[c].time += d;
    byTool[t.name] ??= { name: t.name, category: c, count: 0, time: 0, errors: 0 };
    byTool[t.name].count++;
    byTool[t.name].time += d;
    if (t.status === 'error') {
      byCategory[c].errors++;
      byTool[t.name].errors++;
    }
  }
  return {
    wallTime: trace.end - trace.start,
    activeTime: unionDuration(spans.filter((s) => s.kind === 'llm' || s.kind === 'tool')),
    modelTime: unionDuration(llms),
    toolTime: unionDuration(tools),
    turns: spans.filter((s) => s.kind === 'turn').length,
    llmCalls: llms.length,
    toolCalls: tools.length,
    subagents: spans.filter((s) => s.kind === 'agent').length,
    errors: tools.filter((t) => t.status === 'error').length,
    tokens: {
      input: sum('llm.tokens.input'),
      cacheRead: sum('llm.tokens.cache_read'),
      cacheWrite: sum('llm.tokens.cache_write'),
      output: sum('llm.tokens.output'),
      thinking: sum('llm.tokens.thinking'),
      peakContext: llms.reduce((m, s) => Math.max(m, Number(s.attrs?.['llm.tokens.context']) || 0), 0),
    },
    models: [...new Set(llms.map((s) => s.attrs?.['llm.model']).filter(Boolean))],
    byCategory,
    topTools: Object.values(byTool).sort((a, b) => b.count - a.count || b.time - a.time),
  };
}

/**
 * Part of a trace, shaped like a trace, for scoped statistics: one span's subtree (rootId),
 * or everything overlapping a time window [t0, t1] with spans clipped to it.
 */
export function sliceTrace(trace, { rootId = null, t0 = null, t1 = null } = {}) {
  if (rootId) {
    const { byId, children } = indexTrace(trace);
    const root = byId.get(rootId);
    if (!root) return { ...trace, spans: [], events: [] };
    const ids = new Set();
    const stack = [root];
    while (stack.length) {
      const s = stack.pop();
      ids.add(s.id);
      stack.push(...(children.get(s.id) ?? []));
    }
    return {
      ...trace,
      start: root.start,
      end: root.end,
      spans: trace.spans.filter((s) => ids.has(s.id)),
      events: trace.events.filter((e) => (e.spanId && ids.has(e.spanId)) || (!e.spanId && e.time >= root.start && e.time <= root.end)),
    };
  }
  if (t0 != null && t1 != null) {
    return {
      ...trace,
      start: t0,
      end: t1,
      spans: trace.spans
        .filter((s) => s.end >= t0 && s.start <= t1)
        .map((s) => ({ ...s, start: Math.max(s.start, t0), end: Math.min(s.end, t1) })),
      events: trace.events.filter((e) => e.time >= t0 && e.time <= t1),
    };
  }
  return trace;
}
