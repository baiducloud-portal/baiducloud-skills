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

## Onboarding: install the CLI and bundled skills

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

**Listing the bundled skills (read-only).** A separate check from the two
signals above: run the list subcommand of `qianfan +connect` (take its exact
name/flags from `qianfan +connect --help`; a bare `qianfan +connect` may
connect/install, so do not use it to list). Do not hardcode the skill names —
enumerate from the CLI. Depending on the CLI version the output may expose the
full available set plus which are connected, or only the connected ones; both
step 1 and step 4 rely on this same read-only listing.

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
   - A `qianfan` runs and its banner is the official CLI: it is installed. Run
     the read-only *Listing the bundled skills* check — no connecting here. If
     the CLI exposes the full available set and **all** bundled `qianfan-*`
     skills are already connected, skip onboarding and go straight to the task.
     If any are missing — or the CLI reports only connected skills, so
     completeness cannot be confirmed read-only — continue to step 4 and let its
     idempotent connect settle it.

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

3. **Verify the install.** `npm ls -g --depth=0 <official-package-from-README>`
   listing the package is the primary success signal; then run `qianfan --help`
   and confirm the banner names the official package. If `npm ls -g` lists it but
   `qianfan --help` will not run (global npm bin not on PATH), that is the "add
   npm's global bin to PATH" case from step 1, not a failed install — do not
   reinstall.

4. **Connect all the bundled agent skills, then confirm.** The qianfan CLI
   carries its own agent skills and installs them into local agents (Comate,
   Claude Code, and others) via `qianfan +connect`. The goal state is that
   **every** bundled `qianfan-*` skill is connected, not just some:

   - **Enumerate + detect (read-only):** run the *Listing the bundled skills*
     check to see the bundled skills and which are already connected (reuse the
     listing from step 1's final branch if it is still valid rather than
     repeating it).
   - **Diff (when the listing supports it):** if the list output distinguishes
     the full available set from the connected set, compare them to find any
     missing. If the CLI only reports connected skills (no full available list)
     and names must not be hardcoded, skip the explicit diff and instead rely on
     the connect action below.
   - **Connect all (confirm-gated):** if any are missing, none are connected, or
     completeness could not be confirmed by listing, running `qianfan +connect`
     changes local state, so follow the confirm-then-execute rule in
     [Safe execution](#safe-execution): preview the intent (use `--dry-run` if
     supported), confirm, then run it once; do not add `-y/--yes` for the user.
     Connect the full set, not a subset. Observe this run's output: if it reports
     that nothing was added, the set was already complete.
   - **Verify:** if the CLI exposes the full available set, re-list with the same
     read-only list subcommand from the Enumerate step (not a bare
     `qianfan +connect`, which may connect/install) and confirm every bundled
     `qianfan-*` skill is present. If it only reports connected skills, do not
     trigger a second confirm-gated connect just to verify — read completeness
     from the Connect-all run's output above (nothing added = already complete).

5. **Reload, then defer to the bundled skills.** Newly connected `qianfan-*`
   skills usually need a new session or a host-agent reload before they are
   picked up. Afterward, prefer these bundled skills for actual Qianfan
   operations (login, model discovery, plan and default-model binding,
   inference, usage, diagnostics). They orchestrate `qianfan` commands only;
   they do not read local credentials or call Qianfan HTTP APIs directly. This
   Skill does not restate their contents; re-run the step 4 detect/connect flow
   to keep the full set installed and current.

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
