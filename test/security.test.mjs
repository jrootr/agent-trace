// Trace files are shared between people, so treat every field as hostile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { parseAny } from '../src/adapters/registry.mjs';
import { sanitizeTrace } from '../src/core/model.mjs';
import { prepareTrace } from '../src/viewer/store.mjs';
import { renderDetails, renderSelectionHeader } from '../src/viewer/panels.mjs';
import { renderOpportunityList, renderOverview, renderScopedInsights } from '../src/viewer/insights.mjs';
import { buildHtml, contentSecurityPolicy } from '../src/build/bundle.mjs';
import { toOtlp } from '../src/adapters/otlp.mjs';

const XSS = '"><img src=x onerror=alert(1)>';
function hostileTrace() {
  return {
    schema: 1, id: 'x', title: XSS, source: 'evil', start: 0, end: 10,
    events: [{ time: 5, kind: `interjection${XSS}`, label: XSS }],
    spans: [
      { id: 's', parentId: null, kind: 'session', name: 's', start: 0, end: 10, status: 'ok', attrs: {} },
      { id: `t${XSS}`, parentId: 's', kind: `tool${XSS}`, name: XSS, start: 1, end: 9, status: `error${XSS}`,
        attrs: { 'tool.category': `x);background:url(https://evil.example)${XSS}`, 'tool.phase': XSS, 'tool.summary': XSS, 'error.message': XSS },
        input: { a: `<script>alert(1)</script>${XSS}` }, output: `</pre>${XSS}` },
      { id: 'l', parentId: 's', kind: 'llm', name: XSS, start: 2, end: 3, status: 'ok', attrs: { 'llm.model': XSS }, output: XSS },
    ],
  };
}

test('sanitizeTrace forces markup-bound fields to known values', () => {
  const t = sanitizeTrace(hostileTrace());
  const tool = t.spans[1];
  assert.equal(tool.kind, 'span');
  assert.equal(tool.status, 'unset');
  assert.equal(tool.attrs['tool.category'], 'other');
  assert.equal(tool.attrs['tool.phase'], null);
  const weird = sanitizeTrace({ spans: [{ id: 'a', start: 0, end: 1, name: 42, attrs: [1] }], events: [{ time: 0 }] });
  assert.equal(weird.spans[0].name, '42');
  assert.deepEqual(weird.spans[0].attrs, {});
  assert.equal(weird.events[0].kind, 'event');
});

test('parseAny sanitizes everything it returns', () => {
  const { traces: [t] } = parseAny(JSON.stringify(hostileTrace()));
  assert.ok(t.spans.every((s) => ['session', 'turn', 'llm', 'tool', 'agent', 'span'].includes(s.kind)));
  assert.ok(t.spans.every((s) => ['ok', 'error', 'unset'].includes(s.status)));
});

test('rendered panels never contain raw markup from the trace', () => {
  const prepared = prepareTrace(hostileTrace());
  const htmls = [
    ...prepared.trace.spans.map((s) => renderDetails(prepared, s.id).html),
    ...prepared.trace.spans.map((s) => renderSelectionHeader(prepared, s.id)),
    renderScopedInsights(prepared, { scope: { mode: 'selection', rootId: 's', label: XSS } }).html,
    renderScopedInsights(prepared, { scope: { mode: 'view', t0: 0, t1: 10, label: XSS } }).html,
    renderOpportunityList(prepared, { expandedId: prepared.opportunities[0]?.id }),
    renderOverview(prepared),
  ];
  for (const html of htmls) {
    assert.ok(!/<img|<script|onerror=|url\(https/i.test(html.replace(/&lt;img|&lt;script|onerror=alert\(1\)&gt;|url\(https:\/\/evil\.example\)/g, '')), 'no live markup');
    assert.ok(!html.includes('"><img'), 'attribute breakout is escaped');
  }
});

test('built report: strict CSP whose hash matches the inline script; hostile data stays inert', () => {
  const { traces } = parseAny(JSON.stringify(hostileTrace()));
  const html = buildHtml({ data: { traces } });
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.ok(!/unsafe-eval/.test(csp));
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'no inline-script escape hatch');
  const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const hash = crypto.createHash('sha256').update(script, 'utf8').digest('base64');
  assert.ok(csp.includes(`'sha256-${hash}'`), 'CSP allows exactly the bundled script');
  assert.equal(contentSecurityPolicy(script), csp);
  assert.equal((html.match(/<script/g) ?? []).length, 2, 'only the data block and the app script');
});

test('OTLP export keeps hostile strings as plain attribute values', () => {
  const { traces: [t] } = parseAny(JSON.stringify(hostileTrace()));
  const doc = toOtlp(t);
  const values = JSON.stringify(doc);
  assert.ok(values.includes('onerror=alert(1)'), 'data preserved (it is data, not markup)');
  for (const s of doc.resourceSpans[0].scopeSpans[0].spans) assert.match(s.spanId, /^[0-9a-f]{16}$/);
});

test('no catastrophic backtracking on hostile transcripts (ReDoS regression)', async () => {
  const { cleanPromptText } = await import('../src/adapters/claude-code.mjs');
  const { redactString } = await import('../src/core/redact.mjs');
  // Inputs shaped to make lazy "match anything up to a closing tag" regexes backtrack.
  const openTags = '<system-reminder>'.repeat(50000) + 'x';
  const commands = '<command-name>'.repeat(50000);
  const pem = '-----BEGIN RSA PRIVATE KEY-----'.repeat(20000);
  const t0 = performance.now();
  cleanPromptText(openTags);
  cleanPromptText(commands);
  redactString(pem);
  redactString('-----BEGIN '.repeat(50000));
  assert.ok(performance.now() - t0 < 1000, 'linear-time scanning');
});

test('marker-based parsing keeps the old behavior', async () => {
  const { cleanPromptText } = await import('../src/adapters/claude-code.mjs');
  const { redactString } = await import('../src/core/redact.mjs');
  assert.equal(cleanPromptText('<system-reminder>a</system-reminder>hi<ide_selection>b</ide_selection> there'), 'hi there');
  assert.equal(cleanPromptText('<system-reminder>never closed hi'), '<system-reminder>never closed hi', 'unclosed wrappers are left alone');
  assert.equal(cleanPromptText('<command-name>/x</command-name>'), '/x');
  const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';
  assert.equal(redactString(`a ${key} b ${key} c`), 'a [REDACTED] b [REDACTED] c');
  assert.equal(redactString('x -----BEGIN PRIVATE KEY-----\nMIIabc (cut off)'), 'x [REDACTED]', 'unterminated key redacted to the end');
  const cert = '-----BEGIN CERTIFICATE-----\nMIIabc\n-----END CERTIFICATE-----';
  assert.equal(redactString(cert), cert, 'public certificates are not secrets');
});
