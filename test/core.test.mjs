import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findInflections, computeStats, unionDuration } from '../src/core/analysis.mjs';
import { createTrace, addSpan, finalizeTrace, validateTrace } from '../src/core/model.mjs';
import { categorizeTool, phaseOf, summarizeToolInput } from '../src/core/categories.mjs';
import { redactValue, isSecretKeyName } from '../src/core/redact.mjs';
import { hashHex, percentile, truncateText } from '../src/core/util.mjs';
import { parseAny, registerAdapter, listAdapters } from '../src/adapters/registry.mjs';
import { parseClaudeTranscript } from '../src/adapters/claude-code.mjs';
import { fixtureText, T0 } from './fixtures/transcript.mjs';

const trace = parseClaudeTranscript(fixtureText());

test('inflections: recovery, pivot, heavy thinking, user steering, milestone, compaction', () => {
  const inf = findInflections(trace);
  const kinds = inf.map((i) => i.kind);
  assert.ok(kinds.includes('recovery'));
  assert.ok(kinds.includes('thinking'));
  assert.ok(kinds.includes('interjection'));
  assert.ok(kinds.includes('interrupt'));
  assert.ok(kinds.includes('compaction'));
  const recovery = inf.find((i) => i.kind === 'recovery');
  assert.equal(recovery.label, 'Bash failed, then Edit');
  const milestone = inf.find((i) => i.kind === 'milestone');
  assert.equal(milestone.label, 'Tests green');
  const thinking = inf.filter((i) => i.kind === 'thinking');
  assert.equal(thinking.length, 1, 'only the unusually heavy call is flagged');
  assert.equal(thinking[0].spanId, 'llm-msg_A');
  const pivots = inf.filter((i) => i.kind === 'pivot').map((i) => i.label);
  assert.deepEqual(pivots, ['Exploring → Building'], 'one-call blips are smoothed away');
  assert.deepEqual(inf.map((i) => i.time), [...inf.map((i) => i.time)].sort((a, b) => a - b), 'sorted by time');
  assert.equal(new Set(inf.map((i) => i.id)).size, inf.length);
});

test('inflections: retry vs unresolved error; slow-call fallback without thinking data', () => {
  const t = createTrace({ id: 't', title: 't', source: 'test' });
  addSpan(t, { id: 'turn', kind: 'turn', start: 0, end: 100000 });
  addSpan(t, { id: 'a', parentId: 'turn', kind: 'tool', name: 'Bash', start: 0, end: 10, status: 'error', input: { command: 'make' } });
  addSpan(t, { id: 'b', parentId: 'turn', kind: 'tool', name: 'Bash', start: 20, end: 30, status: 'ok', input: { command: 'make' } });
  addSpan(t, { id: 'c', parentId: 'turn', kind: 'tool', name: 'Write', start: 40, end: 50, status: 'error' });
  for (let i = 0; i < 9; i++) addSpan(t, { id: `l${i}`, parentId: 'turn', kind: 'llm', start: 1000 * i, end: 1000 * i + 500 });
  addSpan(t, { id: 'slow', parentId: 'turn', kind: 'llm', start: 50000, end: 95000 });
  finalizeTrace(t);
  const inf = findInflections(t);
  assert.deepEqual(inf.filter((i) => i.kind === 'retry').map((i) => i.spanId), ['b']);
  assert.deepEqual(inf.filter((i) => i.kind === 'error').map((i) => i.spanId), ['c']);
  assert.deepEqual(inf.filter((i) => i.kind === 'slow').map((i) => i.spanId), ['slow']);
});

test('stats: counts, tokens, categories and active vs wall time', () => {
  const st = computeStats(trace);
  assert.equal(st.turns, 2);
  assert.equal(st.toolCalls, 8);
  assert.equal(st.errors, 1);
  assert.equal(st.subagents, 1);
  assert.equal(st.tokens.thinking, 2600);
  assert.equal(st.tokens.peakContext, 1553);
  assert.equal(st.byCategory.exec.count, 2);
  assert.equal(st.byCategory.exec.errors, 1);
  assert.deepEqual(st.topTools.slice(0, 2).map((x) => x.name), ['Bash', 'Read'], 'ties on count broken by time');
  assert.ok(st.activeTime < st.wallTime / 10, 'the two-hour idle gap is not active time');
  assert.equal(st.wallTime, 7240000);
});

test('unionDuration merges overlaps', () => {
  assert.equal(unionDuration([{ start: 0, end: 10 }, { start: 5, end: 15 }, { start: 20, end: 25 }, { start: 30, end: 30 }]), 20);
  assert.equal(unionDuration([]), 0);
});

