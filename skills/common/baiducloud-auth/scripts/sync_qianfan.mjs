#!/usr/bin/env node
// Bridge a bce-cli IAM OAuth login to the official qianfan CLI.
//
// Reads the STS credentials and id_token that `bce auth login|refresh` wrote
// and hands them to `qianfan auth internal login|refresh-login` over stdin.
// Credentials never appear in argv, environment variables, files, or output.
//
// Usage: node sync_qianfan.mjs <sync|check|logout> [--dry-run] [--format json|text] [--debug]
//        [--no-auto-sync] [--no-auto-refresh]
//
// When the bce STS credentials are expired or within 2 minutes of expiry,
// `sync` first renews them with `bce auth refresh` (disable: --no-auto-refresh).
//
// --debug (or SYNC_QIANFAN_DEBUG=1) prints step-by-step diagnostics to stderr.
// Debug lines carry only paths, field presence, timestamps, commands, and exit
// codes. Credential values are never logged; qianfan output is scrubbed first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const OAUTH_DIR = process.env.BCE_IAM_OAUTH_DIR || path.join(os.homedir(), '.bce', 'oauth');
const OAUTH_PROFILE = 'oauth';
// qianfan treats credentials as expired 2 minutes before `expiration`.
const SAFETY_MARGIN_MS = 2 * 60 * 1000;

export const EXIT = { ok: 0, failure: 1, usage: 2, agreementNotSigned: 3, accountMismatch: 4 };

let debugEnabled = process.env.SYNC_QIANFAN_DEBUG === '1';

function debug(message) {
  if (debugEnabled) {
    process.stderr.write(`[debug ${new Date().toISOString()}] ${message}\n`);
  }
}

const HINTS = {
  INVALID_ARGUMENT: "the credential payload was rejected; run 'bce auth login' again and retry",
  LOGIN_FAILED: "the credential payload is incomplete; run 'bce auth login' again and retry",
  AUTH_FAILED: 'id_token verification failed or the account differs from the qianfan login; '
    + "confirm, run 'node sync_qianfan.mjs logout', then sync again",
  CREDENTIAL_NOT_FOUND: "qianfan is not logged in or its login expired; run 'sync' again",
};

function parseArgs(argv) {
  const opts = { command: null, dryRun: false, format: 'json', autoSync: true, autoRefresh: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--no-auto-sync') {
      opts.autoSync = false;
    } else if (arg === '--no-auto-refresh') {
      opts.autoRefresh = false;
    } else if (arg === '--debug') {
      debugEnabled = true;
    } else if (arg === '--format') {
      opts.format = argv[i + 1];
      i += 1;
    } else if (!arg.startsWith('-') && opts.command === null) {
      opts.command = arg;
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }
  if (!['sync', 'logout', 'check'].includes(opts.command)) {
    return { error: "command must be 'sync', 'check' or 'logout'" };
  }
  if (!['json', 'text'].includes(opts.format)) {
    return { error: '--format must be json or text' };
  }
  return opts;
}

