<#
.SYNOPSIS
Worker setup + start script for Windows cluster hosts.

.DESCRIPTION
Idempotent. Safe to re-run any time to bring this host current with
main, rebuild Rust, and (re)start the host process. Replaces the
multi-line copy-paste dance and encodes the lessons learned:
  - Use `npm ci` instead of `npm install` so the lockfile stays
    clean (otherwise the cluster panel shows
    "modified · package-lock.json").
  - Set up Git Credential Manager so auto-update's git pull
    doesn't prompt for a token on every fire.
  - Hard-reset to origin/main to survive divergence (host stuck on
    a feature branch, dirty tracked files from a prior failed setup).
  - Stop-Process anything already running before relaunching.

Prerequisites — install once if missing:
  - Git for Windows (https://git-scm.com/download/win) — ships GCM by default.
  - Node.js LTS (https://nodejs.org/en/download).
  - Rust toolchain (one-time):
      Invoke-WebRequest -Uri "https://win.rustup.rs/x86_64" -OutFile "$env:TEMP\rustup-init.exe"
      Start-Process -FilePath "$env:TEMP\rustup-init.exe" -ArgumentList "-y --default-toolchain stable" -Wait
  - MSVC Build Tools (one-time, for the Rust napi link step):
      winget install --id Microsoft.VisualStudio.2022.BuildTools --silent --override `
        "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  After the toolchain installs, close and reopen PowerShell so PATH picks them up.

.PARAMETER RepoDir
Where the repo lives. Defaults to $HOME\retirement-calculator.

.PARAMETER DispatcherUrl
ws://host:port URL. Defaults to ws://192.168.68.101:8765.

.PARAMETER DisplayName
Panel label. Defaults to node-host-$env:COMPUTERNAME.
#>

[CmdletBinding()]
param(
    [string]$RepoDir = "$HOME\retirement-calculator",
    [string]$DispatcherUrl = "ws://192.168.68.101:8765",
    [string]$DisplayName = "node-host-$env:COMPUTERNAME"
)

$ErrorActionPreference = "Stop"

Write-Host "[start-host] dispatcher: $DispatcherUrl"
Write-Host "[start-host] display name: $DisplayName"
Write-Host "[start-host] repo: $RepoDir"

# Stop anything currently running so the relaunch lands cleanly.
Stop-Process -Name node -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# Clone if the repo isn't already there.
if (-not (Test-Path $RepoDir)) {
    Write-Host "[start-host] cloning repo into $RepoDir"
    git clone https://github.com/bonro001/retirement-calculator.git $RepoDir
}

Set-Location $RepoDir

# Idempotent Git Credential Manager setup. After the first git pull
# prompts (browser-based GitHub sign-in), the credential is stored in
# Windows Credential Manager and never re-prompts.
git config --global credential.helper manager

# Hard-reset to origin/main so we survive any prior divergence:
#   - dirty working tree (npm install bumped package-lock.json)
#   - host stuck on a feature branch
#   - partial state from an earlier failed run
git fetch origin
git checkout main 2>$null
if ($LASTEXITCODE -ne 0) {
    git checkout -b main origin/main
}
git reset --hard origin/main

# `npm ci` installs strictly from the lockfile and never modifies it,
# so the cluster panel won't show "modified · package-lock.json".
npm ci

# Rebuild the Rust napi. On first run, the build script downloads
# node.lib (~700 KB) for delay-loading and caches it in
# %USERPROFILE%\.flight-engine-rs\node-lib\. Cold compile takes
# 5-10 minutes; subsequent runs are fast incremental.
npm run engine:rust:build:napi

# Start the host with auto-update enabled. The launcher will check
# main on every welcome / start_session and self-update if behind.
Write-Host "[start-host] launching with auto-update enabled"
$env:DISPATCHER_URL = $DispatcherUrl
$env:HOST_DISPLAY_NAME = $DisplayName
$env:HOST_AUTO_UPDATE = "1"
npm run cluster:host:rust-auto
