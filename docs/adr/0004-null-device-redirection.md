# ADR 0004: Allow shell redirection to the Unix null device

- Status: accepted
- Date: 2026-10-27
- Author: Giuseppe Trisciuoglio
- Issue: [#31](https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/issues/31)
- Amends: [ADR 0002](0002-workdir-guard.md)

## Context

The workdir boundary guard treats every path outside the working directory as
unsafe. That is appropriate for ordinary files, but it also blocks a standard
shell idiom for discarding output:

```bash
grep -rn "pattern" docs/ .pi/ 2>/dev/null | head -30
```

The destination is the Unix null device. It does not expose or modify files
outside the working directory, so treating it like an ordinary external path
causes a false positive in a common read-only workflow.

A broad exception would weaken the boundary. In particular, allowing the path
through file tools, ordinary write commands, or destructive commands would
also allow access that the issue does not need to permit.

## Decision

The workdir guard distinguishes a shell redirect destination from an ordinary
write target. The exact normalized path `/dev/null` is allowed only when it is
the destination of a configured shell write-redirect operator, including `2>`
and `>`.

The null-device exception does not apply to direct reads, file-tool writes,
ordinary write commands, or destructive commands. Other paths under `/dev`
remain blocked. Redirecting into an installed skills directory remains blocked
because the redirect is still a write operation for that location.

The redirect classification lives in `src/rules/workdir-guard.ts`. The shared
path decision in `src/rules/path-utils.ts` enforces the narrow null-device
exception and keeps the existing read, write, and skill protections.

## Consequences

- Common commands that discard standard output or standard error through
  `/dev/null` work without disabling the workdir guard.
- Direct access to `/dev/null` remains blocked, preserving the boundary for
  file tools and commands that are not redirects.
- Other special devices remain outside the exception and are blocked.
- The behavior is covered by regression tests in
  `test/workdir-guard-test.ts`.
