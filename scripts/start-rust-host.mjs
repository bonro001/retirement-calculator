#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { arch, cpus, hostname, platform } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const HOST_ENTRY = resolve(REPO_ROOT, 'cluster/host.ts');
const AUTO_UPDATE_EXIT_CODE = 75;

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

function gitOk(args) {
  const res = spawnSync('git', args, {
    cwd: REPO_ROOT,
    stdio: 'ignore',
    env: process.env,
  });
  return res.status === 0;
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

function stashDirtyTrackedFiles(reason) {
  const info = buildInfo();
  if (!info.gitDirty) return false;
  runStep('git', [
    'stash',
    'push',
    '-m',
    `start-rust-host autostash: ${reason}`,
  ]);
  return true;
}

function restoreAutostash(didStash) {
  if (!didStash) return;
  runStep('git', ['stash', 'pop']);
}

function switchToBranch(targetBranch, remote, autostash) {
  if (!targetBranch) return;
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current === targetBranch) return;

  const before = buildInfo();
  if (before.gitDirty && !autostash) {
    console.log(
      `[start-rust-host] auto-update skipped: cannot switch to ${targetBranch}; ` +
        `local tracked files are dirty (${(before.gitDirtyFiles ?? []).join(', ') || 'unknown files'})`,
    );
    return;
  }

  const didStash = stashDirtyTrackedFiles(`switch ${current ?? 'unknown'} -> ${targetBranch}`);
  try {
    const localExists = gitOk(['show-ref', '--verify', `refs/heads/${targetBranch}`]);
    const remoteRef = `${remote}/${targetBranch}`;
    if (localExists) {
      runStep('git', ['switch', targetBranch]);
    } else if (gitOk(['show-ref', '--verify', `refs/remotes/${remoteRef}`])) {
      runStep('git', ['switch', '--track', '-c', targetBranch, remoteRef]);
    } else {
      console.log(`[start-rust-host] auto-update skipped: ${remoteRef} not found`);
    }
  } finally {
    restoreAutostash(didStash);
  }
}

function updateIfBehind({ targetBranch, remote, autostash }) {
  if (targetBranch) {
    runStep('git', ['fetch', '--prune', remote]);
    switchToBranch(targetBranch, remote, autostash);
  }

  const before = buildInfo();
  if (!before.gitUpstream) {
    console.log('[start-rust-host] auto-update skipped: no upstream branch');
    return;
  }
  if (before.gitDirty) {
    if (!autostash) {
      console.log(
        `[start-rust-host] auto-update skipped: local tracked files are dirty ` +
          `(${(before.gitDirtyFiles ?? []).join(', ') || 'unknown files'})`,
      );
      return;
    }
  }

  const didStash = stashDirtyTrackedFiles('pull');
  try {
    runStep('git', ['fetch', '--prune']);
    const local = git(['rev-parse', 'HEAD']);
    const upstream = git(['rev-parse', '@{u}']);
    if (!local || !upstream || local === upstream) {
      console.log('[start-rust-host] auto-update: already current');
      return;
    }
    const base = git(['merge-base', 'HEAD', '@{u}']);
    if (base !== local) {
      console.log('[start-rust-host] auto-update skipped: branch is not fast-forwardable');
      return;
    }
    runStep('git', ['pull', '--ff-only']);
    runStep('npm', ['install']);
    runStep('npm', ['run', 'engine:rust:build:napi']);
  } finally {
    restoreAutostash(didStash);
  }
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
const updateBranch = readArg('branch') ?? process.env.HOST_AUTO_UPDATE_BRANCH;
const updateRemote = readArg('remote') ?? process.env.HOST_AUTO_UPDATE_REMOTE ?? 'origin';
const autostash =
  hasFlag('autostash') ||
  process.env.HOST_AUTO_UPDATE_AUTOSTASH === '1' ||
  process.env.HOST_AUTO_UPDATE_AUTOSTASH === 'true';
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
if (updateBranch) process.env.HOST_AUTO_UPDATE_BRANCH = updateBranch;
process.env.HOST_AUTO_UPDATE_REMOTE = updateRemote;
process.env.HOST_AUTO_UPDATE_AUTOSTASH = autostash ? '1' : '0';

console.log(
  `[start-rust-host] ${process.env.HOST_DISPLAY_NAME} ` +
    `workers=${process.env.HOST_WORKERS} runtime=${runtime} ` +
    `dispatcher=${process.env.DISPATCHER_URL ?? 'ws://localhost:8765'} ` +
    `profile=${profile.source} autoUpdate=${autoUpdate ? 'on' : 'off'} ` +
    `branch=${updateBranch ?? '(current)'} remote=${updateRemote} ` +
    `autostash=${autostash ? 'on' : 'off'}`,
);

if (dryRun) {
  refreshBuildEnv();
  console.log(`[start-rust-host] build=${process.env.HOST_BUILD_INFO_JSON}`);
  process.exit(0);
}

let child = null;
let shuttingDown = false;

function refreshBuildEnv() {
  process.env.HOST_BUILD_INFO_JSON = JSON.stringify(buildInfo());
}

function startChild() {
  refreshBuildEnv();
  child = spawn(process.execPath, ['--import', 'tsx', HOST_ENTRY], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      process.exit(code ?? (signal ? 1 : 0));
    }
    if (autoUpdate && code === AUTO_UPDATE_EXIT_CODE) {
      try {
        updateIfBehind({ targetBranch: updateBranch, remote: updateRemote, autostash });
      } catch (err) {
        console.error('[start-rust-host] auto-update failed', err);
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
    updateIfBehind({ targetBranch: updateBranch, remote: updateRemote, autostash });
  } catch (err) {
    console.error('[start-rust-host] initial auto-update failed', err);
  }
}

startChild();
