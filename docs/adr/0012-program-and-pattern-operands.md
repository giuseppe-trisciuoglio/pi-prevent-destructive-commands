# ADR 0012: Program and pattern operands are not paths

- Status: accepted
- Date: 2026-11-22
- Author: Giuseppe Trisciuoglio
- Issue: [#46](https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/issues/46)

## Context

The workdir boundary guard classified every operand that starts with `/` as an
absolute path. Read-only inspection commands were blocked because their
program or pattern begins with a regex delimiter:
`awk '/^<<<<<<</,/^>>>>>>>/' f`, `grep '/api/' f`, `rg '/api/' src`,
`sed -n '/start/,/end/p' f`, `node -e "x.replace(/a/,'b')"`,
`python3 -c "re.sub(r'/x/', '', s)"`. ADR 0005 / #33 fixed only simple
`sed '/re/p'` scripts.

## Decision

`src/rules/program-operands.ts` classifies operands by position for each tool.
Input files and path-valued options stay unclassified and are still checked.

- **Patterns (never checked):** the first positional operand of
  `grep`/`egrep`/`fgrep`/`rg`/`ag` unless `-e`/`--regexp` or `-f`/`--file`
  supplied it; the values of `-e`/`--regexp` (also attached), `rg -r/--replace`,
  `awk -F`. Option values are tracked per tool (`-m N`, `-A N`, `--glob X`, ...)
  so the pattern position is found correctly. `-f`/`--file`, `--exclude-from`,
  `--ignore-file`, `--pre` values remain paths.
- **Inline programs:** the first positional of `awk`/`gawk`/`mawk`/`nawk`
  (unless `-f`/`-e`/`--source` supplied it), `awk -e/--source`, `node`/`bun`
  `-e/--eval/-p/--print`, `python* -c`, `ruby -e`, `perl -e/-E` (including
  clusters such as `-ne`, `-lne`), and `deno eval <code>`. A program is not a
  path, but it can name files, so its **string literals** are extracted and
  checked: a literal containing whitespace and `/` is analyzed as a shell
  command line (it may be passed to `system()`, `os.system`, backticks), other
  path-like literals are checked as paths, URLs are skipped. Regex literals,
  division and code outside strings are ignored. The first string argument of
  `re.sub/match/search/compile/...`, `RegExp(...)` and `Regexp.new(...)` is a
  regex and is skipped. When the literal scan ends inside an unterminated
  string (e.g. a quote inside a regex literal such as `/'/g`), the program
  falls back to the previous generic token analysis — never less safe than
  before.
- **sed:** `isNonFileSedScript` is now a small parser for sequences of
  `[addr[,addr2]][!]cmd`, with addresses `N`, `$`, `first~step`, `/re/`,
  `\cREc`, `I`/`M` flags, and `+N`/`~N` as the second address; commands must be
  read-only (`p P d D n N h H g G x l z =`, `q`/`Q` with exit code, bare
  `b`/`t`/`T`, `{ }`). Scripts with `w`, `r`, `e`, `s`, `y` keep the previous
  handling. Each `-e` script is classified separately.
- Interpreter script files (`node /x.js`, `python3 /x.py`) and their input
  files remain checked.

## Consequences

- Common inspection and conflict-resolution commands no longer push agents to
  workarounds.
- A program can still read or write outside the workdir through a path built at
  runtime (string concatenation, variables); this was already the case with the
  token-based analysis and is out of scope for a static guard.
- Covered by `test/workdir-guard-test.ts` (issue #46 block).
