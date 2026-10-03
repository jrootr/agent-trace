// OpenTelemetry interop: export traces as OTLP/JSON, and import OTLP/JSON from any source.
//
// Export follows the OpenTelemetry GenAI semantic conventions (gen_ai.*), so traces land in
// Jaeger, Tempo, Langfuse, Phoenix, etc. as chat / execute_tool / invoke_agent spans. Everything
// else is kept under the agent_trace.* prefix, which lets an exported trace round-trip losslessly.
import { createTrace, addSpan, finalizeTrace } from '../core/model.mjs';
import { categorizeTool, phaseOf } from '../core/categories.mjs';
import { hashHex, truncateText } from '../core/util.mjs';

const OTLP_KIND_INTERNAL = 1;
const OTLP_KIND_CLIENT = 3;
const ATTR_PREFIX = 'agent_trace.';
const MAX_ATTR_CHARS = 8192;

export function looksLikeOtlp(text) {
  return /"resourceSpans"\s*:/.test(text.slice(0, 20000));
}

function toAnyValue(v) {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.filter((x) => x != null).map(toAnyValue) } };
  return { stringValue: JSON.stringify(v) };
}

function fromAnyValue(v) {
  if (!v || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('boolValue' in v) return v.boolValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('arrayValue' in v) return (v.arrayValue?.values ?? []).map(fromAnyValue);
  if ('kvlistValue' in v) return attrsToObject(v.kvlistValue?.values ?? []);
  if ('bytesValue' in v) return v.bytesValue;
  return null;
}

function objectToAttrs(obj) {
  const out = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    out.push({ key, value: toAnyValue(value) });
  }
  return out;
}

function attrsToObject(list) {
  const out = {};
  for (const kv of list ?? []) out[kv.key] = fromAnyValue(kv.value);
  return out;
}

const msToNanos = (ms) => (BigInt(Math.round(ms * 1000)) * 1000n).toString();
const nanosToMs = (n) => Number(BigInt(String(n ?? 0)) / 1000n) / 1000;

function otlpTraceId(trace) {
  const hex = String(trace.id ?? '').replace(/-/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) ? hex : hashHex(`trace:${trace.id}`, 32);
}

function ioAttr(value) {
  if (value === undefined || value === null) return undefined;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return truncateText(s, MAX_ATTR_CHARS);
}

/** GenAI semantic-convention name and attributes for one span. */
function genAiShape(span, trace) {
  const a = span.attrs ?? {};
  switch (span.kind) {
    case 'session':
      return { name: span.name, attrs: { 'gen_ai.conversation.id': trace.id } };
    case 'turn':
    case 'agent':
      return {
        name: span.name,
        attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': trace.source, 'gen_ai.conversation.id': trace.id },
      };
    case 'llm':
      return {
        name: `chat ${a['llm.model'] ?? span.name}`,
        kind: OTLP_KIND_CLIENT,
        attrs: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': trace.source === 'claude-code' ? 'anthropic' : undefined,
          'gen_ai.request.model': a['llm.model'],
          'gen_ai.response.model': a['llm.model'],
          'gen_ai.usage.input_tokens': a['llm.tokens.context'],
          'gen_ai.usage.output_tokens': a['llm.tokens.output'],
          'gen_ai.response.finish_reasons': a['llm.stop_reason'] ? [a['llm.stop_reason']] : undefined,
          'gen_ai.conversation.id': trace.id,
        },
      };
    case 'tool':
      return {
        name: `execute_tool ${span.name}`,
        kind: OTLP_KIND_CLIENT,
        attrs: {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': span.name,
          'gen_ai.tool.call.id': a['tool.call_id'],
          'gen_ai.tool.type': 'function',
        },
      };
    default:
      return { name: span.name, attrs: {} };
  }
}

/**
 * Convert a trace to an OTLP/JSON ExportTraceServiceRequest.
 * options.includeIo (default true): attach inputs/outputs as attributes (truncated).
 * options.inflections: [{ spanId, kind, label, time }] added as span events.
 */
