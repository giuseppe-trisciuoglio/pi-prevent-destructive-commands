# ADR 0005: Classify command operands before applying path rules

- Status: accepted
- Date: 2026-10-27
- Author: Giuseppe Trisciuoglio
- Issue: [#33](https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/issues/33)
- Related: [#34](https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/issues/34)
- Amends: [ADR 0002](0002-workdir-guard.md)

## Context

The workdir boundary guard historically treated any token containing a slash as
a possible filesystem path. This is useful for ordinary commands, but it does
not distinguish the role of a command operand. A slash-delimited `sed` address
is an expression interpreted by `sed`, not a path that the command reads.

The same distinction matters for security. A `sed` input file and a script
file supplied with `-f` or `--file` are real filesystem reads, while a `sed`
script can also write files or execute commands. Those operations must not be
hidden by classifying the whole script as harmless text.

The destructive-command checker and the workdir guard also contained three
larger blocks of duplicated token-analysis logic. Keeping separate copies made
future operand-classification changes harder to apply consistently.

## Decision

The shared command-analysis module owns the token cursor, scoped working
directory state, heredoc orchestration, nested-command helpers, and command
operand classification. Both analyzers import these primitives while keeping
their command-specific decisions in their own modules.

For `sed`, operands are classified before the generic path check:

- an inline, read-only slash-delimited address is a script and is not treated
  as a filesystem path;
- an inline expression supplied with `-e` or `--expression` is handled the
  same way when it has the supported read-only form;
- an input file remains a path and is checked against the workdir boundary;
- a script file supplied with `-f` or `--file` remains a path and is checked
  against the workdir boundary;
- an inline script that writes files or executes commands remains blocked
  because its effects cannot be verified against the workdir boundary.

The recognition is deliberately conservative. It covers slash-delimited
address scripts whose commands only print, select, or otherwise operate on the
current pattern space. A more complex or unfamiliar script remains subject to
the existing conservative path decision.

## Consequences

- Common commands that search an HTML or source file with a slash-delimited
  `sed` address work without disabling the workdir guard.
- `sed` input files and script files cannot escape the workdir boundary.
- Scripts with file-writing or command-execution effects remain blocked.
- The destructive-command checker and the workdir guard share one token-walking
  implementation, removing the duplicate blocks reported by jscpd.
- The shared cursor exposes whether the current token starts a command, which
  prevents operand classification from being applied to an unrelated token
  that merely contains the name `sed`.
