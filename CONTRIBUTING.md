# Contributing

Thanks for helping! For how the pieces fit together, start with [docs/architecture.md](docs/architecture.md).

## Development

You need Node.js 18.17+. There are no dependencies to install.

```bash
npm run check      # build + lint + tests: what CI runs
npm run coverage   # tests with a coverage table
npm run badges     # refresh the README test/coverage badges
node scripts/make-demo.mjs            # regenerate examples/demo-session.jsonl
node scripts/make-large-fixture.mjs   # big synthetic session for perf work
```

CI runs Node 18, 20, 22 and 24 on Linux, macOS and Windows, plus lint, `npm audit`, a package-contents check, coverage, and CodeQL.

The tests use `node:test` and cover:
- adapters, moments, opportunities, scoping and stats
- the OTLP round trip, including import from other GenAI apps
- the CLI end to end, including a real HTTP collector
- the bundler, including hostile embedded data
- security (sanitizing, escaping, CSP)
- a 20,000-call performance guard

The canvas and DOM wiring are checked by hand in a browser.

## Ground rules

- **No runtime dependencies.** Keep anything that ships dependency-free.
- **Viewer modules run in Node and the browser.** That covers `src/viewer`, `src/core` and `src/adapters`, so they can't use Node built-ins. They follow the bundler's rules:
  - single-line named imports
  - `export function|const|class`
  - unique top-level names

  `npm run build` explains any violation.
- **Commit `dist/`.** It's the downloadable viewer, and CI fails if it's stale.
- **Security.** Any new field that ends up in markup structure (class names, styles, attributes) must be escaped, or normalized in `sanitizeTrace`. Add a case to `test/security.test.mjs`. See [SECURITY.md](SECURITY.md).
- **Changelog.** Add a line under `## [Unreleased]` in `CHANGELOG.md` for anything users would notice.

## Releasing

Versions follow [Semantic Versioning](https://semver.org):
- **patch** for fixes
- **minor** for features
- **major** for breaking changes. While on 0.x, a minor release may also break things, and the changelog says so.

`main` is protected, so the version bump goes in through a pull request, and the tag goes on the merged commit.

1. **Prepare the release on a branch.** Make sure `CHANGELOG.md` lists the changes under `## [Unreleased]`, then:

   ```bash
   git switch main && git pull
   git switch -c release/v0.3.0
   npm version minor --no-git-tag-version   # or patch | major. Match the branch name.
   git commit -am "Release 0.3.0"
   git push -u origin release/v0.3.0
   ```

   `npm version` bumps `package.json`, turns *Unreleased* into a dated `## [0.3.0]` section, and rebuilds `dist/`.
2. **Open the pull request, let CI pass, and squash-merge it.**
3. **Tag the merged commit.** This step starts the release:

   ```bash
   git switch main && git pull
   git tag v0.3.0
   git push origin v0.3.0
   ```

The tag push runs the [release workflow](.github/workflows/release.yml), which:
1. checks that the tag matches `package.json`
2. runs build, lint and tests
3. creates the **GitHub release**, with notes from the changelog and `agent-trace.html` attached
4. **publishes to npm**

npm publishing uses [trusted publishing](https://docs.npmjs.com/trusted-publishers). npm trusts this repository's `release.yml` through OpenID Connect, so no token is stored anywhere, and every version gets a provenance attestation.

To re-run a release, for example if a step failed, open **Actions → Release → Run workflow** and enter the existing tag. Steps that already succeeded are skipped.

## Roadmap

Good places to help. Sizes are rough: S is small, M is medium.

| Item | Size | What it is |
|---|---|---|
| GitHub Copilot adapter | S | Copilot hook logs → traces |
| Live mode | M | `agent-trace view --watch` tails a running session |
| Flame graph by tokens | M | What fills the context window |
| Trace diff | M | Two runs of the same task side by side |
| Browser UI tests | M | Playwright smoke tests for the viewer |
| More importers | S each | LangSmith, Langfuse, OpenAI Agents SDK, OTLP protobuf |
