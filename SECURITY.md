# Security policy

## Supported versions

Security fixes go into the latest minor release.

| Version | Supported |
|---|---|
| 0.2.x | ✅ |
| < 0.2 | ❌ |

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private vulnerability reporting (Security → Report a vulnerability) on this repository, or contact the maintainer directly. You'll get an acknowledgement within a few days, and a fix or mitigation plan once the issue is confirmed.

## Threat model

agent-trace reads transcripts and traces that may contain prompts, code, command output and credentials, and it renders them in a browser. The design assumes trace files can be hostile and reports can be shared.

- **Local only.** The CLI reads files and writes a report. The only network call is `send`, which posts to the collector you name.
- **Strict report sandbox.** The generated HTML has a Content-Security-Policy that:
  - allows only its own script, pinned by SHA-256 hash
  - blocks all network access (`connect-src 'none'`)
  - blocks plugins, base-tag and form tricks

  A report can't send its data anywhere, even if a bug let markup through.
- **Untrusted input is escaped and normalized.** All trace text is HTML-escaped before rendering. Fields that reach markup structure (span kind, status, tool category, phase) are forced to known values. `test/security.test.mjs` feeds hostile traces through every renderer.
- **Secrets are redacted by default.** Values that look like API keys, tokens, JWTs or private keys, and arguments named like `password`, `token` or `apiKey`, become `[REDACTED]`. Redaction is best-effort pattern matching: use `--no-io` before sharing a report outside your team.
- **No runtime dependencies**, so there's no supply chain to audit beyond Node.js itself.
