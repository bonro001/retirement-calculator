#!/usr/bin/env node
// Print the branch the dispatcher reports it's running on, or "main"
// if the dispatcher is unreachable, doesn't expose buildInfo, or
// reports an invalid branch name.
//
// Used by the bootstrap scripts (start-host.sh, start-host.ps1) so a
// worker checks out the same branch as the dispatcher on first run,
// not just during in-flight auto-update. Without this, a worker on
// `main` couldn't bootstrap when the dispatcher (and its prebuilt
// napi binary) lived on a feature branch.

import { spawnSync } from 'node:child_process';

const FALLBACK = 'main';

function emit(branch) {
  console.log(branch);
  process.exit(0);
}

const dispatcherUrl = process.env.DISPATCHER_URL;
if (!dispatcherUrl) emit(FALLBACK);

const httpUrl = dispatcherUrl
  .replace(/^ws:\/\//, 'http://')
  .replace(/^wss:\/\//, 'https://')
  .replace(/\/$/, '');

const res = spawnSync('curl', ['-s', '--max-time', '5', `${httpUrl}/`], { encoding: 'utf8' });
if (res.status !== 0) emit(FALLBACK);

try {
  const branch = JSON.parse(res.stdout)?.buildInfo?.gitBranch;
  if (typeof branch === 'string' && /^[A-Za-z0-9._/-]+$/.test(branch)) {
    emit(branch);
  }
} catch {}
emit(FALLBACK);
