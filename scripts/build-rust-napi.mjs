import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const crateDir = 'flight-engine-rs';
const profile = process.env.RUST_PROFILE === 'debug' ? 'debug' : 'release';
const cargoArgs = ['build', '--manifest-path', `${crateDir}/Cargo.toml`, '--lib', '--features', 'node-napi'];

if (profile === 'release') {
  cargoArgs.splice(1, 0, '--release');
}

const cargo = spawnSync('cargo', cargoArgs, { stdio: 'inherit' });
if (cargo.error) {
  console.error(`Failed to run cargo: ${cargo.error.message}`);
  console.error('Install Rust/Cargo or make sure cargo is on PATH, then retry.');
  process.exit(1);
}
if (cargo.status !== 0) {
  console.error(`Cargo build failed with exit code ${cargo.status ?? 'unknown'}.`);
  process.exit(cargo.status ?? 1);
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
const directSource = join(targetDir, 'deps', `${libPrefix}flight_engine.${libExt}`);
const fallbackSource = join(targetDir, `${libPrefix}flight_engine.${libExt}`);
const source = existsSync(directSource) ? directSource : fallbackSource;
const output = join(targetDir, 'flight_engine_napi.node');

if (!existsSync(source)) {
  throw new Error(`Rust native library was not produced: ${source}`);
}

mkdirSync(dirname(output), { recursive: true });
copyFileSync(source, output);
if (process.platform === 'darwin') {
  const installName = spawnSync('install_name_tool', [
    '-id',
    '@loader_path/flight_engine_napi.node',
    output,
  ], { stdio: 'inherit' });
  if (installName.error) {
    console.error(`Failed to run install_name_tool: ${installName.error.message}`);
    process.exit(1);
  }
  if (installName.status !== 0) {
    console.error(
      `install_name_tool failed with exit code ${installName.status ?? 'unknown'}.`,
    );
    process.exit(installName.status ?? 1);
  }
}
console.log(`Built ${basename(output)} from ${source}`);
