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
if (cargo.status !== 0) {
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
const source = join(targetDir, `${libPrefix}flight_engine.${libExt}`);
const output = join(targetDir, 'flight_engine_napi.node');

if (!existsSync(source)) {
  throw new Error(`Rust native library was not produced: ${source}`);
}

mkdirSync(dirname(output), { recursive: true });
copyFileSync(source, output);
console.log(`Built ${basename(output)} from ${source}`);
