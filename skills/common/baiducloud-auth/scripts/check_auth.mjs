#!/usr/bin/env node
// Read-only checks for the official bce CLI and IAM OAuth login state.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const CONFIG_FILE = process.env.BCE_CONFIG_FILE || path.join(os.homedir(), ".bce", "config.json");
const OAUTH_DIR = process.env.BCE_IAM_OAUTH_DIR || path.join(os.homedir(), ".bce", "oauth");

// The profile to check: --profile / BCE_PROFILE, else the profile that
// `bce auth status` reports (the current one), else `current` in config.json.
function resolveProfile(binary) {
  const argIndex = process.argv.indexOf("--profile");
  const explicit = argIndex >= 0 ? process.argv[argIndex + 1] : process.env.BCE_PROFILE;
  if (argIndex >= 0 && (!explicit || explicit.startsWith("-"))) {
    throw new Error("--profile requires a profile name");
  }
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }
  if (binary) {
    const proc = spawnSync(binary, ["auth", "status", "--format", "json"], { encoding: "utf-8", timeout: 10000 });
    try {
      const fromStatus = proc.error ? null : JSON.parse(proc.stdout || "").profile;
      if (typeof fromStatus === "string" && fromStatus) {
        return fromStatus;
      }
    } catch {
      // unparseable status output; fall back to the config file
    }
  }
  try {
    const current = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"))?.current;
    if (typeof current === "string" && current) {
      return current;
    }
  } catch {
    // no readable config; fall through to the default name
  }
  return "oauth";
}

function which(bin) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // not executable here; keep searching
    }
  }
  return null;
}

function oauthProfileExists(profileName) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return false;
  }
  const profiles = data && typeof data === "object" ? data.profiles : null;
  if (!Array.isArray(profiles)) {
    return false;
  }
  for (const profile of profiles) {
    if (
      profile && typeof profile === "object"
      && profile.name === profileName
      && String(profile.mode ?? "").trim().toLowerCase() === "oauth"
    ) {
      return true;
    }
  }
  return false;
}

function parseExpiration(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  // A timestamp without a timezone is treated as UTC; append Z so JS does the
  // same instead of interpreting it in local time.
  const text = value.trim();
  const hasTz = /(Z|[+-]\d{2}:?\d{2})$/.test(text);
  const parsed = new Date(hasTz ? text : text + "Z");
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function oauthLoginState(profileName) {
  const state = { logged_in: false, credentials_expired: null, state_readable: true };
  const statePath = path.join(OAUTH_DIR, `${profileName}.json`);
  if (!fs.existsSync(statePath) || !fs.statSync(statePath).isFile()) {
    return state;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  } catch {
    state.state_readable = false;
    return state;
  }
  const sts = data && typeof data === "object" ? data.sts : null;
  state.logged_in = Boolean(sts && typeof sts === "object" && sts.accessKeyId);
  const expiration = sts && typeof sts === "object" ? sts.expiration : null;
  const expiresAt = parseExpiration(expiration);
  if (expiresAt !== null) {
    state.credentials_expired = expiresAt.getTime() <= Date.now();
  }
  return state;
}

function main() {
  const binary = process.env.BCE_CLI_BIN || "bce";
  const resolved = path.basename(binary) === binary ? which(binary) : binary;
  const available = Boolean(resolved) && fs.existsSync(resolved);
  let profileName;
  try {
    profileName = resolveProfile(available ? resolved : null);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  const cli = { binary, available };
  const result = {
    cli,
    oauth: { profile: profileName, profile_exists: false },
  };
  if (available) {
    const proc = spawnSync(resolved, ["version"], { encoding: "utf-8", timeout: 10000 });
    if (proc.error) {
      cli.error = String(proc.error.message ?? proc.error);
    } else {
      cli.version_exit_code = proc.status;
      cli.version = (proc.stdout || proc.stderr || "").trim().slice(0, 200);
    }
  }
  const oauth = result.oauth;
  oauth.profile_exists = oauthProfileExists(profileName);
  Object.assign(oauth, oauthLoginState(profileName));
  if (!available) {
    result.hint = "install bce-cli from https://github.com/baidubce/bce-cli";
  } else if (
    !oauth.profile_exists
    || !oauth.logged_in
    || oauth.credentials_expired === true
  ) {
    result.hint = `run 'bce auth login --profile ${profileName}' to sign in`;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return available ? 0 : 1;
}

process.exit(main());
