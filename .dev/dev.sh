#!/usr/bin/env bash
# Sutu development helper for macOS/Linux
# Usage:
#   ./.dev/dev.sh                # interactive menu
#   ./.dev/dev.sh <command>      # command mode

set -u

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR" || exit 1

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'
  C_CYAN=$'\033[36m'
  C_GREEN=$'\033[32m'
  C_RED=$'\033[31m'
  C_YELLOW=$'\033[33m'
else
  C_RESET=""
  C_CYAN=""
  C_GREEN=""
  C_RED=""
  C_YELLOW=""
fi

log_step() { printf "%s[Sutu] %s%s\n" "$C_CYAN" "$1" "$C_RESET"; }
log_ok() { printf "%s[Sutu] %s%s\n" "$C_GREEN" "$1" "$C_RESET"; }
log_warn() { printf "%s[Sutu] %s%s\n" "$C_YELLOW" "$1" "$C_RESET"; }
log_err() { printf "%s[Sutu] ERROR: %s%s\n" "$C_RED" "$1" "$C_RESET" >&2; }

pause_if_interactive() {
  if [[ -z "${1:-}" ]]; then
    printf "\nPress Enter to continue..."
    read -r _
  fi
}

run_cmd() {
  "$@"
  local ec=$?
  if [[ $ec -ne 0 ]]; then
    log_err "Command failed ($ec): $*"
    return $ec
  fi
  return 0
}

ensure_homebrew() {
  if command -v brew >/dev/null 2>&1; then
    return 0
  fi

  log_err "Homebrew is not installed."
  printf "Install it first:\n"
  printf '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n'
  return 1
}

ensure_xcode_clt() {
  if xcode-select -p >/dev/null 2>&1; then
    log_ok "Xcode Command Line Tools detected."
    return 0
  fi

  log_warn "Xcode Command Line Tools not found. Triggering installer..."
  xcode-select --install >/dev/null 2>&1 || true
  log_warn "Please complete the installer UI, then rerun this command."
  return 1
}

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    local node_version
    node_version="$(node -v)"
    log_ok "Node detected: ${node_version}"
    return 0
  fi

  ensure_homebrew || return 1
  log_step "Installing Node.js via Homebrew..."
  run_cmd brew install node || return 1
  log_ok "Node installed."
}

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    local pnpm_version
    pnpm_version="$(pnpm -v)"
    log_ok "pnpm detected: ${pnpm_version}"
    return 0
  fi

  if command -v corepack >/dev/null 2>&1; then
    log_step "Enabling pnpm via Corepack..."
    run_cmd corepack enable || return 1
    run_cmd corepack prepare pnpm@latest --activate || return 1
  else
    log_step "Corepack not found; installing pnpm globally via npm..."
    run_cmd npm install -g pnpm || return 1
  fi

  if ! command -v pnpm >/dev/null 2>&1; then
    log_err "pnpm install finished but command is still unavailable."
    log_warn "Try reopening terminal, then run again."
    return 1
  fi

  log_ok "pnpm installed: $(pnpm -v)"
}

ensure_rust() {
  if command -v rustc >/dev/null 2>&1 && command -v cargo >/dev/null 2>&1; then
    log_ok "Rust detected: $(rustc --version)"
    return 0
  fi

  ensure_homebrew || return 1

  if ! command -v rustup-init >/dev/null 2>&1; then
    log_step "Installing rustup-init via Homebrew..."
    run_cmd brew install rustup-init || return 1
  fi

  log_step "Running rustup-init (non-interactive)..."
  run_cmd rustup-init -y || return 1

  if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck disable=SC1090
    source "$HOME/.cargo/env"
  fi

  run_cmd rustup component add rustfmt clippy || return 1

  if ! command -v rustc >/dev/null 2>&1 || ! command -v cargo >/dev/null 2>&1; then
    log_err "Rust installed but rustc/cargo not found in PATH."
    log_warn "Run: source \$HOME/.cargo/env"
    return 1
  fi

  log_ok "Rust installed: $(rustc --version)"
}

install_toolchain() {
  log_step "Checking toolchain prerequisites..."
  ensure_xcode_clt || return 1
  ensure_node || return 1
  ensure_pnpm || return 1
  ensure_rust || return 1
  log_ok "Toolchain is ready."
}

install_deps() {
  if ! command -v pnpm >/dev/null 2>&1; then
    log_err "pnpm is missing. Run: ./.dev/dev.sh install-toolchain"
    return 1
  fi
  log_step "Installing project dependencies..."
  run_cmd pnpm install || return 1
  log_ok "Dependencies installed."
}

bootstrap() {
  install_toolchain || return 1
  install_deps || return 1
  log_ok "Bootstrap completed."
}

cmd_dev() {
  log_step "Starting development server..."
  run_cmd pnpm dev
}

cmd_build() {
  log_step "Building project (debug)..."
  run_cmd pnpm build:dev || return 1
  (
    cd src-tauri || exit 1
    run_cmd cargo build
  ) || return 1
  log_ok "Build completed."
}

cmd_build_release() {
  log_step "Building project (release)..."
  run_cmd pnpm build:dev || return 1
  (
    cd src-tauri || exit 1
    run_cmd cargo build --release
  ) || return 1
  log_ok "Release build completed."
}

cmd_test() {
  log_step "Running frontend tests..."
  run_cmd pnpm test || return 1
  log_step "Running Rust tests..."
  (
    cd src-tauri || exit 1
    run_cmd cargo test
  ) || return 1
  log_ok "All tests passed."
}

