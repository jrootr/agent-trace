#!/usr/bin/env node
// agent-trace CLI: open, summarize, export, or ship agent traces.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseAny } from '../src/adapters/registry.mjs';
import { toOtlp } from '../src/adapters/otlp.mjs';
import { computeStats, findInflections } from '../src/core/analysis.mjs';
import { buildHtml } from '../src/build/bundle.mjs';
import { findSessions, resolveTarget, readTraceText, projectsDir } from '../src/node/sessions.mjs';

const PKG = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));

const HELP = `agent-trace ${PKG.version}: see what your agent actually did.

Usage: agent-trace <command> [target] [options]

  target   a .jsonl transcript, an OTLP/JSON file, a directory, or a Claude Code
           session id (prefix ok). Omit it to use your most recent Claude Code session.

Commands
  view [target]       Build a self-contained HTML report and open it
      --out FILE        where to write it (default: a temp file)
      --no-open         don't open a browser
  list                Recent Claude Code sessions        [--limit N] [--json]
  stats [target]      Summary and inflection points      [--json]
  export [target]     Write a trace                      --format otlp|trace (default otlp) [--out FILE]
  send [target]       POST OTLP/JSON to a collector      --endpoint URL [--header "K: V"]...
  build               Rebuild dist/agent-trace.html (the drag-and-drop viewer)

Options for commands that read a trace
  --no-redact         keep secrets that look like tokens/keys (redacted by default)
  --no-io             drop tool inputs/outputs and model text (structure and timing only)
  --max-io N          characters kept per input/output (default 20000)

Examples
  agent-trace view
  agent-trace export --format otlp --out session.otlp.json
  agent-trace send --endpoint http://localhost:4318 --header "Authorization: Bearer $TOKEN"`;

class UsageError extends Error {}

function parseArgs(argv) {
  const args = { _: [], header: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      args._.push(a);
      continue;
    }
    const [key, inline] = a.slice(2).split(/=(.*)/s);
    if (key.startsWith('no-')) {
      args[key] = true;
      continue;
    }
    if (['json', 'help', 'version'].includes(key)) {
      args[key] = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new UsageError(`--${key} needs a value`);
    if (key === 'header') args.header.push(value);
    else args[key] = value;
  }
  return args;
}

function loadTraces(target, args) {
  const file = resolveTarget(target);
  const text = file.endsWith('.jsonl') ? readTraceText(file) : fs.readFileSync(file, 'utf8');
  const maxIo = args['max-io'] !== undefined ? Number(args['max-io']) : undefined;
  if (maxIo !== undefined && !(maxIo > 0)) throw new UsageError('--max-io must be a positive number');
  const { traces, adapter } = parseAny(text, {
    fileName: path.basename(file),
    redact: !args['no-redact'],
    includeIo: !args['no-io'],
    maxIo,
  });
  return { file, traces, adapter };
}

function slug(s) {
  return String(s ?? 'trace').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'trace';
}

