---
name: baiducloud-cli
description: Use the official Baidu Intelligent Cloud bce-cli as the default entry point for any Baidu Cloud service or operation supported by the installed CLI. Use whenever a user asks how to install, authenticate, discover, debug, or invoke bce-cli commands, including IAM OAuth login, profiles, regions, JSON output, pagination, dry-run, debug, or CLI errors. Do not reimplement BCE signing or cloud APIs.
---

# BaiduCloud CLI

Treat the official `bce` executable as the source of truth for command names,
parameters, authentication, signing, and API behavior. This is the default
Skill for basic operations across all products supported by `bce-cli`.

Use the official CLI directly. Do not install an untrusted binary, implement a
second SDK, or create a product Skill that only mirrors basic CLI CRUD
commands. Add a workflow Skill only for meaningful orchestration, polling,
rollback, cleanup, or cross-product verification.

## Check the CLI

```bash
command -v bce
bce version
bce --help
```

If `bce` is missing, direct the user to the official
[bce-cli repository](https://github.com/baidubce/bce-cli) and ask them to
install `bce-cli` first. Never ask for credentials in chat.

Commands default to the `bce` executable on `PATH`. When `BCE_CLI_BIN` is set
(tests or a custom CLI location), replace `bce` in every command below with
that executable, matching the `baiducloud-auth` and `baiducloud-openapi`
runtimes.

## Keep the CLI up to date

Check whether a newer `bce-cli` is available once at the start of a session
(and again whenever a command fails because the CLI is outdated). The
`baiducloud-gateway` preflight does this too and reports it as `cli_update`:

```bash
# Check the latest version online without changing anything.
# It still shows an "upgrade? [y/N]" prompt; answer n (or close stdin).
bce upgrade --dry-run

# Upgrade to the latest version, skipping the interactive prompt.
bce upgrade --yes
```

`bce upgrade --dry-run` only queries the latest version and makes no changes.
Compare the current version (`bce version`) against the latest version it
reports; the reported version numbers are authoritative. The
"already the latest version" phrase (for example `已是最新版本`) is localized and
may change, so treat it only as a hint, not as the sole signal. When the CLI is
already current, continue. When a newer version is available, tell the user that
new features may be unavailable on the old version and that you are upgrading,
then run `bce upgrade --yes` first without asking again, and continue with the
requested operation once it succeeds. If the upgrade fails, report it and
continue on the current version.

This is the official `bce` self-update, not an untrusted binary install.
Running it without an extra per-call confirmation is the configured behavior
for this Skill and is the documented exception to the confirmation rule in
"Write-operation safety" below. If the upgrade fails, report the failure to the
user honestly and point them to the
[bce-cli repository](https://github.com/baidubce/bce-cli); do not pretend it
succeeded or proceed as if the CLI were current. A common cause is insufficient
permission to replace the binary (macOS/Linux may need `sudo bce upgrade`,
Windows an elevated shell); do not self-escalate privileges — surface this to
the user and let them rerun with the required permission.

## Authentication

This Skill uses the OAuth profile (IAM OAuth) that `bce` has selected: the
current profile, or the one named with `--profile`. Profile names are not fixed;
`bce auth login --profile <name>` creates or updates a named profile. Before
running any service operation, ensure both preconditions hold:

- `bce` is installed. If not, ask the user to install `bce-cli` first.
- The selected profile is an OAuth profile and is logged in. If not, ask the
  user to run `bce auth login` (add `--profile <name>` for a named profile).

`baiducloud-auth` owns this readiness check (`node scripts/check_auth.mjs`
reports whether `bce` is installed, which profile is selected, whether that
profile exists, and whether its credentials expired). Route sign-in and
credential-status questions there.

Sign in with the official CLI IAM OAuth browser login:

```bash
# Open the system browser for IAM OAuth login.
bce auth login

# Login to a named profile.
bce auth login --profile dev

# Login and set the default region.
bce auth login --region bj

# SSH, container, or other headless environment.
bce auth login --no-browser

# Inspect or clear OAuth login state.
bce auth status
bce auth logout
```

Credentials are written to the selected profile. An existing AK/SK profile is
not overwritten. A successful login switches the current profile to the OAuth
profile. `--callback-timeout` controls how long the CLI waits for the browser
callback and defaults to 300 seconds.

OAuth credentials are managed by `bce-cli` and stored separately, one
`<profile>.json` per profile under `~/.bce/oauth/`. Never read, copy, or print
those files. Before temporary credentials expire, the CLI renews them
automatically. If renewal fails, run `bce auth login` again. The OAuth access
token is not a BCE API credential.

## Discover services and operations

Inspect the installed CLI before invoking unfamiliar commands. Do not assume
that a product is supported just because it exists in the wider product
catalog:

```bash
bce --help
bce bcc --help
bce bls --help
bce <service> <operation> --help
```

Invoke operations with the selected OAuth profile (omit `--profile` to use the
current one) and prefer structured output for Agent processing:

```bash
bce bcc ListInstances --region bj --output json
```

Use `--query` to reduce output and use `--pager` only when operation help
confirms pagination support.

## Profile and region

Target the current profile, or the profile the user names with `--profile`. Pass
the region explicitly when it matters:

```bash
bce configure list
bce bcc ListInstances --profile dev --region bj --output json
```

`--profile <name>` selects a profile for one command. Never switch the current
profile or guess a profile name for the user; if the intended profile is
missing, run `bce auth login --profile <name>`. Do not infer an account, region,
or payment type from a resource name.

## Write-operation safety

The official `bce upgrade` self-update in "Keep the CLI up to date" is the one
documented exception to the confirmation requirement below: it updates only the
`bce` binary itself and runs without a per-call confirmation by design.

For every state-changing operation:

- require explicit confirmation before execution;
- run `--dry-run` first when supported and show profile, region, resource ID,
  operation, and exact command;
- do not infer destructive flags, payment type, region, or account;
- do not release related resources unless the user explicitly requests it;
- never print secret keys, STS tokens, OAuth tokens, Authorization headers, or
  signatures.

For BCC `StopInstance`, `RebootInstance`, and delete operations:

- choose `DeletePrepayInstance` for `Prepaid` and `ReleaseInstanceByPost` for
  `Postpaid`;
- retain related disks, EIPs, snapshots, and ENIs by default;
- never infer a payment type or release-related flag.

## Output and debugging

Use `--output json` for machine-readable responses. Use `--debug` only when
request diagnostics are needed, and inspect the output for secrets before
sharing it. Never paste raw debug output into chat, Issues, or logs.

## Error handling

Separate local errors from service errors:

- missing `bce` or unknown operation: inspect installation and `--help`; if a
  command fails because the CLI is outdated, run `bce upgrade --dry-run` to
  check and upgrade per "Keep the CLI up to date";
- missing or expired credentials: `baiducloud-auth` owns this; run
  `bce auth status` and, if the selected profile is missing or expired, follow
  its troubleshooting (`bce auth login`);
- invalid region or parameter: confirm operation help and service
  documentation, retrieved through `baiducloud-docs` rather than from memory;
- permission, IP allowlist, signature, or request ID errors: preserve only
  the non-secret error and request ID for cloud administrator/support
  troubleshooting;
- signature or clock errors: do not manually edit Authorization data; check
  the selected profile and system time.
