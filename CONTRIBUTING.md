# Contributing

Thanks for helping! The project has no dependencies, and it should stay that way for anything that ships.

```bash
npm run check     # build + lint + tests (what CI runs)
npm run coverage  # tests with a coverage table
```

- **Node.js 18.17+**. CI runs Node 18, 20, 22 and 24 on Linux, macOS and Windows.
- **Viewer modules** (`src/viewer`, `src/core`, `src/adapters`) run in both Node and the browser, so they can't use Node built-ins. They follow the bundler's rules:
  - single-line named imports
  - `export function|const|class`
  - unique top-level names

  `npm run build` explains any violation.
- **Commit `dist/`.** It's the downloadable viewer, and CI fails if it's stale.
- **Security.** Any new field that ends up inside markup structure (class names, styles, attributes) must be escaped or normalized in `sanitizeTrace`. Add a case to `test/security.test.mjs`.
- **Changelog.** Add a line under `## [Unreleased]` in `CHANGELOG.md` for user-visible changes.

## Releasing

Versions follow [Semantic Versioning](https://semver.org).

```bash
npm version minor   # or patch / major: bumps package.json, dates the changelog, syncs the README badge, rebuilds dist/, commits and tags
npm run badges      # refresh test and coverage badges (amend or commit)
git push --follow-tags
```

Pushing a `v*` tag runs the release workflow:
1. It checks that the tag matches `package.json`.
2. It runs the tests.
3. It publishes a GitHub release with notes from `CHANGELOG.md`, with `dist/agent-trace.html` attached.
4. If an `NPM_TOKEN` secret is configured, it publishes to npm with provenance.
