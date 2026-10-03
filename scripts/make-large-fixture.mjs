// Generates a large synthetic Claude Code transcript for performance checks.
// Usage: node scripts/make-large-fixture.mjs [toolCalls=20000] > big.jsonl
const n = Number(process.argv[2] ?? 20000);
const t0 = Date.parse('2026-03-01T09:00:00Z');
const sid = '00000000-0000-0000-0000-00000000b19b';
const tools = [['Read', { file_path: '/src/x.js' }], ['Edit', { file_path: '/src/x.js', old_string: 'a', new_string: 'b' }], ['Bash', { command: 'npm test' }], ['Grep', { pattern: 'foo' }], ['WebFetch', { url: 'https://example.com' }]];
let t = t0;
const out = [];
const ts = () => new Date(t).toISOString();
for (let i = 0; i < n; i++) {
  if (i % 40 === 0) {
    t += i % 400 === 0 ? 3_600_000 : 20_000;
    out.push({ type: 'user', sessionId: sid, timestamp: ts(), cwd: '/big', origin: { kind: 'human' }, message: { role: 'user', content: `Task ${i / 40}: keep going` } });
  }
  t += 800 + (i % 7) * 300;
  const [name, input] = tools[i % tools.length];
  const id = `toolu_${i}`;
  out.push({ type: 'assistant', sessionId: sid, timestamp: ts(), message: { id: `msg_${i}`, model: 'claude-big', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 5, cache_read_input_tokens: 20000 + i, cache_creation_input_tokens: 100, output_tokens: 200, output_tokens_details: { thinking_tokens: i % 97 === 0 ? 4000 : 50 } } } });
  t += 200 + (i % 11) * 150;
  out.push({ type: 'user', sessionId: sid, timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok '.repeat(40), ...(i % 53 === 0 ? { is_error: true } : {}) }] } });
  if (i % 40 === 39) out.push({ type: 'assistant', sessionId: sid, timestamp: ts(), message: { id: `end_${i}`, model: 'claude-big', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } });
}
process.stdout.write(out.map((e) => JSON.stringify(e)).join('\n') + '\n');
