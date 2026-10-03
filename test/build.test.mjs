import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildHtml, bundleScripts, safeJsonForHtml, BUNDLE_ORDER } from '../src/build/bundle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const scriptOf = (html) => html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)[1];
const dataOf = (html) => JSON.parse(html.match(/<script type="application\/json" id="agent-trace-data">([\s\S]*?)<\/script>/)[1]);

test('bundle is one valid script that bundles every viewer module', () => {
  const js = bundleScripts();
  assert.doesNotThrow(() => new vm.Script(js));
  for (const rel of BUNDLE_ORDER) assert.ok(js.includes(`// ---- ${rel} ----`));
  assert.ok(!/^\s*(import|export)\s/m.test(js), 'no module syntax left');
});

test('every src module the viewer needs is in the bundle order', () => {
  const viewerFiles = fs.readdirSync(path.join(ROOT, 'src', 'viewer')).filter((f) => f.endsWith('.mjs')).map((f) => `viewer/${f}`);
  for (const f of viewerFiles) assert.ok(BUNDLE_ORDER.includes(f), `${f} is bundled`);
});

test('html is self-contained: no external scripts, styles or fonts', () => {
  const html = buildHtml();
  assert.ok(!/<script[^>]+src=/i.test(html));
  assert.ok(!/<link[^>]+rel="stylesheet"/i.test(html));
  assert.ok(!/@import|url\(https?:/i.test(html));
  assert.ok(!html.includes('/*__'), 'all placeholders filled');
  assert.equal(dataOf(html), null);
});

test('embedded data survives hostile content (placeholders, </script>, line separators)', () => {
  const nasty = {
    traces: [{ title: '</script><script>alert(1)</script> /*__SCRIPT__*/ /*__DATA__*/ $& $1 ' + String.fromCharCode(0x2028), spans: [] }],
  };
  const html = buildHtml({ data: nasty });
  assert.deepEqual(dataOf(html), nasty);
  assert.equal(html.match(/<\/script>/g).length, 2, 'only the two real closing tags');
  assert.doesNotThrow(() => new vm.Script(scriptOf(html)));
  assert.ok(scriptOf(html).includes('startApp();'));
  assert.equal(JSON.parse(safeJsonForHtml('a<b')), 'a<b');
});

test('dist/agent-trace.html is up to date with the sources', () => {
  const dist = fs.readFileSync(path.join(ROOT, 'dist', 'agent-trace.html'), 'utf8');
  assert.equal(dist, buildHtml(), 'run `npm run build` and commit dist/');
});
