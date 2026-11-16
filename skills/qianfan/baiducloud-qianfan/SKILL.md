---
name: baiducloud-qianfan
description: Single entry point for Baidu Qianfan (千帆) large-model platform tasks; use it before any qianfan-* skill. Routes work to the official qianfan CLI after the account gate. Trigger for 千帆 / Qianfan model discovery, inference/chat, embedding, image or video generation, plan and default-model binding, custom endpoints, usage, or diagnostics, or mentions of qianfan, qianfan +chat, or qianfan-cli. Do not route Qianfan inference through bce-cli, bcecmd, or baiducloud-openapi.
---

# BaiduCloud Qianfan

Baidu Qianfan (千帆) is Baidu's large-model platform. It has its own official
CLI, `qianfan`, published at
[baidubce/qianfan-cli](https://github.com/baidubce/qianfan-cli). Treat that CLI
as the source of truth for Qianfan command names, parameters, authentication,
signing, and service behavior. Qianfan is not a `bce-cli` service and does not
use the BOS `bcecmd` client.

This Skill is the single entry point for Qianfan tasks. It routes work to the
official CLI after the account gate below, and takes command names and flags from
`qianfan --help`. It does not install the CLI's bundled `qianfan-*` skills (see
*Bundled `qianfan-*` skills*). Keep the boundary with the rest of this marketplace
clear.

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
separate from the `bce-cli` `oauth` profile. Do not read or write one from the
other by hand. The only supported bridge is `baiducloud-auth`'s
`scripts/sync_qianfan.mjs`, which copies a finished `bce auth login` into
`qianfan` automatically (no confirmation needed) after a `bce auth login` or
`bce auth refresh`, or when Qianfan is not logged in; the browser login via
`qianfan auth login`
remains the alternative.

## Account gate (mandatory)

Before the first `qianfan` command of a task (inference, models, profile,
usage, doctor, and so on), run the account check through the `baiducloud-auth`
Skill: `node scripts/sync_qianfan.mjs check` in that Skill's directory. It is
read-only and compares the account in `qianfan auth status --format json` with
the account of the local `bce auth login`. If Qianfan is not logged in but bce
is, `check` automatically adopts the bce login (no confirmation needed) and
reports `auto_synced: true`; tell the user it happened.

- Exit 0 (`match`, `skipped`, or auto-synced): continue.
- Exit 3 after an auto-sync (`AGREEMENT_NOT_SIGNED`): the login was saved, but
  the user must open the printed URL and sign the Qianfan agreement. Continue
  once they have.
- If the bce credentials are expired or about to expire, `check` renews them with
  `bce auth refresh` itself before syncing (`bce_refreshed: true`). Only if that
  refresh fails, ask the user to run `bce auth login` and run `check` again.
- Exit 4 (`ACCOUNT_MISMATCH`): stop. Do not run any `qianfan` command. Tell the
  user the two accounts differ (ids are masked), and ask them to log out first
  (`node scripts/sync_qianfan.mjs logout` for Qianfan, `bce auth logout` for
  bce), then run `bce auth login` as the intended account and sync again.
  Never log out or switch accounts on the user's behalf.
- Any other failure: report it and continue only if the user agrees.

If a `qianfan` command later reports that the login expired ("登录已过期",
`login expired`, or `CREDENTIAL_NOT_FOUND`), do not ask: run
`sync_qianfan.mjs sync` through `baiducloud-auth`. It renews the bce credentials
with `bce auth refresh` when needed, then renews the Qianfan login, and you retry
the failed command once. `check` does the same proactively when it sees an
expired Qianfan login.

Once per task is enough; repeat it after any login, logout, or account switch.

## Host rules (DuMate only)

