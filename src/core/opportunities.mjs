// Opportunities: evidence-backed suggestions for making a session cheaper or faster.
//
// Each detector looks for one recognizable pattern and estimates what it cost, so results can
// be ranked. Estimates are deliberately simple and labelled as such in the UI:
//   - a model round trip costs the session's median model-call time
//   - text costs ~4 characters per token
// Every opportunity carries the span ids that make up its evidence.
import { percentile } from './util.mjs';

const CHARS_PER_TOKEN = 4;
const BIG_OUTPUT_CHARS = 12000; // ~3k tokens
const CACHE_TTL_MS = 5 * 60 * 1000;

export const OPPORTUNITY_KINDS = {
  redundant: { label: 'Redundant reads', icon: 'copy' },
  failures: { label: 'Repeated failures', icon: 'alert' },
  serial: { label: 'One-at-a-time lookups', icon: 'layers' },
  bloat: { label: 'Context bloat', icon: 'compress' },
  cache: { label: 'Cache expired', icon: 'retry' },
  tests: { label: 'Slow test loop', icon: 'spark' },
  churn: { label: 'Edit churn', icon: 'pivot' },
  routine: { label: 'Repeated routine', icon: 'flag' },
};

const dur = (s) => Math.max(0, s.end - s.start);
const textLen = (v) => (v == null ? 0 : typeof v === 'string' ? v.length : JSON.stringify(v).length);
const tokensOf = (chars) => Math.round(chars / CHARS_PER_TOKEN);

