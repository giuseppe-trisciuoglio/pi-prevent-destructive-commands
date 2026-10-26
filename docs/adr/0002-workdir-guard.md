# ADR 0002: Workdir boundary guard blocks path access outside the working directory

- Status: accepted
- Date: 2026-10-26
- Author: Giuseppe Trisciuoglio
- Issue: [#24](https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/issues/24)

## Context

The extension guards against destructive commands and protected paths, but it
does not prevent the agent from reading, writing, modifying, or deleting files
outside the working directory where pi runs. Users need a guard that confines
all file operations to the workdir, with a single exception for system temp
files (e.g. `/tmp`).

Two constraints shaped the design:

1. The exception must be coherent across the whole extension. Allow the agent
   to `cat /tmp/x` while the older destructive-command checker still blocks
   `rm /tmp/x` would produce contradictory messages from a single extension.
2. The configuration is per project and user-managed, so the guard needs an
   opt-out and a discoverable way to toggle it, like the existing `/git-guards`
   and `/read-only` commands.

## Decision

The workdir boundary guard lives in `src/rules/workdir-guard.ts`. It checks
every path used by bash commands and by file tools (`read`, `write`, `edit`,
`apply_patch`) and blocks any path that resolves outside the working directory.

The system temp exception is implemented once, in `src/rules/path-utils.ts`
(`isSystemTempPath` / `isSystemTempRoot`), and shared by every path-based rule.
Both the raw and the realpath form of each temp root are recorded because path
resolution here is textual: on macOS `os.tmpdir()` is `/var/folders/...` with
realpath `/private/var/folders/...`, and `/tmp` is a symlink to `/private/tmp`.

The temp root itself is not a temp file: `rm -rf /tmp` stays blocked. Copying
into it (`cp file /tmp/`) is allowed, since the trailing slash states the
destination is the directory.

Bash analysis tracks `cd` inside a command chain: `cd` must stay inside the
boundary, and relative paths after it resolve against the tracked directory.
A `cd` that escapes, a bare `cd` (home directory), and `cd -` are blocked
because their effect cannot be verified against the boundary.

The guard is configurable per project via `.pi/prevent-destructive-commands.json`
using the `disableWorkdirGuard` boolean, defaulting to `false` (guard active),
and toggled from the pi TUI with `/workdir-guard [on|off|status]`.

Integration points:

- `src/rules/path-utils.ts`: shared system temp helpers.
- `src/rules/path-sensitive.ts`: rejects the temp root as a deletion target.
- `src/index.ts`: `checkToolInputWorkdir` runs for non-bash tools;
  `checkCommandWorkdir` runs for bash commands.
- `src/project-config.ts`: `disableWorkdirGuard` in the project configuration.
- `src/workdir-guard-command.ts`: the `/workdir-guard` slash command.

## Consequences

- File operations outside the workdir are blocked for both bash and file tools,
  while temp files keep working everywhere in the extension.
- The guard shifts behaviour of the existing destructive checker: `/tmp` targets
  are no longer rejected. Tests that relied on `/tmp` being outside the boundary
  were rewritten to use non-temp paths so they keep asserting what they meant to.
- Paths with variables or globs cannot be resolved statically and are blocked,
  which is conservative but predictable.
- The guard is opt-out per project through the JSON file or `/workdir-guard off`.
- Operating inside a workdir that itself lives under a temp root weakens the
  boundary, because the whole temp root is trusted by design.