cmd_check() {
  log_step "Running typecheck..."
  run_cmd pnpm typecheck || return 1
  log_step "Running frontend lint..."
  run_cmd pnpm lint || return 1
  log_step "Running Rust clippy..."
  (
    cd src-tauri || exit 1
    run_cmd cargo clippy -- -D warnings
  ) || return 1
  log_step "Running Rust tests..."
  (
    cd src-tauri || exit 1
    run_cmd cargo test
  ) || return 1
  log_step "Running frontend tests..."
  run_cmd pnpm test || return 1
  log_ok "All checks passed."
}

cmd_lint() {
  log_step "Running linters..."
  run_cmd pnpm lint || return 1
  (
    cd src-tauri || exit 1
    run_cmd cargo clippy -- -D warnings
  ) || return 1
  log_ok "Lint passed."
}

cmd_format() {
  log_step "Formatting code..."
  run_cmd pnpm format || return 1
  log_ok "Formatting completed."
}

cmd_clean() {
  log_step "Cleaning build artifacts..."
  rm -rf node_modules dist src-tauri/target
  log_ok "Cleaned."
}

cmd_sync_icons() {
  log_step "Regenerating icon assets..."
  run_cmd pnpm sync:icons || return 1
  log_ok "Icon assets updated."
}

cmd_doctor() {
  printf "\nSutu Environment Doctor\n"
  printf "=======================\n"
  printf "Repo: %s\n" "$PROJECT_DIR"
  printf "OS:   %s\n" "$(uname -a)"

  if xcode-select -p >/dev/null 2>&1; then
    printf "xcode-select: %s\n" "$(xcode-select -p)"
  else
    printf "xcode-select: missing\n"
  fi

  if command -v brew >/dev/null 2>&1; then
    printf "brew: %s\n" "$(brew --version | head -n 1)"
  else
    printf "brew: missing\n"
  fi

  if command -v node >/dev/null 2>&1; then
    printf "node: %s\n" "$(node -v)"
  else
    printf "node: missing\n"
  fi

  if command -v pnpm >/dev/null 2>&1; then
    printf "pnpm: %s\n" "$(pnpm -v)"
  else
    printf "pnpm: missing\n"
  fi

  if command -v rustc >/dev/null 2>&1; then
    printf "rustc: %s\n" "$(rustc --version)"
  else
    printf "rustc: missing\n"
  fi

  if command -v cargo >/dev/null 2>&1; then
    printf "cargo: %s\n" "$(cargo --version)"
  else
    printf "cargo: missing\n"
  fi

  printf "\n"
}

show_help() {
  cat <<'EOF'
Sutu Development Scripts (macOS/Linux)
======================================

Usage:
  ./.dev/dev.sh                # interactive menu
  ./.dev/dev.sh <command>      # command mode

Commands:
  bootstrap          Install toolchain + install project dependencies
  install            Alias of bootstrap
  install-toolchain  Install/check: Xcode CLT, node, pnpm, rust
  install-deps       Install project dependencies (pnpm install)
  dev                Start development server
  build              Build project (debug)
  build-release      Build project (release)
  test               Run frontend + rust tests
  check              Run typecheck + lint + tests
  lint               Run linters
  format             Format code
  clean              Remove build artifacts
  sync-icons         Regenerate icon assets
  doctor             Print environment status
  help               Show this help
EOF
}

dispatch() {
  local cmd="${1:-}"
  case "$cmd" in
    bootstrap|install) bootstrap ;;
    install-toolchain) install_toolchain ;;
    install-deps) install_deps ;;
    dev) cmd_dev ;;
    build) cmd_build ;;
    build-release) cmd_build_release ;;
    test) cmd_test ;;
    check) cmd_check ;;
    lint) cmd_lint ;;
    format) cmd_format ;;
    clean) cmd_clean ;;
    sync-icons) cmd_sync_icons ;;
    doctor) cmd_doctor ;;
    help|"") show_help ;;
    *)
      log_err "Unknown command: $cmd"
      show_help
      return 1
      ;;
  esac
}

menu_loop() {
  while true; do
    clear
    cat <<'EOF'
============================================
     Sutu Development Menu (macOS/Linux)
============================================
[1] bootstrap        Install toolchain + dependencies
[2] install-toolchain
[3] install-deps
[4] dev              Start development server
[5] build            Build project (debug)
[6] build-release    Build project (release)
[7] test             Run tests
[8] check            Run all checks
[9] lint             Run linters
[10] format          Format code
[11] clean           Clean build artifacts
[12] sync-icons      Regenerate icon assets
[13] doctor          Environment status
[0] exit
EOF
    printf "\nEnter choice [0-13]: "
    read -r choice

    local cmd=""
    case "$choice" in
      1) cmd="bootstrap" ;;
      2) cmd="install-toolchain" ;;
      3) cmd="install-deps" ;;
      4) cmd="dev" ;;
      5) cmd="build" ;;
      6) cmd="build-release" ;;
      7) cmd="test" ;;
      8) cmd="check" ;;
      9) cmd="lint" ;;
      10) cmd="format" ;;
      11) cmd="clean" ;;
      12) cmd="sync-icons" ;;
      13) cmd="doctor" ;;
      0) break ;;
      *)
        printf "\nInvalid choice.\n"
        pause_if_interactive
        continue
        ;;
    esac

    printf "\n"
    dispatch "$cmd"
    local ec=$?
    if [[ $ec -ne 0 ]]; then
      log_err "Action failed: ${cmd}"
    fi
    pause_if_interactive
  done
}

main() {
  if [[ $# -eq 0 ]]; then
    menu_loop
  else
    dispatch "$1"
  fi
}

main "$@"
