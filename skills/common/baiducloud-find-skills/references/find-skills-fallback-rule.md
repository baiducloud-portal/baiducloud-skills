# Always-apply rule: fall back to baiducloud-find-skills when a capability is missing

Install this as an always-apply rule in your host Agent's rule directory (for
example a Comate `.mdr` rule, a Claude Code / Cursor rule file, or an equivalent
"always apply" instruction). Run `node scripts/install_rule.mjs` from this
Skill's directory to do it. Skills cannot hand a failed task to each other at
runtime, so this rule is how the finder gets consulted.

---

## BaiduCloud Skill discovery fallback

When a Baidu Cloud task fails because the installed Skills do not cover the
capability, look for an installable Skill with `baiducloud-find-skills`, ask the
user, install it, and continue the original task. Do not use this for any other
kind of failure.

1. Trigger only on a missing capability: no installed Skill covers the product,
   `bce-cli` reports that the product or subcommand is unsupported, or a Skill
   states that it does not cover the request. Do not trigger on authentication,
   permission, invalid parameter, resource not found, throttling, network, or
   timeout errors; a new Skill would not fix them.
2. Search at most once per task:
   `node <baiducloud-find-skills skill dir>/scripts/find_skills.mjs search <keyword>`.
   Use one or two product or operation keywords. Never put the user's original
   text, resource ids, IPs, or credentials into the keyword.
3. If nothing matches, say so and stop. Do not retry with other keywords or
   install anything.
4. If a Skill matches, tell the user its name, source repo (`repo`), and what it
   does, then wait for confirmation. Installing pulls code from an external
   repository, so never install without an explicit yes.
5. After confirmation, run
   `node <baiducloud-find-skills skill dir>/scripts/find_skills.mjs install <name>`
   (add `--repo <owner/name>` when the name exists in more than one source).
6. Continue the original task:
   - If the new Skill is already in this session's Skill list, invoke it.
   - Otherwise read `<host skills dir>/<name>/SKILL.md` (Comate
     `~/.comate/skills`, Claude Code `~/.claude/skills`, Codex
     `~/.codex/skills`) and follow it. If that file is missing, report it and
     tell the user the Skill will be available in a new session.
   - Tell the user that a new session loads the Skill automatically.
7. Invoking a new `baiducloud-*` or `qianfan-*` Skill still goes through the
   `baiducloud-gateway` and `qianfan-gate` rules.

Do not run this for pure Q&A that executes no Skill.
