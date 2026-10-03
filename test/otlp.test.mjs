import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toOtlp, fromOtlp, looksLikeOtlp } from '../src/adapters/otlp.mjs';
import { parseClaudeTranscript } from '../src/adapters/claude-code.mjs';
import { findInflections } from '../src/core/analysis.mjs';
import { validateTrace } from '../src/core/model.mjs';
import { fixtureText } from './fixtures/transcript.mjs';

const trace = parseClaudeTranscript(fixtureText());
const inflections = findInflections(trace);
const doc = toOtlp(trace, { inflections });
const spans = doc.resourceSpans[0].scopeSpans[0].spans;
const attr = (span, key) => {
  const v = span.attributes.find((a) => a.key === key)?.value;
  return v && (v.stringValue ?? (v.intValue !== undefined ? Number(v.intValue) : v.doubleValue ?? v.boolValue ?? v.arrayValue));
};

test('export: valid OTLP ids, times and parent links', () => {
  assert.ok(looksLikeOtlp(JSON.stringify(doc)));
  assert.equal(spans.length, trace.spans.length);
  const ids = new Set(spans.map((s) => s.spanId));
  assert.equal(ids.size, spans.length);
  for (const s of spans) {
    assert.match(s.traceId, /^[0-9a-f]{32}$/);
    assert.match(s.spanId, /^[0-9a-f]{16}$/);
    assert.match(s.startTimeUnixNano, /^\d+$/);
    assert.ok(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano));
    if (s.parentSpanId) assert.ok(ids.has(s.parentSpanId));
  }
  assert.equal(spans[0].traceId, '11111111222233334444555555555555', 'UUID session ids become the trace id');
  assert.equal(spans.filter((s) => !s.parentSpanId).length, 1);
});

test('export: GenAI semantic conventions on model and tool spans', () => {
  const llm = spans.find((s) => attr(s, 'agent_trace.id') === 'llm-msg_A');
  assert.equal(llm.name, 'chat claude-test-1');
  assert.equal(llm.kind, 3);
  assert.equal(attr(llm, 'gen_ai.operation.name'), 'chat');
  assert.equal(attr(llm, 'gen_ai.provider.name'), 'anthropic');
  assert.equal(attr(llm, 'gen_ai.request.model'), 'claude-test-1');
  assert.equal(attr(llm, 'gen_ai.usage.input_tokens'), 1210);
  assert.equal(attr(llm, 'gen_ai.usage.output_tokens'), 300);
  const bash = spans.find((s) => attr(s, 'gen_ai.tool.call.id') === 't_bash1');
  assert.equal(bash.name, 'execute_tool Bash');
  assert.equal(attr(bash, 'gen_ai.operation.name'), 'execute_tool');
  assert.equal(attr(bash, 'gen_ai.tool.name'), 'Bash');
  assert.deepEqual(bash.status, { code: 2, message: attr(bash, 'agent_trace.error.message') });
  const turn = spans.find((s) => attr(s, 'agent_trace.kind') === 'turn');
  assert.equal(attr(turn, 'gen_ai.operation.name'), 'invoke_agent');
});

test('export: events and inflections become span events; IO can be dropped', () => {
  const allEvents = spans.flatMap((s) => s.events);
  assert.ok(allEvents.some((e) => e.name === 'agent_trace.interjection'));
  assert.equal(allEvents.filter((e) => e.name === 'agent_trace.inflection').length, inflections.length);
  const lean = toOtlp(trace, { includeIo: false });
  assert.ok(!JSON.stringify(lean).includes('agent_trace.input'));
  assert.ok(JSON.stringify(doc).includes('agent_trace.input'));
});

test('round trip: OTLP back to the same trace', () => {
  const [back] = fromOtlp(JSON.stringify(doc));
  assert.deepEqual(validateTrace(back), []);
  assert.equal(back.id, trace.id);
  assert.equal(back.title, trace.title);
  assert.equal(back.source, 'claude-code');
  assert.equal(back.spans.length, trace.spans.length);
  const orig = new Map(trace.spans.map((s) => [s.id, s]));
  for (const s of back.spans) {
    const o = orig.get(s.id);
    assert.ok(o, `span ${s.id} survived`);
    assert.equal(s.kind, o.kind);
    assert.equal(s.name, o.name);
    assert.equal(s.parentId, o.parentId);
    assert.equal(s.status, o.status);
    assert.ok(Math.abs(s.start - o.start) < 1 && Math.abs(s.end - o.end) < 1);
    for (const [k, v] of Object.entries(o.attrs)) assert.deepEqual(s.attrs[k], v, `${s.id} attr ${k}`);
  }
  assert.equal(back.events.length, trace.events.length);
  assert.deepEqual(findInflections(back).map((i) => i.kind), inflections.map((i) => i.kind), 'analysis gives the same answer');
});

