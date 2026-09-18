---
name: baiducloud-auth
description: Use the official bce-cli IAM OAuth browser login for Baidu Intelligent Cloud authentication. Use when a user needs to sign in, configure an OAuth profile, log in from a headless environment, or troubleshoot OAuth login.
---

# BaiduCloud authentication

Use the official `bce` CLI for IAM OAuth. The core subcommands are:

```bash
# Sign in via the system browser (open the printed URL manually if needed).
bce auth login
bce auth login --region bj          # sign in and set the default region
bce auth login --no-browser         # SSH, container, or other headless env
bce auth login --callback-timeout 600  # browser callback timeout, seconds

bce auth status                     # show login and credential status
bce auth logout                     # clear the oauth login state
bce auth refresh                    # renew temporary credentials
```

For the exact flag set of any subcommand, consult `bce auth <subcommand>
--help` rather than assuming it here.

Credentials are written to the `oauth` profile. An existing AK/SK profile is
not modified. A successful login switches the current profile to the OAuth
profile; use `bce configure use <name>` to switch back. `--callback-timeout`
changes the browser callback timeout; the default is 300 seconds.

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
checks. See Troubleshooting below to resolve a missing CLI or a missing or
expired `oauth` profile.

## Troubleshooting authentication

Start by reading the current state with `node scripts/check_auth.mjs`, then act
on what it reports:

- `bce` not installed → install `bce-cli` first.
- `oauth` profile missing or not logged in → run `bce auth login`.
- credentials expired → run `bce auth login` again. The CLI renews temporary
  credentials automatically (`bce auth refresh`); if renewal does not produce
  valid credentials, sign in again.
- browser callback times out → raise `--callback-timeout`, or switch to
  `bce auth login --no-browser`.
- SSH, container, or other headless environment → use
  `bce auth login --no-browser` and open the printed URL on a machine with a
  browser.

## Authentication vs authorization

The steps above only fix *authentication* (who you are). They do not fix
*authorization* (what you may do). Permission-denied, IP-allowlist, or policy
errors (for example `AccessDenied`) are not solved by signing in again, so do
not loop on `bce auth login`. Preserve only the non-secret error message and
request ID and escalate to the cloud account administrator or support to adjust
the account's IAM policy or allowlist.
