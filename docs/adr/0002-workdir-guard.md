# ADR 0002: Workdir boundary guard blocks path access outside the working directory

- Status: accepted
- Date: 2026-10-26
- Author: Giuseppe Trisciuoglio

## Context

The extension guards against destructive commands and protected paths, but it
does not prevent the agent from reading, writing, modifying, or deleting files
outside the working directory where pi runs. Users need a guard that confines
all file operations to the workdir, with a single exception for system temp
files (e.g. `/tmp`).

## Decision

A new workdir boundary guard is added in `src/rules/workdir-guard.ts`. It
checks every path used by bash commands and by file tools (read, write, edit,
apply_patch) and blocks any path that resolves outside the working directory.
System temp directories (`tmpdir()` and `/tmp`) are always allowed.

The guard is configurable per project via `.pi/prevent-destructive-commands.json`
using the `disableWorkdirGuard` boolean. It defaults to `false` (guard active).

Integration points:
- `src/project-config.ts`: `disableWorkdirGuard` added to `ProjectConfig` and
  `DEFAULT_PROJECT_CONFIG`, read from the JSON config file.
- `src/index.ts`: `checkToolInputWorkdir` is invoked for non-bash tools before
  the early `return undefined`; `checkCommandWorkdir` is invoked for bash
  commands after the existing destructive-command check.

## Consequences

- All file reads, writes, edits, and deletions outside the workdir are blocked,
  except under the system temp directory.
- Commands that appear to have no path (e.g. `git status`, `npm install`) are
  unaffected.
- The guard is opt-out per project: users set `disableWorkdirGuard: true` in
  `.pi/prevent-destructive-commands.json` to disable it.
- Path traversal attempts (e.g. `../../secret.txt`) are blocked because they
  resolve outside the boundary.
