# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is 0.x, minor releases may change behavior; breaking changes are called out explicitly.

## [Unreleased]

### Changed
- Releases publish to npm through trusted publishing (OIDC, with provenance) rather than an access token. The workflow can be re-run for an existing tag and skips steps that are already done.
- The README badge shows the live npm version, and the README now has step-by-step release instructions.
- GitHub Actions updated to checkout v7, setup-node v7 and CodeQL v4.

## [0.2.0] - 2026-10-03

### Added
- **Opportunities.** Ranked, evidence-backed suggestions with estimated time and token savings, from eight detectors: redundant reads, repeated failures, one-at-a-time lookups, context bloat, cache expiry after breaks, slow test loops, edit churn, and repeated routines. Each one has a concrete "Try:" action and a **Show calls** button that highlights its evidence in the tree and the timeline.
- **Scoped Insights.** Insights follow the selected turn or subagent, the whole session, or the visible timeline range, and update as you click and zoom.
- **Story.** The agent's own messages in order, interleaved with moments: an overview of its reasoning even when the thinking text isn't stored.
- **Where the time went** split (model, tools, waiting), and a **Slowest calls** ranking.
- **Newest first / Oldest first** toggle for the call tree (`o`), applied at every level and remembered.
- **Clear** button (`c`), which resets selection, search and filters.
- **Shift+click a filter chip** to show only that category; Shift+click it again to show everything.
- Logo and favicon; the version is shown in the help dialog.
- CI on Linux, macOS and Windows with Node 18, 20 and 22; a release workflow that publishes the standalone viewer as a release asset.
- `npm run coverage`, `npm run badges`, and an `npm version` hook that keeps the changelog and README badges in sync.

### Changed
- Selecting a span from the timeline or tree keeps the current side tab. Insights re-scope to the selection; clicks inside the side panel open Details.
- The Insights tab was rebuilt around scope, opportunities and story.

### Fixed
- Durations near a minute boundary showed as "4m 60s"; they now round correctly ("5m 00s").

## [0.1.0] - 2026-10-03

### Added
- Normalized trace model with pluggable adapters: Claude Code transcripts, OpenTelemetry OTLP/JSON, and agent-trace JSON.
- OTLP/JSON export following the OpenTelemetry GenAI semantic conventions, import from any OTLP source, `send` to collectors, and a lossless round trip.
- Single-file HTML viewer:
  - canvas timeline with idle compression
  - virtualized call tree
  - drill-down details
  - inferred moments (errors and recoveries, phase pivots, heavy thinking, user steering, milestones, compactions)
  - search and filters, light and dark themes, keyboard navigation, drag-and-drop
- CLI: `view`, `list`, `stats`, `export`, `send`, `build`.
- Secret redaction by default; `--no-io` for shareable reports.

[Unreleased]: https://github.com/jrootr/agent-trace/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/jrootr/agent-trace/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jrootr/agent-trace/releases/tag/v0.1.0
