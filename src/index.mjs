// Library entry point: use the adapters and analysis from your own code.
export { parseAny, registerAdapter, listAdapters } from './adapters/registry.mjs';
export { parseClaudeTranscript } from './adapters/claude-code.mjs';
export { toOtlp, fromOtlp } from './adapters/otlp.mjs';
export { findInflections, computeStats, sliceTrace, INFLECTION_KINDS } from './core/analysis.mjs';
export { findOpportunities, summarizeOpportunities, OPPORTUNITY_KINDS } from './core/opportunities.mjs';
export { createTrace, addSpan, finalizeTrace, validateTrace, sanitizeTrace, SCHEMA_VERSION } from './core/model.mjs';
export { redactValue } from './core/redact.mjs';
export { buildHtml } from './build/bundle.mjs';
