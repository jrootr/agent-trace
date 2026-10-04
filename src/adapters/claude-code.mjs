// Adapter: Claude Code session transcripts (~/.claude/projects/<project>/<session>.jsonl).
//
// A transcript is one JSON object per line. The relevant entry types:
//   user       - a human prompt (string content) or tool results (tool_result blocks)
//   assistant  - one entry per content block; blocks of one API response share message.id
//                and repeat the same usage numbers
//   system     - hook summaries, compaction boundaries, API errors
//   attachment - context injected by the app, incl. messages queued while the agent worked
// Entries with isSidechain=true belong to subagents and are nested under their Agent call.
import { createTrace, addSpan, finalizeTrace } from '../core/model.mjs';
import { categorizeTool, phaseOf, summarizeToolInput } from '../core/categories.mjs';
import { redactValue, redactString } from '../core/redact.mjs';
import { parseTime, truncateText, contentText, textBetween, removeSections } from '../core/util.mjs';

const DEFAULT_MAX_IO = 20000;
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

export function looksLikeClaudeTranscript(text) {
  const head = text.slice(0, 20000);
  return /"sessionId"\s*:/.test(head) && /"type"\s*:\s*"(user|assistant|queue-operation|summary)"/.test(head);
}

function parseLines(text) {
  const entries = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      bad++;
    }
  }
  return { entries, bad };
}

// Context the app wraps around a prompt; not something the user typed.
const WRAPPER_TAGS = ['system-reminder', 'ide_opened_file', 'ide_selection', 'ide_diagnostics'];

/** Strip app-injected wrappers so titles show what the user typed (slash commands become "/name args"). */
export function cleanPromptText(text) {
  const raw = String(text ?? '');
  const cmd = textBetween(raw, '<command-name>', '</command-name>');
  if (cmd !== null) {
    const args = (textBetween(raw, '<command-args>', '</command-args>') ?? '').trim();
    return `${cmd.trim()}${args ? ' ' + args : ''}`;
  }
  let stripped = raw;
  for (const tag of WRAPPER_TAGS) stripped = removeSections(stripped, `<${tag}>`, `</${tag}>`);
  stripped = stripped.trim();
  return stripped || raw.trim();
}

function snippet(text, max = 80) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

/** Prompts the app sends that aren't really the user typing. */
function classifyHumanText(text) {
  if (text.startsWith('[Request interrupted by user')) return 'interrupt';
  if (text.startsWith('<local-command-stdout>') || text.startsWith('<local-command-caveat>')) return 'noise';
  if (text.startsWith('<task-notification>')) return 'background';
  return 'prompt';
}

function taskSummary(text) {
  const summary = textBetween(text, '<summary>', '</summary>');
  return summary ? summary.trim() : 'Background task finished';
}

