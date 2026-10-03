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

See [Releasing a new version](README.md#releasing-a-new-version) in the README. In short:

```bash
git switch -c release/v0.3.0 && npm version minor --no-git-tag-version && git commit -am "Release 0.3.0"
git push -u origin release/v0.3.0     # PR → CI → merge
git switch main && git pull && git tag v0.3.0 && git push origin v0.3.0
```

The release workflow publishes the GitHub release and the npm package. npm uses trusted publishing, so no token is involved.
