import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { request as httpsRequest } from 'node:https';

const crateDir = 'flight-engine-rs';
const profile = process.env.RUST_PROFILE === 'debug' ? 'debug' : 'release';
const cargoArgs = ['build', '--manifest-path', `${crateDir}/Cargo.toml`, '--lib', '--features', 'node-napi'];

if (profile === 'release') {
  cargoArgs.splice(1, 0, '--release');
}

const extByPlatform = {
  darwin: 'dylib',
  linux: 'so',
  win32: 'dll',
};
const libPrefix = process.platform === 'win32' ? '' : 'lib';
const libExt = extByPlatform[process.platform];
if (!libExt) {
  throw new Error(`Unsupported native addon platform: ${process.platform}`);
}

const targetDir = join(crateDir, 'target', profile);
const output = join(targetDir, 'flight_engine_napi.node');
const platArchDir = `${process.platform}-${process.arch}`;
const prebuiltDir = join(crateDir, 'prebuilt', platArchDir);
const prebuiltPath = join(prebuiltDir, 'flight_engine_napi.node');

const cargoCheck = spawnSync('cargo', ['--version'], { stdio: 'ignore' });
const hasCargo = cargoCheck.status === 0;

if (hasCargo) {
  await buildFromSource();
  // Only publish prebuilt to the committed location when explicitly
  // requested (PUBLISH_PREBUILT=1). Auto-publishing on every build
  // dirtied the worker's tree (release builds aren't byte-deterministic),
  // and that dirty status caused workers to loop through auto-update.
  // After a Rust change, the operator runs `PUBLISH_PREBUILT=1 npm run
  // engine:rust:build:napi` once on a cargo Mac, then commits + pushes.
  if (process.env.PUBLISH_PREBUILT === '1') {
    publishPrebuilt();
  }
} else if (existsSync(prebuiltPath)) {
  usePrebuilt();
} else {
  console.error(
    `[build-rust-napi] cargo not found on PATH and no prebuilt binary at ${prebuiltPath}. ` +
      `Either install rustup (https://sh.rustup.rs) or commit a prebuilt binary for ${platArchDir} ` +
      `from a cargo-equipped worker: PUBLISH_PREBUILT=1 npm run engine:rust:build:napi, then commit ${prebuiltDir}.`,
  );
  process.exit(1);
}

async function buildFromSource() {
  // Per-platform pre-step. Windows is the only platform that needs one:
  // flight-engine-rs/build.rs links against `node.lib`, which is an
  // import library for the running Node binary's exported symbols.
  // Node ships it under https://nodejs.org/dist/v<VERSION>/<arch>/node.lib
  // — we download it once per (version, arch), cache in the user's home
  // dir, and tell cargo where to find it via RUSTFLAGS.
  const cargoEnv = { ...process.env };
  if (process.platform === 'win32') {
    const nodeLibDir = await ensureNodeLib();
    const existingFlags = cargoEnv.RUSTFLAGS ? `${cargoEnv.RUSTFLAGS} ` : '';
    cargoEnv.RUSTFLAGS = `${existingFlags}-L native=${nodeLibDir}`;
    console.log(`[build-rust-napi] using node.lib from ${nodeLibDir}`);
  }

  const cargo = spawnSync('cargo', cargoArgs, { stdio: 'inherit', env: cargoEnv });
  if (cargo.status !== 0) process.exit(cargo.status ?? 1);

  const source = join(targetDir, `${libPrefix}flight_engine.${libExt}`);
  if (!existsSync(source)) {
    throw new Error(`Rust native library was not produced: ${source}`);
  }
  mkdirSync(dirname(output), { recursive: true });
  copyFileSync(source, output);
  console.log(`Built ${basename(output)} from ${source}`);
}

function publishPrebuilt() {
  // After every successful local build, refresh the committed prebuilt
  // binary for this (platform, arch) so cargo-less workers (locked-down
  // boxes) pick it up on their next git pull. Operator must `git add` +
  // commit the result; release-build outputs aren't byte-deterministic
  // so a no-op commit may appear when two cargo-equipped workers both
  // rebuild — that's fine, just discard the diff if you didn't intend
  // to publish.
  mkdirSync(prebuiltDir, { recursive: true });
  copyFileSync(output, prebuiltPath);
  console.log(`[build-rust-napi] published prebuilt → ${prebuiltPath}`);
}

function usePrebuilt() {
  // Cargo-less worker (e.g. locked-down Mac): copy the committed
  // prebuilt binary into the path the loader expects.
  mkdirSync(dirname(output), { recursive: true });
  copyFileSync(prebuiltPath, output);
  console.log(`[build-rust-napi] using prebuilt ${prebuiltPath} → ${output}`);
}

// ---------------------------------------------------------------------------
// Windows-only helpers
// ---------------------------------------------------------------------------

/**
 * Download (and cache) the Node import library that matches the running
 * Node binary's version + arch. Returns the directory containing
 * `node.lib`, ready to be added to cargo's library search path.
 *
 * Cached at `~/.flight-engine-rs/node-lib/v<version>-<arch>/node.lib` so
 * subsequent builds skip the download. The file is small (~700 KB) and
 * Node's CDN is fast, so even cold downloads take a second or two.
 */
async function ensureNodeLib() {
  const version = process.versions.node;
  const archDir = process.arch === 'arm64' ? 'win-arm64' : 'win-x64';
  const cacheDir = join(homedir(), '.flight-engine-rs', 'node-lib', `v${version}-${archDir}`);
  const cachePath = join(cacheDir, 'node.lib');

  if (existsSync(cachePath)) {
    return cacheDir;
  }

  mkdirSync(cacheDir, { recursive: true });
  const url = `https://nodejs.org/dist/v${version}/${archDir}/node.lib`;
  console.log(`[build-rust-napi] downloading ${url}`);
  await downloadFile(url, cachePath);
  return cacheDir;
}

/**
 * Minimal HTTPS download with redirect support. Buffers the response
 * in memory (node.lib is < 1 MB) and writes once on completion to
 * avoid leaving a partial file on disk if the connection drops.
 */
function downloadFile(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, (res) => {
      const status = res.statusCode ?? 0;
      if (status === 301 || status === 302 || status === 307 || status === 308) {
        if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects fetching ${url}`));
          return;
        }
        const next = res.headers.location;
        if (!next) {
          reject(new Error(`Redirect from ${url} missing Location header`));
          return;
        }
        downloadFile(next, destPath, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        reject(new Error(`Failed to download ${url}: HTTP ${status}`));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          writeFileSync(destPath, Buffer.concat(chunks));
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}
