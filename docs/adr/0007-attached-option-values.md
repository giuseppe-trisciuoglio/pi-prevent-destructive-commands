# ADR 0007: Check path values attached to long options

- Status: accepted
- Date: 2026-11-22
- Author: Giuseppe Trisciuoglio
- Issue: [#39](https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/issues/39)
- Amends: [ADR 0002](0002-workdir-guard.md), [ADR 0004](0004-null-device-redirection.md)

## Context

The workdir guard ignores any token starting with `-`, so a path written as
the value of a long option was never checked. This allowed `curl
--output=/etc/passwd URL`, `wget --output-document=~/.bashrc URL`, and
`tar --file=/etc/shadow -t`. The same paths written as a separate argument
(`curl -o /etc/passwd URL`) were already blocked.

## Decision

For tokens of the form `--name=value` the guard checks `value` with the same
path rules it uses for a separate argument:

- options that take free text (`--title`, `--body`, `--message`, `--subject`,
  `--description`, `--notes`, `--grep`, `--format`, `--pretty`, `--author`,
  `--committer`, `--label`) are skipped;
- values containing `://` are URLs and are skipped;
- a value is checked only when it looks like a path (contains `/` or starts
  with `~`);
- `--output=` and `--output-document=` use the redirect access, so
  `--output=/dev/null` is allowed (as `-o /dev/null` is, see ADR 0004) and
  writes into installed skills directories stay blocked. Other options use the
  read access.

The existing `--template=` and git message handling run first and are unchanged.

## Consequences

- Path values attached to long options can no longer escape the working directory.
- `--output=/dev/null`, temp paths and paths inside the working directory keep working.
- An unlisted option whose value is free text containing an absolute path
  (for example `--exclude=/etc/x`) is now blocked. This is the same
  conservative decision the guard applies to a separate argument.
- Short options with an attached value (`-o/etc/passwd`, `-Dkey=/x`) are not
  covered by this decision.
- Covered by regression tests in `test/workdir-guard-test.ts`.
