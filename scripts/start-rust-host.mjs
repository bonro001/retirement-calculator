#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { arch, cpus, hostname, platform } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const HOST_ENTRY = resolve(REPO_ROOT, 'cluster/host.ts');
const UPDATE_REQUEST_PATH = resolve(REPO_ROOT, '.cluster-update-request.json');
const AUTO_UPDATE_EXIT_CODE = 75;

function shortLocalTime() {
  return new Date().toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

const rawConsoleLog = console.log.bind(console);
const rawConsoleWarn = console.warn.bind(console);
const rawConsoleError = console.error.bind(console);
console.log = (...args) => rawConsoleLog(shortLocalTime(), ...args);
console.warn = (...args) => rawConsoleWarn(shortLocalTime(), ...args);
console.error = (...args) => rawConsoleError(shortLocalTime(), ...args);

function readArg(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0) return process.argv[idx + 1];
  return undefined;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function git(args, options = {}) {
  const res = spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (res.status !== 0) return null;
  return res.stdout.trim() || null;
}

function runStep(command, args) {
  const bin = process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command;
  console.log(`[start-rust-host] ${[command, ...args].join(' ')}`);
  const res = spawnSync(bin, args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if (res.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with ${res.status}`);
  }
}

function packageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function parseDirtyFiles(status) {
  if (!status) return [];
  return status
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.replace(/^[ MADRCU?!]{1,2}\s+/, '').trim())
    .filter(Boolean)
}

function buildInfo() {
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const trackedStatus = git(['status', '--porcelain', '--untracked-files=no']);
  const gitDirtyFiles = parseDirtyFiles(trackedStatus);
  return {
    packageVersion: packageVersion(),
    gitBranch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    gitCommit: git(['rev-parse', '--short=12', 'HEAD']),
    gitDirty: gitDirtyFiles.length > 0,
    gitDirtyFiles,
    gitUpstream: upstream,
    gitUpstreamCommit: upstream ? git(['rev-parse', '--short=12', '@{u}']) : null,
    source: git(['rev-parse', '--short=12', 'HEAD']) ? 'git' : 'unknown',
  };
}

function sameBuildCommit(a, b) {
  return Boolean(
    a?.gitCommit &&
      b?.gitCommit &&
      a.gitCommit === b.gitCommit &&
      a.packageVersion === b.packageVersion,
  );
}

/**
 * Query the dispatcher's HTTP status endpoint for its current build
 * info, including which branch it's running. Lets the launcher follow
 * the dispatcher across branches (e.g., dispatcher running on a
 * feature branch for testing — workers auto-checkout that branch
 * instead of getting stuck "needs update" forever). Returns null if
 * the dispatcher is unreachable, doesn't expose buildInfo, or the
 * URL isn't configured — the caller falls back to plain fast-forward
 * on the current branch.
 *
 * Uses curl (universally available on macOS, Linux, and Windows 10+)
 * so we don't need an async fetch in this otherwise-sync flow.
 */
function fetchDispatcherBranch() {
  const buildInfo = fetchDispatcherBuildInfo();
  const branch = buildInfo?.gitBranch;
  return typeof branch === 'string' && branch.length > 0 ? branch : null;
}

function fetchDispatcherBuildInfo() {
  const dispatcherUrl = process.env.DISPATCHER_URL;
  if (!dispatcherUrl) return null;
  const httpUrl = dispatcherUrl
    .replace(/^ws:\/\//, 'http://')
    .replace(/^wss:\/\//, 'https://')
    .replace(/\/$/, '');
  try {
    const res = spawnSync(
      'curl',
      ['-s', '--max-time', '5', `${httpUrl}/health`],
      { encoding: 'utf8' },
    );
    if (res.status !== 0) return null;
    const body = JSON.parse(res.stdout);
    return body?.buildInfo ?? null;
  } catch {
    return null;
  }
}

function deriveRepoGitUrl() {
  if (process.env.REPO_GIT_URL) return process.env.REPO_GIT_URL;
  const dispatcherUrl = process.env.DISPATCHER_URL;
  const match = dispatcherUrl?.match(/^wss?:\/\/([^:/]+)/);
  return match ? `git://${match[1]}/retirement-calculator` : null;
}

function ensureOriginRemote() {
  const repoGitUrl = deriveRepoGitUrl();
  if (!repoGitUrl) return;
  const currentOrigin = git(['remote', 'get-url', 'origin']);
  if (currentOrigin === repoGitUrl) return;
  if (currentOrigin) {
    runStep('git', ['remote', 'set-url', 'origin', repoGitUrl]);
  } else {
    runStep('git', ['remote', 'add', 'origin', repoGitUrl]);
  }
}

function readAndClearUpdateRequest() {
  try {
    const parsed = JSON.parse(readFileSync(UPDATE_REQUEST_PATH, 'utf8'));
    unlinkSync(UPDATE_REQUEST_PATH);
    const buildInfo = parsed?.expectedBuildInfo;
    if (!buildInfo || typeof buildInfo !== 'object') return null;
    return buildInfo;
  } catch {
    return null;
  }
}

/**
 * Try to bring the local checkout in sync with the dispatcher and
 * rebuild. Returns true when the working tree actually advanced.
 *
 * The dispatcher is authoritative. Each attempt derives the LAN git
 * URL from DISPATCHER_URL (unless REPO_GIT_URL overrides it), fetches
 * origin explicitly, then force-resets the local branch to
 * origin/<dispatcher-branch>. That makes auto-update self-healing even
 * when a worker's origin/upstream was stale, missing, or pointed at
 * GitHub from an older bootstrap.
 *
 * Branch names are validated against a strict regex before being
 * passed to git, so a malicious dispatcher (compromised or spoofed)
 * can't inject shell args.
 */
function updateIfBehind() {
  const before = buildInfo();
  const requestedBuildInfo = readAndClearUpdateRequest();
  ensureOriginRemote();

  runStep('git', ['fetch', '--prune', 'origin']);

  // Determine target branch: prefer dispatcher's, fall back to current.
  const dispatcherBranch = fetchDispatcherBranch();
  const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const requestedBranch =
    typeof requestedBuildInfo?.gitBranch === 'string'
      ? requestedBuildInfo.gitBranch
      : null;
  const targetBranch = requestedBranch ?? dispatcherBranch ?? currentBranch;
  if (!targetBranch) {
    console.log('[start-rust-host] auto-update skipped: no target branch');
    return false;
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(targetBranch)) {
    console.log(
      `[start-rust-host] auto-update skipped: dispatcher reports invalid branch '${targetBranch}'`,
    );
    return false;
  }
  const originRef = git(['rev-parse', '--verify', `refs/remotes/origin/${targetBranch}`]);
  if (!originRef) {
    console.log(
      `[start-rust-host] auto-update skipped: origin/${targetBranch} doesn't exist`,
    );
    return false;
  }
  const requestedCommit =
    typeof requestedBuildInfo?.gitCommit === 'string'
      ? requestedBuildInfo.gitCommit
      : null;
  if (requestedCommit && !originRef.startsWith(requestedCommit)) {
    console.log(
      `[start-rust-host] auto-update skipped: origin/${targetBranch}@${originRef.slice(0, 12)} ` +
        `does not match dispatcher command ${requestedCommit}`,
    );
    return false;
  }
  const local = git(['rev-parse', 'HEAD']);
  if (local === originRef && !before.gitDirty && currentBranch === targetBranch) {
    console.log('[start-rust-host] auto-update: already current');
    return false;
  }
  console.log(
    `[start-rust-host] resetting ${currentBranch ?? 'detached'} → ${targetBranch} to follow dispatcher`,
  );
  runStep('git', ['checkout', '-f', '-B', targetBranch, `origin/${targetBranch}`]);
  runStep('git', ['branch', '--set-upstream-to', `origin/${targetBranch}`, targetBranch]);

  // Prefer `npm ci` (strict, never modifies lockfile). Fall back to
  // `npm install` if the lockfile drifted out of sync with package.json
  // — `npm ci` would otherwise refuse and wedge the worker.
  try {
    runStep('npm', ['ci']);
  } catch (err) {
    console.warn(
      `[start-rust-host] npm ci failed (${err.message}); falling back to npm install`,
    );
    runStep('npm', ['install']);
  }
  // The build script handles the cargo-vs-prebuilt fallback internally:
  // workers with cargo compile from source and publish to prebuilt/;
  // workers without cargo copy the committed prebuilt binary into target/.
  runStep('npm', ['run', 'engine:rust:build:napi']);
  return true;
}

function normalize(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function autoProfile() {
  const host = hostname();
  const normalized = normalize(host);
  const known = [
    {
      match: ['mac-mini-upstairs'],
      name: 'local-rust-main',
      workers: 8,
    },
    {
      match: ['ath-4gpj6wkh'],
      name: 'node-host-ATH-4GPJ6WKH',
      workers: 12,
    },
    {
      match: ['desktop-lt718f9'],
      name: 'node-host-DESKTOP-LT718F9',
      workers: 12,
    },
    {
      match: ['m2-mini', 'robs-mac-mini'],
      name: 'm2-mini-host',
      workers: 6,
    },
  ];
  const hit = known.find((profile) =>
    profile.match.some((needle) => normalized.includes(needle)),
  );
  if (hit) return { ...hit, source: 'known-host' };
  const workers = Math.max(1, Math.min(12, cpus().length - 2));
  const prefix = platform() === 'darwin' && arch() === 'arm64'
    ? 'apple-host'
    : 'node-host';
  return {
    name: `${prefix}-${host}`,
    workers,
    source: 'auto-default',
  };
}

const dispatcher = readArg('dispatcher');
const workers = readArg('workers');
const name = readArg('name');
const runtime = readArg('runtime') ?? 'rust-native-compact';
const autoUpdate =
  hasFlag('auto-update') ||
  process.env.HOST_AUTO_UPDATE === '1' ||
  process.env.HOST_AUTO_UPDATE === 'true';
const dryRun = hasFlag('dry-run');
const profile = autoProfile();

if (dispatcher) process.env.DISPATCHER_URL = dispatcher;
process.env.HOST_WORKERS = workers ?? String(profile.workers);
process.env.HOST_DISPLAY_NAME = name ?? profile.name;
process.env.ENGINE_RUNTIME_DEFAULT = runtime;
process.env.HOST_AUTO_UPDATE = autoUpdate ? '1' : '0';
process.env.HOST_ACCEPT_UPDATE_CONTROL = autoUpdate ? '1' : '0';

console.log(
  `[start-rust-host] ${process.env.HOST_DISPLAY_NAME} ` +
    `workers=${process.env.HOST_WORKERS} runtime=${runtime} ` +
    `dispatcher=${process.env.DISPATCHER_URL ?? 'ws://localhost:8765'} ` +
    `profile=${profile.source} autoUpdate=${autoUpdate ? 'on' : 'off'}`,
);

if (dryRun) {
  refreshBuildEnv();
  console.log(`[start-rust-host] build=${process.env.HOST_BUILD_INFO_JSON}`);
  process.exit(0);
}

let child = null;
let shuttingDown = false;
let restartingForAutoUpdateRetry = false;
// Set when an auto-update attempt couldn't actually move the branch
// forward (already current, not fast-forwardable, dirty tree). Without
// this, the launcher would catch each AUTO_UPDATE_EXIT_CODE, no-op the
// pull, restart the host, the host would re-detect the same mismatch
// against the dispatcher, exit again, and we'd loop forever — observed
// 200+ rapid reconnects when a Windows host on a feature branch tried
// to auto-update against a `main`-expecting dispatcher.
let autoUpdateExhausted = false;
let autoUpdateExhaustedForCommit = null;
let autoUpdateExhaustedAtMs = 0;

const AUTO_UPDATE_RETRY_MS = Number.parseInt(
  process.env.HOST_AUTO_UPDATE_RETRY_MS ?? '60000',
  10,
);

function refreshBuildEnv() {
  process.env.HOST_BUILD_INFO_JSON = JSON.stringify(buildInfo());
}

function relaunchSupervisorAfterUpdate() {
  console.warn('[start-rust-host] relaunching supervisor from updated checkout');
  shuttingDown = true;
  const args = process.argv.slice(1);
  const next = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  next.on('error', (err) => {
    console.error('[start-rust-host] failed to relaunch supervisor', err);
    process.exit(1);
  });
  process.exit(0);
}

function startChild() {
  refreshBuildEnv();
  // Tell the host process to skip its own auto-update path once we
  // know the launcher can't fast-forward it. The host will keep
  // running until the dispatcher explicitly tells it to cycle again.
  if (autoUpdateExhausted) {
    process.env.HOST_AUTO_UPDATE = '0';
  } else {
    process.env.HOST_AUTO_UPDATE = autoUpdate ? '1' : '0';
  }
  process.env.HOST_ACCEPT_UPDATE_CONTROL = autoUpdate ? '1' : '0';
  child = spawn(process.execPath, ['--import', 'tsx', HOST_ENTRY], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      process.exit(code ?? (signal ? 1 : 0));
    }
    if (restartingForAutoUpdateRetry) {
      restartingForAutoUpdateRetry = false;
      startChild();
      return;
    }
    if (autoUpdate && code === AUTO_UPDATE_EXIT_CODE) {
      if (autoUpdateExhausted) {
        console.warn(
          '[start-rust-host] dispatcher requested update retry after previous exhaustion',
        );
        autoUpdateExhausted = false;
        autoUpdateExhaustedForCommit = null;
        autoUpdateExhaustedAtMs = 0;
      }
      let advanced = false;
      try {
        advanced = updateIfBehind();
      } catch (err) {
        console.error('[start-rust-host] auto-update failed', err);
      }
      if (!advanced) {
        const dispatcherBuildInfo = fetchDispatcherBuildInfo();
        const localBuildInfo = buildInfo();
        const localAlreadyAtDispatcherCommit = sameBuildCommit(
          dispatcherBuildInfo,
          localBuildInfo,
        );
        autoUpdateExhausted = true;
        autoUpdateExhaustedForCommit = dispatcherBuildInfo?.gitCommit ?? null;
        autoUpdateExhaustedAtMs = localAlreadyAtDispatcherCommit
          ? Number.POSITIVE_INFINITY
          : Date.now();
        if (localAlreadyAtDispatcherCommit) {
          console.warn(
            '[start-rust-host] auto-update reached dispatcher commit; ' +
              'dispatcher has local dirty edits, so keeping host-triggered ' +
              'auto-update disabled until the dispatcher commit changes.',
          );
        } else {
          console.warn(
            "[start-rust-host] auto-update can't catch up with the dispatcher — " +
              'continuing without host-triggered auto-update for now; the ' +
              'supervisor will retry periodically.',
          );
        }
      } else {
        relaunchSupervisorAfterUpdate();
        return;
      }
      startChild();
      return;
    }
    process.exit(code ?? (signal ? 1 : 0));
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shuttingDown = true;
    if (child && !child.killed) child.kill(signal);
    setTimeout(() => process.exit(signal === 'SIGINT' ? 130 : 143), 1500).unref();
  });
}

if (autoUpdate) {
  try {
    // Initial check before the first child spawn. Don't mark exhausted
    // here — the host might still be at-or-ahead of the dispatcher,
    // in which case mismatch is benign and never triggers an
    // auto-update request. The exhausted flag flips lazily, only
    // after the host actually requests an update we can't fulfill.
    if (updateIfBehind()) {
      relaunchSupervisorAfterUpdate();
    }
  } catch (err) {
    console.error('[start-rust-host] initial auto-update failed', err);
  }
}

startChild();

if (autoUpdate) {
  setInterval(() => {
    if (!autoUpdateExhausted || shuttingDown || restartingForAutoUpdateRetry) return;
    const dispatcherBuildInfo = fetchDispatcherBuildInfo();
    const dispatcherCommit = dispatcherBuildInfo?.gitCommit ?? null;
    const dispatcherChanged =
      dispatcherCommit &&
      autoUpdateExhaustedForCommit &&
      dispatcherCommit !== autoUpdateExhaustedForCommit;
    const retryElapsed =
      Number.isFinite(AUTO_UPDATE_RETRY_MS) &&
      AUTO_UPDATE_RETRY_MS > 0 &&
      Date.now() - autoUpdateExhaustedAtMs >= AUTO_UPDATE_RETRY_MS;
    if (!dispatcherChanged && !retryElapsed) return;
    console.warn('[start-rust-host] retrying previously exhausted auto-update', {
      dispatcherCommit,
      exhaustedForCommit: autoUpdateExhaustedForCommit,
      reason: dispatcherChanged ? 'dispatcher_changed' : 'retry_interval',
    });
    autoUpdateExhausted = false;
    autoUpdateExhaustedForCommit = null;
    autoUpdateExhaustedAtMs = 0;
    process.env.HOST_AUTO_UPDATE = autoUpdate ? '1' : '0';
    if (child && !child.killed) {
      restartingForAutoUpdateRetry = true;
      child.kill('SIGTERM');
    }
  }, 5_000).unref();
}
