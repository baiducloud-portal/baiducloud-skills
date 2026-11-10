---
name: baiducloud-find-skills
description: Discover and install the smallest exact BaiduCloud Skill needed for a task. Use when a Baidu Cloud capability is missing, when the user asks to find or install a skill, or when the current skills cannot cover a product domain.
---

# Find BaiduCloud Skills

Read the bundled catalog, search by product, summary, and keywords, then install only the exact Skill name through `npx skills add`. Because core and optional Skills live at different depths in the repository, always include `--full-depth`. The finder defaults to `--global --yes --copy` so installed Skills are available across projects, installation is non-interactive, and files do not depend on the source checkout. For a user-requested project-local or interactive install, invoke `npx skills add` directly with the desired optional flags while retaining `--full-depth`. Verify the installation afterward. Plugins are distribution groups; do not install an entire product domain when one Skill is sufficient.

The catalog also lists Skills from other official Baidu Cloud repositories under `external_sources` (for example `baidubce/baiducloud-aiops-skills`, which provides diagnosis, audit, and monitoring Skills for BCC, VPC/CSN/DNS/BLB networking, APM/BCM observability, Hermes LLM tracing, BLS logging, BOS storage, and databases (RDS, Redis, MongoDB, DTS, DBSC) with billing and IAM). `list` and `search` merge these with the built-in Skills and annotate each entry with its source `repo`; `install` routes `npx skills add` to that repo automatically. When a Skill name exists in more than one source (for example `baiducloud-bos`), `install` prefers the source the catalog marks with `"preferred": true` (currently the aiops BOS Skill) so it can proceed without `--repo`; pass `--repo <owner/name>` to override that default or to disambiguate when no single source is preferred.

```bash
node scripts/find_skills.mjs list
node scripts/find_skills.mjs search bcc
node scripts/find_skills.mjs search vm
node scripts/find_skills.mjs install baiducloud-vm-diagnosis
node scripts/find_skills.mjs install baiducloud-bos
node scripts/find_skills.mjs install baiducloud-bos --repo baiducloud-portal/baiducloud-skills
node scripts/find_skills.mjs status
```

## Fallback when a capability is missing

When another Baidu Cloud Skill fails because it does not cover the requested product or operation (not because of authentication, permission, parameter, network, or throttling errors), search once with a short product keyword, show the user the matching Skill name, source `repo`, and purpose, and install only after they confirm. Then invoke the new Skill if the session already lists it; otherwise read `<host skills dir>/<name>/SKILL.md` (`~/.comate/skills`, `~/.claude/skills`, or `~/.codex/skills`) and continue the original task. `status` does not return an install path. If nothing matches, say so and stop.

`references/find-skills-fallback-rule.md` encodes this flow as an always-apply rule. Install it with `node scripts/install_rule.mjs` (`--host comate|claude|codex|all`, `--project <dir>` for Cursor, `--dry-run`, `--uninstall`); the script is idempotent and only touches its own rule file or marked block.
