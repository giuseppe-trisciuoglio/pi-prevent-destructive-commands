# ADR 0006: Treat git message arguments as free text in the workdir guard

- Status: accepted
- Date: 2026-10-28
- Author: Giuseppe Trisciuoglio
- Issue: [#35](https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/issues/35)
- Amends: [ADR 0002](0002-workdir-guard.md)

## Context

The workdir boundary guard tokenizes the whole shell command and, when a
token contains whitespace and a slash, re-analyzes it as a nested command
line. A quoted commit message is a single such token, so the message prose
is parsed as shell syntax. Path-like words inside the message — for example
a route name such as `/conversazioni` — are then blocked as paths outside
the working directory:

```bash
git add -A && git commit -m "feat(conversazioni): lista /conversazioni ..."
# Blocked: "/conversazioni" is outside the working directory
```

The message is free text. It is never executed, read, or written, so
analyzing it as a command line is a false positive that blocks ordinary
commits.

## Decision

Before paths are checked, the workdir guard collects the indices of tokens
that hold git message free text and excludes them from every further check
(path-shaped or nested-command). The collection covers:

- `git commit`, `git tag`, `git merge`, `git notes`, and `git stash` with
  `-m`, `--message`, or `--notes`, including combined short flags ending in
  `m` (for example `git commit -am "text"`);
- attached values such as `--message="text"`, taking into account that the
  tokenizer splits a quoted attached value into the flag and the text.

Options whose values remain filesystem paths stay guarded: `-F`/`--file` for
the commit message file and `--template=` for the commit template follow the
workdir boundary like any other path, and path arguments such as
`git add /etc/passwd` are still blocked.

The change is limited to the workdir guard in `src/rules/workdir-guard.ts`.
The destructive-command checker's git decisions are unchanged.

## Consequences

Commit messages can mention any path-like text without being blocked. The
guard still cannot distinguish message text from other free-text arguments of
commands it does not know about; that broader heuristic is out of scope.