export function toOtlp(trace, options = {}) {
  const includeIo = options.includeIo !== false;
  const traceId = otlpTraceId(trace);
  const spanIds = new Map(trace.spans.map((s) => [s.id, hashHex(`${trace.id}/${s.id}`, 16)]));
  const eventsBySpan = new Map();
  const rootId = trace.spans.find((s) => !s.parentId)?.id;
  const pushEvent = (spanId, ev) => {
    const key = spanIds.has(spanId) ? spanId : rootId;
    if (!eventsBySpan.has(key)) eventsBySpan.set(key, []);
    eventsBySpan.get(key).push(ev);
  };
  for (const e of trace.events) {
    pushEvent(e.spanId, {
      timeUnixNano: msToNanos(e.time),
      name: `${ATTR_PREFIX}${e.kind}`,
      attributes: objectToAttrs({ label: e.label, detail: e.detail }),
    });
  }
  for (const inf of options.inflections ?? []) {
    pushEvent(inf.spanId, {
      timeUnixNano: msToNanos(inf.time),
      name: `${ATTR_PREFIX}inflection`,
      attributes: objectToAttrs({ kind: inf.kind, label: inf.label, detail: inf.detail }),
    });
  }

  const spans = trace.spans.map((s) => {
    const shape = genAiShape(s, trace);
    const own = {};
    for (const [k, v] of Object.entries(s.attrs ?? {})) own[ATTR_PREFIX + k] = v;
    own[`${ATTR_PREFIX}kind`] = s.kind;
    own[`${ATTR_PREFIX}id`] = s.id;
    own[`${ATTR_PREFIX}name`] = s.name;
    if (includeIo) {
      own[`${ATTR_PREFIX}input`] = ioAttr(s.input);
      own[`${ATTR_PREFIX}output`] = ioAttr(s.output);
    }
    const out = {
      traceId,
      spanId: spanIds.get(s.id),
      name: shape.name,
      kind: shape.kind ?? OTLP_KIND_INTERNAL,
      startTimeUnixNano: msToNanos(s.start),
      endTimeUnixNano: msToNanos(s.end),
      attributes: objectToAttrs({ ...shape.attrs, ...own }),
      events: eventsBySpan.get(s.id) ?? [],
      status: s.status === 'error'
        ? { code: 2, message: String(s.attrs?.['error.message'] ?? 'error') }
        : { code: s.status === 'ok' ? 1 : 0 },
    };
    if (s.parentId && spanIds.has(s.parentId)) out.parentSpanId = spanIds.get(s.parentId);
    return out;
  });

  const resource = { 'service.name': trace.source ?? 'agent-trace', [`${ATTR_PREFIX}title`]: trace.title, [`${ATTR_PREFIX}trace_id`]: trace.id };
  for (const [k, v] of Object.entries(trace.meta ?? {})) {
    if (v !== null && (typeof v !== 'object' || Array.isArray(v))) resource[`${ATTR_PREFIX}meta.${k}`] = v;
  }
  return {
    resourceSpans: [
      {
        resource: { attributes: objectToAttrs(resource) },
        scopeSpans: [{ scope: { name: 'agent-trace', version: '1' }, spans }],
      },
    ],
  };
}

function kindFromAttrs(attrs, hasParent) {
  if (attrs[`${ATTR_PREFIX}kind`]) return attrs[`${ATTR_PREFIX}kind`];
  const op = attrs['gen_ai.operation.name'];
  if (op === 'chat' || op === 'text_completion' || op === 'generate_content' || op === 'embeddings') return 'llm';
  if (op === 'execute_tool') return 'tool';
  if (op === 'invoke_agent' || op === 'create_agent') return 'agent';
  return hasParent ? 'span' : 'session';
}

