<p align="center">
  <img src="docs/logo.svg" width="96" height="96" alt="agent-trace logo">
</p>

<h1 align="center">agent-trace</h1>

<p align="center">
  <b>See what your AI agent actually did, and where it could do better.</b><br>
  An interactive timeline, call tree and savings report for Claude Code sessions and OpenTelemetry traces, in one self-contained HTML file.
</p>

<p align="center">
  <a href="https://github.com/jrootr/agent-trace/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/jrootr/agent-trace/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="tests" src="https://img.shields.io/badge/tests-60%20passing-2ea043?style=flat-square">
  <img alt="coverage" src="https://img.shields.io/badge/coverage-91%25-2ea043?style=flat-square">
  <a href="https://www.npmjs.com/package/@jrootr/agent-trace"><img alt="npm" src="https://img.shields.io/npm/v/@jrootr/agent-trace?style=flat-square&color=5b4ff5&logo=npm&label=npm"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A518.17-339933?style=flat-square&logo=nodedotjs&logoColor=white">
  <img alt="dependencies" src="https://img.shields.io/badge/dependencies-0-2ea043?style=flat-square">
  <img alt="OpenTelemetry" src="https://img.shields.io/badge/OpenTelemetry-GenAI%20semconv-425cc7?style=flat-square&logo=opentelemetry&logoColor=white">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"></a>
</p>

![agent-trace showing a Claude Code session with its opportunities (light theme)](docs/screenshot-light.png)

<details><summary>Dark theme</summary>

![agent-trace dark theme](docs/screenshot-dark.png)

</details>

The screenshots show [`examples/demo-session.jsonl`](examples/demo-session.jsonl), a synthetic session. Open [`examples/demo.html`](examples/demo.html) in a browser to click around with nothing installed.

## Quick start

```bash
npx @jrootr/agent-trace view
```

This opens your most recent Claude Code session as an interactive report in your browser. You need Node.js 18.17+ (22 or 24 recommended); there are no dependencies. Prefer no CLI? Download `agent-trace.html` from the [latest release](https://github.com/jrootr/agent-trace/releases) and drop a trace file onto it.

## What you get

- **Timeline:** turns, model calls, tools, moments and context size. Idle stretches are squeezed out. Scroll to zoom, drag to pan.
- **Call tree:** turns → model calls → tools → subagents. Newest or oldest first, searchable, filterable.
- **Details:** prompts, responses, tool inputs and outputs, errors, and the token breakdown for any call.
- **Moments:** where the agent changed course. Errors and recoveries, phase pivots, heavy thinking, times you stepped in.
- **Insights:** scoped to your selection, the session, or the visible range. Includes a *story* of what the agent said, where the time went, and the slowest calls.
- **Opportunities:** ranked, evidence-backed ways to make the next run faster and cheaper (below).
- **OpenTelemetry in and out:** export with GenAI conventions, send to Jaeger, Langfuse or Phoenix, or open any OTLP trace.
- **Safe to share:** secrets redacted, `--no-io` for structure-only reports, and a strict CSP so a report can't phone home.

## Opportunities

Each one comes with an estimated time and token saving, a concrete **Try:** action, and **Show calls** to highlight the evidence.

| Detector | What it spots | Typical fix |
|---|---|---|
| Redundant reads | Re-reading content it already had | Point the agent at what changed |
| Repeated failures | The same call failing again | Put the fix in project instructions (CLAUDE.md) |
| One-at-a-time lookups | Independent reads, one per round trip | Ask for related reads together |
| Context bloat | Huge tool outputs carried by every later call | Trim noisy output; read line ranges |
| Cache expired | Context re-processed after a long break | New session or compact before a new task |
| Slow test loop | Test runs dominating active time | Run affected tests while iterating |
| Edit churn | Many small edits to one file | Describe the whole change up front |
| Repeated routine | The same steps across turns | Make it a script, command or skill |

## CLI

```text
agent-trace view   [target] [--out FILE] [--no-open]   HTML report, opened in your browser
agent-trace list   [--limit N]                         recent Claude Code sessions
agent-trace stats  [target] [--json]                   summary + moments in the terminal
agent-trace export [target] --format otlp|trace        write OTLP/JSON or agent-trace JSON
agent-trace send   [target] --endpoint URL             post OTLP to a collector
```

A `target` can be a transcript, an OTLP file or a session id (a prefix works). Leave it out to use your latest session.

Useful options:
- `--no-io`: structure and timing only (for sharing)
- `--no-redact`: keep secrets
- `--header "Authorization: …"`: auth for `send`

In the viewer, press `?` for keyboard shortcuts.

## Use it as a library

```js
import { parseAny, findOpportunities } from '@jrootr/agent-trace';

const { traces: [trace] } = parseAny(fs.readFileSync('session.jsonl', 'utf8'));
for (const o of findOpportunities(trace)) console.log(o.title, o.impact, o.action);
```

## Learn more

- [How it works](docs/architecture.md): the data model, adapters (add your own format), the OpenTelemetry mapping, performance
- [Contributing](CONTRIBUTING.md): development, tests, the release process, roadmap
- [Security](SECURITY.md): the threat model, and how to report a vulnerability
- [Changelog](CHANGELOG.md)

## License

MIT. See [LICENSE](LICENSE).