百度搭子 DuMate has no always-apply rules, so this Skill applies them itself. In the
`baiducloud-gateway` Skill directory run `node scripts/gateway.mjs host`. If
`dumate` is false, skip this section (the host's rules already cover it).

If `dumate` is true:

- Run `gateway.mjs preflight` before the first `qianfan` command (`--skill
  baiducloud-qianfan --source-layer qianfan-cli --caller-name dumate`) and
  `gateway.mjs report` after it, as in `baiducloud-gateway/references/gateway-rule.md`.
  Run the account gate above first; if it stops on an account mismatch, send no report.
- The `qianfan-*` skills bundled with the CLI would bypass the account gate on
  DuMate, so do not run `qianfan +connect` into DuMate. Run `qianfan` commands
  from this Skill, after the gate, and take flags from `qianfan --help`.
- If the task needs a capability this Skill does not cover, follow
  `baiducloud-find-skills`: search once, and install only after the user confirms.

## Onboarding: install the CLI

When this Skill triggers, bring the environment to a ready state with the
following ordered flow. It is confirm-gated: detect first, then propose each
state-changing step and run it only after explicit confirmation. Do not perform
a silent or unattended install.

**Positive identification of the official CLI.** Read these two complementary
signals and decide via the tree below — they are not a strict AND; the tree says
how to act on each combination. Use the exact package name from the README (do
not invent it). The check uses only npm and the CLI itself — no OS-specific
shell tools — so it works the same on every platform the CLI supports (see the
README's platform matrix):

- `npm ls -g --depth=0 <official-package-from-README>` lists the official
  package as installed. Under nvm/fnm/volta or a custom `--prefix` it can report
  a false "not found", so treat a miss there as inconclusive, not as proof of
  absence.
- `qianfan --help` banner names the official package (use `--help`, which the
  CLI always implements; `--version` only as an additional signal). This banner
  is the sole discriminator between the official package and a different tool
  that merely happens to be named `qianfan`, so it must be checked. It defends
  against an accidental name collision, not against an adversarial binary that
  deliberately prints the official banner.

1. **Detect (read-only, run immediately).** Run the two identification commands
   and apply *Positive identification* above:

   ```bash
   qianfan --help   # command-not-found here is a normal "not on PATH" signal, not an error
   npm ls -g --depth=0 <official-package-from-README>
   ```

   `qianfan --help` failing with command-not-found just means `qianfan` is not
   on PATH; read that as "not runnable here", not as an error to fix. Decide from
   the two results (check whether a `qianfan` actually runs first):

   - `qianfan` is not on PATH and `npm ls -g` clearly misses (no version-manager
     or custom-prefix in play that could make it a false negative): not installed
     — proceed to the confirm-gated npm install.
   - `qianfan` is not on PATH and `npm ls -g` misses but a version manager or
     custom `--prefix` is active (possible false negative): inconclusive — re-run
     the check under the active toolchain or ask the user to confirm before
     deciding; do not install blindly.
   - `qianfan` is not on PATH but `npm ls -g` lists the official package (global
     npm bin not on PATH): installed but not usable — do not reinstall; tell the
     user to add npm's global bin dir to PATH (`$(npm prefix -g)/bin` in POSIX
     shells; on Windows it is the `npm prefix -g` directory itself), then
     re-check.
   - A `qianfan` runs but its `--help` banner is not the official CLI: it is a
     different tool occupying the name — do not use it and do not silently
     overwrite it. Combine with `npm ls -g`: if `npm ls -g` also lists the
     official package, it is already installed but shadowed by that binary
     earlier on PATH — reinstalling will not help; guide the user to fix PATH
     order or remove/rename the shadowing entry, then re-check. If `npm ls -g`
     does not list it, surface the name conflict to the user first; only after
     they decide, proceed to the confirm-gated install of the official package.
   - A `qianfan` runs and its banner is the official CLI: it is installed. Skip
     onboarding and go straight to the task.

2. **Install the official npm package, then confirm.** If the official package
   is missing, direct the user to the official
   [qianfan-cli repository](https://github.com/baidubce/qianfan-cli). Install it
   only as the official npm package (`npm install -g <official-package-from-README>`)
   — never a downloaded binary, a system package manager, or an unverified
   `qianfan` already on PATH. Take the exact package name, install command, and
   supported platforms from the repository README; do not invent them. Show the
   command, explain that it changes the global environment, and wait for
   explicit confirmation before running it on the user's behalf. Do not download
   an untrusted binary and never ask for credentials in chat. In offline
   environments the repository documents `QIANFAN_SKIP_POSTINSTALL=1` to skip
   the platform binary download.

   **Upgrading an installed CLI.** The `baiducloud-gateway` preflight reports a
   newer release as `cli_update` (`available`, `current`, `latest`,
   `upgrade_command`). When `available` is true, tell the user that new features
   may be missing on the old version and that you are upgrading, then run
   `cli_update.upgrade_command` (the official npm package, from the pinned
   registry) without asking again; this applies only to upgrading an
   already-verified official install, never to a first install above. Run it with
   the user's own privileges: on failure (for example a permission error) report
   it, never retry with `sudo`, and continue on the current version.

3. **Verify the install.** `npm ls -g --depth=0 <official-package-from-README>`
   listing the package is the primary success signal; then run `qianfan --help`
   and confirm the banner names the official package. If `npm ls -g` lists it but
   `qianfan --help` will not run (global npm bin not on PATH), that is the "add
   npm's global bin to PATH" case from step 1, not a failed install — do not
   reinstall.

## Bundled `qianfan-*` skills

The CLI can install its own `qianfan-*` agent skills with `qianfan +connect`.
This Skill does not run it and does not recommend it: the commands below are
enough, and the bundled skills do not pass through the account gate.

If the user asks for `qianfan +connect`, or the bundled skills are already
installed, do not block or uninstall them. Start the task here, run the account
gate first, and let the bundled skills help with details afterwards. Installing
or uninstalling them changes local state, so use the confirm-then-execute rule in
[Safe execution](#safe-execution) (`--dry-run` first, no `-y/--yes` on the
user's behalf).

## Command entry points

The official CLI exposes these entry points (verify flags with `--help` before
use):

- `qianfan auth` - browser OAuth login, logout, and login status. The CLI keeps
  a single logged-in account; switch accounts with `qianfan auth logout` first.
- `qianfan models` - list bindable models and their `modelId`.
- `qianfan profile` - list/switch plans (profiles) and bind a default model per
  model type (`profile use`, `profile set-default`).
- `qianfan +chat` - text inference and streaming output.
- `qianfan +embedding` - turn one or more texts into vectors.
- `qianfan +gen` - text-to-image generation.
- `qianfan +video` - video generation. It is an asynchronous task: it returns a
  `taskId`; query it later with `--task`, or add `--wait` to poll until done.
- `qianfan endpoint` - list preset services (to get a `serviceId`), and create,
  query, modify, or disable custom endpoints with RPM/TPM rate limits. `create`
  needs `--service-id`, `--name`, and `--suffix`, and at least one rate limit;
  `modify` needs at least one field to change.
- `qianfan service usage` - call counts and token consumption over a time range.
- `qianfan doctor` - read-only health check and connectivity diagnostics.
- `qianfan +connect` - install, list, or uninstall the bundled agent skills.

`+chat`, `+embedding`, `+gen`, and `+video` fall back to the default model bound
for their model type (`chat`, `embedding`, `image`, `video`) when `--model` is
not given. Bind one with `qianfan profile set-default --model-type <type>`.

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
