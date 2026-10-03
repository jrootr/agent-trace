// A synthetic Claude Code transcript covering the shapes the adapter handles:
// parallel tool calls, a failed tool, a mid-turn user message, a milestone, a slash command,
// a long idle gap, a subagent (sidechain), a compaction, an interrupt and a malformed line.
export const T0 = Date.parse('2026-01-01T10:00:00.000Z');
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
const SESSION = '11111111-2222-3333-4444-555555555555';
const base = { sessionId: SESSION, cwd: '/work/app', version: '2.1.0', gitBranch: 'main', userType: 'external' };

export const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

function human(sec, text, extra = {}) {
  return { ...base, type: 'user', timestamp: at(sec), origin: { kind: 'human' }, message: { role: 'user', content: text }, ...extra };
}
function assistant(sec, id, block, { usage, stop = 'tool_use', side = false } = {}) {
  return {
    ...base,
    type: 'assistant',
    timestamp: at(sec),
    isSidechain: side,
    ...(side ? { agentId: 'agent-1' } : {}),
    message: {
      id,
      model: 'claude-test-1',
      role: 'assistant',
      stop_reason: stop,
      content: [block],
      usage: usage ?? { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 50 },
    },
  };
}
function toolUse(id, name, input) {
  return { type: 'tool_use', id, name, input };
}
function result(sec, id, text, { error = false, side = false } = {}) {
  return {
    ...base,
    type: 'user',
    timestamp: at(sec),
    isSidechain: side,
    ...(side ? { agentId: 'agent-1' } : {}),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(error ? { is_error: true } : {}) }] },
  };
}

export function fixtureEntries() {
  const usageA = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 300, output_tokens_details: { thinking_tokens: 2500 } };
  return [
    { type: 'custom-title', customTitle: 'Fixture session', sessionId: SESSION },
    { type: 'queue-operation', operation: 'enqueue', timestamp: at(0), sessionId: SESSION, content: 'Fix the failing build' },
    human(0, 'Fix the failing build'),
    assistant(5, 'msg_A', { type: 'thinking', thinking: '', signature: 'sig' }, { usage: usageA }),
    assistant(6, 'msg_A', toolUse('t_read', 'Read', { file_path: '/work/app/src/index.js' }), { usage: usageA }),
    result(7, 't_read', 'export const x = 1;'),
    assistant(10, 'msg_B', { type: 'text', text: 'Running the tests.' }),
    assistant(10, 'msg_B', toolUse('t_bash1', 'Bash', { command: `GH_TOKEN=${SECRET} npm test`, description: 'Run tests' })),
    assistant(11, 'msg_B', toolUse('t_grep', 'Grep', { pattern: 'TODO', path: 'src' })),
    result(12, 't_grep', 'src/a.js: TODO'),
    result(20, 't_bash1', 'Exit code 1\n3 tests failed', { error: true }),
    human(21, 'also check lint'),
    assistant(25, 'msg_C', toolUse('t_edit', 'Edit', { file_path: '/work/app/src/index.js', old_string: '1', new_string: '2' }), {
      usage: { input_tokens: 3, cache_read_input_tokens: 1500, cache_creation_input_tokens: 50, output_tokens: 120, output_tokens_details: { thinking_tokens: 100 } },
    }),
    result(26, 't_edit', 'The file was updated.'),
    assistant(30, 'msg_D', toolUse('t_bash2', 'Bash', { command: 'npm test', description: 'Run tests again' })),
    result(40, 't_bash2', 'All 12 tests passed'),
    assistant(41, 'msg_E', toolUse('t_chapter', 'mcp__ccd_session__mark_chapter', { title: 'Tests green', summary: 'Fixed the build' })),
    result(41.5, 't_chapter', 'Chapter marked.'),
    assistant(45, 'msg_F', { type: 'text', text: 'Done: the build passes.' }, { stop: 'end_turn' }),
    { ...base, type: 'system', subtype: 'stop_hook_summary', timestamp: at(45.1), hookErrors: [] },
    { ...base, type: 'attachment', timestamp: at(46), attachment: { type: 'queued_command', prompt: '<task-notification>\n<summary>Background build finished</summary>\n</task-notification>' } },
    // two hours later: a slash command that spawns a subagent
    human(7200, '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>src</command-args>'),
    assistant(7205, 'msg_G', toolUse('t_agent', 'Agent', { description: 'Review code', prompt: 'Review src/ for bugs' })),
    { ...base, type: 'user', timestamp: at(7206), isSidechain: true, agentId: 'agent-1', message: { role: 'user', content: 'Review src/ for bugs' } },
    assistant(7208, 'msg_H', toolUse('t_side_read', 'Read', { file_path: '/work/app/src/a.js' }), { side: true }),
    result(7209, 't_side_read', 'const a = 1;', { side: true }),
    assistant(7212, 'msg_I', { type: 'text', text: 'No bugs found.' }, { side: true, stop: 'end_turn' }),
    result(7215, 't_agent', 'No bugs found.'),
    assistant(7220, 'msg_J', { type: 'text', text: 'The review found nothing.' }, { stop: 'end_turn' }),
    { ...base, type: 'system', subtype: 'compact_boundary', timestamp: at(7230), compactMetadata: { trigger: 'auto', preTokens: 150000 } },
    human(7240, '[Request interrupted by user]'),
  ];
}

export function fixtureText() {
  const lines = fixtureEntries().map((e) => JSON.stringify(e));
  lines.splice(5, 0, '{not valid json');
  return lines.join('\n') + '\n';
}

export const FIXTURE_SESSION_ID = SESSION;
