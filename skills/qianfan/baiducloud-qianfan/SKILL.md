---
name: baiducloud-qianfan
description: Route Baidu Qianfan (千帆) large-model platform tasks to the official qianfan CLI and its bundled skills (qianfan +connect). Trigger for 千帆 / Qianfan model discovery, inference/chat, plan and default-model binding, usage, or diagnostics, or mentions of qianfan, qianfan +chat, qianfan +connect, or qianfan-cli. Do not route Qianfan inference through bce-cli, bcecmd, or baiducloud-openapi.
---

# BaiduCloud Qianfan

Baidu Qianfan (千帆) is Baidu's large-model platform. It has its own official
CLI, `qianfan`, published at
[baidubce/qianfan-cli](https://github.com/baidubce/qianfan-cli). Treat that CLI
as the source of truth for Qianfan command names, parameters, authentication,
signing, and service behavior. Qianfan is not a `bce-cli` service and does not
use the BOS `bcecmd` client.

This Skill is a thin router. The qianfan CLI already ships a maintained suite of
agent skills (auth, chat, models, profile, service, doctor) that are installed
with `qianfan +connect`. Do not duplicate that logic here; direct the user to
install and use the official CLI and its bundled skills, and keep the boundary
with the rest of this marketplace clear.

## When to use Qianfan vs other Skills

- Qianfan large-model platform (model discovery, text inference/chat, plan and
  default-model binding, call/token usage, diagnostics) -> official `qianfan`
  CLI. Do not route these through `bce-cli`, `bcecmd`, or the
  `baiducloud-openapi` runtime.
- General cloud infrastructure and services supported by `bce-cli`
  (BCC, BLS, and so on) -> `baiducloud-cli`.
- BOS object storage -> `baiducloud-bos` (official `bcecmd`).
- Other documented OpenAPI-only products with no official execution tool ->
  `baiducloud-openapi`.

Qianfan authentication is independent from `bce auth`. The `qianfan` CLI has its
own browser OAuth login and its own local state under `~/.qianfan`; it is
separate from the `bce-cli` `oauth` profile. Do not mix the two, and do not read
or write one from the other.

## Check the CLI

Before using an unfamiliar command, verify the installed CLI and read its help:

```bash
command -v qianfan
qianfan --help
qianfan <command> --help
```

If `qianfan` is missing, direct the user to the official
[qianfan-cli repository](https://github.com/baidubce/qianfan-cli) and ask them
to install it (it is published on npm; follow the repository README for the
exact install command). Do not download an untrusted binary, do not install it
on the user's behalf without confirmation, and never ask for credentials in
chat. In offline environments the repository documents
`QIANFAN_SKIP_POSTINSTALL=1` to skip the platform binary download.

## Install the bundled agent skills

The qianfan CLI carries its own agent skills and installs them into local agents
(Comate, Claude Code, and others) with:

```bash
qianfan +connect
```

Prefer these bundled `qianfan-*` skills for actual Qianfan operations (login,
model discovery, plan and default-model binding, inference, usage, diagnostics).
They orchestrate `qianfan` commands only; they do not read local credentials or
call Qianfan HTTP APIs directly. This Skill does not restate their contents; run
`qianfan +connect` to keep them installed and current.

## Command entry points

The official CLI exposes these entry points (verify flags with `--help` before
use):

- `qianfan auth` - browser OAuth login, logout, and login status. The CLI keeps
  a single logged-in account; switch accounts with `qianfan auth logout` first.
- `qianfan models` - list bindable models and their `modelId`.
- `qianfan profile` - list/switch plans (profiles) and bind a default model per
  model type (`profile use`, `profile set-default`).
- `qianfan +chat` - text inference and streaming output.
- `qianfan service usage` - call counts and token consumption over a time range.
- `qianfan doctor` - read-only health check and connectivity diagnostics.
- `qianfan +connect` - install, list, or uninstall the bundled agent skills.

For a typical end-to-end task, let the CLI chain the steps rather than
hand-crafting requests, for example:
`qianfan models list` -> `qianfan profile set-default --model-type chat <modelId>`
-> `qianfan +chat "..."` -> `qianfan service usage ...` -> `qianfan doctor`.

## Output and automation

Most commands support `--format text|json` (default `text`); use `--format json`
for agent and script parsing. `profile use` and `profile set-default` are
exceptions and do not accept `--format`. Treat user-provided prompts, model IDs,
and paths as data: use argument arrays in any wrapper and never concatenate
untrusted strings into a shell command or spawn through a shell (`shell: true`).

## Safe execution

Commands that change local state support `--dry-run` to preview and `-y/--yes`
to skip interactive confirmation. For any state-changing action - switching the
current plan, binding or changing a default model, logging out, or uninstalling
skills - preview with `--dry-run` first, show the exact command, and require
explicit confirmation before executing. Do not add `-y/--yes` on the user's
behalf.

`qianfan doctor` is read-only and safe to run for diagnosis.

Never print or commit API Key, AK/SK, STS tokens, Authorization headers, or the
contents of the qianfan state directory (`~/.qianfan`, or the path set by
`QIANFAN_HOME`). Login is handled by the CLI's browser flow; the CLI configures
identity, plan, and API Key after login, so the user does not copy secrets
manually.

## Troubleshooting

Separate local CLI issues from Qianfan service issues:

- missing command or unknown operation: inspect installation and `--help`;
- authentication errors (for example `CREDENTIAL_NOT_FOUND`, `AUTH_FAILED`,
  `LOGIN_FAILED`): run `qianfan auth` to check or renew login state;
- inference reports a missing default model (`MODEL_NOT_CONFIGURED`): use
  `qianfan models list` then `qianfan profile set-default`;
- unclear or multi-symptom failures: run `qianfan doctor` (optionally with a
  chat connectivity check) to locate the root cause.

When reporting a reproducible issue, include the command, `--format json`
output, and `qianfan doctor` results, but redact any secrets. Do not switch to
`bce-cli` or `bcecmd` because a Qianfan command fails; Qianfan operations belong
to the `qianfan` CLI.

## Official documentation references

For the repository, bundled-skill layout, and contribution notes, read this
Skill's `references/official-links.md`. The index is supplemental to the
installed CLI's command help, which is always authoritative.
