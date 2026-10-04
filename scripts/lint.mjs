// Zero-dependency quality gate. Run with `npm run lint`; CI runs it on every push.
//   - every .mjs parses (node --check)
//   - text hygiene: LF endings, final newline, no trailing whitespace, no tabs in code
//   - no debugging leftovers in shipped code (console.log, debugger, TODO/FIXME)
//   - no secrets in tracked files
//   - package.json is publishable: semver version, engines, bin shebang, files that exist
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const report = (file, line, msg) => problems.push(`${file}${line ? `:${line}` : ''}  ${msg}`);

const tracked = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && fs.existsSync(path.join(ROOT, f)));
const TEXT = /\.(mjs|js|json|jsonl|css|html|md|yml|yaml|svg|txt)$|^(LICENSE|\.gitignore|\.gitattributes|\.editorconfig)$/;
const GENERATED = new Set(['dist/agent-trace.html', 'examples/demo.html', 'examples/demo-session.jsonl', 'package-lock.json']);
const SHIPPED = (f) => f.startsWith('src/') || f.startsWith('bin/');

const SECRET_PATTERNS = [
  [/\bsk-(ant-)?[A-Za-z0-9_-]{20,}/, 'API key (sk-…)'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/, 'GitHub fine-grained token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{20,}/, 'Slack token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\bnpm_[A-Za-z0-9]{36}\b/, 'npm token'],
];
// Test fixtures deliberately contain fake secrets to prove they get redacted.
const SECRET_ALLOW = new Set(['test/fixtures/transcript.mjs', 'test/cli.test.mjs', 'test/security.test.mjs', 'test/core.test.mjs', 'src/core/redact.mjs', 'scripts/lint.mjs']);

for (const f of tracked) {
  const full = path.join(ROOT, f);
  if (f.endsWith('.mjs')) {
    try {
      execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
    } catch (e) {
      report(f, 0, `does not parse: ${String(e.stderr).split('\n').find((l) => l.includes('Error')) ?? 'syntax error'}`);
    }
  }
  if (!TEXT.test(path.basename(f)) && !TEXT.test(f)) continue;
  const text = fs.readFileSync(full, 'utf8');
  if (text.includes('\r\n')) report(f, 0, 'CRLF line endings (use LF)');
  if (text.length && !text.endsWith('\n') && !f.endsWith('.svg')) report(f, 0, 'missing final newline');
  if (!SECRET_ALLOW.has(f)) {
    for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) report(f, 0, `looks like it contains a ${what}`);
  }
  if (GENERATED.has(f)) continue;
  text.split('\n').forEach((line, i) => {
    if (line !== line.trimEnd() && !f.endsWith('.md')) report(f, i + 1, 'trailing whitespace');
    if (/\.(mjs|css|html|yml)$/.test(f) && line.includes('\t')) report(f, i + 1, 'tab character (use spaces)');
    if (SHIPPED(f) && f.endsWith('.mjs')) {
      if (/\bconsole\.(log|debug)\(/.test(line)) report(f, i + 1, 'console.log in shipped code');
      if (/^\s*debugger\b/.test(line)) report(f, i + 1, 'debugger statement');
      if (/\b(TODO|FIXME|XXX)\b/.test(line)) report(f, i + 1, 'unresolved TODO/FIXME');
    }
  });
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version)) report('package.json', 0, `version "${pkg.version}" is not semver`);
if (!pkg.engines?.node) report('package.json', 0, 'missing engines.node');
if (pkg.dependencies && Object.keys(pkg.dependencies).length) report('package.json', 0, 'runtime dependencies crept in; this project ships with none');
for (const [name, bin] of Object.entries(pkg.bin ?? {})) {
  const src = fs.readFileSync(path.join(ROOT, bin), 'utf8');
  if (!src.startsWith('#!/usr/bin/env node')) report(bin, 1, `bin "${name}" needs a node shebang`);
}
for (const entry of pkg.files ?? []) {
  if (!fs.existsSync(path.join(ROOT, entry))) report('package.json', 0, `"files" entry ${entry} does not exist`);
}
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes(`## [${pkg.version}]`)) report('CHANGELOG.md', 0, `no entry for ${pkg.version}`);

if (problems.length) {
  console.error(`lint: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`lint: ${tracked.length} files clean`);
