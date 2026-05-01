import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClusterBuildInfo, ClusterBuildStatus } from '../src/mining-protocol';

const REPO_ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

function parseDirtyFiles(status: string | null): string[] {
  if (!status) return [];
  return status
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.replace(/^[ MADRCU?!]{1,2}\s+/, '').trim())
    .filter(Boolean)
}

export function getLocalBuildInfo(): ClusterBuildInfo {
  const envJson = process.env.HOST_BUILD_INFO_JSON;
  if (envJson) {
    try {
      return JSON.parse(envJson) as ClusterBuildInfo;
    } catch {
      // Fall through to local detection.
    }
  }

  const gitCommit = git(['rev-parse', '--short=12', 'HEAD']);
  const gitBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const gitUpstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const gitUpstreamCommit = gitUpstream
    ? git(['rev-parse', '--short=12', '@{u}'])
    : null;
  const trackedStatus = git(['status', '--porcelain', '--untracked-files=no']);
  const gitDirtyFiles = parseDirtyFiles(trackedStatus);

  return {
    packageVersion: readPackageVersion(),
    gitBranch,
    gitCommit,
    gitDirty: gitDirtyFiles.length > 0,
    gitDirtyFiles,
    gitUpstream,
    gitUpstreamCommit,
    source: gitCommit ? 'git' : 'unknown',
  };
}

export function compareBuildInfo(
  expected: ClusterBuildInfo | undefined,
  actual: ClusterBuildInfo | undefined,
): ClusterBuildStatus {
  if (!expected?.gitCommit || !actual?.gitCommit) return 'unknown';
  if (expected.packageVersion !== actual.packageVersion) return 'mismatch';
  if (expected.gitCommit !== actual.gitCommit) return 'mismatch';
  if (expected.gitDirty || actual.gitDirty) return 'dirty';
  return 'match';
}

export function formatBuildInfo(info: ClusterBuildInfo | undefined): string {
  if (!info) return 'unknown';
  const commit = info.gitCommit ?? 'no-git';
  const branch = info.gitBranch ?? 'detached';
  return `${branch}@${commit}${info.gitDirty ? '+dirty' : ''}`;
}
