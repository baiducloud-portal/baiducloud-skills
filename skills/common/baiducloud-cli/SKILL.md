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

## Authentication

This Skill uses the fixed `oauth` profile (IAM OAuth). Before running any
service operation, ensure both preconditions hold:

- `bce` is installed. If not, ask the user to install `bce-cli` first.
- The `oauth` OAuth profile exists. If not, ask the user to run
  `bce auth login`.

`baiducloud-auth` owns this readiness check (`node scripts/check_auth.mjs`
reports whether `bce` is installed, whether the `oauth` profile exists, and
whether its credentials expired). Route sign-in and credential-status
questions there.

Sign in with the official CLI IAM OAuth browser login:

```bash
# Open the system browser for IAM OAuth login.
bce auth login

# Login and set the default region.
bce auth login --region bj

# SSH, container, or other headless environment.
bce auth login --no-browser

# Inspect or clear OAuth login state.
bce auth status
bce auth logout
```

Credentials are written to the `oauth` profile. An existing AK/SK profile is
not overwritten. A successful login switches the current profile to the OAuth
profile. `--callback-timeout` controls how long the CLI waits for the browser
callback and defaults to 300 seconds.

OAuth credentials are managed by `bce-cli` and stored separately from
`oauth.json` under `~/.bce/oauth/`. Never read, copy, or print that file.
Before temporary credentials expire, the CLI renews them automatically. If
renewal fails, run `bce auth login` again. The OAuth access token is not a
BCE API credential.

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

Invoke operations with the fixed `oauth` profile and prefer structured output
for Agent processing:

```bash
bce bcc ListInstances --profile oauth --region bj --output json
```

Use `--query` to reduce output and use `--pager` only when operation help
confirms pagination support.

## Profile and region

Always target the fixed `oauth` profile. Pass the region explicitly when it
matters:

```bash
bce configure list
bce bcc ListInstances --profile oauth --region bj --output json
```

`--profile oauth` selects the OAuth profile for one command. If the `oauth`
profile is missing, run `bce auth login`. Do not infer an account, region, or
payment type from a resource name.

## Write-operation safety

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

- missing `bce` or unknown operation: inspect installation and `--help`;
- missing or expired credentials: run `bce auth status`; if the `oauth`
  profile is missing or expired, run `bce auth login`;
- invalid region or parameter: confirm operation help and service
  documentation;
- permission, IP allowlist, signature, or request ID errors: preserve only
  the non-secret error and request ID for cloud administrator/support
  troubleshooting;
- signature or clock errors: do not manually edit Authorization data; check
  the selected profile and system time.
