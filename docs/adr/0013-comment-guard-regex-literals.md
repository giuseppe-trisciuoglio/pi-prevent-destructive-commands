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
   expression position — after one of `( , = : [ ! & | ? { } ; + - * % > ~ ^`,
   at the start of the text, or after a keyword such as `return`, `typeof`,
   `case`, `yield`, `await` — the scanner reads a regex literal: it honours `\`
   escapes and `[...]` classes, ends at the unescaped `/` and skips the flags.
   If the line ends first, the `/` was a division. After an identifier, number,
   `)` or `]` a `/` is a division. Enabled for every `"c"` file except `.scss`
   and `.less` (`url(/a.png)`).
2. **Fail-safe.** The scan is marked unreliable when it ends inside an
   unterminated string, or when a `'`/`"` string contains a raw newline in
   JavaScript/TypeScript (impossible there). An unreliable scan falls back to
   a line-based extraction that only reports comments whose marker opens a
   line (`// …`, `/* … */`, `# …`, `-- …`, `<!-- … -->` after indentation). A
   marker in the middle of a line never blocks after a desync: a false block
   costs more than a missed comment.
3. **Scope.** The guard applies only to files inside the project working
   directory. Throwaway files elsewhere (for example under the system temp
   directory, which the workdir guard allows) are not project source.

## Consequences

- The reported patterns (shell-quoting helpers, escapers, path globs in
  strings) no longer block writes.
- Rare constructs such as `if (x) /re/.test(s)` (regex right after `)`) are
  read as a division; at worst the line-based fallback applies.
- Covered by `test/comment-guard-test.ts` (issue #49 block).
