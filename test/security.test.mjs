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
  const script = /<script>([\s\S]*)<\/script>\s*<\/body>/.exec(html)[1];
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
