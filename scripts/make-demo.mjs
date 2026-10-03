// Generates examples/demo-session.jsonl: a realistic, entirely synthetic Claude Code session
// (add rate limiting, hit a failing test, get steered mid-task, run a review subagent, open a PR).
// Used for the README screenshots and as a safe file to try the viewer with.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SID = '7d3c1f0e-5a2b-4c8d-9e6f-0a1b2c3d4e5f';
let clock = Date.parse('2026-04-14T09:12:00Z');
let msgN = 0;
let toolN = 0;
const out = [];
const base = { sessionId: SID, cwd: '/home/dev/shop-api', gitBranch: 'feature/rate-limit', version: '2.1.0', entrypoint: 'cli' };
const ts = () => new Date(clock).toISOString();
const wait = (sec) => (clock += sec * 1000);

let context = 18000;
function model(sec, { thinking = 0, out: outTok = 180 } = {}) {
  wait(sec);
  context += 1400 + outTok;
  return { id: `msg_demo_${++msgN}`, usage: { input_tokens: 4, cache_read_input_tokens: context - 900, cache_creation_input_tokens: 896, output_tokens: outTok + thinking, output_tokens_details: { thinking_tokens: thinking } } };
}
function assistantBlock(m, block, stop = 'tool_use', side = false) {
  out.push({ ...base, type: 'assistant', timestamp: ts(), isSidechain: side, ...(side ? { agentId: 'review-1' } : {}), message: { id: m.id, model: 'claude-opus-demo', role: 'assistant', stop_reason: stop, content: [block], usage: m.usage } });
}
function prompt(text) {
  out.push({ ...base, type: 'user', timestamp: ts(), origin: { kind: 'human' }, message: { role: 'user', content: text } });
}
/** One model call that requests several tools in parallel; results arrive after their durations. */
function step({ think = 3, thinking = 0, text, tools, side = false, end = false }) {
  const m = model(think, { thinking });
  if (thinking) assistantBlock(m, { type: 'thinking', thinking: '', signature: 'demo' }, 'tool_use', side);
  if (text) assistantBlock(m, { type: 'text', text }, end ? 'end_turn' : 'tool_use', side);
  const started = clock;
  const calls = (tools ?? []).map(([name, input, dur, result, isError]) => {
    const id = `toolu_demo_${++toolN}`;
    assistantBlock(m, { type: 'tool_use', id, name, input }, 'tool_use', side);
    return { id, dur, result, isError };
  });
  for (const c of calls.sort((a, b) => a.dur - b.dur)) {
    clock = started + c.dur * 1000;
    out.push({ ...base, type: 'user', timestamp: ts(), isSidechain: side, ...(side ? { agentId: 'review-1' } : {}), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: c.id, content: c.result, ...(c.isError ? { is_error: true } : {}) }] } });
  }
  return calls;
}

out.push({ type: 'custom-title', customTitle: 'Add rate limiting to the orders API', sessionId: SID });

