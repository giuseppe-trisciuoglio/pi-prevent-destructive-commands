# ADR 0013: Comment guard — regex literals, desync fail-safe, project scope

- Status: accepted
- Date: 2026-11-22
- Author: Giuseppe Trisciuoglio
- Issue: [#49](https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/issues/49)

## Context

`extractComments()` tracks string state to ignore comment markers inside
strings, but did not know regex literals. A quote inside a regex such as
`/'/g` opened a phantom string, inverting the string/code state for the rest
of the file, so a later `/*` inside a real string (`'js/gimmicks/*.js'`) was
reported as a new comment. A plain JS helper script under `/tmp` was blocked.

## Decision

1. **Regex literals (C family).** At a `/` not followed by `/` or `*`, in an
   expression position — after one of `( , = : [ ! & | ? { ; + - * % > ~ ^`,
   at the start of the text, or after a keyword such as `return`, `typeof`,
   `case`, `yield`, `await` — the scanner reads a regex literal: it honours `\`
   escapes and `[...]` classes, ends at the unescaped `/` and skips the flags.
   If the line ends first, the `/` was a division. After an identifier, number,
   `)`, `]` or `}` a `/` is a division (`}` closes blocks and JSX attributes as
   often as expressions: `{a} / 2`, `<A b={1} />`). So is a `/` after a postfix
   `++`/`--` (`i++ / n`) or a TypeScript non-null `!` that follows an
   identifier, `)` or `]` (`total! / n`). A `/` followed by `>` never starts a
   regex: it closes a JSX self-closing tag. Enabled for every `"c"` file except
   `.scss` and `.less` (`url(/a.png)`).
   In `.rs` files a `'` followed by an identifier that is not closed by `'`
   right after it (`'static`, `'a`, `'outer:`) is a lifetime or label, not a
   char literal, and is treated as code.
2. **Fail-safe.** The scan is marked unreliable when it ends inside an
   unterminated string, or when a `'`/`"` string contains a raw newline in
   JavaScript/TypeScript (impossible there). An unreliable scan falls back to
   a line-based extraction that only reports comments whose marker opens a
   line (`// …`, `/* … */`, `# …`, `-- …`, `<!-- … -->` after indentation).
   The fallback is partial: comments scanned before the string that failed are
   kept, and only the lines after the one where it opened use the line-based
   extraction (a comment opening that line starts before the string, so it is
   already kept and never duplicated). A marker in the middle of a line after
   the desync never blocks: a false block costs more than a missed comment.
3. **Scope.** The guard applies only to files inside the project working
   directory (a path is outside only when its relative form is `..`, starts
   with `../`, or is absolute; a `..foo` directory is inside). Throwaway files elsewhere (for example under the system temp
   directory, which the workdir guard allows) are not project source.

## Consequences

- The reported patterns (shell-quoting helpers, escapers, path globs in
  strings) no longer block writes.
- A `/` after the `)` closing the condition of `if`/`while`/`for` starts a
  regex literal (issue #53): the matching `(` is found by a bounded backward
  paren count and the keyword before it is checked, so
  `if (x) /'/.test(s); const p = 'a/*b';` is no longer a false comment. Any
  other `)` (calls, grouping, `o.if(x)`) keeps meaning a division. Remaining
  limitation: parentheses inside strings in the condition can fool the paren
  count, and a regex after `)` of other statements (`do ... while`, `with`) is
  still read as a division; the line-based fallback then usually applies.
- A desync no longer discards the real comments found before it (for example
  `let x = 1; // real` before an unclosed quote is still blocked).
- Covered by `test/comment-guard-test.ts` (issue #49 block).
