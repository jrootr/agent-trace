// Drives the real CLI as a child process against a fake ~/.claude/projects directory.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixtureText, fixtureEntries, FIXTURE_SESSION_ID } from './fixtures/transcript.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'agent-trace.mjs');
let tmp;
let env;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-trace-test-'));
  const project = path.join(tmp, 'projects', 'C--work-app');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, `${FIXTURE_SESSION_ID}.jsonl`), fixtureText());
  const older = path.join(project, '99999999-0000-0000-0000-000000000000.jsonl');
  const olderEntries = fixtureEntries().filter((e) => e.type !== 'custom-title').map((e) => ({ ...e, sessionId: '99999999-0000-0000-0000-000000000000' }));
  fs.writeFileSync(older, olderEntries.map((e) => JSON.stringify(e)).join('\n'));
  const past = new Date(Date.now() - 86400000);
  fs.utimesSync(older, past, past);
  env = { ...process.env, AGENT_TRACE_CLAUDE_DIR: path.join(tmp, 'projects') };
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, cwd: tmp });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('help, version, and unknown commands', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: agent-trace <command>/);
  assert.match((await run(['--version'])).stdout, /^\d+\.\d+\.\d+/);
  const bad = await run(['nope']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /Unknown command/);
});

test('list shows sessions newest first, with titles', async () => {
  const r = await run(['list', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const rows = JSON.parse(r.stdout);
  assert.deepEqual(rows.map((x) => x.title), ['Fixture session', 'Fix the failing build']);
});

test('stats resolves the latest session by default and by id prefix', async () => {
  const latest = await run(['stats']);
  assert.equal(latest.code, 0, latest.stderr);
  assert.match(latest.stdout, /Fixture session/);
  assert.match(latest.stdout, /2 turns, 10 model calls, 8 tool calls, 1 errors/);
  assert.match(latest.stdout, /recovery\s+Bash failed, then Edit/);
  const byId = JSON.parse((await run(['stats', '9999', '--json'])).stdout);
  assert.equal(byId.title, 'Fix the failing build');
  const missing = await run(['stats', 'zzzz']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /No file or session matching "zzzz"/);
});

test('view writes a self-contained report with the trace embedded', async () => {
  const out = path.join(tmp, 'report.html');
  const r = await run(['view', '--no-open', '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  const html = fs.readFileSync(out, 'utf8');
  const start = html.indexOf('id="agent-trace-data">') + 'id="agent-trace-data">'.length;
  const data = JSON.parse(html.slice(start, html.indexOf('</script>', start)));
  assert.equal(data.traces[0].title, 'Fixture session');
  assert.ok(!html.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'secrets redacted by default');
  const lean = path.join(tmp, 'lean.html');
  await run(['view', '--no-open', '--no-io', '--out', lean]);
  assert.ok(fs.statSync(lean).size < fs.statSync(out).size);
});

test('view picks up subagent transcripts stored beside the session', async () => {
  const project = path.join(tmp, 'projects', 'C--work-app');
  const id = 'abababab-0000-0000-0000-000000000000';
  const main = fixtureEntries().filter((e) => !e.isSidechain).map((e) => ({ ...e, sessionId: id }));
  const side = fixtureEntries().filter((e) => e.isSidechain).map((e) => ({ ...e, sessionId: id }));
  fs.writeFileSync(path.join(project, `${id}.jsonl`), main.map((e) => JSON.stringify(e)).join('\n'));
  fs.mkdirSync(path.join(project, id, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(project, id, 'subagents', 'agent-1.jsonl'), side.map((e) => JSON.stringify(e)).join('\n'));
  const r = JSON.parse((await run(['stats', 'abab', '--json'])).stdout);
  assert.equal(r.stats.subagents, 1);
});

test('export writes OTLP or agent-trace JSON', async () => {
  const otlpFile = path.join(tmp, 'out.otlp.json');
  const r = await run(['export', '--format', 'otlp', '--out', otlpFile]);
  assert.equal(r.code, 0, r.stderr);
  const otlp = JSON.parse(fs.readFileSync(otlpFile, 'utf8'));
  assert.ok(otlp.resourceSpans[0].scopeSpans[0].spans.length > 10);
  const tr = JSON.parse((await run(['export', '--format', 'trace'])).stdout);
  assert.equal(tr.schema, 1);
  // exported files open again (the viewer and CLI accept their own output)
  const again = await run(['stats', otlpFile, '--json']);
  assert.equal(JSON.parse(again.stdout).title, 'Fixture session');
  assert.equal((await run(['export', '--format', 'xml'])).code, 2);
});

test('send posts OTLP/JSON to a collector with custom headers', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body });
      res.writeHead(req.headers.authorization === 'Bearer good' ? 200 : 401).end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await run(['send', '--endpoint', endpoint, '--header', 'Authorization: Bearer good']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /Sent \d+ spans in 1 trace\(s\) to .*\/v1\/traces/);
    assert.equal(received[0].url, '/v1/traces');
    assert.equal(received[0].headers['content-type'], 'application/json');
    assert.ok(JSON.parse(received[0].body).resourceSpans.length === 1);
    const denied = await run(['send', '--endpoint', `${endpoint}/v1/traces`, '--header', 'Authorization: Bearer bad']);
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /HTTP 401/);
    assert.equal((await run(['send'])).code, 2, 'endpoint required');
    assert.equal((await run(['send', '--endpoint', endpoint, '--header', 'nocolon'])).code, 2);
  } finally {
    server.close();
  }
});
