#!/usr/bin/env bash

set -u

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR" || exit 1
MAC_TREE_PATH=""

cleanup() {
  if [[ -n "${MAC_TREE_PATH:-}" ]]; then
    rm -f "$MAC_TREE_PATH"
  fi
}

run_step() {
  local title="$1"
  shift

  printf "\n"
  printf '%s\n' "--------------------------------------------------------"
  printf '%s\n' "$title"
  printf '%s\n' "--------------------------------------------------------"

  "$@"
}

assert_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    printf '[FAIL] Required command not found: %s\n' "$name" >&2
    return 1
  fi
}

assert_mac_tree_missing_windows_deps() {
  local tree_path="$1"
  local blocked_deps=("wintab_lite" "libloading")
  local has_error=0

  for dep in "${blocked_deps[@]}"; do
    local matches
    matches="$(grep -nE "${dep} v" "$tree_path" || true)"
    if [[ -n "$matches" ]]; then
      if [[ $has_error -eq 0 ]]; then
        printf '[FAIL] macOS dependency tree contains Windows-only dependencies:\n'
      fi
      has_error=1
      printf '%s\n' "$matches"
    fi
  done

  if [[ $has_error -ne 0 ]]; then
    return 1
  fi
}

assert_mac_tree_has_required_common_deps() {
  local tree_path="$1"
  local required_deps=("base64" "quick-xml" "image" "byteorder" "zip" "tiff" "dirs" "sha2" "hex")
  local missing=()

  for dep in "${required_deps[@]}"; do
    if ! grep -qE "${dep} v" "$tree_path"; then
      missing+=("$dep")
    fi
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    printf '[FAIL] Missing common dependencies in macOS tree: %s\n' "${missing[*]}"
    return 1
  fi
}

build_mac_tree() {
  local output_path="$1"
  cargo tree --manifest-path src-tauri/Cargo.toml --target aarch64-apple-darwin >"$output_path"
}

main() {
  trap cleanup EXIT

  assert_command cargo || return 1

  run_step "[1/4] Cargo host check" \
    cargo check --manifest-path src-tauri/Cargo.toml || return 1

  MAC_TREE_PATH="$(mktemp -t sutu-mac-tree-precheck.XXXXXX.txt)"

  run_step "[2/4] Build macOS dependency tree" \
    build_mac_tree "$MAC_TREE_PATH" || return 1

  run_step "[3/4] Ensure macOS tree excludes Windows-only deps" \
    assert_mac_tree_missing_windows_deps "$MAC_TREE_PATH" || return 1

  run_step "[4/4] Ensure macOS tree includes common deps" \
    assert_mac_tree_has_required_common_deps "$MAC_TREE_PATH" || return 1
}

if main; then
  printf "\n"
  printf '%s\n' "========================================================"
  printf '%s\n' "Pre-release checks passed."
  printf '%s\n' "========================================================"
  exit 0
else
  local_ec=$?
  printf "\n"
  printf '%s\n' "========================================================"
  printf '%s\n' "Pre-release checks failed."
  printf '%s\n' "========================================================"
  exit "$local_ec"
fi
