$ErrorActionPreference = "Stop"

function Invoke-Step {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Title,
        [Parameter(Mandatory = $true)]
        [scriptblock]$Action
    )

    Write-Host ""
    Write-Host "--------------------------------------------------------"
    Write-Host $Title
    Write-Host "--------------------------------------------------------"

    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "Step failed: $Title"
    }
}

function Assert-Command {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $Name"
    }
}

function Assert-MacTreeMissingWindowsDeps {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TreePath
    )

    $blockedDeps = @("wintab_lite", "libloading")
    $badLines = @()

    foreach ($dep in $blockedDeps) {
        $matches = Select-String -Path $TreePath -Pattern ("{0} v" -f [regex]::Escape($dep))
        if ($matches) {
            $badLines += $matches
        }
    }

    if ($badLines.Count -gt 0) {
        Write-Host "[FAIL] macOS dependency tree contains Windows-only dependencies:"
        $badLines | ForEach-Object { Write-Host ("  " + $_.Line) }
        throw "Found Windows-only dependencies in macOS dependency tree."
    }
}

function Assert-MacTreeHasRequiredCommonDeps {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TreePath
    )

    $requiredDeps = @("base64", "quick-xml", "image", "byteorder", "zip", "tiff", "dirs", "sha2", "hex")
    $missing = @()

    foreach ($dep in $requiredDeps) {
        $present = Select-String -Path $TreePath -Pattern ("{0} v" -f [regex]::Escape($dep)) -Quiet
        if (-not $present) {
            $missing += $dep
        }
    }

    if ($missing.Count -gt 0) {
        Write-Host ("[FAIL] Missing common dependencies in macOS tree: {0}" -f ($missing -join ", "))
        throw "Required common dependencies are missing in macOS dependency tree."
    }
}

try {
    Assert-Command cargo

    Invoke-Step -Title "[1/4] Cargo host check" -Action {
        cargo check --manifest-path src-tauri/Cargo.toml
    }

    $macTreePath = Join-Path $env:TEMP "paintboard-mac-tree-precheck.txt"
    Invoke-Step -Title "[2/4] Build macOS dependency tree" -Action {
        cargo tree --manifest-path src-tauri/Cargo.toml --target aarch64-apple-darwin > $macTreePath
    }

    Invoke-Step -Title "[3/4] Ensure macOS tree excludes Windows-only deps" -Action {
        Assert-MacTreeMissingWindowsDeps -TreePath $macTreePath
    }

    Invoke-Step -Title "[4/4] Ensure macOS tree includes common deps" -Action {
        Assert-MacTreeHasRequiredCommonDeps -TreePath $macTreePath
    }

    Write-Host ""
    Write-Host "========================================================"
    Write-Host "Pre-release checks passed."
    Write-Host "========================================================"
    exit 0
}
catch {
    Write-Host ""
    Write-Host "========================================================"
    Write-Host ("Pre-release checks failed: {0}" -f $_.Exception.Message)
    Write-Host "========================================================"
    exit 1
}
