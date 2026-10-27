#!/usr/bin/env node
// baiducloud-auth: install this Skill's always-apply rule into host Agents.
//
// Reads references/qianfan-gate-rule.md, keeps the protocol text after the first `---`
// line, and writes it where each host loads always-apply rules:
//   comate  ~/.comate/rules/<name>.mdr        (frontmatter alwaysApply: true)
//   claude  ~/.claude/rules/<name>.md
//   codex   ~/.codex/AGENTS.md                (marker block, replaced in place)
//   cursor  <project>/.cursor/rules/<name>.mdc (project level only, --project)
//
// Runs without confirmation and is idempotent: an unchanged file is left alone,
// a changed one is rewritten, and symlinked targets are never written through.
// Only the hosts' rule locations are touched; no credentials are read.
// Zero third-party dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Per-skill settings; the copy of this script in the other Skill differs only here.
const RULE = {
  skill: 'baiducloud-auth',
  reference: 'qianfan-gate-rule.md',
  name: 'qianfan-account-gate',
  comateName: 'qianfan-gate',
};

const HOST_NAMES = ['comate', 'claude', 'codex'];
const HELP = `Usage: install_rule.mjs [--host comate|claude|codex|all[,...]] [--project <dir>]
                        [--dry-run] [--uninstall]

Installs the ${RULE.skill} always-apply rule into host Agents. Without --host,
every host whose config directory exists (~/.comate, ~/.claude, ~/.codex) is used.
--project <dir> also writes the Cursor project rule <dir>/.cursor/rules/.
--dry-run reports what would change; --uninstall removes the rule.
`;

class UsageError extends Error {}

export function extractBody(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const sep = lines.findIndex((line) => line.trim() === '---');
  if (sep < 0) throw new Error('rule reference has no `---` separator');
  const body = lines.slice(sep + 1).join('\n').trim();
  const m = /^#{1,6}\s+(.+)\n?/.exec(body);
  if (!m) throw new Error('rule body must start with a heading');
  return { title: m[1].trim(), rest: body.slice(m[0].length).trim() };
}

// `<baiducloud-auth skill dir>` placeholders become the host's real Skill path
// when that Skill is installed there; otherwise the placeholder is kept.
function resolveSkillDirs(text, skillsRoot) {
  if (!skillsRoot) return text;
  return text.replace(/<(baiducloud-[a-z-]+) skill dir>/g, (whole, skill) =>
    fs.existsSync(path.join(expandHome(skillsRoot), skill)) ? `${skillsRoot}/${skill}` : whole);
}

function expandHome(p) {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function readRule() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.join(here, '..', 'references', RULE.reference);
  return extractBody(fs.readFileSync(file, 'utf-8'));
}

function hostSpec(host) {
  const h = os.homedir();
  const specs = {
    comate: { root: path.join(h, '.comate'), file: path.join(h, '.comate', 'rules', `${RULE.comateName}.mdr`), kind: 'mdr', skillsRoot: '~/.comate/skills' },
    claude: { root: path.join(h, '.claude'), file: path.join(h, '.claude', 'rules', `${RULE.name}.md`), kind: 'claude', skillsRoot: '~/.claude/skills' },
    codex: { root: path.join(h, '.codex'), file: path.join(h, '.codex', 'AGENTS.md'), kind: 'block', skillsRoot: '~/.codex/skills' },
  };
  return specs[host];
}

const SOURCE = `<!-- Source: ${RULE.skill} skill (references/${RULE.reference}). Always-apply rule. -->`;
const BEGIN = `<!-- baiducloud-skills:${RULE.name}:begin -->`;
const END = `<!-- baiducloud-skills:${RULE.name}:end -->`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BLOCK_SRC = `${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}`;

export function render(kind, rule, skillsRoot) {
  const rest = resolveSkillDirs(rule.rest, skillsRoot);
  const frontmatter = `---\ndescription: ${JSON.stringify(rule.title)}\nalwaysApply: true\n---\n\n`;
  if (kind === 'mdr' || kind === 'mdc') return `${frontmatter}# ${rule.title}\n\n${SOURCE}\n\n${rest}\n`;
  if (kind === 'claude') return `# ${rule.title}\n\n${SOURCE}\n\n${rest}\n`;
  return `${BEGIN}\n# ${rule.title}\n\n${rest}\n${END}`;
}

