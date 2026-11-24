# ADR 0014: Resolve `$TMPDIR` in bash paths from the environment

- Status: accepted
- Date: 2026-11-24
- Author: Giuseppe Trisciuoglio
- Issue: [#60](https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/issues/60)

## Context

The workdir guard blocks any path that contains a shell variable, because it
cannot resolve the variable statically. The orchestrator sets `TMPDIR` to an
in-worktree scratch directory (git-ignored) and tells its agents to use it. As a
result, `python3 lint.py > "$TMPDIR/lint.out"` and `cat > "$TMPDIR/search.js"`
were blocked. In addition, the tokenizer split `"$TMPDIR"/*.pid` into `$TMPDIR`
and `/*.pid`, and the second token was then read as a glob rooted at `/`.

## Decision

- **Expansion.** In bash commands only, the workdir guard replaces `$TMPDIR` and
  `${TMPDIR}` with `process.env.TMPDIR` (`expandTmpdir`/`checkCommandPath` in
  `src/rules/workdir-guard.ts`). The expanded path then goes through the normal
  check, so it is allowed only inside the working directory or the system temp
  directories (ADR 0010). If the expanded path escapes, the block message shows
  both the original and the expanded path. A `cd "$TMPDIR"` moves the tracked
  cwd to the expanded value.
- **When the value is not trusted.** No expansion happens in these cases, and the
  path stays blocked as unresolvable with a reason that says which case applies:
  - `TMPDIR` is unset;
  - its value is not absolute, or contains `$`, a backtick, glob characters or a
    newline;
  - the top-level command mentions `TMPDIR` other than as `$TMPDIR` or
    `${TMPDIR}`, for example `TMPDIR=/etc cmd`, `export TMPDIR=…`,
    `for TMPDIR in …`, `read TMPDIR` or `unset TMPDIR`. Matching on any such
    mention is deliberately coarse and fails safe.

  `${TMPDIR:-x}` and every other variable (`$HOME`, `$TMPDIR_X`, …) stay
  unresolvable.
- **Literal paths are not expanded.** The `write`, `edit` and `apply_patch` tool
  paths are not expanded, because a `$` in those paths is literal. String
  literals in inline programs (`python -c '…$TMPDIR…'`) are not expanded either.
- **Tokenizer.** A double-quoted segment that is only a variable reference
  (`"$NAME"`, `"${NAME}"`) and starts a word is joined with the non-whitespace
  text that follows it, so `"$TMPDIR"/*.pid` is the single token
  `$TMPDIR/*.pid`. With an unresolvable variable, `"$X"/*.pid` is now blocked as
  unresolvable, not as a glob rooted at `/`.

## Consequences

- Agents can use the sanctioned scratch directory without workarounds.
- The guard trusts the extension process's environment to match the bash
  environment, which holds when the orchestrator sets `TMPDIR` for the agent
  process. `os.tmpdir()` already honours `TMPDIR`, so a `TMPDIR` outside the
  worktree was already treated as a temp root for literal paths (ADR 0010).
  Expansion adds no new allowed locations.
- With `TMPDIR` unset, behaviour is the same as before (verified by a
  differential run).
- Covered by `test/workdir-guard-test.ts` (issue #60 block).
