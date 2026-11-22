# ADR 0009: Remote deletions are blocked by effect, not by syntax

- Status: accepted
- Date: 2026-11-22
- Author: Giuseppe Trisciuoglio
- Issue: [#43](https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/issues/43)

## Context

The guard blocked remote ref and resource deletion only in some syntaxes:
`git push --delete`, `gh api -X DELETE`, `gh api --method[=]DELETE`. Other
commands with the same effect were allowed:

1. `gh api` method flag spellings that the parser did not normalise (value
   attached to the short flag);
2. a method supplied through a variable or substitution;
3. generic HTTP clients sending `DELETE` to `api.github.com`, often with a
   token taken from `gh auth token`;
4. destructive GraphQL mutations sent with `gh api graphql`.

When a model is blocked in one syntax, it tries another one with the same effect.
The guard must therefore check the effect.

## Decision

Shared helpers live in `src/rules/remote-api.ts`.

- **`gh api` method.** `checkGh` reads the method in every spelling `gh`
  accepts: `-X V`, `-XV`, `-X=V`, short clusters such as `-iX V`,
  `--method V` and `--method=V`, in any case. The scan stops at the end of the
  simple command (`|`, `;`, `&&`, `||`, `&`, parentheses).
- **Unresolvable method.** A method value containing `$` or a backtick blocks,
  like an unresolvable path (ADR 0002). This can block a safe
  `-X "$METHOD"` call. That false positive is accepted.
- **GraphQL.** For `gh api graphql`, the `query` field is inspected inline
  (`-f`, `-F`, `--raw-field`, `--field`, including attached forms), from
  `-F query=@file`, and from `--input <file>`. A document containing
  `mutation` blocks when it names a field whose name starts with `delete`,
  `remove`, `archive` or `transfer` followed by an uppercase letter, or a field
  listed in `GH_GRAPHQL_DESTRUCTIVE_MUTATIONS` (`updateRefs`). A payload that
  cannot be inspected blocks: stdin (`@-`, `--input -`), a missing or unreadable
  file, a file over 1 MiB, or a query that is only a variable or contains a
  substitution.
- **Generic HTTP clients.** `src/rules/http-client.ts` checks `curl`, `wget`,
  HTTPie (`http`, `https`) and `xh`/`xhs` (`HTTP_CLIENT_COMMANDS`). A request
  targets GitHub when the command names `api.github.com`, `uploads.github.com`
  or `*.githubusercontent.com`, or when it injects a GitHub token
  (`gh auth token`, `$GH_TOKEN`, `$GITHUB_TOKEN`, ...) and no literal URL names
  another host. For such requests, `DELETE` or an unresolvable method blocks
  (curl `-X`/`--request` in every spelling, wget `--method`, HTTPie/xh method
  positional). Requests to a `/graphql` URL are inspected for destructive
  mutations in inline data and `@file` payloads. An unreadable payload file
  blocks.
- **Not blocked.** `GET` requests are allowed, also with an injected token.
  `POST`, `PATCH` and `PUT` are allowed, as `gh api --method POST` already was
  (`GH_DESTRUCTIVE_METHODS` = `DELETE`). Requests that send a token to a
  non-GitHub host are allowed. GitHub Enterprise hosts are not recognised until
  a host configuration option exists.
- **Tests.** `test/gh-guard-test.ts` has a table keyed by destructive effect
  (`delete a remote branch`, `delete a repository`, ...). Each effect lists every
  known equivalent spelling, so a new bypass is added as a new row.

## Consequences

- The four gap classes from issue #43 are blocked with a clear reason.
  Read-only `gh api` calls, GraphQL queries and HTTP `GET` requests remain
  allowed.
- The guard reads local GraphQL payload files (at most 1 MiB) to inspect them.
- The check is still static. A destructive request built in an interpreter
  (`python -c`, `node -e`) or sent through an unlisted client is not detected.
  Add such clients to `HTTP_CLIENT_COMMANDS` when needed.
- Blocking unresolvable methods and opaque GraphQL payloads can block safe
  commands. The agent must write the method or query literally.
- For HTTP clients, a GraphQL body that is only a shell variable is not
  blocked. The auth header usually contains a substitution, so a reliable
  "opaque payload" check is not possible there.
