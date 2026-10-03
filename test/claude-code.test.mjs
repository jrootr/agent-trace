import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeTranscript, cleanPromptText, looksLikeClaudeTranscript } from '../src/adapters/claude-code.mjs';
import { validateTrace } from '../src/core/model.mjs';
import { fixtureText, T0, SECRET, FIXTURE_SESSION_ID } from './fixtures/transcript.mjs';

const trace = parseClaudeTranscript(fixtureText());
const byKind = (k) => trace.spans.filter((s) => s.kind === k);
const tool = (callId) => trace.spans.find((s) => s.attrs['tool.call_id'] === callId);

test('produces a valid trace with session metadata', () => {
  assert.deepEqual(validateTrace(trace), []);
  assert.equal(trace.id, FIXTURE_SESSION_ID);
  assert.equal(trace.title, 'Fixture session');
  assert.equal(trace.source, 'claude-code');
  assert.equal(trace.meta.cwd, '/work/app');
  assert.equal(trace.meta.skippedLines, 1, 'malformed line is skipped and counted');
  assert.deepEqual(trace.meta.models, ['claude-test-1']);
  assert.equal(trace.start, T0);
});

test('splits turns on human prompts and names slash commands by what was typed', () => {
  const turns = byKind('turn');
  assert.equal(turns.length, 2);
  assert.equal(turns[0].name, 'Fix the failing build');
  assert.equal(turns[1].name, '/review src');
  assert.ok(turns[0].end >= T0 + 45000, 'turn covers its last activity');
});

test('one model span per API message, with usage counted once', () => {
  const main = byKind('llm').filter((s) => !s.id.startsWith('a'));
  assert.equal(main.length, 8);
  const a = trace.spans.find((s) => s.id === 'llm-msg_A');
  assert.equal(a.attrs['llm.tokens.context'], 1210);
  assert.equal(a.attrs['llm.tokens.thinking'], 2500);
  assert.equal(a.attrs['llm.thinking_blocks'], 1);
  assert.equal(a.attrs['llm.tool_calls'], 1);
  const b = trace.spans.find((s) => s.id === 'llm-msg_B');
  assert.equal(b.output, 'Running the tests.');
  assert.equal(b.attrs['llm.tool_calls'], 2);
  assert.equal(b.start, T0 + 7000, 'model time starts when the previous result arrived');
});

test('tool spans get timing, status, category, phase and the error message', () => {
  const bash = tool('t_bash1');
  assert.equal(bash.name, 'Bash');
  assert.equal(bash.end - bash.start, 10000);
  assert.equal(bash.status, 'error');
  assert.match(bash.attrs['error.message'], /3 tests failed/);
  assert.equal(bash.attrs['tool.category'], 'exec');
  assert.equal(bash.attrs['tool.phase'], 'verify');
  assert.equal(tool('t_read').attrs['tool.phase'], 'explore');
  assert.equal(tool('t_edit').attrs['tool.phase'], 'build');
  assert.equal(tool('t_bash2').status, 'ok');
  assert.equal(tool('t_chapter').attrs['tool.category'], 'mcp');
  assert.equal(tool('t_read').parentId, 'turn-1');
});

test('captures interjections, background tasks, compactions and interrupts as events', () => {
  const kinds = trace.events.map((e) => e.kind);
  assert.deepEqual(kinds, ['interjection', 'background', 'compaction', 'interrupt']);
  const inter = trace.events[0];
  assert.equal(inter.label, 'also check lint');
  assert.equal(inter.spanId, 'turn-1');
  assert.equal(inter.time, T0 + 21000);
  assert.equal(trace.events[1].label, 'Background build finished');
});

test('nests subagent work under the Agent call that spawned it', () => {
  const agentCall = tool('t_agent');
  const [agent] = byKind('agent');
  assert.equal(agent.parentId, agentCall.id);
  assert.equal(agent.attrs['agent.id'], 'agent-1');
  const sideLlms = byKind('llm').filter((s) => s.parentId === agent.id);
  assert.equal(sideLlms.length, 2);
  const sideRead = tool('t_side_read');
  assert.equal(sideRead.parentId, agent.id);
  assert.equal(sideRead.status, 'ok');
});

test('redacts secrets by default; can keep them, drop IO, or truncate', () => {
  assert.ok(!JSON.stringify(trace).includes(SECRET));
  assert.match(tool('t_bash1').input.command, /\[REDACTED\]/);
  const raw = parseClaudeTranscript(fixtureText(), { redact: false });
  assert.ok(JSON.stringify(raw).includes(SECRET));
  const noIo = parseClaudeTranscript(fixtureText(), { includeIo: false });
  assert.ok(noIo.spans.every((s) => s.input === undefined && s.output === undefined));
  assert.equal(noIo.title, 'Fixture session');
  const tiny = parseClaudeTranscript(fixtureText(), { maxIo: 10 });
  assert.match(tiny.spans.find((s) => s.attrs['tool.call_id'] === 't_bash2').output, /truncated/);
});

test('falls back to the first prompt for the title, and copes with empty input', () => {
  const noTitle = fixtureText().split('\n').filter((l) => !l.includes('custom-title')).join('\n');
  assert.equal(parseClaudeTranscript(noTitle).title, 'Fix the failing build');
  const empty = parseClaudeTranscript('');
  assert.deepEqual(validateTrace(empty), []);
  assert.equal(empty.spans.length, 1);
});

test('detects transcripts and cleans app-injected prompt wrappers', () => {
  assert.ok(looksLikeClaudeTranscript(fixtureText()));
  assert.ok(!looksLikeClaudeTranscript('{"resourceSpans":[]}'));
  assert.equal(cleanPromptText('<ide_opened_file>a.c</ide_opened_file> fix it'), 'fix it');
  assert.equal(cleanPromptText('<system-reminder>x</system-reminder>hello'), 'hello');
  assert.equal(cleanPromptText('<command-name>/clear</command-name><command-args></command-args>'), '/clear');
});