/** Parse an OTLP/JSON payload into one trace per traceId, largest first. */
export function fromOtlp(input) {
  const doc = typeof input === 'string' ? JSON.parse(input) : input;
  const groups = new Map();
  for (const rs of doc.resourceSpans ?? []) {
    const resource = attrsToObject(rs.resource?.attributes);
    for (const ss of rs.scopeSpans ?? rs.instrumentationLibrarySpans ?? []) {
      for (const sp of ss.spans ?? []) {
        if (!groups.has(sp.traceId)) groups.set(sp.traceId, { resource, spans: [] });
        groups.get(sp.traceId).spans.push(sp);
      }
    }
  }

  const traces = [];
  for (const [traceId, { resource, spans }] of groups) {
    const meta = { otlpTraceId: traceId, serviceName: resource['service.name'] ?? null };
    for (const [k, v] of Object.entries(resource)) {
      if (k.startsWith(`${ATTR_PREFIX}meta.`)) meta[k.slice(ATTR_PREFIX.length + 5)] = v;
    }
    const trace = createTrace({
      id: resource[`${ATTR_PREFIX}trace_id`] ?? traceId,
      title: resource[`${ATTR_PREFIX}title`] ?? null,
      source: resource['service.name'] && resource['service.name'] !== 'agent-trace' ? String(resource['service.name']) : 'otlp',
      meta,
    });
    const present = new Set(spans.map((s) => s.spanId));
    const idMap = new Map();
    for (const sp of spans) {
      const a = attrsToObject(sp.attributes);
      idMap.set(sp.spanId, a[`${ATTR_PREFIX}id`] ?? sp.spanId);
    }
    for (const sp of spans) {
      const a = attrsToObject(sp.attributes);
      const hasParent = Boolean(sp.parentSpanId && present.has(sp.parentSpanId));
      const kind = kindFromAttrs(a, hasParent);
      const attrs = {};
      for (const [k, v] of Object.entries(a)) {
        if (k.startsWith(ATTR_PREFIX)) {
          const bare = k.slice(ATTR_PREFIX.length);
          if (!['kind', 'id', 'name', 'input', 'output'].includes(bare)) attrs[bare] = v;
        } else attrs[k] = v;
      }
      // Fill our own fields from GenAI conventions when the trace came from elsewhere.
      if (kind === 'llm') {
        attrs['llm.model'] ??= a['gen_ai.response.model'] ?? a['gen_ai.request.model'] ?? null;
        attrs['llm.tokens.context'] ??= a['gen_ai.usage.input_tokens'];
        attrs['llm.tokens.output'] ??= a['gen_ai.usage.output_tokens'];
      }
      let name = a[`${ATTR_PREFIX}name`] ?? sp.name;
      if (kind === 'tool') {
        name = a[`${ATTR_PREFIX}name`] ?? a['gen_ai.tool.name'] ?? String(sp.name).replace(/^execute_tool\s+/, '');
        attrs['tool.category'] ??= categorizeTool(name);
        attrs['tool.phase'] ??= phaseOf(name, undefined, attrs['tool.category']);
      }
      const code = sp.status?.code;
      const status = code === 2 || code === 'STATUS_CODE_ERROR' ? 'error' : code === 1 || code === 'STATUS_CODE_OK' ? 'ok' : 'unset';
      if (status === 'error' && sp.status?.message) attrs['error.message'] ??= sp.status.message;
      const span = {
        id: idMap.get(sp.spanId),
        parentId: hasParent ? idMap.get(sp.parentSpanId) : null,
        kind,
        name,
        start: nanosToMs(sp.startTimeUnixNano),
        end: nanosToMs(sp.endTimeUnixNano),
        status,
        attrs,
      };
      if (a[`${ATTR_PREFIX}input`] !== undefined) span.input = a[`${ATTR_PREFIX}input`];
      if (a[`${ATTR_PREFIX}output`] !== undefined) span.output = a[`${ATTR_PREFIX}output`];
      addSpan(trace, span);
      for (const ev of sp.events ?? []) {
        if (ev.name === `${ATTR_PREFIX}inflection`) continue; // recomputed by the analyzer
        const ea = attrsToObject(ev.attributes);
        const evKind = ev.name.startsWith(ATTR_PREFIX) ? ev.name.slice(ATTR_PREFIX.length) : ev.name === 'exception' ? 'error' : 'event';
        trace.events.push({
          time: nanosToMs(ev.timeUnixNano),
          kind: evKind,
          label: ea.label ?? ea['exception.message'] ?? ev.name,
          spanId: span.id,
          detail: ea.detail,
        });
      }
    }
    finalizeTrace(trace);
    if (!trace.title) trace.title = trace.spans.find((s) => !s.parentId)?.name ?? `Trace ${traceId.slice(0, 8)}`;
    traces.push(trace);
  }
  return traces.sort((a, b) => b.spans.length - a.spans.length);
}
