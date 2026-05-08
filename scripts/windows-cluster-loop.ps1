param(
  [ValidateSet("dispatcher", "host", "web")]
  [string]$Role = "host",

  [string]$DispatcherUrl = "ws://127.0.0.1:8765",

  [switch]$Pull,
  [switch]$SkipInstall,
  [switch]$SkipBuild,

  [int]$RestartDelaySeconds = 10
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
Set-Location $RepoRoot

function Write-LoopLog {
  param([string]$Message)
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Write-Host "[$stamp] $Message"
}

function Invoke-Checked {
  param(
    [string]$Label,
    [scriptblock]$Command
  )
  Write-LoopLog $Label
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE"
  }
}

function Sync-And-Build {
  if ($Pull) {
    Invoke-Checked "git pull --ff-only" { git pull --ff-only }
  }

  if (-not $SkipInstall) {
    Invoke-Checked "npm install" { npm install }
  }

  if (-not $SkipBuild) {
    Invoke-Checked "npm run build" { npm run build }
  }
}

function Start-Role {
  switch ($Role) {
    "dispatcher" {
      Write-LoopLog "starting dispatcher"
      npm run cluster:dispatcher
      break
    }
    "host" {
      $env:DISPATCHER_URL = $DispatcherUrl
      $env:HOST_AUTO_UPDATE = "1"
      $env:HOST_ACCEPT_UPDATE_CONTROL = "1"
      Write-LoopLog "starting auto-updating host against $env:DISPATCHER_URL"
      npm run cluster:host:rust-auto
      break
    }
    "web" {
      Write-LoopLog "starting web app on 0.0.0.0"
      npm run dev -- --host 0.0.0.0
      break
    }
  }
}

Write-LoopLog "repo: $RepoRoot"
Write-LoopLog "role: $Role"
Write-LoopLog "press Ctrl+C to stop"

while ($true) {
  try {
    Sync-And-Build
    Start-Role
    Write-LoopLog "$Role exited with code $LASTEXITCODE"
  } catch {
    Write-LoopLog "ERROR: $($_.Exception.Message)"
  }

  Write-LoopLog "restarting in $RestartDelaySeconds seconds..."
  Start-Sleep -Seconds $RestartDelaySeconds
}
