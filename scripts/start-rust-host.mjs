#!/usr/bin/env node

import { arch, cpus, hostname, platform } from 'node:os';
import { fileURLToPath } from 'node:url';

function readArg(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0) return process.argv[idx + 1];
  return undefined;
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
      match: ['m2-mini'],
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
const profile = autoProfile();

if (dispatcher) process.env.DISPATCHER_URL = dispatcher;
process.env.HOST_WORKERS = workers ?? String(profile.workers);
process.env.HOST_DISPLAY_NAME = name ?? profile.name;
process.env.ENGINE_RUNTIME_DEFAULT = runtime;

console.log(
  `[start-rust-host] ${process.env.HOST_DISPLAY_NAME} ` +
    `workers=${process.env.HOST_WORKERS} runtime=${runtime} ` +
    `dispatcher=${process.env.DISPATCHER_URL ?? 'ws://localhost:8765'} ` +
    `profile=${profile.source}`,
);

const hostEntryUrl = new URL('../cluster/host.ts', import.meta.url);
process.argv[1] = fileURLToPath(hostEntryUrl);
await import(hostEntryUrl.href);
