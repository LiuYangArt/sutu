# PaintBoard Development Scripts
# Usage: .\dev.ps1 [command]

param(
    [Parameter(Position=0)]
    [ValidateSet("install", "dev", "build", "build-release", "test", "check", "lint", "format", "clean", "help")]
    [string]$Command = "help"
)

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $PSScriptRoot

function Write-Step($message) {
    Write-Host "[PaintBoard] $message" -ForegroundColor Cyan
}

function Write-Success($message) {
    Write-Host "[PaintBoard] $message" -ForegroundColor Green
}

function Write-Error($message) {
    Write-Host "[PaintBoard] ERROR: $message" -ForegroundColor Red
}

Push-Location $ProjectDir

try {
    switch ($Command) {
        "install" {
            Write-Step "Installing dependencies..."
            pnpm install
            if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
            Write-Success "Dependencies installed!"
        }

        "dev" {
            Write-Step "Starting development server..."
            pnpm tauri dev
        }

        "build" {
            Write-Step "Building project (debug)..."
            pnpm run build:dev
            if ($LASTEXITCODE -ne 0) { throw "Frontend build failed" }

            Push-Location src-tauri
            cargo build
            if ($LASTEXITCODE -ne 0) { throw "Rust build failed" }
            Pop-Location

            Write-Success "Build completed!"
        }

        "build-release" {
            Write-Step "Building project (release)..."
            pnpm run build:dev
            if ($LASTEXITCODE -ne 0) { throw "Frontend build failed" }

            Push-Location src-tauri
            cargo build --release
            if ($LASTEXITCODE -ne 0) { throw "Rust build failed" }
            Pop-Location

            Write-Success "Release build completed!"
            Write-Host "Output: src-tauri\target\release\" -ForegroundColor Yellow
        }

        "test" {
            Write-Step "Running frontend tests..."
            pnpm test
            if ($LASTEXITCODE -ne 0) { throw "Frontend tests failed" }

            Write-Step "Running Rust tests..."
            Push-Location src-tauri
            cargo test
            if ($LASTEXITCODE -ne 0) { throw "Rust tests failed" }
            Pop-Location

            Write-Success "All tests passed!"
        }

        "check" {
            Write-Step "Running TypeScript check..."
            pnpm typecheck
            if ($LASTEXITCODE -ne 0) { throw "TypeScript check failed" }

            Write-Step "Running ESLint..."
            pnpm lint
            if ($LASTEXITCODE -ne 0) { throw "ESLint failed" }

            Write-Step "Running Clippy..."
            Push-Location src-tauri
            cargo clippy -- -D warnings
            if ($LASTEXITCODE -ne 0) { throw "Clippy failed" }

            Write-Step "Running Rust tests..."
            cargo test
            if ($LASTEXITCODE -ne 0) { throw "Rust tests failed" }
            Pop-Location

            Write-Step "Running frontend tests..."
            pnpm test
            if ($LASTEXITCODE -ne 0) { throw "Frontend tests failed" }

            Write-Success "All checks passed!"
        }

        "lint" {
            Write-Step "Running linters..."
            pnpm lint
            Push-Location src-tauri
            cargo clippy -- -D warnings
            Pop-Location
        }

        "format" {
            Write-Step "Formatting code..."
            pnpm format
            Write-Success "Code formatted!"
        }

        "clean" {
            Write-Step "Cleaning build artifacts..."

            if (Test-Path "node_modules") {
                Remove-Item -Recurse -Force "node_modules"
            }
            if (Test-Path "dist") {
                Remove-Item -Recurse -Force "dist"
            }
            if (Test-Path "src-tauri\target") {
                Remove-Item -Recurse -Force "src-tauri\target"
            }

            Write-Success "Cleaned!"
        }

        "help" {
            Write-Host ""
            Write-Host "  PaintBoard Development Scripts" -ForegroundColor Cyan
            Write-Host "  ==============================" -ForegroundColor Cyan
            Write-Host ""
            Write-Host "  Usage: .\dev.ps1 [command]"
            Write-Host ""
            Write-Host "  Commands:"
            Write-Host "    install        " -NoNewline; Write-Host "Install all dependencies" -ForegroundColor Gray
            Write-Host "    dev            " -NoNewline; Write-Host "Start development server with hot reload" -ForegroundColor Gray
            Write-Host "    build          " -NoNewline; Write-Host "Build project (debug mode)" -ForegroundColor Gray
            Write-Host "    build-release  " -NoNewline; Write-Host "Build project (release, optimized)" -ForegroundColor Gray
            Write-Host "    test           " -NoNewline; Write-Host "Run all tests" -ForegroundColor Gray
            Write-Host "    check          " -NoNewline; Write-Host "Run all checks (typecheck, lint, test)" -ForegroundColor Gray
            Write-Host "    lint           " -NoNewline; Write-Host "Run linters only" -ForegroundColor Gray
            Write-Host "    format         " -NoNewline; Write-Host "Format all code" -ForegroundColor Gray
            Write-Host "    clean          " -NoNewline; Write-Host "Remove all build artifacts" -ForegroundColor Gray
            Write-Host ""
        }
    }
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}
finally {
    Pop-Location
}
