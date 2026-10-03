// Adapter registry. An adapter turns some file format into normalized traces.
// To support a new agent (e.g. GitHub Copilot hook logs), register { id, label, detect, parse }.
import { looksLikeClaudeTranscript, parseClaudeTranscript } from './claude-code.mjs';
import { looksLikeOtlp, fromOtlp } from './otlp.mjs';
import { validateTrace, sanitizeTrace, SCHEMA_VERSION } from '../core/model.mjs';

const ADAPTERS = [];

export function registerAdapter(adapter) {
  for (const key of ['id', 'detect', 'parse']) {
    if (!adapter?.[key]) throw new Error(`adapter is missing "${key}"`);
  }
  const existing = ADAPTERS.findIndex((a) => a.id === adapter.id);
  if (existing >= 0) ADAPTERS.splice(existing, 1, adapter);
  else ADAPTERS.push(adapter);
}

export function listAdapters() {
  return ADAPTERS.map(({ id, label }) => ({ id, label }));
}

registerAdapter({
  id: 'agent-trace',
  label: 'agent-trace JSON',
  detect: (text) => /^\s*\{\s*"schema"\s*:\s*\d+/.test(text.slice(0, 200)) || /^\s*\[\s*\{\s*"schema"\s*:/.test(text.slice(0, 200)),
  parse: (text) => {
    const doc = JSON.parse(text);
    return Array.isArray(doc) ? doc : [doc];
  },
});
registerAdapter({ id: 'otlp', label: 'OpenTelemetry OTLP/JSON', detect: looksLikeOtlp, parse: (text) => fromOtlp(text) });
registerAdapter({
  id: 'claude-code',
  label: 'Claude Code transcript (.jsonl)',
  detect: looksLikeClaudeTranscript,
  parse: (text, opts) => [parseClaudeTranscript(text, opts)],
});

/** Detect the format, parse, and validate. Throws with a readable message on failure. */
export function parseAny(text, options = {}) {
  const adapter = options.adapter
    ? ADAPTERS.find((a) => a.id === options.adapter)
    : ADAPTERS.find((a) => {
        try {
          return a.detect(text, options.fileName);
        } catch {
          return false;
        }
      });
  if (!adapter) {
    throw new Error(`Unrecognized format${options.fileName ? ` in ${options.fileName}` : ''}. Supported: ${ADAPTERS.map((a) => a.label).join(', ')}.`);
  }
  const traces = adapter.parse(text, options);
  if (!traces.length) throw new Error('The file contains no traces.');
  for (const t of traces) {
    if (t.schema !== undefined && t.schema > SCHEMA_VERSION) throw new Error(`Trace schema ${t.schema} is newer than this viewer supports (${SCHEMA_VERSION}).`);
    const problems = validateTrace(t);
    if (problems.length) throw new Error(`Invalid trace "${t.title ?? t.id}": ${problems.slice(0, 3).join('; ')}`);
    sanitizeTrace(t);
  }
  return { adapter: adapter.id, traces };
}
