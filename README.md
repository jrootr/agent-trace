# agent-trace

**See what your AI agent actually did.** agent-trace turns an agent session into an interactive timeline and call tree:
- every model call, with its tokens and thinking
- every tool call, with its inputs, outputs, timing and errors
- the **moments where the agent changed course**

It reads Claude Code transcripts and any OpenTelemetry trace, and exports OpenTelemetry back out. The viewer is a single self-contained HTML file. There's no server, no install step for viewers, and nothing leaves your machine.

![agent-trace showing a Claude Code session (light theme)](docs/screenshot-light.png)

<details><summary>Dark theme</summary>

![agent-trace dark theme](docs/screenshot-dark.png)

</details>

The screenshots show [`examples/demo-session.jsonl`](examples/demo-session.jsonl), a synthetic session. Open [`examples/demo.html`](examples/demo.html) in a browser to click around without installing anything.

## What you get

- **Timeline.** Lanes for turns, model calls (shaded by thinking intensity), tools (colored by category, parallel calls stacked), moments, and context-window size over time.
  - Scroll to zoom, drag to pan, double-click to zoom to a span.
  - Long idle stretches (you went to lunch) are squeezed so the activity stays readable. Toggle this with **Compress idle**.
- **Call tree.** Turns → model calls → tool calls → subagents, with a mini-bar showing where each call sits inside its turn.
  - It's virtualized, so sessions with 40,000+ spans stay smooth.
- **Drill-down.** Select any span to see:
  - the prompt, response, tool input and output (pretty-printed, copyable)
  - errors, and the token breakdown (cache read / cache write / fresh input, thinking / visible output)
  - breadcrumbs to its ancestors, and sibling navigation
- **Moments.** Inflection points inferred from behavior, since raw reasoning text usually isn't stored:

  | Moment | How it's detected |
  |---|---|
  | Recovered / retried / unresolved error | A tool failed. The agent did something else, repeated the same call, or never followed up. |
  | Changed phase | The tool mix shifted between *exploring* (read, search, web), *building* (write, edit, commands) and *verifying* (test runs). One-call blips are smoothed out. |
  | Heavy thinking | A model call's reasoning tokens are at or above the session's 90th percentile, and at least 1,500. |
  | Slow model call | Fallback when no thinking data exists: a call 1.5× the 90th-percentile duration, and at least 30s. |
  | User steered / interrupted | You sent a message mid-task, or pressed Esc. |
  | Milestone | The agent marked a chapter, or presented a plan. |
  | Context compacted | The conversation was summarized to free up context. |

  Jump between moments with `[` and `]`.
- **Insights.** Active time vs wall time, model vs tool time, tokens, peak context, a tools table, and moments filtered by type.
- **Search and filters.** Full-text search over names, inputs and outputs. Category chips, *errors only*, and *moments only* filters. Matches stay bright in both the tree and the timeline, and their ancestors are kept for context.
- **Light and dark** themes that follow your system, plus a toggle (`t`) and a `?theme=dark` URL parameter.
- **Keyboard first.** Press `?` in the viewer for the full list.

## Quick start

Requires **Node.js 18.17+**. There are no dependencies.

```bash
git clone <this repo> agent-trace
cd agent-trace
node bin/agent-trace.mjs view        # opens your most recent Claude Code session
```

Put the command on your PATH (`agent-trace …` from anywhere):

```bash
npm link
```

Or skip the CLI entirely. Open `dist/agent-trace.html` in a browser and drag a file onto it.

## CLI

```text
agent-trace view   [target] [--out FILE] [--no-open]     self-contained HTML report, opened in your browser
agent-trace list   [--limit N] [--json]                  recent Claude Code sessions
agent-trace stats  [target] [--json]                     summary + moments in the terminal
agent-trace export [target] --format otlp|trace [--out FILE]
agent-trace send   [target] --endpoint URL [--header "Name: value"]...
agent-trace build                                        rebuild dist/agent-trace.html
```

A `target` can be:
- a `.jsonl` transcript
- an OTLP/JSON file
- an exported `agent-trace` JSON file
- a directory
- a Claude Code **session id**, or the first few characters of one