test('import: OTLP from another GenAI-instrumented app', () => {
  const ns = (ms) => String(BigInt(ms) * 1000000n);
  const t0 = Date.parse('2026-02-02T12:00:00Z');
  const kv = (key, value) => ({ key, value: typeof value === 'number' ? { intValue: value } : { stringValue: value } });
  const foreign = {
    resourceSpans: [{
      resource: { attributes: [kv('service.name', 'support-bot')] },
      scopeSpans: [{
        scope: { name: 'openinference' },
        spans: [
          { traceId: 'aa'.repeat(16), spanId: '01'.repeat(8), name: 'invoke_agent support', startTimeUnixNano: ns(t0), endTimeUnixNano: ns(t0 + 9000), attributes: [kv('gen_ai.operation.name', 'invoke_agent')] },
          { traceId: 'aa'.repeat(16), spanId: '02'.repeat(8), parentSpanId: '01'.repeat(8), name: 'chat gpt-x', startTimeUnixNano: ns(t0), endTimeUnixNano: ns(t0 + 3000), attributes: [kv('gen_ai.operation.name', 'chat'), kv('gen_ai.request.model', 'gpt-x'), kv('gen_ai.usage.input_tokens', 900), { key: 'gen_ai.usage.output_tokens', value: { intValue: '120' } }] },
          { traceId: 'aa'.repeat(16), spanId: '03'.repeat(8), parentSpanId: '01'.repeat(8), name: 'execute_tool lookup_order', startTimeUnixNano: ns(t0 + 3000), endTimeUnixNano: ns(t0 + 4000), attributes: [kv('gen_ai.operation.name', 'execute_tool'), kv('gen_ai.tool.name', 'lookup_order')], status: { code: 'STATUS_CODE_ERROR', message: 'order not found' }, events: [{ name: 'exception', timeUnixNano: ns(t0 + 3900), attributes: [kv('exception.message', 'order not found')] }] },
          { traceId: 'aa'.repeat(16), spanId: '04'.repeat(8), parentSpanId: 'ffffffffffffffff', name: 'orphan', startTimeUnixNano: ns(t0 + 5000), endTimeUnixNano: ns(t0 + 6000) },
          { traceId: 'bb'.repeat(16), spanId: '05'.repeat(8), name: 'tiny other trace', startTimeUnixNano: ns(t0), endTimeUnixNano: ns(t0 + 1) },
        ],
      }],
    }],
  };
  const traces = fromOtlp(foreign);
  assert.equal(traces.length, 2);
  const [t] = traces;
  assert.deepEqual(validateTrace(t), []);
  assert.equal(t.source, 'support-bot');
  assert.equal(t.title, 'invoke_agent support');
  const kinds = Object.fromEntries(t.spans.map((s) => [s.name, s.kind]));
  assert.deepEqual(kinds, { 'invoke_agent support': 'agent', 'chat gpt-x': 'llm', lookup_order: 'tool', orphan: 'session' });
  const llm = t.spans.find((s) => s.kind === 'llm');
  assert.equal(llm.attrs['llm.model'], 'gpt-x');
  assert.equal(llm.attrs['llm.tokens.context'], 900);
  assert.equal(llm.attrs['llm.tokens.output'], 120);
  const toolSpan = t.spans.find((s) => s.kind === 'tool');
  assert.equal(toolSpan.status, 'error');
  assert.equal(toolSpan.attrs['error.message'], 'order not found');
  assert.equal(toolSpan.attrs['tool.category'], 'other');
  assert.deepEqual(t.events.map((e) => [e.kind, e.label]), [['error', 'order not found']]);
  assert.ok(findInflections(t).some((i) => i.kind === 'error'));
});
