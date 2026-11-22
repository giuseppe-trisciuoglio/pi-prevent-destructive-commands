# ADR 0008: API endpoint arguments are not filesystem paths

- Status: accepted
- Date: 2026-11-22
- Author: Giuseppe Trisciuoglio
- Issue: [#41](https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/issues/41)
- Amends: [ADR 0002](0002-workdir-guard.md), [ADR 0005](0005-command-operand-classification.md)

## Context

The workdir guard treats any token containing `/` as a path. API clients take
an endpoint such as `/repos/o/r/pulls` or `/api/ce/activity?project=x`, which
was then checked as a filesystem path and blocked: `gh api /repos/o/r/pulls`,
`sonar api get "/api/ce/activity?project=x"`, and the same endpoint passed
through a variable (`EP="/api/..."; sonar api get "$EP"`). These are read-only
diagnostics. When they were blocked, the model tried to work around the guard.

## Decision

`collectApiEndpointIndices` in `src/rules/workdir-guard.ts` finds the endpoint
token of known API clients. The guard skips that token, like it skips git
message text (ADR 0006):

- `gh api <endpoint>`: the first positional after `api`. Known value flags
  (`-X`, `-H`, `-f`, `-F`, `--input`, `-q`, `-t`, `--cache`, `-p`,
  `--hostname`, ...) consume their value.
- `sonar api <METHOD> <endpoint>`: only in this strict form, with the method
  right after `api` and the endpoint right after the method. The flags of this
  CLI are not modelled, so a flag value is never taken for the endpoint.
- HTTPie (`http`, `https`) and `xh`/`xhs`: `[METHOD] <url>`, after skipping
  known value flags (`--auth`, `--session`, `--cert`, `--output`, ...).

A variable assignment (`NAME="value"`) in the same command is skipped when
`$NAME`/`${NAME}` is referenced from an endpoint token. The variable is then
used only where it is not a filesystem path.

Real file arguments of these clients are still checked:

- `gh api --input <file>` and `--input=<file>`;
- `gh api -F key=@file` / `--field key=@file`: the path after `@` is checked
  with read access;
- HTTPie request items `field=@file`, `field:=@file` and `field@file`: the
  path is checked with read access;
- value flags such as `--cert`, `--session` and `--output` keep the normal
  path rules.

An endpoint token containing a command substitution (`$(...)` or backticks) is
not skipped.

## Consequences

- Read-only API diagnostics with `gh api`, `sonar api`, HTTPie and xh are no
  longer blocked.
- Reading files outside the working directory through these clients stays
  blocked, and is now also checked for `-F key=@file` and HTTPie `@file` items,
  which were not checked before.
- `sonar api` with flags between `api`, the method and the endpoint is not
  exempted and keeps the previous behavior.
- Other API clients are not covered. Add them to `API_CLIENTS` when needed.
- Covered by regression tests in `test/workdir-guard-test.ts`.
