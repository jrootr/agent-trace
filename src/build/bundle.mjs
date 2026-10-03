// Builds the viewer into ONE self-contained HTML file: no server, no network, opens from disk.
//
// The modules are plain ESM written for this bundler's simple rules, which it enforces:
//   - imports are single-line `import { a, b } from './x.mjs';` of modules earlier in BUNDLE_ORDER
//   - exports are `export function|const|let|class` declarations
//   - top-level names are unique across all bundled modules (they share one scope)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const BUNDLE_ORDER = [
  'core/util.mjs',
  'core/redact.mjs',
  'core/categories.mjs',
  'core/model.mjs',
  'adapters/claude-code.mjs',
  'adapters/otlp.mjs',
  'adapters/registry.mjs',
  'core/analysis.mjs',
  'viewer/format.mjs',
  'viewer/store.mjs',
  'viewer/timescale.mjs',
  'viewer/timeline.mjs',
  'viewer/tree.mjs',
  'viewer/panels.mjs',
  'viewer/app.mjs',
];

const IMPORT_RE = /^import\s+\{[^}\n]*\}\s+from\s+'([^']+)';[ \t]*$/gm;
const DECL_RE = /^(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

export function bundleScripts() {
  const owners = new Map();
  const included = new Set();
  const parts = [];
  for (const rel of BUNDLE_ORDER) {
    const file = path.join(SRC, rel);
    let src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
      if (!included.has(target)) throw new Error(`${rel} imports ${m[1]}, which must come earlier in BUNDLE_ORDER`);
    }
    src = src.replace(IMPORT_RE, '');
    if (/^import\s/m.test(src)) throw new Error(`${rel} has an import the bundler doesn't support (use a single-line named import)`);
    src = src.replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/gm, '');
    if (/^export\s/m.test(src)) throw new Error(`${rel} has an export the bundler doesn't support`);
    for (const m of src.matchAll(DECL_RE)) {
      if (owners.has(m[1])) throw new Error(`top-level name "${m[1]}" is declared in both ${owners.get(m[1])} and ${rel}`);
      owners.set(m[1], rel);
    }
    included.add(rel);
    parts.push(`// ---- ${rel} ----\n${src.trim()}\n`);
  }
  return `(() => {\n'use strict';\n${parts.join('\n')}\nstartApp();\n})();\n`;
}

const BACKSLASH = String.fromCharCode(92);
const HTML_UNSAFE = [['<', 'u003c'], [String.fromCharCode(0x2028), 'u2028'], [String.fromCharCode(0x2029), 'u2029']];

/** JSON that is safe inside <script type="application/json">: no "</script>", no JS line separators. */
export function safeJsonForHtml(data) {
  let json = JSON.stringify(data ?? null);
  for (const [ch, code] of HTML_UNSAFE) json = json.split(ch).join(BACKSLASH + code);
  return json;
}

export function buildHtml({ data = null } = {}) {
  const template = fs.readFileSync(path.join(SRC, 'viewer', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(SRC, 'viewer', 'styles.css'), 'utf8');
  const script = bundleScripts().replace(/<\/script/gi, '<\\/script');
  const parts = { STYLES: css, DATA: safeJsonForHtml(data), SCRIPT: script };
  // One pass over the template only: injected content (a transcript can contain these very
  // placeholder strings) is never rescanned. A function replacer also keeps `$` sequences literal.
  return template.replace(/\/\*__(STYLES|DATA|SCRIPT)__\*\//g, (_, key) => parts[key]);
}
