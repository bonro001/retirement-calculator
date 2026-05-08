<#
.SYNOPSIS
Run the GPU backend POC benchmark matrix on a Windows AMD host.

.DESCRIPTION
This script is intentionally separate from the cluster worker. The worker
process receives policy-mining batches from the dispatcher; it is not a
general remote command runner. Start this script in a second PowerShell on
the Windows machine to collect AMD `wgpu` numbers without stopping the host.

By default, it updates the repo first:
  - clone if RepoDir is missing and RepoGitUrl is provided
  - fetch origin
  - follow the dispatcher's branch when DispatcherUrl is reachable
  - hard-reset the local branch to origin/<branch>
  - npm ci unless skipped

Results are written to out/gpu-poc-amd/<timestamp>/.
#>

[CmdletBinding()]
param(
    [string]$RepoDir = "$HOME\retirement-calculator",
    [string]$DispatcherUrl = "ws://192.168.68.101:8765",
    [string]$RepoGitUrl = "",
    [string]$Branch = "",
    [string]$OutDir = "",
    [int]$Policies = 5000,
    [int]$Trials = 5000,
    [int[]]$WorkgroupSizes = @(64, 128, 256),
    [string[]]$Backends = @("vulkan", "dx12"),
    [switch]$SkipUpdate,
    [switch]$SkipInstall,
    [switch]$SkipBuild
)

# Native commands like `cargo` and `git` write normal progress to stderr.
# In Windows PowerShell, ErrorActionPreference=Stop can turn that progress
# into a terminating NativeCommandError even when the native exit code is 0.
# Keep native stderr as output and gate success with $LASTEXITCODE instead.
$ErrorActionPreference = "Continue"

function Write-Step {
    param([string]$Message)
    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$stamp] $Message"
}

function Invoke-Logged {
    param(
        [string]$Label,
        [string]$LogPath,
        [scriptblock]$Command
    )
    Write-Step $Label
    "[$(Get-Date -Format o)] $Label" | Tee-Object -FilePath $LogPath
    & $Command 2>&1 | Tee-Object -FilePath $LogPath -Append
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE. See $LogPath"
    }
}

if (-not $RepoGitUrl) {
    if ($DispatcherUrl -match '^wss?://([^:/]+)') {
        $RepoGitUrl = "git://$($Matches[1])/retirement-calculator"
    } else {
        $RepoGitUrl = "https://github.com/bonro001/retirement-calculator.git"
    }
}

if (-not $SkipUpdate -and -not (Test-Path $RepoDir)) {
    Write-Step "cloning repo into $RepoDir from $RepoGitUrl"
    git clone $RepoGitUrl $RepoDir
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Set-Location $RepoDir

if (-not $SkipUpdate) {
    Write-Step "updating repo from $RepoGitUrl"
    git config --global credential.helper manager
    git remote set-url origin $RepoGitUrl
    git fetch origin
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    if (-not $Branch) {
        $env:DISPATCHER_URL = $DispatcherUrl
        $Branch = (node scripts/dispatcher-branch.mjs 2>$null)
        if (-not $Branch) { $Branch = "main" }
    }

    Write-Step "target branch: $Branch"
    git checkout -f -B $Branch "origin/$Branch"
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    if (-not $SkipInstall) {
        Write-Step "npm ci"
        npm ci
        if ($LASTEXITCODE -ne 0) {
            Write-Step "npm ci failed; falling back to npm install"
            npm install
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        }
    }
}

if (-not $OutDir) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $OutDir = Join-Path $RepoDir "out\gpu-poc-amd\$stamp"
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Step "repo: $RepoDir"
Write-Step "out: $OutDir"
Write-Step "dispatcher: $DispatcherUrl"
Write-Step "git source: $RepoGitUrl"
Write-Step "branch: $(if ($Branch) { $Branch } else { '(unchanged)' })"
Write-Step "policies: $Policies trials: $Trials"
Write-Step "backends: $($Backends -join ', ')"
Write-Step "workgroup sizes: $($WorkgroupSizes -join ', ')"

if (-not $SkipBuild) {
    Invoke-Logged `
        -Label "cargo build gpu_poc release" `
        -LogPath (Join-Path $OutDir "build.log") `
        -Command {
            cargo build --release --manifest-path flight-engine-rs\Cargo.toml --bin gpu_poc
        }
}

$summaryPath = Join-Path $OutDir "summary.txt"
"GPU POC AMD run $(Get-Date -Format o)" | Set-Content $summaryPath
"repo=$RepoDir" | Add-Content $summaryPath
"policies=$Policies trials=$Trials" | Add-Content $summaryPath
"" | Add-Content $summaryPath

foreach ($backend in $Backends) {
    $env:WGPU_BACKEND = $backend
    Write-Step "backend: $backend"

    $stage0Log = Join-Path $OutDir "$backend-stage0-wg256.log"
    Invoke-Logged `
        -Label "$backend stage0 wg256" `
        -LogPath $stage0Log `
        -Command {
            cargo run --release --manifest-path flight-engine-rs\Cargo.toml --bin gpu_poc -- stage0 --items 1000000 --inner-iters 1000 --workgroup-size 256
        }
    Get-Content $stage0Log | Select-String "gpu_poc adapter|gpu_poc result|cpu_ms=|parity" | ForEach-Object {
        "[$backend stage0 wg256] $($_.Line)" | Add-Content $summaryPath
    }

    foreach ($stage in @("stage1", "stage2")) {
        $log = Join-Path $OutDir "$backend-$stage-wg256.log"
        Invoke-Logged `
            -Label "$backend $stage wg256" `
            -LogPath $log `
            -Command {
                cargo run --release --manifest-path flight-engine-rs\Cargo.toml --bin gpu_poc -- $stage --policies $Policies --trials $Trials --workgroup-size 256
            }
        Get-Content $log | Select-String "gpu_poc adapter|gpu_poc result|cpu_ms=|ending_wealth_parity|summary_parity" | ForEach-Object {
            "[$backend $stage wg256] $($_.Line)" | Add-Content $summaryPath
        }
    }

    foreach ($workgroupSize in $WorkgroupSizes) {
        $log = Join-Path $OutDir "$backend-stage1-wg$workgroupSize.log"
        Invoke-Logged `
            -Label "$backend stage1 wg$workgroupSize" `
            -LogPath $log `
            -Command {
                cargo run --release --manifest-path flight-engine-rs\Cargo.toml --bin gpu_poc -- stage1 --policies $Policies --trials $Trials --workgroup-size $workgroupSize
            }
        Get-Content $log | Select-String "gpu_poc result|cpu_ms=|ending_wealth_parity|summary_parity" | ForEach-Object {
            "[$backend stage1 wg$workgroupSize] $($_.Line)" | Add-Content $summaryPath
        }
    }

    "" | Add-Content $summaryPath
}

Remove-Item Env:\WGPU_BACKEND -ErrorAction SilentlyContinue

Write-Step "done"
Write-Host ""
Write-Host "Summary:"
Get-Content $summaryPath
Write-Host ""
Write-Host "Full logs: $OutDir"
