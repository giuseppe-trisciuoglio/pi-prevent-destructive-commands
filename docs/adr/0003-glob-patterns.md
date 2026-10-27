# ADR 0003: Glob patterns are decided from the directory they expand from

- Status: accepted
- Date: 2026-10-27
- Author: Giuseppe Trisciuoglio
- Issue: [#29](https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/issues/29)
- Related: [ADR 0002](0002-workdir-guard.md)

## Context

The workdir boundary guard resolves every path it sees and refuses the ones it
cannot resolve. A glob pattern was classified with the shell variables: it is
not a path, so it was blocked with "cannot safely resolve path", and the agent
could not run ordinary commands such as `ls docs/agent/*.md` or
`grep -rn "x" frontend/src/pages/*.tsx`.

Blocking shell variables is right: their value only exists at run time, so no
static decision can be trusted. A glob is different. The set of files a pattern
selects is chosen by the shell, but the directory it expands from is part of
the pattern itself and is known statically.

## Decision

A glob pattern is split into the directory it expands from — everything before
the first wildcard — and the wildcard remainder. The guard decides the pattern
from that directory, using the same rules as any other path: inside the
workdir is allowed, the system temp directory is allowed, an installed skill
root is allowed for reading and refused for writing, everything else is
blocked.

A pattern that walks out of the directory it expands from, such as
`docs/*/../../etc/passwd`, is blocked: the reachable set cannot be bounded
statically, so the decision would be unsound.

The wildcard primitives live in `src/rules/glob.ts`, the decision lives in
`src/rules/path-utils.ts` (`isOutsideCwd`), and both entry points reuse it:
the workdir guard for bash commands and file tools, the destructive checker
for path-sensitive commands and `find` search roots. A path-sensitive command
evaluates its patterns as writes, a `find` search root as a read.

## Consequences

- Glob patterns that expand inside the workdir are usable again, for bash
  commands, for the `read`/`write`/`edit`/`apply_patch` tools and for the
  destructive checker.
- Patterns that expand outside the workdir keep the same verdict as the
  concrete paths they would select.
- The skills and system temp exceptions apply to patterns too, so reading a
  skill through a pattern works while writing one through a pattern does not.
- A globbed `find` search root inside the workdir or under the temp directory
  is now allowed, where it used to be refused as unresolvable.
- Patterns that walk out of their expansion directory are refused even when
  they would in fact stay inside the workdir, for instance
  `docs/*/../*.md`. The alternative would be enumerating the matches, which
  is unbounded work on a tree of unknown size.
- Symlinked directories keep the textual resolution used everywhere else in
  the guard: a symlink inside the workdir pointing outside it is not detected.