function openInBrowser(file) {
  const [cmd, cmdArgs] = process.platform === 'win32'
    ? ['explorer.exe', [file]]
    : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
  try {
    spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    // no browser available (CI, SSH): the path is printed anyway
  }
}

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
const fmtK = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const commands = {
  view(args, out) {
    const { file, traces } = loadTraces(args._[0], args);
    const html = buildHtml({ data: { generator: `agent-trace ${PKG.version}`, generatedAt: new Date().toISOString(), traces } });
    const dest = args.out ? path.resolve(args.out) : path.join(os.tmpdir(), 'agent-trace', `${slug(traces[0].title)}-${slug(traces[0].id).slice(0, 8)}.html`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, html);
    out(`Read ${file}`);
    out(`Wrote ${dest} (${(html.length / 1024).toFixed(0)} KB)`);
    if (!args['no-open']) openInBrowser(dest);
  },

  list(args, out) {
    const limit = Number(args.limit ?? 15);
    const sessions = findSessions().slice(0, limit);
    const rows = sessions.map((s) => {
      let title = '';
      try {
        const { traces } = parseAny(fs.readFileSync(s.file, 'utf8'), { includeIo: false });
        title = traces[0].title ?? '';
      } catch {
        title = '(unreadable)';
      }
      return { id: s.id, title, modified: new Date(s.mtime).toISOString(), project: s.project, file: s.file };
    });
    if (args.json) return out(JSON.stringify(rows, null, 2));
    if (!rows.length) return out(`No sessions found in ${projectsDir()}`);
    for (const r of rows) out(`${r.id.slice(0, 8)}  ${r.modified.slice(0, 16).replace('T', ' ')}  ${r.title.slice(0, 70)}`);
    out(`\nOpen one with: agent-trace view <id>`);
  },

  stats(args, out) {
    const { traces } = loadTraces(args._[0], args);
    const t = traces[0];
    const st = computeStats(t);
    const inf = findInflections(t);
    if (args.json) return out(JSON.stringify({ title: t.title, stats: st, inflections: inf }, null, 2));
    out(t.title ?? t.id);
    out(`  time      ${fmtMs(st.activeTime)} active of ${fmtMs(st.wallTime)} (model ${fmtMs(st.modelTime)}, tools ${fmtMs(st.toolTime)})`);
    out(`  activity  ${st.turns} turns, ${st.llmCalls} model calls, ${st.toolCalls} tool calls, ${st.errors} errors`);
    out(`  tokens    ${fmtK(st.tokens.output)} out (${fmtK(st.tokens.thinking)} thinking), ${fmtK(st.tokens.cacheRead)} cache read, peak context ${fmtK(st.tokens.peakContext)}`);
    out(`  top tools ${st.topTools.slice(0, 6).map((x) => `${x.name}×${x.count}`).join(', ')}`);
    if (inf.length) {
      out(`\nMoments (${inf.length})`);
      for (const i of inf.slice(0, 40)) out(`  ${new Date(i.time).toLocaleTimeString()}  ${i.kind.padEnd(12)} ${i.label}`);
      if (inf.length > 40) out(`  …and ${inf.length - 40} more (--json for all)`);
    }
  },

  export(args, out) {
    const format = args.format ?? 'otlp';
    if (!['otlp', 'trace'].includes(format)) throw new UsageError('--format must be otlp or trace');
    const { traces } = loadTraces(args._[0], args);
    const payload = format === 'otlp'
      ? mergeOtlp(traces.map((t) => toOtlp(t, { inflections: findInflections(t), includeIo: !args['no-io'] })))
      : traces.length === 1 ? traces[0] : traces;
    const json = JSON.stringify(payload, null, 2);
    if (args.out) {
      fs.writeFileSync(args.out, json);
      out(`Wrote ${args.out}`);
    } else out(json);
  },

  async send(args, out) {
    if (!args.endpoint) throw new UsageError('send needs --endpoint (e.g. http://localhost:4318)');
    const { traces } = loadTraces(args._[0], args);
    const body = JSON.stringify(mergeOtlp(traces.map((t) => toOtlp(t, { inflections: findInflections(t), includeIo: !args['no-io'] }))));
    const url = /\/v1\/traces\/?$/.test(args.endpoint) ? args.endpoint : args.endpoint.replace(/\/$/, '') + '/v1/traces';
    const headers = { 'content-type': 'application/json' };
    for (const h of args.header) {
      const i = h.indexOf(':');
      if (i <= 0) throw new UsageError(`--header must look like "Name: value", got "${h}"`);
      headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
    }
    const res = await fetch(url, { method: 'POST', headers, body });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`Collector answered HTTP ${res.status}: ${text.slice(0, 300)}`);
    const spans = traces.reduce((n, t) => n + t.spans.length, 0);
    out(`Sent ${spans} spans in ${traces.length} trace(s) to ${url}`);
  },

  build(_args, out) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const dest = path.join(root, 'dist', 'agent-trace.html');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buildHtml());
    out(`Wrote ${dest}`);
  },
};

function mergeOtlp(requests) {
  return { resourceSpans: requests.flatMap((r) => r.resourceSpans) };
}

export async function main(argv = process.argv.slice(2), out = (s) => process.stdout.write(s + '\n')) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 2;
  }
  const [cmd, ...rest] = args._;
  if (args.version) {
    out(PKG.version);
    return 0;
  }
  if (!cmd || args.help || cmd === 'help') {
    out(HELP);
    return 0;
  }
  const handler = commands[cmd];
  if (!handler) {
    process.stderr.write(`Unknown command "${cmd}". Run agent-trace --help.\n`);
    return 2;
  }
  args._ = rest;
  try {
    await handler(args, out);
    return 0;
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return e instanceof UsageError ? 2 : 1;
  }
}

function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
const isMain = isEntryPoint();
if (isMain) main().then((code) => (process.exitCode = code));
