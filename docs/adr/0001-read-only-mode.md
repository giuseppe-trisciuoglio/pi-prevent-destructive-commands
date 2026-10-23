# ADR 0001: Read-only mode blocks shell execution wholesale

- Status: accepted
- Date: 2026-10-23
- Author: Giuseppe Trisciuoglio

## Context

The extension guards against destructive commands and protected paths, but there
is no way to declare a project inspection-only. Users wanted a per-project flag
that lets the agent read files and explore the codebase while preventing any
modification. The natural home for the flag is the existing per-project
configuration file, `.pi/prevent-destructive-commands.json`, and the `/git-guards`
command already established the pattern of a user-invoked toggle that writes that
file from the extension process.

Tools that can mutate state are `write`, `edit`, any patch-style variant such as
`apply_patch`, `bash`, and `powershell`. Read-only tools are `read`, `grep`,
`find`, `ls`, and similar non-mutating tools.

The open design question was whether read-only mode should keep allowing
"obviously read-only" shell commands such as `cat`, `ls`, or `grep` invoked
through `bash`. Classifying a shell command line as read-only is the same
unsolved problem the destructive-command checker already deals with: commands
can hide mutations behind wrappers, redirects, command substitution, heredocs,
and arbitrary binaries.

## Decision

Read-only mode blocks `bash` and `powershell` entirely, without attempting to
classify individual shell commands as safe. It also blocks `write`, `edit`, and
every tool whose name ends with `apply_patch`. Read-only tools keep working.

The mode is stored as a `readOnly` boolean in
`.pi/prevent-destructive-commands.json`. It defaults to `false` when the file is
missing or invalid, so the agent stays writable until the user explicitly turns
it on. The `/read-only on|off|status` slash command toggles the flag while
preserving unrelated JSON keys, mirroring `/git-guards`.

When read-only mode is active, the `tool_call` handler checks it first and
short-circuits the other write-related guards: a rejected write needs no further
analysis.

## Consequences

- Inspection-only projects are safe: no shell invocation can mutate the
  workspace while the mode is on.
- Users lose the convenience of running read-only shell commands through `bash`
  in read-only mode; they use `read`, `grep`, `find`, and `ls` instead.
- The mode is per project, so different projects can be in different modes at
  the same time.
- Read-only mode is independent of the destructive-command, git, migration, Nx,
  and comment guards; those behaviors are unchanged when the mode is off.
