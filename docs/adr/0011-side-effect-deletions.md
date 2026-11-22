# ADR 0011: Deletions performed as a side effect of high-level commands

- Status: accepted
- Date: 2026-11-22
- Author: Giuseppe Trisciuoglio
- Issue: [#45](https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/issues/45)

## Context

The guard blocked the deletion primitives (`git push --delete`,
`git branch -D`), but allowed high-level commands that delete as a side
effect: `gh pr merge --delete-branch`, `gh pr close --delete-branch` and
`git worktree remove --force`. Some of these lose work, some do not.

## Decision

The guard decides by what can be lost, not by the presence of a delete flag.

- **`gh pr merge … -d|--delete-branch`: allowed.** After a successful merge the
  head branch is reachable from the base, so nothing is lost.
- **`gh pr close … -d|--delete-branch`: blocked.** The PR is not merged, so its
  head commits may become unreachable. Detected spellings: `-d`,
  `--delete-branch`, `--delete-branch=<anything but false>`, and `d` inside a
  short-option cluster before a value-taking letter (`-dc msg` blocks, `-Rd` is
  `-R d` and does not). `-R/--repo` may appear before or after `pr close`. The
  reason suggests closing without `-d` and keeping or archiving the branch.
- **`git worktree remove --force|-f` (any count, `-ff`, before or after the
  path): allowed only when verifiably harmless.** The guard resolves the path
  (honouring `-C <dir>` and a preceding `cd`), then runs
  `git -C <path> status --porcelain --untracked-files=all` and checks
  `<git-dir>/locked`. A clean, unlocked worktree is allowed, because forced
  removal then has the same effect as a plain `remove`. A dirty or locked
  worktree blocks, and so does any state that cannot be checked (missing path,
  variable or glob in the path, unknown cwd, git failure). Plain
  `git worktree remove` and `git worktree prune` stay allowed, since git itself
  refuses to drop a dirty worktree without `--force`.

These rules are unconditional: they apply also when the git add/commit/push
guards are disabled for the project.

## Consequences

- The checker now runs `git` synchronously (5 s timeout) for forced worktree
  removals. This is the first rule that inspects repository state.
- `gh pr merge -d` on a PR that later fails to merge does not delete the branch
  (gh deletes only after merging), so no warning is added.
- Covered by `test/gh-guard-test.ts` and `test/git-guards-command-test.ts`.
