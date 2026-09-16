---
name: baiducloud-auth
description: Use the official bce-cli IAM OAuth browser login for Baidu Intelligent Cloud authentication. Use when a user needs to sign in, configure an OAuth profile, log in from a headless environment, or troubleshoot OAuth login.
---

# BaiduCloud authentication

Use the official `bce` CLI for IAM OAuth browser login:

```bash
bce auth login
bce auth login --region bj
bce auth login --no-browser
```

Credentials are written to the `oauth` profile. An existing AK/SK profile is
not modified. A successful login switches the current profile to the OAuth
profile; use `bce configure use <name>` to switch back. Use
`--callback-timeout` to change the browser callback timeout; the default is
300 seconds.

The CLI owns OAuth token storage, temporary credential exchange, and renewal.
Never implement a second OAuth flow, collect passwords or MFA data, or request
OAuth tokens in chat. Never print, copy, or echo the contents of the local
OAuth state file or the tokens inside it; the read-only checker below may read
it only to derive login status.
For OAuth status or logout, continue using the corresponding official
`bce auth` subcommands.

This Skill is the single place to verify authentication readiness. The
read-only checker reports whether `bce` is installed, whether the fixed `oauth`
OAuth profile exists, and whether its temporary credentials have expired:

```bash
node scripts/check_auth.mjs
```

Other Skills (for example `baiducloud-cli` and `baiducloud-openapi`) route
authentication and login troubleshooting here instead of implementing their own
checks. If `bce` is missing, install `bce-cli` first; if the `oauth` profile is
missing or expired, run `bce auth login`.