test('model: finalize widens parents, sorts, and validation catches broken traces', () => {
  const t = createTrace({ id: 'x', title: 'x', source: 'test' });
  addSpan(t, { id: 'p', kind: 'turn', start: 100, end: 110 });
  addSpan(t, { id: 'c', parentId: 'p', kind: 'tool', start: 90, end: 200 });
  finalizeTrace(t);
  assert.deepEqual([t.spans[0].start, t.spans[0].end], [90, 200]);
  assert.deepEqual([t.start, t.end], [90, 200]);
  assert.deepEqual(validateTrace(t), []);
  t.spans.push({ id: 'c', start: 1, end: 0, parentId: 'ghost' });
  const problems = validateTrace(t);
  assert.ok(problems.some((p) => p.includes('duplicate')));
  assert.ok(problems.some((p) => p.includes('ends before')));
  assert.ok(problems.some((p) => p.includes('unknown parent')));
  assert.deepEqual(validateTrace(null), ['trace is not an object']);
});

test('categories and phases', () => {
  assert.equal(categorizeTool('Read'), 'read');
  assert.equal(categorizeTool('mcp__github__get_issue'), 'mcp');
  assert.equal(categorizeTool('mcp__Claude_Browser__navigate'), 'web');
  assert.equal(categorizeTool('SomethingNew'), 'other');
  assert.equal(phaseOf('Bash', { command: 'cd app && npm test' }), 'verify');
  assert.equal(phaseOf('Bash', { command: 'pytest -q' }), 'verify');
  assert.equal(phaseOf('Bash', { command: 'ls -la' }), 'explore');
  assert.equal(phaseOf('Bash', { command: 'git status' }), 'explore');
  assert.equal(phaseOf('Bash', { command: 'npm install' }), 'build');
  assert.equal(phaseOf('TodoWrite', {}), null);
  assert.equal(summarizeToolInput('Bash', { command: 'echo hi\nmore', description: 'Say hi' }), 'Say hi');
  assert.equal(summarizeToolInput('X', { foo: 'line one\nline two' }), 'line one');
});

test('redaction by key and by value shape, without false positives', () => {
  assert.ok(isSecretKeyName('apiKey') && isSecretKeyName('client_secret') && isSecretKeyName('Authorization'));
  assert.ok(!isSecretKeyName('author') && !isSecretKeyName('max_tokens') && !isSecretKeyName('title'));
  const out = redactValue({ password: 'x', ok: true, note: 'key sk-ant-abcdefghijklmnop0123 here', nested: [{ token: 'abc' }] });
  assert.equal(out.password, '[REDACTED]');
  assert.equal(out.ok, true);
  assert.equal(out.note, 'key [REDACTED] here');
  assert.equal(out.nested[0].token, '[REDACTED]');
});

test('util helpers', () => {
  assert.match(hashHex('a', 32), /^[0-9a-f]{32}$/);
  assert.equal(hashHex('a', 16), hashHex('a', 16));
  assert.notEqual(hashHex('a', 16), hashHex('b', 16));
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(percentile([], 50), 0);
  assert.match(truncateText('x'.repeat(50), 10), /^x{10}\n… \[40 more characters truncated\]$/);
});

test('registry: detects formats, reports unknown ones, accepts new adapters', () => {
  assert.equal(parseAny(fixtureText()).adapter, 'claude-code');
  assert.equal(parseAny(JSON.stringify(trace)).adapter, 'agent-trace');
  assert.throws(() => parseAny('hello world', { fileName: 'notes.txt' }), /Unrecognized format in notes\.txt/);
  const tooNew = { ...trace, schema: 99 };
  assert.throws(() => parseAny(JSON.stringify(tooNew)), /newer than this viewer/);
  const broken = { schema: 1, id: 'b', spans: [{ id: 'x', start: 5, end: 1 }], events: [] };
  assert.throws(() => parseAny(JSON.stringify(broken)), /Invalid trace/);

  registerAdapter({
    id: 'csv-demo',
    label: 'Demo CSV',
    detect: (text) => text.startsWith('name,start,end'),
    parse: (text) => {
      const t = createTrace({ id: 'csv', title: 'CSV', source: 'csv' });
      for (const [i, line] of text.trim().split('\n').slice(1).entries()) {
        const [name, start, end] = line.split(',');
        addSpan(t, { id: `s${i}`, kind: 'tool', name, start: Number(start), end: Number(end) });
      }
      return [finalizeTrace(t)];
    },
  });
  assert.ok(listAdapters().some((a) => a.id === 'csv-demo'));
  const { adapter, traces } = parseAny('name,start,end\nfetch,0,10\nparse,10,25\n');
  assert.equal(adapter, 'csv-demo');
  assert.equal(traces[0].spans.length, 2);
  assert.throws(() => registerAdapter({ id: 'bad' }), /missing "detect"/);
  assert.equal(T0 > 0, true);
});
