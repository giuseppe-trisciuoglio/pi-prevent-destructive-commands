# ADR 0015: Network guard blocks curl/wget requests to non-loopback hosts

- Status: accepted
- Date: 2026-11-25
- Author: Giuseppe Trisciuoglio
- Issue: [#65](https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/issues/65)

## Context

The extension confined file access to the workdir ([ADR 0002](0002-workdir-guard.md))
but let the agent run `curl`/`wget` against any host. That is a channel to
exfiltrate project data or to download and execute untrusted content
(`wget -qO- … | sh`) without the user's consent. The only HTTP client rule
([ADR 0009](0009-effect-based-remote-deletion.md)) covered destructive GitHub
API requests.

Authorization had to follow the existing per-project model (`/git-guards`,
`/workdir-guard`): a flag in the user-managed
`.pi/prevent-destructive-commands.json` that the agent cannot write.

## Decision

`src/rules/network-guard.ts` inspects every `curl` and `wget` invocation in
command position (at the start of a command or after wrappers such as `sudo`,
`env`, `timeout`, `command`, `exec`) and is invoked from `checkTokens`, so it
also covers `bash -c`, `xargs`, `find -exec` and heredoc-executed scripts.

- **Only loopback is trusted**: `localhost`, `*.localhost`, `127.0.0.0/8`,
  `::1`, IPv4-mapped `::ffff:127.x.x.x` and `0.0.0.0`. Private networks,
  link-local (including `169.254.169.254` cloud metadata), unique-local IPv6,
  mDNS `*.local` and single-label names are external: a LAN is not a trust
  boundary the agent should cross without consent.
- **Targets** are positional URLs (with or without scheme), `--url`, proxy
  options (`-x`/`--proxy`, `--preproxy`, `--proxy1.0`, `--socks*`), the
  destination of `--connect-to`, the addresses of `--resolve`, `--doh-url`
  and wget `-B`/`--base`. Option values are skipped using per-client tables of
  value-taking options, so `-H "Host: example.com"` is not a target.
- **Hosts are normalized** through the WHATWG URL parser (`http://<host>`), so
  decimal/hex IPv4 forms (`2130706433`, `0x7f.1`), case and trailing dots do
  not bypass the loopback check. `userinfo@` is stripped
  (`http://localhost@example.com` targets `example.com`).
- **Unknowable targets are blocked**: values with `$`, backticks, `{{…}}`
  (curl variables), globbing characters in the host, and target lists read
  from files (`wget -i`, `curl -K`/`--config`, `curl --url @file`).
- `file://` URLs are ignored (the workdir guard owns file access).
- **Authorization**: `disableNetworkGuard` in the project config (default
  `false`), toggled with `/network-guard [on|off|status]`
  (`src/network-guard-command.ts`). `CheckerOptions.networkGuardEnabled`
  carries the flag; omitted means enabled.
- The GitHub API destructive-request check runs independently and stays
  active when the network guard is disabled.

## Consequences

- With the default config, `curl`/`wget` work only against local services;
  any other request asks the user to run `/network-guard off`.
- Classification is static: no DNS lookup, so a public name that resolves to
  `127.0.0.1` is still blocked, and a hostile name cannot be laundered through
  a local resolver.
- Unknown long options that take a value may make the guard read their value
  as a URL and block conservatively.
- Other network clients (HTTPie/xh, `nc`, `ssh`, `git`, package managers,
  inline interpreters) and proxies configured through environment variables or
  `.curlrc`/`.wgetrc` are out of scope.
- Existing GitHub API tests run with the network guard disabled to keep
  asserting the independent check.
