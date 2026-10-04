// Tiny observable store. Components subscribe and re-render only for the keys they care about.
import { indexTrace, sanitizeTrace } from '../core/model.mjs';
import { findInflections, computeStats } from '../core/analysis.mjs';
import { findOpportunities } from '../core/opportunities.mjs';

export function createStore(initial) {
  let state = initial;
  const subscribers = new Set();
  return {
    get: () => state,
    set(patch) {
      const changed = Object.keys(patch).filter((k) => state[k] !== patch[k]);
      if (!changed.length) return;
      state = { ...state, ...patch };
      for (const fn of subscribers) fn(state, new Set(changed));
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}

/** Everything derived from a trace once, up front, so rendering stays cheap. */
export function prepareTrace(trace) {
  sanitizeTrace(trace); // embedded data skips parseAny, so sanitize here too
  const { byId, children } = indexTrace(trace);
  const inflections = findInflections(trace);
  const stats = computeStats(trace);
  // ranked once for the whole session, so the left list and the right panel agree on rank
  const opportunities = findOpportunities(trace).map((o, i) => ({ ...o, rank: i + 1 }));
  const opportunitiesBySpan = new Map();
  for (const o of opportunities) {
    for (const id of o.evidence) {
      if (!opportunitiesBySpan.has(id)) opportunitiesBySpan.set(id, []);
      opportunitiesBySpan.get(id).push(o);
    }
  }
  const inflectionsBySpan = new Map();
  for (const inf of inflections) {
    if (!inf.spanId) continue;
    if (!inflectionsBySpan.has(inf.spanId)) inflectionsBySpan.set(inf.spanId, []);
    inflectionsBySpan.get(inf.spanId).push(inf);
  }
  const depth = new Map();
  const walkDepth = (parentKey, d) => {
    for (const s of children.get(parentKey) ?? []) {
      depth.set(s.id, d);
      walkDepth(s.id, d + 1);
    }
  };
  walkDepth(null, 0);
  const searchText = new Map();
  const textFor = (s) => {
    if (!searchText.has(s.id)) {
      const io = (v) => (v == null ? '' : typeof v === 'string' ? v.slice(0, 4000) : JSON.stringify(v).slice(0, 4000));
      searchText.set(s.id, `${s.name} ${s.attrs?.['tool.summary'] ?? ''} ${io(s.input)} ${io(s.output)}`.toLowerCase());
    }
    return searchText.get(s.id);
  };
  return { trace, byId, children, depth, inflections, inflectionsBySpan, opportunities, opportunitiesBySpan, stats, textFor };
}

export function ancestorsOf(prepared, id) {
  const out = [];
  let cur = prepared.byId.get(id);
  while (cur && cur.parentId && prepared.byId.has(cur.parentId)) {
    cur = prepared.byId.get(cur.parentId);
    out.unshift(cur);
  }
  return out;
}