const isSymlink = (p) => {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
};

function readOrNull(p) {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Writes `next` to `file` unless it already matches. A file this script did not
// write (no Source marker, and not a marker-block host file) is never replaced.
function applyContent(file, next, { dryRun, owned }) {
  if (isSymlink(file)) return { action: 'skipped', reason: 'target is a symlink' };
  const cur = readOrNull(file);
  if (cur === next) return { action: 'unchanged' };
  if (cur !== null && !owned(cur)) return { action: 'skipped', reason: 'existing file was not written by this Skill' };
  if (dryRun) return { action: cur === null ? 'would_create' : 'would_update' };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return { action: cur === null ? 'created' : 'updated' };
}

function installOne({ file, kind, skillsRoot }, rule, dryRun) {
  if (kind !== 'block') {
    return applyContent(file, render(kind, rule, skillsRoot), { dryRun, owned: (cur) => cur.includes(SOURCE) });
  }
  const block = render(kind, rule, skillsRoot);
  const cur = readOrNull(file);
  const re = new RegExp(BLOCK_SRC);
  let next;
  if (cur === null || cur.trim() === '') next = `${block}\n`;
  else if (re.test(cur)) next = cur.replace(re, () => block);
  else next = `${cur.replace(/\s*$/, '')}\n\n${block}\n`;
  return applyContent(file, next, { dryRun, owned: () => true });
}

function uninstallOne({ file, kind }, dryRun) {
  if (isSymlink(file)) return { action: 'skipped', reason: 'target is a symlink' };
  const cur = readOrNull(file);
  if (cur === null) return { action: 'absent' };
  if (kind === 'block') {
    const re = new RegExp(`\\n*${BLOCK_SRC}\\n?`);
    if (!re.test(cur)) return { action: 'absent' };
    if (dryRun) return { action: 'would_remove' };
    fs.writeFileSync(file, cur.replace(re, ''));
    return { action: 'removed' };
  }
  if (!cur.includes(SOURCE)) return { action: 'skipped', reason: 'existing file was not written by this Skill' };
  if (dryRun) return { action: 'would_remove' };
  fs.unlinkSync(file);
  return { action: 'removed' };
}

function parseArgs(argv) {
  const opts = { hosts: [], project: null, dryRun: false, uninstall: false, help: false };
  const value = (i, flag) => {
    if (!argv[i + 1]) throw new UsageError(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--uninstall') opts.uninstall = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--project') opts.project = path.resolve(value(i++, arg));
    else if (arg === '--host') {
      for (const host of value(i++, arg).split(',')) {
        if (host === 'all') opts.hosts.push(...HOST_NAMES);
        else if (HOST_NAMES.includes(host)) opts.hosts.push(host);
        else throw new UsageError(`unknown host: ${host}`);
      }
    } else throw new UsageError(`unknown argument: ${arg}`);
  }
  opts.hosts = [...new Set(opts.hosts)];
  return opts;
}

export function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`${err.message}\n${HELP}`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const detected = !opts.hosts.length;
  const hosts = detected ? HOST_NAMES.filter((h) => fs.existsSync(hostSpec(h).root)) : opts.hosts;
  const targets = hosts.map((host) => ({ host, ...hostSpec(host) }));
  if (opts.project) {
    targets.push({
      host: 'cursor',
      file: path.join(opts.project, '.cursor', 'rules', `${RULE.name}.mdc`),
      kind: 'mdc',
      skillsRoot: '~/.cursor/skills',
    });
  }
  if (!targets.length) {
    process.stderr.write(`no supported host detected (looked for ~/.comate, ~/.claude, ~/.codex); pass --host or --project\n${HELP}`);
    return 1;
  }
  const rule = opts.uninstall ? null : readRule();
  let failed = false;
  const results = targets.map((target) => {
    let outcome;
    try {
      outcome = opts.uninstall ? uninstallOne(target, opts.dryRun) : installOne(target, rule, opts.dryRun);
    } catch (err) {
      failed = true;
      outcome = { action: 'error', reason: err.code || 'write failed' };
    }
    return { host: target.host, path: target.file, ...outcome };
  });
  const report = { rule: RULE.name, mode: opts.uninstall ? 'uninstall' : 'install', dry_run: opts.dryRun, results };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
