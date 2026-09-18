---
name: baiducloud-find-skills
description: Discover and install the smallest exact BaiduCloud Skill needed for a task. Use when a Baidu Cloud capability is missing, when the user asks to find or install a skill, or when the current skills cannot cover a product domain.
---

# Find BaiduCloud Skills

Read the bundled catalog, search by product, summary, and keywords, then install only the exact Skill name through `npx skills add`. Because core and optional Skills live at different depths in the repository, always include `--full-depth`. The finder defaults to `--global --yes --copy` so installed Skills are available across projects, installation is non-interactive, and files do not depend on the source checkout. For a user-requested project-local or interactive install, invoke `npx skills add` directly with the desired optional flags while retaining `--full-depth`. Verify the installation afterward. Plugins are distribution groups; do not install an entire product domain when one Skill is sufficient.

The catalog also lists Skills from other official Baidu Cloud repositories under `external_sources` (for example `baidubce/baiducloud-aiops-skills`, which provides diagnosis, audit, and monitoring Skills for BCC, VPC/CSN/DNS networking, APM/BCM observability, Hermes LLM tracing, BLS logging, and BOS storage). `list` and `search` merge these with the built-in Skills and annotate each entry with its source `repo`; `install` routes `npx skills add` to that repo automatically. When a Skill name exists in more than one source (for example `baiducloud-bos`), `install` prefers the source the catalog marks with `"preferred": true` (currently the aiops BOS Skill) so it can proceed without `--repo`; pass `--repo <owner/name>` to override that default or to disambiguate when no single source is preferred.

```bash
node scripts/find_skills.mjs list
node scripts/find_skills.mjs search bcc
node scripts/find_skills.mjs search vm
node scripts/find_skills.mjs install baiducloud-vm-diagnosis
node scripts/find_skills.mjs install baiducloud-bos
node scripts/find_skills.mjs install baiducloud-bos --repo baidubce/baiducloud-skills
node scripts/find_skills.mjs install baiducloud-qianfan
node scripts/find_skills.mjs install baiducloud-qianfan --repo baidubce/baiducloud-skills
node scripts/find_skills.mjs status
```
