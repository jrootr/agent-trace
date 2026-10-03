// Guards against accidental O(n²) work: a 20k-tool-call session must stay fast end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseAny } from '../src/adapters/registry.mjs';
import { prepareTrace } from '../src/viewer/store.mjs';
import { buildTimeScale } from '../src/viewer/timescale.mjs';
import { flattenRows } from '../src/viewer/tree.mjs';
import { toOtlp, fromOtlp } from '../src/adapters/otlp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('20k tool calls: parse, analyze, lay out and round-trip in well under a few seconds', () => {
  const text = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-large-fixture.mjs'), '20000'], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
  const t0 = performance.now();
  const { traces: [trace] } = parseAny(text);
  const prepared = prepareTrace(trace);
  buildTimeScale(trace);
  const rows = flattenRows(prepared, new Set(), null);
  const pipelineMs = performance.now() - t0;
  assert.ok(trace.spans.length > 40000);
  assert.equal(rows.length, trace.spans.length - 1);
  assert.ok(pipelineMs < 4000, `viewer pipeline took ${Math.round(pipelineMs)}ms`);

  const t1 = performance.now();
  const back = fromOtlp(toOtlp(trace, { includeIo: false }))[0];
  const otlpMs = performance.now() - t1;
  assert.equal(back.spans.length, trace.spans.length);
  assert.ok(otlpMs < 6000, `OTLP round trip took ${Math.round(otlpMs)}ms`);
});