export function parseClaudeTranscript(text, options = {}) {
  const maxIo = options.maxIo ?? DEFAULT_MAX_IO;
  const doRedact = options.redact !== false;
  const keepIo = options.includeIo !== false;
  const { entries, bad } = parseLines(text);

  const clipValue = (v) => {
    if (!keepIo || v === undefined) return undefined;
    const clean = doRedact ? redactValue(v) : v;
    if (typeof clean === 'string') return truncateText(clean, maxIo);
    const json = JSON.stringify(clean);
    return json && json.length > maxIo ? truncateText(JSON.stringify(clean, null, 2), maxIo) : clean;
  };
  const clipText = (s) => (keepIo ? truncateText(doRedact ? redactString(s) : s, maxIo) : undefined);

  const first = entries.find((e) => e.sessionId);
  const withEnv = entries.find((e) => e.cwd) ?? {};
  const sessionId = first?.sessionId ?? options.id ?? 'session';
  let title = options.title;
  const models = new Set();
  for (const e of entries) {
    if (e.type === 'custom-title' && e.customTitle) title = options.title ?? e.customTitle;
    if (e.type === 'summary' && e.summary && !title) title = e.summary;
  }
  const meta = {
    sessionId,
    cwd: withEnv.cwd ?? null,
    gitBranch: withEnv.gitBranch ?? null,
    version: withEnv.version ?? null,
    entrypoint: withEnv.entrypoint ?? null,
    skippedLines: bad,
  };
  const trace = createTrace({ id: sessionId, title: title ?? null, source: 'claude-code', meta });
  const startTs = entries.map((e) => parseTime(e.timestamp)).find((t) => t != null) ?? 0;
  const root = addSpan(trace, { id: 'session', kind: 'session', name: 'Session', start: startTs, end: startTs, status: 'ok' });

  let firstPrompt = null;
  const toolSpans = new Map(); // tool_use id -> span (shared so subagent results can resolve too)

  /**
   * Walk one stream of entries (the main conversation, or one subagent's sidechain).
   * ctx.parentId(): where new llm/tool spans go when there is no turn.
   */
  function walk(list, ctx) {
    const llmSpans = new Map();
    let turn = null;
    let turnActive = false;
    let turnCount = 0;
    let lastTime = null;

    const openTurn = (time, promptText) => {
      if (promptText && firstPrompt === null) firstPrompt = promptText;
      if (turn) turn.end = Math.max(turn.end, lastTime ?? time);
      turnCount++;
      turn = addSpan(trace, {
        id: `${ctx.prefix}turn-${turnCount}`,
        parentId: root.id,
        kind: 'turn',
        name: promptText ? snippet(cleanPromptText(promptText)) : '(continued)',
        start: time,
        end: time,
        status: 'ok',
        attrs: { 'turn.index': turnCount },
        input: promptText ? clipText(promptText) : undefined,
      });
      turnActive = true;
    };
    const parentFor = (time) => {
      if (!ctx.turns) return ctx.parentId(time);
      if (!turn) openTurn(time, null);
      return turn.id;
    };

    for (const e of list) {
      const ts = parseTime(e.timestamp);
      if (ts == null) continue;

      if (e.type === 'user' && !e.isMeta) {
        const content = e.message?.content;
        const results = Array.isArray(content) ? content.filter((b) => b?.type === 'tool_result') : [];
        if (results.length) {
          for (const block of results) {
            const span = toolSpans.get(block.tool_use_id);
            if (!span) continue;
            span.end = Math.max(span.start, ts);
            span.status = block.is_error ? 'error' : 'ok';
            const out = contentText(block.content) || (typeof e.toolUseResult === 'string' ? e.toolUseResult : '');
            if (out) span.output = clipText(out);
            if (block.is_error) span.attrs['error.message'] = snippet(out, 200);
          }
          lastTime = ts;
          continue;
        }
        const humanText = contentText(content);
        if (!humanText) continue;
        const kind = classifyHumanText(humanText);
        if (kind === 'noise') continue;
        if (!ctx.turns) {
          lastTime = ts;
          continue;
        }
        if (kind === 'interrupt') {
          trace.events.push({ time: ts, kind: 'interrupt', label: 'Interrupted by user', spanId: turn?.id });
          turnActive = false;
        } else if (kind === 'background') {
          trace.events.push({ time: ts, kind: 'background', label: taskSummary(humanText), spanId: turn?.id });
        } else if (turnActive && turn) {
          trace.events.push({ time: ts, kind: 'interjection', label: snippet(cleanPromptText(humanText), 120), spanId: turn.id, detail: clipText(humanText) });
        } else {
          openTurn(ts, humanText);
        }
        lastTime = ts;
        continue;
      }

      if (e.type === 'assistant' && e.message) {
        const msg = e.message;
        const key = msg.id ?? e.uuid;
        let span = llmSpans.get(key);
        if (!span) {
          if (msg.model) models.add(msg.model);
          span = addSpan(trace, {
            id: `${ctx.prefix}llm-${key}`,
            parentId: parentFor(ts),
            kind: 'llm',
            name: msg.model ?? 'model',
            start: lastTime != null && lastTime <= ts ? lastTime : ts,
            end: ts,
            status: 'ok',
            attrs: { 'llm.model': msg.model ?? null },
          });
          llmSpans.set(key, span);
        }
        span.end = Math.max(span.end, ts);
        const u = msg.usage;
        if (u) {
          const fresh = u.input_tokens ?? 0;
          const cacheRead = u.cache_read_input_tokens ?? 0;
          const cacheWrite = u.cache_creation_input_tokens ?? 0;
          Object.assign(span.attrs, {
            'llm.tokens.input': fresh,
            'llm.tokens.cache_read': cacheRead,
            'llm.tokens.cache_write': cacheWrite,
            'llm.tokens.context': fresh + cacheRead + cacheWrite,
            'llm.tokens.output': u.output_tokens ?? 0,
            'llm.tokens.thinking': u.output_tokens_details?.thinking_tokens ?? 0,
          });
        }
        if (msg.stop_reason) span.attrs['llm.stop_reason'] = msg.stop_reason;
        for (const block of Array.isArray(msg.content) ? msg.content : []) {
          if (block.type === 'thinking' || block.type === 'redacted_thinking') {
            span.attrs['llm.thinking_blocks'] = (span.attrs['llm.thinking_blocks'] ?? 0) + 1;
            if (block.thinking) span.attrs['llm.thinking'] = clipText(((span.attrs['llm.thinking'] ?? '') + '\n' + block.thinking).trim());
          } else if (block.type === 'text' && block.text) {
            const prev = typeof span.output === 'string' ? span.output + '\n\n' : '';
            span.output = clipText(prev + block.text);
          } else if (block.type === 'tool_use') {
            const category = categorizeTool(block.name, block.input);
            const tool = addSpan(trace, {
              id: `${ctx.prefix}tool-${block.id}`,
              parentId: span.parentId,
              kind: 'tool',
              name: block.name,
              start: ts,
              end: ts,
              status: 'unset',
              attrs: {
                'tool.call_id': block.id,
                'tool.category': category,
                'tool.phase': phaseOf(block.name, block.input, category),
                'tool.summary': doRedact ? redactString(summarizeToolInput(block.name, block.input)) : summarizeToolInput(block.name, block.input),
                'tool.requested_by': span.id,
              },
              input: clipValue(block.input),
            });
            toolSpans.set(block.id, tool);
            span.attrs['llm.tool_calls'] = (span.attrs['llm.tool_calls'] ?? 0) + 1;
          }
        }
        if (msg.stop_reason && msg.stop_reason !== 'tool_use') turnActive = false;
        lastTime = ts;
        continue;
      }

      if (e.type === 'system') {
        if (e.subtype === 'compact_boundary') {
          trace.events.push({ time: ts, kind: 'compaction', label: 'Context compacted', spanId: turn?.id, detail: e.compactMetadata ? JSON.stringify(e.compactMetadata) : undefined });
        } else if (e.subtype === 'api_error' || e.level === 'error') {
          trace.events.push({ time: ts, kind: 'error', label: snippet(e.content ?? e.error ?? 'API error', 120), spanId: turn?.id });
        } else if (e.subtype === 'stop_hook_summary') {
          if (Array.isArray(e.hookErrors) && e.hookErrors.length) {
            trace.events.push({ time: ts, kind: 'error', label: `Stop hook error: ${snippet(JSON.stringify(e.hookErrors[0]), 100)}`, spanId: turn?.id });
          }
          if (ctx.turns) turnActive = false;
        }
        continue;
      }

      if (e.type === 'attachment' && e.attachment?.type === 'queued_command' && ctx.turns) {
        const prompt = String(e.attachment.prompt ?? '');
        if (prompt.startsWith('<task-notification>')) {
          trace.events.push({ time: ts, kind: 'background', label: taskSummary(prompt), spanId: turn?.id });
        } else if (prompt) {
          trace.events.push({ time: ts, kind: 'interjection', label: snippet(prompt, 120), spanId: turn?.id, detail: clipText(prompt) });
        }
      }
    }
    if (turn && lastTime != null) turn.end = Math.max(turn.end, lastTime);
  }

  const main = entries.filter((e) => !e.isSidechain);
  walk(main, { prefix: '', turns: true });

  // Subagents: group sidechain entries per agent and hang them under the Agent call that spawned them.
  const groups = new Map();
  for (const e of entries) {
    if (!e.isSidechain) continue;
    const key = e.agentId ?? e.sessionId ?? 'sidechain';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const agentCalls = trace.spans.filter((s) => s.kind === 'tool' && SUBAGENT_TOOLS.has(s.name));
  let n = 0;
  for (const [key, list] of groups) {
    n++;
    const t0 = list.map((e) => parseTime(e.timestamp)).find((t) => t != null);
    const host = agentCalls.filter((s) => s.start <= (t0 ?? 0)).sort((a, b) => b.start - a.start)[0];
    const agentSpan = addSpan(trace, {
      id: `agent-${n}`,
      parentId: host?.id ?? root.id,
      kind: 'agent',
      name: host?.attrs['tool.summary'] || `Subagent ${key.slice(0, 8)}`,
      start: t0 ?? startTs,
      end: t0 ?? startTs,
      status: 'ok',
      attrs: { 'agent.id': key },
    });
    walk(list, { prefix: `a${n}-`, turns: false, parentId: () => agentSpan.id });
  }

  trace.meta.models = [...models];
  if (!trace.title) trace.title = firstPrompt ? snippet(cleanPromptText(firstPrompt), 60) : `Session ${sessionId.slice(0, 8)}`;
  finalizeTrace(trace);
  root.name = trace.title;
  return trace;
}
