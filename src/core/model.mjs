// The normalized trace model every adapter produces and the viewer consumes.
//
// Trace  { id, title, source, start, end, spans: Span[], events: TraceEvent[], meta }
// Span   { id, parentId, kind, name, start, end, status, attrs, input?, output? }
//          kind:   'session' | 'turn' | 'llm' | 'tool' | 'agent' | 'span'
//          status: 'ok' | 'error' | 'unset'
//          start/end: epoch milliseconds
// TraceEvent { time, kind, label, spanId?, detail? }   instant markers (interjections, compactions…)
//
// It mirrors OpenTelemetry spans closely so OTLP import/export is a direct mapping.

export const SCHEMA_VERSION = 1;

export function createTrace({ id, title, source, meta = {} }) {
  return { schema: SCHEMA_VERSION, id, title, source, start: null, end: null, spans: [], events: [], meta };
}

export function addSpan(trace, span) {
  const s = {
    id: span.id,
    parentId: span.parentId ?? null,
    kind: span.kind ?? 'span',
    name: span.name ?? span.kind ?? 'span',
    start: span.start,
    end: Math.max(span.end ?? span.start, span.start),
    status: span.status ?? 'unset',
    attrs: span.attrs ?? {},
  };
  if (span.input !== undefined) s.input = span.input;
  if (span.output !== undefined) s.output = span.output;
  trace.spans.push(s);
  return s;
}

/** Set trace start/end from its spans and events, and widen parents to cover their children. */
export function finalizeTrace(trace) {
  const { byId, children } = indexTrace(trace);
  const widen = (span) => {
    for (const child of children.get(span.id) ?? []) {
      widen(child);
      if (child.start < span.start) span.start = child.start;
      if (child.end > span.end) span.end = child.end;
    }
  };
  for (const s of trace.spans) if (!s.parentId || !byId.has(s.parentId)) widen(s);
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of trace.spans) {
    if (s.start < lo) lo = s.start;
    if (s.end > hi) hi = s.end;
  }
  for (const e of trace.events) {
    if (e.time < lo) lo = e.time;
    if (e.time > hi) hi = e.time;
  }
  trace.start = Number.isFinite(lo) ? lo : 0;
  trace.end = Number.isFinite(hi) ? hi : trace.start;
  trace.spans.sort((a, b) => a.start - b.start || kindOrder(a.kind) - kindOrder(b.kind));
  trace.events.sort((a, b) => a.time - b.time);
  return trace;
}

const KIND_ORDER = { session: 0, turn: 1, agent: 2, llm: 3, tool: 4, span: 5 };
function kindOrder(kind) {
  return KIND_ORDER[kind] ?? 9;
}

export function indexTrace(trace) {
  const byId = new Map();
  const children = new Map();
  for (const s of trace.spans) byId.set(s.id, s);
  for (const s of trace.spans) {
    const key = s.parentId && byId.has(s.parentId) ? s.parentId : null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(s);
  }
  for (const list of children.values()) list.sort((a, b) => a.start - b.start || kindOrder(a.kind) - kindOrder(b.kind));
  return { byId, children };
}

/** Problems that would make a trace unusable in the viewer. Empty array = valid. */
export function validateTrace(trace) {
  const problems = [];
  if (!trace || typeof trace !== 'object') return ['trace is not an object'];
  if (!Array.isArray(trace.spans)) problems.push('trace.spans must be an array');
  const ids = new Set();
  for (const s of trace.spans ?? []) {
    if (!s.id) problems.push('span without id');
    else if (ids.has(s.id)) problems.push(`duplicate span id ${s.id}`);
    ids.add(s.id);
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end)) problems.push(`span ${s.id} has non-numeric times`);
    else if (s.end < s.start) problems.push(`span ${s.id} ends before it starts`);
  }
  for (const s of trace.spans ?? []) {
    if (s.parentId && !ids.has(s.parentId)) problems.push(`span ${s.id} has unknown parent ${s.parentId}`);
  }
  return problems;
}