Leave it out to use your most recent session. Subagent transcripts stored next to a session (`<session>/subagents/*.jsonl`) are merged in automatically.

Options for anything that reads a trace:
- `--no-redact`: keep values that look like secrets. They're redacted by default: API keys, GitHub/Slack/AWS tokens, JWTs, bearer headers, private keys, and arguments named like `password`/`token`/`apiKey`.
- `--no-io`: structure and timing only, with no prompts, outputs or tool inputs. Use this when sharing a report.
- `--max-io N`: characters kept per input/output (default 20,000).

Claude Code transcripts live in `~/.claude/projects/<project>/<session-id>.jsonl`. Set `AGENT_TRACE_CLAUDE_DIR` to look somewhere else.

## OpenTelemetry

agent-trace is pluggable in both directions.

**Export.** `agent-trace export --format otlp` writes OTLP/JSON following the OpenTelemetry GenAI semantic conventions:

| agent-trace span | OTel span name | Key attributes |
|---|---|---|
| model call | `chat <model>` (kind CLIENT) | `gen_ai.operation.name=chat`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons` |
| tool call | `execute_tool <tool>` (kind CLIENT) | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id` |
| turn / subagent | the prompt / task | `gen_ai.operation.name=invoke_agent`, `gen_ai.conversation.id` |

Everything else (cache tokens, thinking tokens, categories, inputs and outputs) is kept under `agent_trace.*`. Errors set span status `ERROR`. Interjections and inflection points become span events. An exported file re-imports into the viewer losslessly.

**Send.** `agent-trace send` POSTs to any OTLP/HTTP collector. For example, local Jaeger:

```bash
docker run --rm -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one
agent-trace send --endpoint http://localhost:4318
# then browse http://localhost:16686
```

For Langfuse, Phoenix, Tempo or a vendor collector, pass the auth header: `--header "Authorization: Basic …"`.

**Import.** Drop any OTLP/JSON trace export onto the viewer, or pass it to the CLI. Spans using the GenAI conventions show up as model and tool calls with token counts. Anything else shows up as generic spans, still on the timeline and in the tree. Multi-trace files get a trace picker.

## How it works

```
 Claude Code .jsonl ─┐                       ┌─► viewer (single HTML file: canvas timeline,
 OTLP/JSON ──────────┼─► adapters ─► Trace ──┤      virtual tree, drill-down, insights)
 agent-trace JSON ───┘   (registry)  model   ├─► analysis (moments, stats)
 your format ────────────►                   └─► OTLP export / send
```

**Normalized model** (`src/core/model.mjs`). A `Trace` is a list of `Span`s plus instant `events`:
- spans have `id`, `parentId`, `kind`, `name`, `start`, `end`, `status`, `attrs`, and optional `input`/`output`
- `kind` is one of `session`, `turn`, `llm`, `tool`, `agent` or `span`

The model deliberately mirrors OpenTelemetry spans, so OTLP is a direct mapping.

**Adapters** (`src/adapters/`). Each one is `{ id, label, detect(text), parse(text) → Trace[] }`, and adding a format is one `registerAdapter` call:

```js
import { registerAdapter, createTrace, addSpan, finalizeTrace } from 'agent-trace';

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

**Claude Code adapter** (`src/adapters/claude-code.mjs`). The transcript stores one entry per content block, so the adapter:
- groups blocks into API messages by `message.id` and counts usage once
- treats a model call as running from the previous event to its last block
- times each tool from its `tool_use` to its `tool_result`
- treats human messages that arrive while a turn is still running as *interjections*, not new turns
- nests subagent (sidechain) entries under the `Agent` call that spawned them

**Viewer** (`src/viewer/`). Plain ES modules with no framework:
- `scripts/build.mjs` inlines them, with the CSS, into `dist/agent-trace.html`
- the CLI reuses the same builder and embeds the trace as JSON
- the timeline is a single `<canvas>`: zoomed out, bars sharing a pixel column are coalesced and the overview strip is cached, so redraws stay within a frame
- a piecewise-linear time scale squeezes idle gaps; the tree only renders visible rows

**Performance** (measured on a laptop with a synthetic 20,000-tool-call session, 41k spans, a 16 MB transcript):

| Step | Time |
|---|---|
| Parse | ~180 ms |
| Analysis | ~50 ms |
| Load in browser | ~1 s |
| Zoom/pan redraw | under one frame |
| JS heap | ~26 MB |

`test/perf.test.mjs` guards this.

**Privacy:**
- Everything runs locally.
- Reports embed redacted data. Use `--no-io` when you share one.
- The viewer makes no network requests.

## Development

```bash
npm test          # 42 tests, ~2s, no dependencies (node:test)
npm run build     # rebuild dist/agent-trace.html (a test fails if it's stale)
node scripts/make-demo.mjs           # regenerate examples/demo-session.jsonl
node scripts/make-large-fixture.mjs  # big synthetic session for perf work
```

What the tests cover:

| File | Covers |
|---|---|
| `core.test.mjs` | Moments (recovery, retry, pivots with smoothing, thinking, slow-call fallback, milestones), stats, model validation, categories and phases, redaction (with false-positive checks), the adapter registry including a custom adapter |
| `claude-code.test.mjs` | Turns, usage de-duplication, tool timing and errors, interjections, background tasks, compaction, interrupts, subagent nesting, redaction / `--no-io` / truncation, slash-command titles, malformed lines |
| `otlp.test.mjs` | OTLP id/time validity, GenAI attributes, events, lossless round trip, import from a foreign GenAI-instrumented app (string status codes, string ints, orphans, multiple traces) |
| `viewer-logic.test.mjs` | Idle compression (invertible, monotonic), tree flattening with collapse and filtered ancestors, derived data, store, formatting |
| `build.test.mjs` | Bundle validity, self-containment, hostile embedded data (`</script>`, placeholder strings, `$&`, U+2028), `dist/` freshness |
| `cli.test.mjs` | Every command against a fake `~/.claude/projects`, including subagent files and a real HTTP collector with auth |
| `perf.test.mjs` | The 20k-call pipeline stays fast |

The viewer UI itself (rendering, selection sync, search, themes, OTLP drag-and-drop, phone layout) was verified by hand in a browser. Automating that is on the backlog.

Bundler rules: viewer modules use single-line named imports, `export function|const|class`, and globally unique top-level names. `src/build/bundle.mjs` enforces these and fails the build with a clear message.

## Execution plan

| Phase | Scope | Status |
|---|---|---|
| 1. Core | Normalized trace model, Claude Code adapter, redaction, moments, stats | ✅ done |
| 2. OpenTelemetry | OTLP/JSON export with GenAI conventions, import from any OTLP source, `send` to collectors, lossless round trip | ✅ done |
| 3. Viewer | Canvas timeline with idle compression, virtual call tree, drill-down, insights, search and filters, light/dark, keyboard, drag-and-drop, single-file build | ✅ done |
| 4. CLI | `view`, `list`, `stats`, `export`, `send`, `build`; session discovery; subagent merge | ✅ done |
| 5. Quality | 42 automated tests, perf guard, manual browser verification on real and 41k-span sessions | ✅ done |

**Backlog**, roughly in order of value. Each item has a size estimate.

1. **GitHub Copilot adapter** (S): VS Code / Copilot CLI hook logs (`PostToolUse` payloads) → traces. Needs a sample payload to pin down field names.
2. **Live mode** (M): `agent-trace view --watch` tails a running session and updates the page.
3. **Flame graph by tokens** (M): width = tokens rather than time, to find what fills the context window.
4. **Trace diff** (M): two runs of the same task side by side. Which calls were added or removed, and where did time go?
5. **Browser UI tests** (M): Playwright smoke tests for selection sync, search, themes and drag-and-drop.
6. **More importers** (S each): LangSmith / Langfuse JSON exports, OpenAI Agents SDK traces, OTLP protobuf.
7. **npm release** (S): publish so `npx agent-trace view` works without cloning.
8. **Shareable links** (M): compressed trace in the URL fragment for small sessions.
9. **Accessibility pass** (S): screen-reader descriptions of timeline content, high-contrast palette.

## License

MIT. See [LICENSE](LICENSE).
