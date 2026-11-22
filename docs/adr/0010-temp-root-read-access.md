# ADR 0010: Allow `cd` and read-only access to the system temp root

- Status: accepted
- Date: 2026-11-22
- Author: Giuseppe Trisciuoglio
- Issue: [#47](https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/issues/47)
- Amends: [ADR 0002](0002-workdir-guard.md)

## Context

The workdir boundary guard allows paths under the system temp directories
(`/tmp`, `/private/tmp`, `os.tmpdir()`) but blocked the temp root itself for
every kind of access. The rule was meant to stop `rm -rf /tmp`, yet it also
blocked `cd /tmp`, `pushd /tmp` and `ls /tmp`, so the agent could not use the
temp directory as a scratch working area. `ls /tmp/` and `cd /tmp/x` were
already allowed, which made the behavior inconsistent.

## Decision

In `checkPathInsideWorkdir` (`src/rules/workdir-guard.ts`) the temp-root block
applies only to non-read access (write, redirect). Reads and `cd` into the
temp root are allowed. After `cd /tmp`, relative paths resolve inside the temp
directory and follow the normal rules: temp files are allowed, leaving the
temp directory (`cd ..`, `../etc/passwd`) is blocked.

To keep the temp root protected from being moved away, `mv` operands are all
write targets (moved from "last argument" to "all arguments"): `mv` removes its
sources, so a source is not a read. The destructive guard
(`src/rules/path-sensitive.ts`) still independently blocks `rm`/`rmdir` on the
temp root.

## Consequences

- `cd /tmp`, `pushd /tmp`, `ls /tmp` and `cd /tmp && <cmd on temp files>` work.
- `rm -rf /tmp`, `chmod 777 /tmp`, `echo x > /tmp`, `mv /tmp ./x` and the
  write tool on `/tmp` stay blocked.
- `mv` out of an installed skills directory is now blocked, since it deletes
  the skill file.
- Covered by regression tests in `test/workdir-guard-test.ts`.