function inputOf(span) {
  const v = span.input;
  if (v && typeof v === 'object') return v;
  if (typeof v === 'string' && v.trim().startsWith('{')) {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return null;
}

function callKey(span) {
  const input = span.input == null ? '' : typeof span.input === 'string' ? span.input : JSON.stringify(span.input);
  return `${span.name}\u0000${input}`;
}

function pathOf(span) {
  const i = inputOf(span);
  return i?.file_path ?? i?.path ?? i?.notebook_path ?? null;
}

const isRead = (s) => ['read', 'web'].includes(s.attrs?.['tool.category']);
const isWrite = (s) => s.attrs?.['tool.category'] === 'write';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Same read-only call made again, with no write to the same file in between. */
function redundantReads(tools, ctx, out) {
  const seen = new Map();
  const wasted = [];
  for (const s of tools) {
    if (isWrite(s)) {
      const p = pathOf(s);
      for (const [k, prev] of seen) if (p && pathOf(prev) === p) seen.delete(k);
      continue;
    }
    if (!isRead(s) || s.status === 'error') continue;
    const k = callKey(s);
    if (seen.has(k)) wasted.push(s);
    else seen.set(k, s);
  }
  if (wasted.length < 2) return;
  const chars = wasted.reduce((n, s) => n + textLen(s.output), 0);
  const names = [...new Set(wasted.map((s) => s.attrs?.['tool.summary'] || s.name))];
  out.push({
    kind: 'redundant',
    title: `Repeated ${plural(wasted.length, 'lookup')} of content it already had`,
    detail: `Same input, same result, nothing changed in between: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}.`,
    action: 'Point the agent at what changed, or ask for targeted reads (search, line ranges) rather than re-reading whole files.',
    impact: { timeMs: wasted.reduce((n, s) => n + dur(s), 0) + wasted.length * ctx.roundTripMs * 0.5, tokens: tokensOf(chars) },
    evidence: wasted.map((s) => s.id),
    confidence: 'high',
  });
}

/** The same call failing more than once, plus the general cost of failures. */
function repeatedFailures(tools, ctx, out) {
  const failed = tools.filter((s) => s.status === 'error');
  if (failed.length < 2) return;
  const byKey = new Map();
  for (const s of failed) {
    const k = callKey(s);
    byKey.set(k, [...(byKey.get(k) ?? []), s]);
  }
  const repeats = [...byKey.values()].filter((l) => l.length > 1).flat();
  const evidence = repeats.length ? repeats : failed;
  const top = Object.entries(failed.reduce((m, s) => ({ ...m, [s.name]: (m[s.name] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1])[0];
  out.push({
    kind: 'failures',
    title: repeats.length
      ? `The same call failed ${plural(repeats.length, 'time')}`
      : `${plural(failed.length, 'tool call')} failed (${top[1]}× ${top[0]})`,
    detail: `Each failure costs the call itself plus a model round trip to react. Most common: ${top[0]}.`,
    action: repeats.length
      ? 'Write the fix down where the agent will see it (project instructions / CLAUDE.md): the right command, flags or environment.'
      : `Check why ${top[0]} keeps failing; a note in the project instructions usually prevents it.`,
    impact: { timeMs: evidence.reduce((n, s) => n + dur(s), 0) + evidence.length * ctx.roundTripMs, tokens: 0 },
    evidence: evidence.map((s) => s.id),
    confidence: repeats.length ? 'high' : 'medium',
  });
}

/** Consecutive model calls that each made exactly one independent read: could have been one step. */
function serialLookups(trace, tools, ctx, out) {
  const toolsByLlm = new Map();
  for (const t of tools) {
    const by = t.attrs?.['tool.requested_by'];
    if (by) toolsByLlm.set(by, [...(toolsByLlm.get(by) ?? []), t]);
  }
  if (!toolsByLlm.size) return;
  const runs = [];
  const byParent = new Map();
  for (const l of trace.spans.filter((s) => s.kind === 'llm')) byParent.set(l.parentId, [...(byParent.get(l.parentId) ?? []), l]);
  for (const llms of byParent.values()) {
    let run = [];
    for (const l of llms.sort((a, b) => a.start - b.start)) {
      const calls = toolsByLlm.get(l.id) ?? [];
      if (calls.length === 1 && isRead(calls[0])) run.push(calls[0]);
      else {
        if (run.length >= 3) runs.push(run);
        run = [];
      }
    }
    if (run.length >= 3) runs.push(run);
  }
  if (!runs.length) return;
  const saved = runs.reduce((n, r) => n + (r.length - 1), 0);
  out.push({
    kind: 'serial',
    title: `${plural(runs.reduce((n, r) => n + r.length, 0), 'lookup')} made one at a time`,
    detail: `${runs.length} stretch${runs.length === 1 ? '' : 'es'} where each model call fetched a single thing before deciding the next. Independent reads can run together in one step.`,
    action: 'Ask for related files or searches together ("read these together", or list them up front) so they run in parallel.',
    impact: { timeMs: saved * ctx.roundTripMs, tokens: 0 },
    evidence: runs.flat().map((s) => s.id),
    confidence: 'medium',
  });
}

/** Big tool outputs: they stay in the context for every later model call. */
function contextBloat(trace, tools, out) {
  const big = tools.filter((s) => textLen(s.output) >= BIG_OUTPUT_CHARS);
  if (!big.length) return;
  const llms = trace.spans.filter((s) => s.kind === 'llm');
  let carried = 0;
  let chars = 0;
  for (const s of big) {
    const len = textLen(s.output);
    chars += len;
    carried += tokensOf(len) * llms.filter((l) => l.start >= s.end && l.parentId === s.parentId).length;
  }
  const truncated = big.some((s) => typeof s.output === 'string' && s.output.includes('more characters truncated]'));
  out.push({
    kind: 'bloat',
    title: `${plural(big.length, 'large tool output')} added ~${Math.round(tokensOf(chars) / 1000)}k tokens${truncated ? '+' : ''}`,
    detail: `That text stays in the context: later model calls re-read about ${Math.round(carried / 1000)}k tokens of it in total (mostly from cache, but it still crowds the window).`,
    action: 'Trim noisy commands (tail, grep, --quiet), read line ranges rather than whole files, or summarize long output before continuing.',
    impact: { timeMs: 0, tokens: tokensOf(chars) },
    evidence: big.map((s) => s.id),
    confidence: 'medium',
  });
}

/** A long pause, then the next call re-writes a big context to cache. */
function cacheExpiry(trace, out) {
  const llms = trace.spans.filter((s) => s.kind === 'llm').sort((a, b) => a.start - b.start);
  const hits = [];
  for (let i = 1; i < llms.length; i++) {
    const gap = llms[i].start - llms[i - 1].end;
    const written = llms[i].attrs?.['llm.tokens.cache_write'] ?? 0;
    if (gap > CACHE_TTL_MS && written > 20000) hits.push({ span: llms[i], gap, written });
  }
  if (!hits.length) return;
  const tokens = hits.reduce((n, h) => n + h.written, 0);
  out.push({
    kind: 'cache',
    title: `Context re-processed after ${plural(hits.length, 'break')} (~${Math.round(tokens / 1000)}k tokens)`,
    detail: `After pauses longer than the cache lifetime, the whole context had to be processed again (longest pause ${Math.round(Math.max(...hits.map((h) => h.gap)) / 60000)} min).`,
    action: 'For a new task after a break, start a fresh session or compact first; keep long-running sessions moving.',
    impact: { timeMs: 0, tokens },
    evidence: hits.map((h) => h.span.id),
    confidence: 'medium',
  });
}

/** Test runs eating a big share of active time. */
function slowTests(tools, ctx, out) {
  const tests = tools.filter((s) => s.attrs?.['tool.phase'] === 'verify');
  if (tests.length < 2) return;
  const time = tests.reduce((n, s) => n + dur(s), 0);
  if (time < 60000 || time < ctx.activeMs * 0.3) return;
  const slowest = tests.reduce((a, b) => (dur(b) > dur(a) ? b : a));
  out.push({
    kind: 'tests',
    title: `Test runs took ${Math.round((time / ctx.activeMs) * 100)}% of active time`,
    detail: `${plural(tests.length, 'run')}, ${Math.round(time / 1000)}s in total; the slowest took ${Math.round(dur(slowest) / 1000)}s.`,
    action: 'While iterating, run only the affected tests (a single file or a name filter) and the full suite once at the end.',
    impact: { timeMs: Math.round(time * 0.5), tokens: 0 },
    evidence: tests.map((s) => s.id),
    confidence: 'medium',
  });
}

/** Many separate edits to one file within a turn. */
function editChurn(tools, ctx, out) {
  const counts = new Map();
  for (const s of tools) {
    if (!isWrite(s)) continue;
    const p = pathOf(s);
    if (!p) continue;
    const k = `${s.parentId}\u0000${p}`;
    counts.set(k, [...(counts.get(k) ?? []), s]);
  }
  const churned = [...counts.values()].filter((l) => l.length >= 5);
  if (!churned.length) return;
  const worst = churned.sort((a, b) => b.length - a.length)[0];
  const extra = churned.reduce((n, l) => n + l.length - 1, 0);
  out.push({
    kind: 'churn',
    title: `${pathOf(worst[0]).split(/[\\/]/).pop()} edited ${worst.length} times in one turn`,
    detail: `${plural(churned.length, 'file')} got five or more separate edits; each edit is its own model round trip.`,
    action: 'Describe the whole change up front so it lands in fewer, larger edits.',
    impact: { timeMs: extra * ctx.roundTripMs * 0.5, tokens: 0 },
    evidence: churned.flat().map((s) => s.id),
    confidence: 'low',
  });
}

/** The same multi-step tool sequence recurring across turns: a script or skill candidate. */
function repeatedRoutines(tools, ctx, out) {
  const byTurn = new Map();
  for (const s of tools) byTurn.set(s.parentId, [...(byTurn.get(s.parentId) ?? []), s]);
  const seqs = new Map();
  for (const [turn, list] of byTurn) {
    const names = list.sort((a, b) => a.start - b.start).map((s) => s.name);
    const seenHere = new Set();
    for (let n = 3; n <= 4; n++) {
      for (let i = 0; i + n <= names.length; i++) {
        const seq = names.slice(i, i + n);
        if (new Set(seq).size < 2 || seq.every((x) => list.find((s) => s.name === x && isRead(s)))) continue;
        const sig = seq.join(' → ');
        if (seenHere.has(sig)) continue;
        seenHere.add(sig);
        const entry = seqs.get(sig) ?? { turns: new Set(), spans: [] };
        entry.turns.add(turn);
        entry.spans.push(...list.slice(i, i + n));
        seqs.set(sig, entry);
      }
    }
  }
  const best = [...seqs.entries()].filter(([, e]) => e.turns.size >= 3).sort((a, b) => b[1].turns.size - a[1].turns.size || b[0].length - a[0].length)[0];
  if (!best) return;
  const [sig, e] = best;
  const steps = sig.split(' → ').length;
  out.push({
    kind: 'routine',
    title: `Same ${steps}-step routine in ${e.turns.size} turns`,
    detail: `${sig}. Repeated routines are candidates for a script, slash command or skill that runs them in one go.`,
    action: 'Capture it as a reusable command or script so the agent (or you) can run it directly.',
    impact: { timeMs: (e.turns.size - 1) * (steps - 1) * ctx.roundTripMs, tokens: 0 },
    evidence: [...new Set(e.spans.map((s) => s.id))],
    confidence: 'low',
  });
}

const CONFIDENCE_WEIGHT = { high: 1, medium: 0.8, low: 0.6 };

/** Ranked opportunities for a trace (or a slice of one). */
export function findOpportunities(trace) {
  const tools = trace.spans.filter((s) => s.kind === 'tool').sort((a, b) => a.start - b.start);
  const llms = trace.spans.filter((s) => s.kind === 'llm');
  const active = trace.spans.filter((s) => s.kind === 'llm' || s.kind === 'tool').reduce((n, s) => n + dur(s), 0);
  const ctx = {
    roundTripMs: llms.length ? percentile(llms.map(dur), 50) : 0,
    activeMs: Math.max(1, active),
  };
  const out = [];
  redundantReads(tools, ctx, out);
  repeatedFailures(tools, ctx, out);
  serialLookups(trace, tools, ctx, out);
  contextBloat(trace, tools, out);
  cacheExpiry(trace, out);
  slowTests(tools, ctx, out);
  editChurn(tools, ctx, out);
  repeatedRoutines(tools, ctx, out);
  // ~1k tokens weighted like ~15s: both are what a user waits for or pays for.
  const score = (o) => (o.impact.timeMs + o.impact.tokens * 15) * CONFIDENCE_WEIGHT[o.confidence];
  return out
    .map((o) => ({ ...o, impact: { timeMs: Math.round(o.impact.timeMs), tokens: Math.round(o.impact.tokens) } }))
    .sort((a, b) => score(b) - score(a))
    .map((o, i) => ({ id: `opp-${i + 1}`, ...o }));
}

/** Headline numbers for a set of opportunities (overlaps make this an upper bound). */
export function summarizeOpportunities(opps, activeMs) {
  const timeMs = opps.reduce((n, o) => n + o.impact.timeMs, 0);
  const tokens = opps.reduce((n, o) => n + o.impact.tokens, 0);
  return { count: opps.length, timeMs: Math.min(timeMs, activeMs), tokens, share: activeMs ? Math.min(1, timeMs / activeMs) : 0 };
}
