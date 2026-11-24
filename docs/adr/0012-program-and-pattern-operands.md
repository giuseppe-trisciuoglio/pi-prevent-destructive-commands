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
    attached `--eval=CODE`. A path-like next token (`--eval= /etc/passwd`) may
    be a script file after an empty value, so it stays unclassified and checked.
  - The node option table lists the common value-taking options
    (`--max-old-space-size`, `--stack-size`, `--loader`, `--env-file`,
    `--conditions`, ...), so `-e`/`-p` after them is still found. An
    option-like next token is not taken as the value of a node option, so
    `-p -e CODE` and `--loader -e CODE` mark CODE.
  - `deno eval`: `--check`, `--reload`/`-r`, `--inspect*`, `--watch` and other
    optional-value options take no separate value token, and more boolean
    options are known. When the token after an optional-value option is path-like
    (`/`, `~`, `..`, `/../`), it is consumed as its value and so checked as a
    path (`deno eval --check /etc/passwd` stays blocked). `--` ends the options
    and the next token is the program, so it is scanned. Unknown options still
    fall back to the generic analysis (the program is then not scanned; this
    limitation predates #53).
  - A separated `--opt= v` is ambiguous (an empty value followed by an operand
    cannot be told apart from a value after tokenizing). The operands are
    classified under both readings (the next token consumed as the value, or
    left as an operand) and an operand is exempt only when both agree. So
    `rg --color= foo /etc`, `rg --color= '' /etc` and `rg --color= '*' /etc/x`
    are blocked. A quoted value written attached (`--include='*.ts'`,
    `--color=""`) is unambiguous: the tokenizer records, per token array, which
    quoted tokens followed an attached `--opt=` (`isAttachedValue`, kept by
    `sliceTokens`), and such a token is always the value, so
    `grep -r --include='*.ts' '/x/' .` stays allowed.
  - Shell expansion: an unquoted or double-quoted operand holding `$(`, a
    backtick or `${` is expanded by the shell before the program runs, so it is
    not opaque program or pattern text and gets the generic analysis, for every
    inline-program form. The tokenizer records such token texts
    (`isExpandableToken`, reset per top-level command; a text seen expandable
    anywhere in the command wins). Single-quoted JS template literals
    (`node -e 'console.log(\`${x}\`)'`) stay allowed. This also closes
    `node -e "$(cat /etc/passwd)"`.
  - By-design blocked-to-allowed changes (the operand is now code, as with
    `node -e '…'` before): programs without a path-like string literal passed
    through a recognised form (`--eval`/`--print` spellings, `-p -e CODE`, `deno eval` booleans and `--`), such as `node --stack-size 1 -e 'x; cat /etc/passwd'`,
    `node --eval='$(cat /etc/passwd)'` (single-quoted, so JS code),
    `node -p ../x`-style programs after a value option, `deno eval --vendor '/etc/passwd'`
    and `deno eval -- '/etc/passwd'`. Unknown-option garbage such as
    `deno eval --reload -g --max-old-space-size '…'` no longer has its code consumed as an option value.
- **Amendment (issue #61).** A string literal that directly follows a
  concatenation operator (`+` or `+=`, plus `.` and `.=` in perl; whitespace is
  ignored) is the tail of a path built at runtime, such as
  `open(d+'/verification.json')`. Its leading `/` characters are stripped and
  the rest is checked as a relative path. So `verification.json` is not a path
  candidate, while `d+'/../../../../etc/passwd'` is still blocked when it
  escapes the cwd. A fragment holding whitespace and `/` is still analysed as a
  command line. Three cases are not fragments and are checked unchanged:
  - a literal *before* `+` (`'/etc/'+n`), which is a real absolute prefix;
  - a `.join` argument, because `os.path.join(d, '/x')` restarts at `/x`;
  - a literal whose left operand is itself a literal (`''+'/etc/passwd'`),
    because that concatenation is static.

  Quote-like perl/ruby literals (`q(…)`, `%q(…)`) are not treated as
  fragments. As noted under Consequences, a left operand that is empty at
  runtime is out of scope for a static guard.

## Consequences

- Common inspection and conflict-resolution commands no longer push agents to
  workarounds.
- A program can still read or write outside the workdir through a path built at
  runtime (string concatenation, variables); this was already the case with the
  token-based analysis and is out of scope for a static guard.
- Covered by `test/workdir-guard-test.ts` (issue #46 block).
