// Library entry point: use the adapters and analysis from your own code.
export { parseAny, registerAdapter, listAdapters } from './adapters/registry.mjs';
export { parseClaudeTranscript } from './adapters/claude-code.mjs';
export { toOtlp, fromOtlp } from './adapters/otlp.mjs';
export { findInflections, computeStats, INFLECTION_KINDS } from './core/analysis.mjs';
export { createTrace, addSpan, finalizeTrace, validateTrace, SCHEMA_VERSION } from './core/model.mjs';
export { buildHtml } from './build/bundle.mjs';
