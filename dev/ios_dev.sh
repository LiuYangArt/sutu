#!/usr/bin/env bash
# Sutu iOS development helper for macOS
# Usage:
#   ./dev/ios_dev.sh               # interactive menu
#   ./dev/ios_dev.sh <command>     # command mode

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

log_step() { printf "%s[Sutu iOS] %s%s\n" "$C_CYAN" "$1" "$C_RESET"; }
log_ok() { printf "%s[Sutu iOS] %s%s\n" "$C_GREEN" "$1" "$C_RESET"; }
log_warn() { printf "%s[Sutu iOS] %s%s\n" "$C_YELLOW" "$1" "$C_RESET"; }
log_err() { printf "%s[Sutu iOS] ERROR: %s%s\n" "$C_RED" "$1" "$C_RESET" >&2; }

pause_if_interactive() {
  if [[ -t 0 ]]; then
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

ensure_macos() {
  local os_name
  os_name="$(uname -s)"
  if [[ "$os_name" != "Darwin" ]]; then
    log_err "iOS development is only supported on macOS. Current OS: ${os_name}"
    return 1
  fi
  return 0
}

assert_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    log_err "Required command not found: ${name}"
    return 1
  fi
  return 0
}

check_prerequisites() {
  ensure_macos || return 1
  assert_command xcodebuild || return 1
  assert_command pnpm || return 1
  assert_command rustup || return 1
  assert_command cargo || return 1

  if ! command -v pod >/dev/null 2>&1; then
    if command -v brew >/dev/null 2>&1; then
      log_step "CocoaPods not found. Installing with Homebrew..."
      run_cmd brew install cocoapods || return 1
      hash -r
    else
      log_err "CocoaPods not found and Homebrew is unavailable."
      log_warn "Install Homebrew first, then run: brew install cocoapods"
      return 1
    fi
  fi

  assert_command pod || return 1
  log_ok "Prerequisites look good."
  return 0
}

ensure_ios_rust_targets() {
  log_step "Ensuring Rust iOS targets..."
  run_cmd rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios || return 1
  log_ok "Rust iOS targets are ready."
  return 0
}

ensure_ios_project() {
  if [[ -d "src-tauri/gen/apple" ]]; then
    log_ok "iOS project already initialized."
    return 0
  fi

  log_step "Initializing iOS target (tauri ios init)..."
  run_cmd pnpm tauri ios init || return 1
  log_ok "iOS target initialized."
  return 0
}

bootstrap() {
  check_prerequisites || return 1
  ensure_ios_rust_targets || return 1
  ensure_ios_project || return 1
  log_ok "iOS bootstrap completed."
  return 0
}

run_ios_dev() {
  local open_mode="${1:-false}"
  local host_args=()

  if [[ -n "${SUTU_IOS_HOST:-}" ]]; then
    host_args=(--host "${SUTU_IOS_HOST}")
  else
    host_args=(--host)
  fi

  if [[ "$open_mode" == "true" ]]; then
    log_step "Starting iOS dev (open Xcode)..."
    log_warn "Keep this terminal running while building/running from Xcode."
    run_cmd pnpm tauri ios dev --open "${host_args[@]}"
    return $?
  fi

  log_step "Starting iOS dev on connected device..."
  log_warn "Keep this terminal running while Xcode is attached."
  run_cmd pnpm tauri ios dev "${host_args[@]}"
  return $?
}

cmd_doctor() {
  printf "\nSutu iOS Doctor\n"
  printf "===============\n"
  printf "Repo: %s\n" "$PROJECT_DIR"
  printf "OS:   %s\n" "$(uname -a)"

  if command -v xcodebuild >/dev/null 2>&1; then
    printf "xcodebuild: %s\n" "$(xcodebuild -version 2>/dev/null | head -n 1)"
  else
    printf "xcodebuild: missing\n"
  fi

  if command -v pod >/dev/null 2>&1; then
    printf "cocoapods: %s\n" "$(pod --version 2>/dev/null)"
  else
    printf "cocoapods: missing\n"
  fi

  if command -v pnpm >/dev/null 2>&1; then
    printf "pnpm: %s\n" "$(pnpm -v)"
  else
    printf "pnpm: missing\n"
  fi

  if command -v rustup >/dev/null 2>&1; then
    printf "rustup: %s\n" "$(rustup --version | head -n 1)"
    printf "ios targets installed:\n"
    rustup target list --installed | grep "apple-ios" || true
  else
    printf "rustup: missing\n"
  fi

  if [[ -d "src-tauri/gen/apple" ]]; then
    printf "tauri ios init: ready (src-tauri/gen/apple exists)\n"
  else
    printf "tauri ios init: not initialized\n"
  fi

  printf "\n"
}

show_help() {
  cat <<'EOF'
Sutu iOS Development Script (macOS)
===================================

Usage:
  ./dev/ios_dev.sh                # interactive menu
  ./dev/ios_dev.sh <command>      # command mode

Commands:
  bootstrap          Check tools + install Rust iOS targets + tauri ios init
  dev                Bootstrap then run `pnpm tauri ios dev --host`
  open               Bootstrap then run `pnpm tauri ios dev --open --host`
  doctor             Print iOS dev environment status
  help               Show this help

Optional env:
  SUTU_IOS_HOST      Skip host selection prompt and use this IP directly
                     Example: SUTU_IOS_HOST=192.168.1.100 ./dev/ios_dev.sh dev
EOF
}

dispatch() {
  local cmd="${1:-}"
  case "$cmd" in
    bootstrap) bootstrap ;;
    dev)
      bootstrap || return 1
      run_ios_dev "false"
      ;;
    open)
      bootstrap || return 1
      run_ios_dev "true"
      ;;
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
        Sutu iOS Menu (macOS only)
============================================
[1] bootstrap   Check env + iOS init
[2] dev         Run on connected device
[3] open        Open Xcode + configure run target
[4] doctor      Environment status
[0] exit
EOF
    printf "\nEnter choice [0-4]: "
    read -r choice

    local cmd=""
    case "$choice" in
      1) cmd="bootstrap" ;;
      2) cmd="dev" ;;
      3) cmd="open" ;;
      4) cmd="doctor" ;;
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
