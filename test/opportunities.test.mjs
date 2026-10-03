import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findOpportunities, summarizeOpportunities } from '../src/core/opportunities.mjs';
import { sliceTrace, computeStats } from '../src/core/analysis.mjs';
import { createTrace, addSpan, finalizeTrace } from '../src/core/model.mjs';
import { parseClaudeTranscript } from '../src/adapters/claude-code.mjs';
import { renderInsights } from '../src/viewer/insights.mjs';
import { prepareTrace } from '../src/viewer/store.mjs';
import { fixtureText } from './fixtures/transcript.mjs';

/** Tiny trace builder: steps are [toolName, input, {dur, status, output, cat, phase}] each requested by its own model call. */
function build(steps, { gapAfter = {} } = {}) {
  const t = createTrace({ id: 'opp', title: 'opp', source: 'test' });
  addSpan(t, { id: 'turn', kind: 'turn', name: 'turn', start: 0, end: 0 });
  let clock = 0;
  steps.forEach(([name, input, o = {}], i) => {
    clock += gapAfter[i] ?? 0;
    const llm = addSpan(t, { id: `l${i}`, parentId: 'turn', kind: 'llm', start: clock, end: clock + 2000, attrs: { 'llm.tokens.cache_write': o.cacheWrite ?? 0 } });
    clock += 2000;
    addSpan(t, {
      id: `t${i}`, parentId: 'turn', kind: 'tool', name, start: clock, end: clock + (o.dur ?? 100), status: o.status ?? 'ok', input, output: o.output ?? 'ok',
      attrs: { 'tool.category': o.cat ?? 'read', 'tool.phase': o.phase ?? 'explore', 'tool.requested_by': llm.id, 'tool.summary': input?.file_path ?? name },
    });
    clock += o.dur ?? 100;
  });
  return finalizeTrace(t);
}
const kinds = (t) => findOpportunities(t).map((o) => o.kind);

test('redundant reads: repeats count, re-reading after a write to the same file does not', () => {
  const t = build([
    ['Read', { file_path: 'a.ts' }], ['Read', { file_path: 'a.ts' }], ['Read', { file_path: 'b.ts' }],
    ['Read', { file_path: 'b.ts' }], ['Edit', { file_path: 'c.ts' }, { cat: 'write', phase: 'build' }],
    ['Read', { file_path: 'c.ts' }], ['Edit', { file_path: 'c.ts' }, { cat: 'write', phase: 'build' }], ['Read', { file_path: 'c.ts' }],
  ]);
  const o = findOpportunities(t).find((x) => x.kind === 'redundant');
  assert.deepEqual(o.evidence, ['t1', 't3']);
  assert.equal(o.confidence, 'high');
});

test('repeated failures: same failing call twice', () => {
  const t = build([
    ['Bash', { command: 'make' }, { status: 'error', cat: 'exec', phase: 'build', dur: 5000 }],
    ['Bash', { command: 'make' }, { status: 'error', cat: 'exec', phase: 'build', dur: 5000 }],
  ]);
  const o = findOpportunities(t).find((x) => x.kind === 'failures');
  assert.match(o.title, /same call failed 2 times/);
  assert.ok(o.impact.timeMs >= 10000);
});

test('serial lookups: three or more single-read steps in a row', () => {
  const t = build([['Read', { file_path: '1' }], ['Read', { file_path: '2' }], ['Grep', { pattern: 'x' }], ['Write', { file_path: 'w' }, { cat: 'write', phase: 'build' }]]);
  const o = findOpportunities(t).find((x) => x.kind === 'serial');
  assert.deepEqual(o.evidence, ['t0', 't1', 't2']);
  assert.equal(o.impact.timeMs, 2 * 2000, 'two round trips saved at the median model time');
  assert.ok(!kinds(build([['Read', { file_path: '1' }], ['Read', { file_path: '2' }]])).includes('serial'));
});

test('context bloat: large outputs, with tokens estimated from characters', () => {
  const t = build([['Bash', { command: 'cat big.log' }, { output: 'x'.repeat(40000), cat: 'exec', phase: 'explore' }], ['Read', { file_path: 'a' }]]);
  const o = findOpportunities(t).find((x) => x.kind === 'bloat');
  assert.equal(o.impact.tokens, 10000);
  assert.match(o.title, /~10k tokens/);
});

test('cache expiry: a long break followed by a big cache write', () => {
  const t = build([['Read', { file_path: 'a' }], ['Read', { file_path: 'b' }, { cacheWrite: 90000 }]], { gapAfter: { 1: 30 * 60 * 1000 } });
  const o = findOpportunities(t).find((x) => x.kind === 'cache');
  assert.equal(o.impact.tokens, 90000);
  assert.match(o.detail, /30 min/);
});