// Turn 1: explore → build → verify (fails) → think hard → fix → user steers → verify → milestone
prompt('Add per-client rate limiting to the orders API (100 req/min) and make sure the tests pass.');
step({ think: 6, thinking: 1900, tools: [
  ['Glob', { pattern: 'src/**/*.ts' }, 0.4, 'src/app.ts\nsrc/routes/orders.ts\nsrc/middleware/auth.ts\nsrc/config.ts'],
  ['Grep', { pattern: 'app.use\\(', path: 'src' }, 0.6, 'src/app.ts:14: app.use(auth())\nsrc/app.ts:15: app.use(json())'],
] });
step({ think: 3, tools: [
  ['Read', { file_path: '/home/dev/shop-api/src/app.ts' }, 0.2, 'import express from "express";\n…'],
  ['Read', { file_path: '/home/dev/shop-api/src/middleware/auth.ts' }, 0.2, 'export function auth() { … }'],
  ['Read', { file_path: '/home/dev/shop-api/src/config.ts' }, 0.2, 'export const config = { port: 8080 };'],
] });
step({ think: 14, thinking: 2600, out: 900, text: 'I\'ll add a token-bucket middleware keyed by API client, wire it into the app, and make the limit configurable.', tools: [
  ['Write', { file_path: '/home/dev/shop-api/src/middleware/rateLimit.ts', content: 'export function rateLimit(opts) { … }' }, 0.3, 'File created'],
] });
step({ think: 5, tools: [
  ['Edit', { file_path: '/home/dev/shop-api/src/app.ts', old_string: 'app.use(auth())', new_string: 'app.use(auth())\napp.use(rateLimit(config.rateLimit))' }, 0.2, 'Updated'],
  ['Edit', { file_path: '/home/dev/shop-api/src/config.ts', old_string: 'port: 8080', new_string: 'port: 8080, rateLimit: { perMinute: 100 }' }, 0.2, 'Updated'],
] });
step({ think: 3, tools: [['Bash', { command: 'npm test', description: 'Run the test suite' }, 38, 'FAIL tests/orders.test.ts\n  ✕ lists orders (429 Too Many Requests)\n  ✕ creates an order (429 Too Many Requests)\n\n' + '    at Object.<anonymous> (tests/orders.test.ts:42:7)\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)\n'.repeat(140) + '\nTests: 2 failed, 41 passed', true]] });
step({ think: 31, thinking: 6400, out: 420, text: 'The tests share one client id, so the limiter trips across tests. The bucket should reset between tests and the test client needs a higher limit.', tools: [
  ['Read', { file_path: '/home/dev/shop-api/tests/helpers.ts' }, 0.2, 'export const client = request(app).set("x-client", "test")'],
] });
step({ think: 6, tools: [
  ['Edit', { file_path: '/home/dev/shop-api/src/middleware/rateLimit.ts', old_string: 'const buckets = new Map()', new_string: 'export const buckets = new Map()' }, 0.2, 'Updated'],
  ['Edit', { file_path: '/home/dev/shop-api/tests/helpers.ts', old_string: 'export const client', new_string: 'afterEach(() => buckets.clear());\nexport const client' }, 0.2, 'Updated'],
] });
wait(4);
prompt('also return an X-RateLimit-Remaining header please');
step({ think: 4, tools: [['Bash', { command: 'npm test', description: 'Run the test suite' }, 36, 'Tests: 43 passed']] });
step({ think: 7, thinking: 900, tools: [['Edit', { file_path: '/home/dev/shop-api/src/middleware/rateLimit.ts', old_string: 'next()', new_string: 'res.setHeader("X-RateLimit-Remaining", String(bucket.tokens));\nnext()' }, 0.2, 'Updated']] });
step({ think: 5, tools: [['Write', { file_path: '/home/dev/shop-api/tests/rateLimit.test.ts', content: 'it("returns 429 after the limit", …)' }, 0.3, 'File created']] });
step({ think: 3, tools: [['Bash', { command: 'npm test', description: 'Run the test suite' }, 41, 'Tests: 46 passed']] });
step({ think: 2, tools: [['mcp__ccd_session__mark_chapter', { title: 'Rate limiting works', summary: 'Middleware, config, header, tests' }, 0.1, 'Chapter marked']] });
step({ think: 5, out: 260, text: 'Rate limiting is in: 100 requests/minute per client, configurable, with an X-RateLimit-Remaining header. All 46 tests pass.', end: true });

