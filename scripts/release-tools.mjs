// Release helpers (no dependencies):
//   node scripts/release-tools.mjs notes 0.2.0   print that version's CHANGELOG section (release notes)
//   node scripts/release-tools.mjs version       npm `version` hook: date the changelog, sync README badge
//   node scripts/release-tools.mjs badges        run tests with coverage, refresh README test/coverage badges
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = (f) => path.join(ROOT, f);
const read = (f) => fs.readFileSync(file(f), 'utf8');
const version = () => JSON.parse(read('package.json')).version;

/** The body of "## [x.y.z]" up to the next "## [" heading. */
export function changelogSection(text, v) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## [${v}]`));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## ['));
  return lines.slice(start + 1, end < 0 ? undefined : end).filter((l) => !/^\[[^\]]+\]: /.test(l)).join('\n').trim();
}

/** Turn "## [Unreleased]" content into a dated "## [v]" section and fix the compare links. */
export function releaseChangelog(text, v, date, repo = 'https://github.com/jrootr/agent-trace') {
  if (text.includes(`## [${v}]`)) return text;
  const prev = /^## \[(\d+\.\d+\.\d+)\]/m.exec(text)?.[1];
  let out = text.replace('## [Unreleased]', `## [Unreleased]\n\n## [${v}] - ${date}`);
  out = out.replace(/^\[Unreleased\]: .*$/m, `[Unreleased]: ${repo}/compare/v${v}...HEAD\n[${v}]: ${repo}/compare/v${prev}...v${v}`);
  return out;
}

export function setBadge(readme, label, message, color) {
  const re = new RegExp(`(https://img\\.shields\\.io/badge/${label}-)[^?)]+(\\?[^)]*)?`);
  if (!re.test(readme)) throw new Error(`README has no ${label} badge`);
  const enc = encodeURIComponent(message).replace(/-/g, '--');
  return readme.replace(re, (_, pre, query = '') => `${pre}${enc}-${color}${query}`);
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
const [cmd, arg] = isMain ? process.argv.slice(2) : [];
if (cmd === 'notes') {
  const notes = changelogSection(read('CHANGELOG.md'), arg ?? version());
  if (!notes) {
    console.error(`CHANGELOG.md has no section for ${arg ?? version()}`);
    process.exit(1);
  }
  process.stdout.write(notes + '\n');
} else if (cmd === 'version') {
  const v = version();
  fs.writeFileSync(file('CHANGELOG.md'), releaseChangelog(read('CHANGELOG.md'), v, new Date().toISOString().slice(0, 10)));
  fs.writeFileSync(file('README.md'), setBadge(read('README.md'), 'version', v, '5b4ff5'));
  execFileSync(process.execPath, [file('scripts/build.mjs')], { stdio: 'inherit' });
  console.log(`prepared ${v}: changelog dated, badge and dist/ updated`);
} else if (cmd === 'badges') {
  const pkg = JSON.parse(read('package.json'));
  const files = pkg.scripts.test.replace('node --test ', '').split(' ');
  let out = '';
  try {
    out = execFileSync(process.execPath, ['--test', '--experimental-test-coverage', '--test-reporter=tap', ...files], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  } catch (e) {
    out = e.stdout ?? '';
  }
  const tests = Number(/^# tests (\d+)/m.exec(out)?.[1]);
  const fail = Number(/^# fail (\d+)/m.exec(out)?.[1]);
  const cov = Number(/^# all files\s*\|\s*([\d.]+)/m.exec(out)?.[1]);
  if (!tests) throw new Error('could not read the test summary');
  let readme = read('README.md');
  readme = setBadge(readme, 'tests', fail ? `${fail} failing` : `${tests} passing`, fail ? 'e5484d' : '2ea043');
  if (cov) readme = setBadge(readme, 'coverage', `${Math.floor(cov)}%`, cov >= 85 ? '2ea043' : cov >= 70 ? 'dfb317' : 'e5484d');
  fs.writeFileSync(file('README.md'), readme);
  console.log(`badges: ${tests} tests, ${fail} failing, coverage ${cov}%`);
  if (fail) process.exit(1);
} else if (cmd) {
  console.error('usage: release-tools.mjs notes [version] | version | badges');
  process.exit(2);
}
