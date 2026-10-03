// The viewer's non-DOM logic: time compression, tree flattening, derived data, formatting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeScale } from '../src/viewer/timescale.mjs';
import { flattenRows } from '../src/viewer/tree.mjs';
import { prepareTrace, ancestorsOf, createStore } from '../src/viewer/store.mjs';
import { fmtDuration, fmtTokens, escapeHtml, prettyValue } from '../src/viewer/format.mjs';
import { parseClaudeTranscript } from '../src/adapters/claude-code.mjs';
import { fixtureText, T0 } from './fixtures/transcript.mjs';

const trace = parseClaudeTranscript(fixtureText());
const prepared = prepareTrace(trace);

test('time scale squeezes the two-hour idle gap and stays invertible', () => {
  const scale = buildTimeScale(trace);
  assert.equal(scale.gaps.length, 1);
  const g = scale.gaps[0];
  assert.ok(g.t0 >= T0 + 41000 && g.t1 <= T0 + 7200000);
  assert.ok(g.v1 - g.v0 <= 45000, 'gap drawn at a bounded width');
  assert.ok(scale.vEnd < 120000, 'two hours collapse to under two minutes of timeline');
  for (const t of [T0, T0 + 12345, g.t0, (g.t0 + g.t1) / 2, g.t1, trace.end]) {
    assert.ok(Math.abs(scale.fromV(scale.toV(t)) - t) < 1e-6, `round-trips ${t}`);
  }
  let prev = -Infinity;
  for (let t = trace.start; t <= trace.end; t += 60000) {
    const v = scale.toV(t);
    assert.ok(v >= prev, 'monotonic');
    prev = v;
  }
  assert.ok(scale.inGap((g.v0 + g.v1) / 2));
  assert.ok(!scale.inGap(1000));
});

test('time scale without compression is linear', () => {
  const scale = buildTimeScale(trace, { compressIdle: false });
  assert.equal(scale.gaps.length, 0);
  assert.equal(scale.toV(T0 + 5000), 5000);
  assert.equal(scale.vEnd, trace.end - trace.start);
});

test('tree rows hide the session root, honour collapsing, and keep ancestors of matches', () => {
  const all = flattenRows(prepared, new Set(), null);
  assert.equal(all[0].span.kind, 'turn', 'session root is not a row');
  assert.equal(all.length, trace.spans.length - 1);
  const collapsed = flattenRows(prepared, new Set(['turn-1']), null);
  assert.ok(collapsed.length < all.length);
  assert.equal(collapsed[0].expanded, false);

  const match = new Set([trace.spans.find((s) => s.attrs['tool.call_id'] === 't_side_read').id]);
  const filtered = flattenRows(prepared, new Set(['turn-2']), match);
  const names = filtered.map((r) => r.span.name);
  assert.deepEqual(names, ['/review src', 'Agent', 'Review code', 'Read']);
  assert.deepEqual(filtered.map((r) => r.dim), [true, true, true, false]);
  assert.deepEqual(filtered.map((r) => r.depth), [0, 1, 2, 3]);
});

test('prepared data: depth, inflections by span, ancestors, lazy search text', () => {
  const read = trace.spans.find((s) => s.attrs['tool.call_id'] === 't_side_read');
  assert.equal(prepared.depth.get(read.id), 4);
  assert.deepEqual(ancestorsOf(prepared, read.id).map((s) => s.kind), ['session', 'turn', 'tool', 'agent']);
  assert.ok(prepared.inflectionsBySpan.get('llm-msg_A').some((i) => i.kind === 'thinking'));
  assert.ok(prepared.textFor(read).includes('/work/app/src/a.js'));
});

test('store notifies subscribers with the keys that changed', () => {
  const store = createStore({ a: 1, b: 2 });
  const seen = [];
  store.subscribe((_, changed) => seen.push([...changed]));
  store.set({ a: 1 });
  store.set({ a: 2, b: 2 });
  assert.deepEqual(seen, [['a']]);
  assert.equal(store.get().a, 2);
});

test('formatting helpers', () => {
  assert.equal(fmtDuration(0.4), '<1ms');
  assert.equal(fmtDuration(950), '950ms');
  assert.equal(fmtDuration(4200), '4.2s');
  assert.equal(fmtDuration(59_600), '1m 00s');
  assert.equal(fmtDuration(299_600), '5m 00s', 'no 4m 60s');
  assert.equal(fmtDuration(9_960), '10s');
  assert.equal(fmtDuration(3_599_700), '1h 00m');
  assert.equal(fmtDuration(999.7), '1.0s');
  assert.equal(fmtDuration(61_000), '1m 01s');
  assert.equal(fmtDuration(3_600_000 * 2 + 60_000 * 5), '2h 05m');
  assert.equal(fmtDuration(NaN), '–');
  assert.equal(fmtTokens(950), '950');
  assert.equal(fmtTokens(1530), '1.5k');
  assert.equal(fmtTokens(2_270_000), '2.27M');
  assert.equal(escapeHtml('<img src=x onerror="a">&\''), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
  assert.equal(prettyValue('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(prettyValue('plain'), 'plain');
  assert.equal(prettyValue({ b: 2 }), '{\n  "b": 2\n}');
});

test('tree rows can be listed newest first at every level', () => {
  const asc = flattenRows(prepared, new Set(), null, 'asc');
  const desc = flattenRows(prepared, new Set(), null, 'desc');
  assert.equal(desc.length, asc.length);
  assert.equal(desc[0].span.name, '/review src', 'latest turn on top');
  const turn1 = desc.findIndex((r) => r.span.id === 'turn-1');
  assert.equal(desc[turn1 + 1].depth, 1, 'children still follow their parent');
  const kids = desc.filter((r) => r.span.parentId === 'turn-1').map((r) => r.span.start);
  assert.deepEqual(kids, [...kids].sort((a, b) => b - a), 'children newest first');
});

test('details panel: model call, failed tool, turn and subagent drill-downs', async () => {
  const { renderDetails } = await import('../src/viewer/panels.mjs');
  const llm = renderDetails(prepared, 'llm-msg_A');
  assert.match(llm.html, /Model call · claude-test-1/);
  assert.match(llm.html, /class="tok"/, 'token breakdown');
  assert.match(llm.html, /isn't stored in the transcript/, 'explains missing reasoning text');
  const bash = trace.spans.find((s) => s.attrs['tool.call_id'] === 't_bash1');
  const tool = renderDetails(prepared, bash.id);
  assert.match(tool.html, /Failed/);
  assert.match(tool.html, /callout is-error/);
  assert.match(tool.html, /Phase<\/dt><dd>Verifying/);
  assert.ok(tool.blocks.some((b) => b.includes('npm test')), 'full input kept for copy');
  assert.match(tool.html, /data-goto="turn-1"/, 'breadcrumb back to the turn');
  const turn = renderDetails(prepared, 'turn-1');
  assert.match(turn.html, /Inside this turn/);
  assert.match(turn.html, /<b>1<\/b><span>errors/);
  const agent = renderDetails(prepared, trace.spans.find((s) => s.kind === 'agent').id);
  assert.match(agent.html, /Subagent/);
  const long = { ...prepared, byId: new Map(prepared.byId) };
  long.byId.set('big', { id: 'big', kind: 'tool', name: 'Bash', start: T0, end: T0 + 1, status: 'ok', attrs: {}, input: 'x', output: 'y'.repeat(9000), parentId: null });
  assert.match(renderDetails(long, 'big').html, /Show all 9,000 characters/);
  assert.equal(renderDetails(prepared, 'missing').html, '');
});
