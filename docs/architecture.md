# How agent-trace works

```
 Claude Code .jsonl ─┐                           ┌─► viewer (one HTML file: canvas timeline, virtual tree,
 OTLP/JSON ──────────┼─► adapters ─► Trace ──────┤      details, scoped insights, opportunities)
 agent-trace JSON ───┘   (registry)  (sanitized) ├─► analysis: moments, stats, opportunities
 your format ────────────►                       └─► OTLP export / send
```

## Data model

`src/core/model.mjs`. A `Trace` is a list of spans plus instant `events`.

- Each span has `id`, `parentId`, `kind`, `name`, `start`, `end`, `status`, `attrs`, and optional `input` / `output`.
- `kind` is one of `session`, `turn`, `llm`, `tool`, `agent` or `span`.
- The model mirrors OpenTelemetry spans, so OTLP import and export are a direct mapping.
- Every trace goes through `sanitizeTrace` on the way in. Fields that end up in markup structure (kind, status, tool category, phase) are forced to known values.

## Adapters

`src/adapters/`. An adapter is `{ id, label, detect(text), parse(text) → Trace[] }`, and adding a format is one call:

```js
import { registerAdapter, createTrace, addSpan, finalizeTrace } from '@jrootr/agent-trace';

registerAdapter({
  id: 'my-agent',
  label: 'My agent logs',
  detect: (text) => text.startsWith('{"myagent":'),
  parse: (text) => {
    const trace = createTrace({ id: 'run-1', title: 'My run', source: 'my-agent' });
    // addSpan(trace, { id, parentId, kind: 'tool', name, start, end, status, attrs, input, output })
    return [finalizeTrace(trace)];
  },
});
```

The **Claude Code adapter**:
- groups content blocks into API messages by `message.id`, and counts usage once per message
- times model calls from the previous event to their last block, and tools from `tool_use` to `tool_result`
- treats human messages sent while a turn is running as *interjections*, not new turns
- nests subagent (sidechain) entries under the `Agent` call that spawned them
- redacts values that look like secrets unless asked not to

## Analysis

`src/core/analysis.mjs` and `src/core/opportunities.mjs`. These are plain functions over a trace, or over a slice of one (`sliceTrace`: a subtree or a time window). The viewer, the CLI and the library all use the same code.

- **Moments** are inferred from behavior: errors and what followed, phase pivots (smoothed), heavy thinking, user interjections, milestones, compactions.
- **Opportunities** are eight detectors. Each one records the span ids it's based on, and estimates its impact:
  - a saved round trip counts as the median model call in scope
  - text counts as ~4 characters per token

  They're ranked by estimated time saved plus tokens saved, weighted by confidence.

## Viewer

`src/viewer/`. Plain ES modules with no framework.

- A small, rule-checking bundler (`src/build/bundle.mjs`) inlines them, with the CSS and logo, into `dist/agent-trace.html`. The CLI embeds a trace as JSON in the same template.
- Every report carries a Content-Security-Policy. Only its own SHA-256-pinned script runs, and network access is off.
- The timeline is one `<canvas>`:
  - bars that share a pixel are coalesced
  - the overview is cached
  - redraws fit in a frame
- A piecewise-linear time scale squeezes idle gaps.
- The tree is virtualized, so only visible rows are in the DOM.

## OpenTelemetry mapping

Export follows the OpenTelemetry GenAI semantic conventions:

| agent-trace span | OTel span name | Key attributes |
|---|---|---|
| model call | `chat <model>` (CLIENT) | `gen_ai.operation.name=chat`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons` |
| tool call | `execute_tool <tool>` (CLIENT) | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id` |
| turn / subagent | the prompt / task | `gen_ai.operation.name=invoke_agent`, `gen_ai.conversation.id` |

- Everything else is kept under `agent_trace.*`.
- Errors set span status `ERROR`.
- Moments and interjections become span events.
- Exported files re-import losslessly.

On import:
- spans using GenAI conventions become model and tool calls with token counts
- other spans still appear on the timeline and in the tree
- a file with multiple traces gets a trace picker

## Performance

Measured on a laptop with a synthetic 20,000-tool-call session (41k spans, a 16 MB transcript):

| Step | Time |
|---|---|
| Parse | ~180 ms |
| Analysis | ~50 ms |
| Load in browser | ~1 s |
| Zoom/pan redraw | within one frame |
| JS heap | ~26 MB |

`test/perf.test.mjs` guards against regressions.
