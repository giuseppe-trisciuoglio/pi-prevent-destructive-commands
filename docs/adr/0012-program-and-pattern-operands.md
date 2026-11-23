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
  supplied it, and unless the mode takes no pattern (`rg --files`,
  `rg --type-list`, `ag -g PATTERN`: every positional is then a path); the
  values of `-e`/`--regexp` (also attached), `rg -r/--replace`, `awk -F`. Option values are tracked per tool (`-m N`, `-A N`, `--glob X`, ...)
  so the pattern position is found correctly (rg value options include
  `--color`, `--colors`, `--hyperlink-format`, ...). The tokenizer splits
  `--include='*.ts'` into `--include=` and `*.ts`, so a known value option
  ending in `=` consumes the next token as its value; that value stays checked
  (an empty `--regexp=` cannot be told apart). `-f`/`--file`, `--exclude-from`,
  `--ignore-file`, `--pre` values remain paths.
- **Inline programs:** the first positional of `awk`/`gawk`/`mawk`/`nawk`
  (unless `-f`/`-e`/`--source` supplied it), `awk -e/--source`, `node`/`bun`
  `-e/--eval/-p/--print` (also `-pe`/`-ep`), `python* -c`, `ruby -e`,
  `perl -e/-E` (including clusters such as `-ne`, `-lne`, `-lane`, `-wle`:
  perl `-l`/`-0` take only digits), and `deno eval [--ext ts|-c file ...] <code>`
  (deno options are matched against known boolean and value lists; value
  tokens, also split `--opt='v'`, stay checked; any unrecognised option
  disables the classification so the generic analysis applies). A program is not a
  path, but it can name files, so its **string literals** are extracted and
  checked: a literal containing whitespace and `/` is analyzed as a shell
  command line (it may be passed to `system()`, `os.system`, backticks), other
  path-like literals are checked as paths, URLs and literals made only of
  slashes (separators such as `split($0, a, "/")`, `FS="/"`) are skipped,
  unless they are the argument of a filesystem call (`unlink "/"`,
  `os.listdir('/')`, `rmSync('/')`, `FileUtils.rm_rf("/")`, ...).
  Perl `q()`/`qq{}`/`qw[]`/`qx<>` and ruby `%q()`/`%Q`/`%w`/`%()` quote-like
  bodies are extracted as literals too; an unterminated one triggers the
  fallback below. Regex literals,
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
- **Markup literals (issue #55):** the literal scanner already honours `\`
  escapes. A literal with whitespace and `/` is normally re-analyzed as a shell
  command line, which misreads markup (`<script src="a.js"></script>`, where
  `</script>` is a redirect from `/script`). Well-formed tags (a name followed
  by whitespace, `>` or `/>`; so `</etc/passwd>` is not a tag) are neutralised
  first: each is replaced by its attribute values with names and quotes
  removed. The normal analysis then runs unchanged on the result, so nothing
  outside tags is hidden and attribute paths stay checked. No shortcut skips
  the command analysis.

- **Amendment (issue #53).**
  - `node`/`bun` `--eval=`/`--print=` with the code in the next token (as the
    tokenizer splits a quoted value) is classified as a program, like the
    attached `--eval=CODE`.
  - The node option table now lists the common value-taking options
    (`--max-old-space-size`, `--stack-size`, `--loader`, `--env-file`,
    `--conditions`, ...), so `-e`/`-p` after them is still found. `-p`/`--print`
    does not consume an option-like next token, so `-p -e CODE` marks CODE.
  - `deno eval` treats `--check`, `--reload`/`-r`, `--inspect*`, `--watch` and
    other optional-value options as booleans (their values are attached with
    `=`), and knows more boolean options. Unknown options still fall back to
    the generic analysis.
  - A split `--opt=` followed by an option does not consume it. When the next
    token is a plain word it may be an empty value followed by the pattern
    (`rg --color= foo /etc`), so it is not consumed and no pattern is assumed:
    later operands are checked as paths. Only glob-like values (`*.ts`, lists)
    are consumed as the value. The ambiguity resolves towards checking, so a
    rare quoted plain-word value (`--exclude-dir='node_modules' '/api/' f`) can
    now block the pattern; no previously blocked case is allowed.

## Consequences

- Common inspection and conflict-resolution commands no longer push agents to
  workarounds.
- A program can still read or write outside the workdir through a path built at
  runtime (string concatenation, variables); this was already the case with the
  token-based analysis and is out of scope for a static guard.
- Covered by `test/workdir-guard-test.ts` (issue #46 block).