function parseExpiration(value, { requireTimezone = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  // A timestamp without a timezone is treated as UTC, matching check_auth.mjs,
  // unless the source's format is unverified (requireTimezone): then ignore it
  // rather than guess and risk an hours-wide error.
  const text = value.trim();
  const hasTz = /(Z|[+-]\d{2}:?\d{2})$/.test(text);
  if (!hasTz && requireTimezone) {
    return null;
  }
  const parsed = new Date(hasTz ? text : text + 'Z');
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Returns { payload } on success or { error, hint } when the bce login state
// is missing or unusable. Only presence is reported, never a value.
function loadBceCredentials() {
  const statePath = path.join(OAUTH_DIR, `${OAUTH_PROFILE}.json`);
  debug(`reading bce oauth state: ${statePath}`);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch (err) {
    debug(`failed to read/parse bce oauth state: ${err.code ?? err.name}`);
    return { error: 'bce oauth login state not found or unreadable', hint: 'run \'bce auth login\'' };
  }
  const sts = data && typeof data === 'object' ? data.sts : null;
  const missing = [];
  const pick = (value, name) => {
    if (typeof value !== 'string' || !value) {
      missing.push(name);
      return '';
    }
    return value;
  };
  const payload = {
    access_key: pick(sts?.accessKeyId, 'sts.accessKeyId'),
    secret_key: pick(sts?.secretAccessKey, 'sts.secretAccessKey'),
    session_token: pick(sts?.sessionToken, 'sts.sessionToken'),
    id_token: pick(data?.id_token, 'id_token'),
    expiration: pick(sts?.expiration, 'sts.expiration'),
  };
  debug(`bce state fields present: ${Object.entries(payload)
    .map(([key, value]) => `${key}=${value ? 'yes' : 'NO'}`).join(' ')}`);
  if (missing.length > 0) {
    return { error: `bce login state is missing: ${missing.join(', ')}`, hint: 'run \'bce auth login\'' };
  }
  const expiresAt = parseExpiration(payload.expiration);
  if (expiresAt === null) {
    return { error: 'bce sts.expiration is not a valid timestamp', hint: 'run \'bce auth login\'' };
  }
  const deadline = new Date(expiresAt.getTime() - SAFETY_MARGIN_MS);
  debug(`sts.expiration=${expiresAt.toISOString()} effective_deadline=${deadline.toISOString()} `
    + `remaining=${Math.round((deadline.getTime() - Date.now()) / 1000)}s`);
  if (deadline.getTime() <= Date.now()) {
    return {
      error: 'bce temporary credentials are expired or within 2 minutes of expiry',
      hint: "run 'bce auth refresh' (or 'bce auth login'), then sync again",
      needsRefresh: true,
    };
  }
  // qianfan requires RFC3339; normalise a zone-less value to explicit UTC.
  payload.expiration = expiresAt.toISOString();
  return { payload, deadline };
}

function qianfanBinary() {
  return process.env.QIANFAN_CLI_BIN || 'qianfan';
}

// Renew the bce OAuth temporary credentials with the official CLI. Only the
// success flag is read; nothing from its output is printed.
function runBceRefresh() {
  const bin = process.env.BCE_CLI_BIN || 'bce';
  const args = ['auth', 'refresh', '--format', 'json'];
  debug(`exec: ${bin} ${args.join(' ')}`);
  const proc = spawnSync(bin, args, { encoding: 'utf-8', timeout: 60000 });
  if (proc.error) {
    debug(`bce refresh failed to run: ${proc.error.code ?? proc.error.message}`);
    return { ok: false, reason: 'bce CLI could not be run' };
  }
  const parsed = parseJson(proc.stdout || '');
  const ok = proc.status === 0 && (parsed === null || parsed.success !== false);
  debug(`bce refresh exit=${proc.status} success=${ok}`);
  return ok ? { ok: true } : { ok: false, reason: 'bce auth refresh did not succeed' };
}

function maskValue(value) {
  return value.length > 8 ? `${value.slice(0, 4)}****${value.slice(-4)}` : '****';
}

// Describe the stdin payload for debug output: AccessKey is masked, other
// secrets show only their length, and expiration is printed in full.
function describePayload(payload) {
  return {
    access_key: maskValue(payload.access_key),
    secret_key: `<redacted, ${payload.secret_key.length} chars>`,
    session_token: `<redacted, ${payload.session_token.length} chars>`,
    id_token: `<redacted, ${payload.id_token.length} chars>`,
    expiration: payload.expiration,
  };
}

// Decode the JWT payload without verifying it; verification is qianfan's job.
function jwtPart(token, index) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[index], 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

// Decode only the JWT header and a few non-secret claims, so key-id (kid) or
// issuer mismatches are visible without printing the token itself.
function describeIdToken(idToken) {
  const h = jwtPart(idToken, 0);
  const c = jwtPart(idToken, 1);
  if (!h || !c) {
    return null;
  }
  return {
    header: { alg: h.alg, kid: h.kid, typ: h.typ },
    claims: { iss: c.iss, aud: c.aud, iat: c.iat, exp: c.exp },
  };
}

// qianfan names the account after the id_token's principal_id, so that is the
// value compared against `qianfan auth status`.
function bceAccountId(idToken) {
  const claims = jwtPart(idToken, 1);
  const id = claims?.principal_id || claims?.account_id;
  return typeof id === 'string' && id ? id : null;
}


// Run qianfan with an argument array (never a shell). `input` goes to stdin.
function runQianfan(args, input, secrets) {
  const started = Date.now();
  const stdinInfo = input === undefined ? 'none' : `JSON payload, ${input.length} bytes`;
  debug(`exec: ${qianfanBinary()} ${args.join(' ')} (stdin: ${stdinInfo})`);
  const proc = spawnSync(qianfanBinary(), args, {
    encoding: 'utf-8',
    input,
    timeout: 30000,
  });
  const elapsed = `${Date.now() - started}ms`;
  if (proc.error) {
    debug(`exec failed to start/finish after ${elapsed}: ${proc.error.code ?? proc.error.message}`);
    return { ok: false, code: 'QIANFAN_UNAVAILABLE', message: String(proc.error.code ?? 'spawn failed') };
  }
  debug(`exit status=${proc.status} signal=${proc.signal ?? 'none'} elapsed=${elapsed}`);
  if (proc.status === 0) {
    const stdout = scrub(proc.stdout || '', secrets);
    debug(`stdout: ${stdout.trim().replace(/\s+/g, ' ').slice(0, 500)}`);
    return { ok: true, stdout };
  }
  // CLI error format: "error: <CODE>: <message>" plus an optional "hint: ..." line.
  const text = scrub(`${proc.stderr || ''}\n${proc.stdout || ''}`, secrets);
  debug(`failure output: ${text.trim().replace(/\s+/g, ' ').slice(0, 500)}`);
  const match = text.match(/error:\s*([A-Z_]+):\s*(.*)/);
  const hint = text.match(/hint:\s*(.*)/);
  return {
    ok: false,
    code: match ? match[1] : 'UNKNOWN',
    message: match ? match[2].trim() : text.trim().slice(0, 300),
    qianfanHint: hint ? hint[1].trim() : undefined,
  };
}

function scrub(text, secrets) {
  let out = text;
  for (const secret of secrets) {
    if (secret) {
      out = out.split(secret).join('***');
    }
  }
  return out;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function qianfanLoggedIn() {
  const result = runQianfan(['auth', 'status', '--format', 'json'], undefined, []);
  if (!result.ok) {
    // A missing binary is a hard stop; any other failure is "unknown" and
    // login/refresh-login decide.
    return { loggedIn: result.code === 'QIANFAN_UNAVAILABLE' ? 'unavailable' : null, account: null, expiresAt: null };
  }
  const status = parseJson(result.stdout);
  const loggedIn = status && typeof status.configured === 'boolean' ? status.configured : null;
  const account = status && typeof status.account === 'string' && status.account ? status.account : null;
  // qianfan reports when its (non-renewable) login lapses, as RFC3339 with a
  // timezone (for example "...Z"). A value without a timezone is ignored.
  const expiresAt = status ? parseExpiration(status.login_expires_at, { requireTimezone: true }) : null;
  return { loggedIn, account, expiresAt };
}

function emit(opts, result) {
  if (opts.format === 'json') {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    const lines = Object.entries(result).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    process.stdout.write(lines.join('\n') + '\n');
  }
}

function fail(opts, result, exit = EXIT.failure) {
  emit(opts, { success: false, ...result });
  return exit;
}

// Returns a failure result when qianfan holds a different account than the bce
// id_token, otherwise null (also null when either side cannot be determined).
function accountMismatch(idToken, qianfanAccount) {
  const bceAccount = bceAccountId(idToken);
  debug(`account check: bce=${bceAccount ? maskValue(bceAccount) : 'unknown'} `
    + `qianfan=${qianfanAccount ? maskValue(qianfanAccount) : 'unknown'}`);
  if (!bceAccount || !qianfanAccount || bceAccount === qianfanAccount) {
    return null;
  }
  return {
    code: 'ACCOUNT_MISMATCH',
    error: 'qianfan is logged in as a different account than bce-cli',
    bce_account: maskValue(bceAccount),
    qianfan_account: maskValue(qianfanAccount),
    hint: "stop and do not call qianfan; log out first ('node sync_qianfan.mjs logout' for qianfan, "
      + "'bce auth logout' for bce), then run 'bce auth login' with the intended account and sync again",
  };
}

// Gate to run before any qianfan command: compares the qianfan account with
// the bce login. The comparison itself is read-only and needs only the
// id_token, so it works even when the bce STS credentials have expired.
//
// Unless --no-auto-sync is given, check also repairs the qianfan login by
// running doSync when qianfan is not logged in, or its login has expired or is
// within 2 minutes of expiring (login_expires_at). That path writes qianfan's
// login state and, via doSync, may run `bce auth refresh`; it needs usable bce
// credentials and fails with a `bce auth login` hint otherwise.
function doCheck(opts) {
  const statePath = path.join(OAUTH_DIR, `${OAUTH_PROFILE}.json`);
  let idToken = null;
  try {
    const data = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    idToken = typeof data?.id_token === 'string' && data.id_token ? data.id_token : null;
  } catch (err) {
    debug(`bce oauth state unreadable: ${err.code ?? err.name}`);
  }
  if (!idToken) {
    emit(opts, { success: true, result: 'skipped', reason: 'bce is not logged in via oauth; nothing to compare' });
    return EXIT.ok;
  }
  const { loggedIn, account, expiresAt: qianfanExpiresAt } = qianfanLoggedIn();
  if (loggedIn === 'unavailable') {
    return fail(opts, {
      error: 'qianfan CLI could not be run',
      hint: 'install or upgrade the official qianfan CLI (see the baiducloud-qianfan Skill)',
    });
  }
  if (loggedIn === false && opts.autoSync) {
    // qianfan has no login: adopt the bce login without asking, as configured.
    debug('qianfan is not logged in; auto-syncing the bce login');
    return doSync({ ...opts, autoSynced: true });
  }
  if (loggedIn !== true) {
    emit(opts, { success: true, result: 'skipped', reason: 'qianfan is not logged in; nothing to compare' });
    return EXIT.ok;
  }
  const mismatch = accountMismatch(idToken, account);
  if (mismatch) {
    return fail(opts, { result: 'mismatch', ...mismatch }, EXIT.accountMismatch);
  }
  // qianfan's synced login cannot renew itself and counts as expired 2 minutes
  // before its expiry. Renew it from bce (refreshing bce first if needed).
  if (opts.autoSync && qianfanExpiresAt && qianfanExpiresAt.getTime() - SAFETY_MARGIN_MS <= Date.now()) {
    debug(`qianfan login expired (login_expires_at=${qianfanExpiresAt.toISOString()}); renewing from bce`);
    return doSync({ ...opts, autoSynced: true });
  }
  emit(opts, { success: true, result: account ? 'match' : 'skipped', reason: account ? undefined : 'qianfan status has no account' });
  return EXIT.ok;
}

function doSync(opts) {
  let loaded = loadBceCredentials();
  let refreshed = false;
  if (loaded.needsRefresh && opts.autoRefresh) {
    if (opts.dryRun) {
      emit(opts, {
        success: true,
        dry_run: true,
        bce_refresh_needed: true,
        note: 'bce credentials are expired or within 2 minutes of expiry; ' +
          "a real run would renew them with 'bce auth refresh' first",
      });
      return EXIT.ok;
    }
    // Renew the expiring bce credentials first, as configured, then retry.
    debug("bce credentials expired or near expiry; running 'bce auth refresh'");
    const refresh = runBceRefresh();
    if (!refresh.ok) {
      return fail(opts, {
        error: refresh.reason,
        hint: "the bce refresh token may have expired; run 'bce auth login', then sync again",
      });
    }
    refreshed = true;
    loaded = loadBceCredentials();
    if (loaded.needsRefresh) {
      // The refresh reported success but did not extend the credentials, so
      // suggesting another refresh would not help.
      return fail(opts, {
        error: "bce credentials are still expired after 'bce auth refresh'",
        hint: "run 'bce auth login' to sign in again, then sync again",
      });
    }
  }
  if (loaded.error) {
    return fail(opts, { error: loaded.error, hint: loaded.hint });
  }
  const { payload, deadline } = loaded;
  const secrets = Object.entries(payload)
    .filter(([key]) => key !== 'expiration')
    .map(([, value]) => value);
  const synced_until = deadline.toISOString();

  debug('probing qianfan login status');
  const { loggedIn, account: qianfanAccount } = qianfanLoggedIn();
  debug(`qianfan login status: ${loggedIn === null ? 'unknown' : loggedIn}`);
  if (loggedIn === 'unavailable') {
    return fail(opts, {
      error: 'qianfan CLI could not be run',
      hint: 'install or upgrade the official qianfan CLI (see the baiducloud-qianfan Skill)',
    });
  }
  // Before touching qianfan, make sure it holds the same account as bce.
  if (loggedIn === true) {
    const mismatch = accountMismatch(payload.id_token, qianfanAccount);
    if (mismatch) {
      return fail(opts, mismatch, EXIT.accountMismatch);
    }
  }
  let action = loggedIn ? 'refresh-login' : 'login';
  debug(`selected action: ${action}${opts.dryRun ? ' (dry-run, will not execute)' : ''}`);
  if (debugEnabled) {
    debug(`command: qianfan auth internal ${action} (payload on stdin)`);
    debug(`stdin payload (masked): ${JSON.stringify(describePayload(payload))}`);
    debug(`id_token header/claims: ${JSON.stringify(describeIdToken(payload.id_token))}`);
  }
  if (opts.dryRun) {
    emit(opts, {
      success: true,
      dry_run: true,
      action,
      fields: Object.keys(payload),
      synced_until,
    });
    return EXIT.ok;
  }

  const body = JSON.stringify(payload);
  let result = runQianfan(['auth', 'internal', action], body, secrets);
  let inconsistent = false;
  if (!result.ok && result.code === 'ALREADY_LOGGED_IN' && action === 'login') {
    debug('login returned ALREADY_LOGGED_IN; falling back to refresh-login');
    action = 'refresh-login';
    result = runQianfan(['auth', 'internal', action], body, secrets);
    // login said "already logged in" but refresh-login found no login: the
    // qianfan state is inconsistent, so retrying login cannot help.
    inconsistent = !result.ok && result.code === 'CREDENTIAL_NOT_FOUND';
    if (inconsistent) {
      debug('refresh-login returned CREDENTIAL_NOT_FOUND after ALREADY_LOGGED_IN: inconsistent state');
    }
  } else if (!result.ok && result.code === 'CREDENTIAL_NOT_FOUND' && action === 'refresh-login') {
    // The login state vanished between the status probe and the call; start fresh.
    debug('refresh-login returned CREDENTIAL_NOT_FOUND; retrying with login');
    const retry = runQianfan(['auth', 'internal', 'login'], body, secrets);
    if (retry.ok || retry.code !== 'ALREADY_LOGGED_IN') {
      action = 'login';
      result = retry;
    } else {
      debug('login retry returned ALREADY_LOGGED_IN; keeping the original error');
      // refresh-login says "not logged in" while login says "already logged
      // in": qianfan's state is inconsistent and only a logout can clear it.
      inconsistent = true;
    }
  }
  debug(`final result: action=${action} ok=${result.ok}${result.ok ? '' : ` code=${result.code}`}`);
  if (result.ok) {
    emit(opts, {
      success: true,
      ...(opts.autoSynced ? { auto_synced: true } : {}),
      ...(refreshed ? { bce_refreshed: true } : {}),
      action,
      qianfan: parseJson(result.stdout),
      synced_until,
    });
    return EXIT.ok;
  }
  if (result.code === 'AGREEMENT_NOT_SIGNED') {
    // The login state was saved; the user only needs to sign the agreement.
    emit(opts, {
      success: true,
      ...(opts.autoSynced ? { auto_synced: true } : {}),
      ...(refreshed ? { bce_refreshed: true } : {}),
      action,
      agreement_not_signed: true,
      message: result.message,
      hint: 'open the agreement URL above to sign it; no re-login is needed',
      synced_until,
    });
    return EXIT.agreementNotSigned;
  }
  if (result.code === 'QIANFAN_UNAVAILABLE') {
    return fail(opts, {
      action,
      error: 'qianfan CLI could not be run',
      hint: 'install or upgrade the official qianfan CLI (see the baiducloud-qianfan Skill)',
    });
  }
  return fail(opts, {
    action,
    code: result.code,
    error: result.message,
    hint: inconsistent
      ? "the qianfan login state is inconsistent; confirm, run 'node sync_qianfan.mjs logout', then sync again"
      : HINTS[result.code] || result.qianfanHint,
  });
}

function doLogout(opts) {
  debug(`logout requested${opts.dryRun ? ' (dry-run)' : ''}`);
  if (opts.dryRun) {
    emit(opts, { success: true, dry_run: true, action: 'logout' });
    return EXIT.ok;
  }
  const result = runQianfan(['auth', 'internal', 'logout'], undefined, []);
  if (!result.ok) {
    return fail(opts, { action: 'logout', code: result.code, error: result.message });
  }
  emit(opts, { success: true, action: 'logout', qianfan: parseJson(result.stdout) });
  return EXIT.ok;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error) {
    const usage = 'usage: sync_qianfan.mjs <sync|check|logout> [--dry-run] [--format json|text] [--debug]';
    process.stderr.write(`${opts.error}\n${usage}\n`);
    return EXIT.usage;
  }
  debug(`command=${opts.command} dry_run=${opts.dryRun} format=${opts.format} `
    + `node=${process.version} platform=${process.platform} qianfan_bin=${qianfanBinary()}`);
  if (opts.command === 'check') {
    return doCheck(opts);
  }
  return opts.command === 'sync' ? doSync(opts) : doLogout(opts);
}

process.exit(main());
