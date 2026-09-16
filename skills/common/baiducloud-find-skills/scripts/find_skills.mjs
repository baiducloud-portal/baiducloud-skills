#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG = path.join(SKILL_DIR, "references", "catalog.json");
const DEFAULT_REPO = "baidubce/baiducloud-skills";

function loadEntries() {
  // Return every discoverable Skill, each annotated with its source repo.
  //
  // Skills declared in the catalog `skills` array ship from this repository
  // (`baidubce/baiducloud-skills`). Skills declared under `external_sources`
  // live in other Baidu Cloud repositories and carry that repo so `install`
  // can route `npx skills add` to the correct source.
  const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf-8"));
  const entries = [];
  for (const skill of catalog.skills || []) {
    entries.push({ ...skill, repo: DEFAULT_REPO });
  }
  for (const source of catalog.external_sources || []) {
    const repo = source.repo;
    for (const skill of source.skills || []) {
      entries.push({ ...skill, repo });
    }
  }
  return entries;
}

function searchableText(entry) {
  // Join the business field values (not keys, not the injected repo, not the
  // `preferred` disambiguation flag).
  //
  // Matching on keys, the repo annotation, or the `preferred` flag would make
  // generic terms such as `name`, `summary`, a repo substring, or `true` hit
  // every entry.
  const parts = [];
  for (const [key, value] of Object.entries(entry)) {
    if (key === "repo" || key === "preferred") {
      continue;
    }
    if (Array.isArray(value)) {
      parts.push(...value.map((item) => String(item)));
    } else {
      parts.push(String(value));
    }
  }
  return parts.join(" ").toLowerCase();
}

function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(2);
}

function parseArgs(argv) {
  const positional = [];
  const opts = { repo: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--json") {
      opts.json = true;
    } else if (token === "--repo") {
      i += 1;
      if (i >= argv.length) {
        fail("--repo 需要一个取值");
      }
      opts.repo = argv[i];
    } else if (token.startsWith("--repo=")) {
      opts.repo = token.slice("--repo=".length);
    } else if (token.startsWith("-")) {
      fail(`未知参数：${token}`);
    } else {
      positional.push(token);
    }
  }
  const action = positional[0];
  if (!["list", "search", "status", "install"].includes(action)) {
    fail("action 必须是 list、search、status 或 install 之一");
  }
  if (positional.length > 2) {
    fail(`多余的参数：${positional.slice(2).join(" ")}`);
  }
  opts.action = action;
  opts.term = positional.length > 1 ? positional[1] : null;
  return opts;
}

function main(argv) {
  const args = parseArgs(argv);
  const entries = loadEntries();
  if (args.action === "list") {
    process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
  } else if (args.action === "search") {
    const term = (args.term || "").toLowerCase();
    const matches = entries.filter((e) => searchableText(e).includes(term));
    process.stdout.write(JSON.stringify(matches, null, 2) + "\n");
  } else if (args.action === "status") {
    const payload = { message: "请使用宿主 Agent 的 skills list/status 命令确认动态加载状态。" };
    process.stdout.write((args.json ? JSON.stringify(payload) : payload.message) + "\n");
  } else {
    let matches = entries.filter((e) => e.name === args.term);
    if (matches.length === 0) {
      fail("必须提供 catalog 中的精确 Skill 名称");
    }
    if (args.repo) {
      const scoped = matches.filter((e) => e.repo === args.repo);
      if (scoped.length === 0) {
        const available = [...new Set(matches.map((e) => e.repo))].sort().join(", ");
        fail(`Skill ${args.term} 不在 repo ${args.repo}；可用来源为：${available}`);
      }
      matches = scoped;
    }
    const repos = [...new Set(matches.map((e) => e.repo))].sort();
    let repo = repos[0];
    if (repos.length > 1) {
      // Multiple sources ship this Skill name. Prefer the source the catalog
      // marks with `preferred: true` when exactly one match carries it;
      // otherwise the choice is ambiguous and the caller must pass --repo.
      const preferred = matches.filter((e) => e.preferred === true);
      if (preferred.length === 1) {
        repo = preferred[0].repo;
        process.stderr.write(
          `Skill ${args.term} 在多个来源存在，已按 preferred 选择来源 ${repo}；如需其他来源请用 --repo 指定\n`,
        );
      } else {
        fail(`Skill ${args.term} 在多个来源存在：${repos.join(", ")}；请用 --repo 指定其一`);
      }
    }
    const bin = process.env.SKILLS_ADD_BIN || "npx";
    const result = spawnSync(
      bin,
      ["skills", "add", repo, "--global", "--yes", "--copy", "--full-depth", "--skill", args.term],
      { stdio: "inherit" },
    );
    if (result.error) {
      fail(`无法执行 ${bin}: ${result.error.message}`);
    }
    if (result.status !== 0) {
      process.exit(result.status === null ? 1 : result.status);
    }
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));