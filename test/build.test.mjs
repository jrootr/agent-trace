import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildHtml, bundleScripts, safeJsonForHtml, BUNDLE_ORDER } from '../src/build/bundle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Slice by markers rather than lazy regexes (linear time, and nothing for scanners to flag).
const scriptOf = (html) => html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
const DATA_OPEN = '<script type="application/json" id="agent-trace-data">';
const dataOf = (html) => {
  const start = html.indexOf(DATA_OPEN) + DATA_OPEN.length;
  return JSON.parse(html.slice(start, html.indexOf('</script>', start)));
};

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

test('release tooling: changelog sections, dated releases, badges; changelog covers this version', async () => {
  const { changelogSection, releaseChangelog, setBadge } = await import('../scripts/release-tools.mjs');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'semver');
  assert.ok(changelogSection(changelog, pkg.version)?.length > 20, `CHANGELOG.md documents ${pkg.version}`);

  const sample = '# C\n\n## [Unreleased]\n\n### Added\n- thing\n\n## [1.0.0] - 2026-01-01\n- old\n\n[Unreleased]: https://x/compare/v1.0.0...HEAD\n[1.0.0]: https://x/releases/tag/v1.0.0\n';
  const released = releaseChangelog(sample, '1.1.0', '2026-02-02', 'https://x');
  assert.match(released, /## \[Unreleased\]\n\n## \[1\.1\.0\] - 2026-02-02\n\n### Added\n- thing/);
  assert.match(released, /\[Unreleased\]: https:\/\/x\/compare\/v1\.1\.0\.\.\.HEAD\n\[1\.1\.0\]: https:\/\/x\/compare\/v1\.0\.0\.\.\.v1\.1\.0/);
  assert.equal(releaseChangelog(released, '1.1.0', 'later'), released, 'idempotent');
  assert.equal(changelogSection(released, '1.0.0'), '- old');

  const readme = '![v](https://img.shields.io/badge/version-0.1.0-5b4ff5?style=flat-square) ![t](https://img.shields.io/badge/tests-1%20passing-2ea043)';
  assert.match(setBadge(readme, 'version', '1.2.3', '5b4ff5'), /badge\/version-1\.2\.3-5b4ff5\?style=flat-square/);
  assert.match(setBadge(readme, 'tests', '53 passing', '2ea043'), /badge\/tests-53%20passing-2ea043\)/);
  assert.throws(() => setBadge(readme, 'nope', 'x', 'y'), /no nope badge/);
});