// Turn 2, after a coffee: a review subagent
wait(26 * 60);
prompt('<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>src/middleware</command-args>');
const [agentCall] = step({ think: 4, tools: [['Agent', { description: 'Review rate limit middleware', prompt: 'Review src/middleware/rateLimit.ts for correctness and edge cases' }, 0, '']] });
const agentStart = clock;
out.push({ ...base, type: 'user', timestamp: ts(), isSidechain: true, agentId: 'review-1', message: { role: 'user', content: 'Review src/middleware/rateLimit.ts for correctness and edge cases' } });
step({ side: true, think: 3, tools: [
  ['Read', { file_path: '/home/dev/shop-api/src/middleware/rateLimit.ts' }, 0.2, '…'],
  ['Grep', { pattern: 'x-client', path: 'src' }, 0.4, 'src/middleware/auth.ts:9'],
] });
step({ side: true, think: 12, thinking: 2100, tools: [['Read', { file_path: '/home/dev/shop-api/src/middleware/auth.ts' }, 0.2, '…']] });
step({ side: true, think: 9, out: 500, text: 'One issue: unauthenticated requests share the "anonymous" bucket, so one noisy caller can block everyone. Key those by IP instead.', end: true });
const agentEnd = clock + 500;
clock = agentEnd;
out.push({ ...base, type: 'user', timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: agentCall.id, content: 'One issue: unauthenticated requests share one bucket. Key them by IP.' }] } });
void agentStart;
step({ think: 6, tools: [['Edit', { file_path: '/home/dev/shop-api/src/middleware/rateLimit.ts', old_string: 'req.clientId ?? "anonymous"', new_string: 'req.clientId ?? `ip:${req.ip}`' }, 0.2, 'Updated']] });
step({ think: 3, tools: [['Bash', { command: 'npm run lint && npm test', description: 'Lint and test' }, 47, 'Tests: 46 passed']] });
step({ think: 4, out: 200, text: 'Fixed the shared anonymous bucket; lint and tests pass.', end: true });

// Turn 3: ship it
wait(3 * 60);
prompt('looks good, open a PR');
step({ think: 3, tools: [['Bash', { command: 'git status --short', description: 'Show changes' }, 0.3, ' M src/app.ts\n M src/config.ts\n?? src/middleware/rateLimit.ts']] });
// gathering PR context one file at a time, and re-reading things it already had
step({ think: 4, tools: [['Read', { file_path: '/home/dev/shop-api/package.json' }, 0.2, '{ "name": "shop-api", "version": "1.8.0" }']] });
step({ think: 5, tools: [['Read', { file_path: '/home/dev/shop-api/CHANGELOG.md' }, 0.2, '## 1.8.0\n- Orders pagination']] });
step({ think: 4, tools: [['Grep', { pattern: 'x-client', path: 'src' }, 0.4, 'src/middleware/auth.ts:9']] });
step({ think: 5, tools: [['Read', { file_path: '/home/dev/shop-api/package.json' }, 0.2, '{ "name": "shop-api", "version": "1.8.0" }']] });
step({ think: 4, tools: [['Read', { file_path: '/home/dev/shop-api/CHANGELOG.md' }, 0.2, '## 1.8.0\n- Orders pagination']] });
step({ think: 4, tools: [['Edit', { file_path: '/home/dev/shop-api/CHANGELOG.md', old_string: '## 1.8.0', new_string: '## 1.9.0\n- Per-client rate limiting\n\n## 1.8.0' }, 0.2, 'Updated']] });
step({ think: 4, tools: [['Bash', { command: 'git add -A && git commit -m "Add per-client rate limiting"', description: 'Commit' }, 1.1, '[feature/rate-limit 3f2c1aa] Add per-client rate limiting']] });
step({ think: 2, tools: [['Bash', { command: 'git push -u origin feature/rate-limit', description: 'Push branch' }, 2.4, 'branch set up to track origin/feature/rate-limit']] });
step({ think: 5, tools: [['mcp__github__create_pull_request', { title: 'Add per-client rate limiting', base: 'main', head: 'feature/rate-limit' }, 1.8, 'Created PR #128']] });
step({ think: 3, out: 90, text: 'Opened PR #128.', end: true });

const dest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'demo-session.jsonl');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, out.map((e) => JSON.stringify(e)).join('\n') + '\n');
console.log(`wrote examples/demo-session.jsonl (${out.length} entries)`);