test('slow tests, edit churn and repeated routines', () => {
  const tests = build([
    ['Bash', { command: 'npm test' }, { cat: 'exec', phase: 'verify', dur: 40000 }],
    ['Edit', { file_path: 'a' }, { cat: 'write', phase: 'build' }],
    ['Bash', { command: 'npm test' }, { cat: 'exec', phase: 'verify', dur: 40000 }],
  ]);
  assert.ok(kinds(tests).includes('tests'));
  const churn = build(Array.from({ length: 6 }, (_, i) => ['Edit', { file_path: 'same.ts', old_string: String(i) }, { cat: 'write', phase: 'build' }]));
  assert.match(findOpportunities(churn).find((x) => x.kind === 'churn').title, /same\.ts edited 6 times/);

  const t = createTrace({ id: 'r', title: 'r', source: 'test' });
  let c = 0;
  for (let turn = 0; turn < 3; turn++) {
    addSpan(t, { id: `turn${turn}`, kind: 'turn', start: c, end: c });
    for (const [name, cat] of [['Read', 'read'], ['Edit', 'write'], ['Bash', 'exec']]) {
      addSpan(t, { id: `${turn}-${name}`, parentId: `turn${turn}`, kind: 'tool', name, start: c, end: c + 10, attrs: { 'tool.category': cat } });
      c += 1000;
    }
  }
  const routine = findOpportunities(finalizeTrace(t)).find((x) => x.kind === 'routine');
  assert.match(routine.title, /Same 3-step routine in 3 turns/);
  assert.match(routine.detail, /Read → Edit → Bash/);
});

test('ranking, ids and the summary headline', () => {
  const trace = parseClaudeTranscript(fixtureText());
  const opps = findOpportunities(trace);
  assert.deepEqual(opps.map((o) => o.id), opps.map((_, i) => `opp-${i + 1}`));
  const s = summarizeOpportunities([{ impact: { timeMs: 5000, tokens: 100 } }, { impact: { timeMs: 99999999, tokens: 0 } }], 60000);
  assert.equal(s.timeMs, 60000, 'capped at active time');
  assert.equal(s.share, 1);
  assert.equal(summarizeOpportunities([], 1000).count, 0);
});

test('sliceTrace: subtree and time window scopes', () => {
  const trace = parseClaudeTranscript(fixtureText());
  const turn2 = sliceTrace(trace, { rootId: 'turn-2' });
  assert.ok(turn2.spans.every((s) => s.id === 'turn-2' || s.start >= turn2.start));
  assert.equal(computeStats(turn2).turns, 1);
  assert.equal(computeStats(turn2).subagents, 1);
  assert.deepEqual(turn2.events.map((e) => e.kind), ['compaction', 'interrupt'], 'only events attached to turn 2');
  const win = sliceTrace(trace, { t0: trace.start + 9000, t1: trace.start + 21000 });
  assert.ok(win.spans.every((s) => s.start >= win.start && s.end <= win.end), 'clipped to the window');
  assert.deepEqual(win.events.map((e) => e.kind), ['interjection']);
  assert.equal(sliceTrace(trace, { rootId: 'nope' }).spans.length, 0);
  assert.equal(sliceTrace(trace), trace);
});

test('insights render per scope, with opportunities, story and scope label', () => {
  const prepared = prepareTrace(parseClaudeTranscript(fixtureText()));
  const all = renderInsights(prepared, { scope: { mode: 'session', label: 'Whole session' } });
  assert.match(all.html, /Whole session/);
  assert.match(all.html, /Story <span class="count">/);
  assert.match(all.html, /Running the tests\./, 'the agent\'s own words appear in the story');
  assert.equal(all.stats.turns, 2);
  const turn = renderInsights(prepared, { scope: { mode: 'auto', rootId: 'turn-2', label: 'Turn · /review src' } });
  assert.equal(turn.stats.turns, 1);
  assert.match(turn.html, /aria-checked="true" data-scope="auto"/);
  assert.ok(!turn.html.includes('Running the tests.'), 'story is scoped to the turn');
  const desc = renderInsights(prepared, { scope: { mode: 'session', label: 's' }, order: 'desc' });
  assert.ok(desc.html.indexOf('Done: the build passes') < desc.html.indexOf('Running the tests.'), 'newest first');
  for (const o of all.opportunities) assert.match(all.html, new RegExp(`data-evidence="${o.id}"`));
});
