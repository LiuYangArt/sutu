#!/usr/bin/env bash

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
  if [[ -t 0 ]]; then
    printf "\nPress Enter to continue..."
    read -r _
  fi
}

is_yes() {
  local value="${1:-}"
  local normalized
  normalized="$(printf '%s' "$value" | tr '[:lower:]' '[:upper:]')"
  [[ "$normalized" == "Y" ]]
}

assert_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    log_err "Required command not found: ${name}"
    return 1
  fi
}

resolve_repo_url() {
  local remote_url
  remote_url="$(git remote get-url origin 2>/dev/null || true)"
  if [[ -z "$remote_url" ]]; then
    printf '%s' ""
    return 0
  fi

  if [[ "$remote_url" =~ ^https://github.com/([^/]+)/([^/]+)(\.git)?$ ]]; then
    printf 'https://github.com/%s/%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]%.git}"
    return 0
  fi

  if [[ "$remote_url" =~ ^git@github.com:([^/]+)/([^/]+)(\.git)?$ ]]; then
    printf 'https://github.com/%s/%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]%.git}"
    return 0
  fi

  if [[ "$remote_url" =~ ^ssh://git@github.com/([^/]+)/([^/]+)(\.git)?$ ]]; then
    printf 'https://github.com/%s/%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]%.git}"
    return 0
  fi

  printf '%s' ""
}

repo_actions_url() {
  local repo_url
  repo_url="$(resolve_repo_url)"
  if [[ -n "$repo_url" ]]; then
    printf '%s/actions' "$repo_url"
  fi
}

repo_preview_workflow_url() {
  local repo_url
  repo_url="$(resolve_repo_url)"
  if [[ -n "$repo_url" ]]; then
    printf '%s/actions/workflows/package-preview.yml' "$repo_url"
  fi
}

compute_versions() {
  local version_info
  version_info="$(node -e '
const v = require("./package.json").version;
const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!m) process.exit(1);
const major = Number(m[1]);
const minor = Number(m[2]);
const patch = Number(m[3]);
process.stdout.write(
  [v, major + "." + minor + "." + (patch + 1), major + "." + (minor + 1) + ".0", (major + 1) + ".0.0"].join("|")
);
' 2>/dev/null)" || return 1

  IFS='|' read -r CURRENT_VERSION NEXT_PATCH NEXT_MINOR NEXT_MAJOR <<<"$version_info"
  [[ -n "${CURRENT_VERSION:-}" && -n "${NEXT_PATCH:-}" && -n "${NEXT_MINOR:-}" && -n "${NEXT_MAJOR:-}" ]]
}

run_release_flow() {
  local vtype="$1"
  local run_local_check force_publish confirm

  printf "\n"
  printf '%s\n' "--------------------------------------------------------"
  printf '%s\n' "[0/2] Local pre-release check"
  printf '%s\n' "--------------------------------------------------------"
  printf "\n"
  printf 'Run local checks first? Y/N [Y recommended]: '
  read -r run_local_check

  if is_yes "$run_local_check"; then
    if ! bash .dev/pre_release_check.sh; then
      printf "\n"
      log_err "Local checks failed."
      printf 'Continue release anyway? Y/N: '
      read -r force_publish
      if ! is_yes "$force_publish"; then
        printf 'Release cancelled. Returning to menu.\n'
        pause_if_interactive
        return 1
      fi
    fi
  else
    printf 'Local checks skipped.\n'
  fi

  printf "\n"
  printf '%s\n' "--------------------------------------------------------"
  printf '[1/2] Running npm version %s ...\n' "$vtype"
  printf '%s\n' "--------------------------------------------------------"
  printf "\n"
  printf '%s\n' "  This will:"
  printf '%s\n' "    1. Update package.json version"
  printf '%s\n' "    2. Sync tauri.conf.json and Cargo.toml"
  printf '%s\n' "    3. Create git commit and tag"
  printf "\n"

  if ! npm version "$vtype"; then
    printf "\n"
    log_err "Version update failed. Please check local git status."
    pause_if_interactive
    return 1
  fi

  printf "\n"
  printf '%s\n' "--------------------------------------------------------"
  printf '%s\n' "[2/2] Push release tag to GitHub"
  printf '%s\n' "--------------------------------------------------------"
  printf '%s\n' "This will trigger GitHub Actions release build for Windows and macOS."
  printf "\n"
  printf 'Push now? Y/N: '
  read -r confirm

  if is_yes "$confirm"; then
    printf "\nPushing...\n"
    if git push --follow-tags; then
      local actions_url
      actions_url="$(repo_actions_url)"
      printf "\n"
      printf '%s\n' "========================================================"
      printf '%s\n' "Release push succeeded."
      if [[ -n "$actions_url" ]]; then
        printf 'Check build progress:\n%s\n' "$actions_url"
      else
        printf '%s\n' "Check build progress in your GitHub Actions page."
      fi
      printf '%s\n' "========================================================"
    else
      printf "\n"
      log_err "Push failed. Check network and git config."
    fi
  else
    printf "\n"
    printf '%s\n' "Push cancelled. Version/tag remain local."
    printf '%s\n' "You can push later with: git push --follow-tags"
  fi

  pause_if_interactive
  return 0
}

preview_build() {
  local current_branch default_branch push_now preview_url
  if ! command -v gh >/dev/null 2>&1; then
    log_err "gh command not found. Please install GitHub CLI first."
    pause_if_interactive
    return 0
  fi

  printf "\n"
  printf '%s\n' "--------------------------------------------------------"
  printf '%s\n' "Trigger remote package preview (no release)"
  printf '%s\n' "--------------------------------------------------------"

  current_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [[ -z "$current_branch" || "$current_branch" == "HEAD" ]]; then
    current_branch="main"
  fi

  printf 'Current branch: %s\n' "$current_branch"
  printf '%s\n' "Triggering workflow: package-preview.yml"

  if gh workflow run package-preview.yml --ref "$current_branch"; then
    preview_url="$(repo_preview_workflow_url)"
    printf "\n"
    printf '%s\n' "Remote package preview triggered."
    if [[ -n "$preview_url" ]]; then
      printf 'See workflow runs:\n%s\n' "$preview_url"
    else
      printf '%s\n' "See workflow runs in your GitHub Actions page."
    fi
    pause_if_interactive
    return 0
  fi

  printf "\n"
  log_err "Failed to trigger preview workflow."

  default_branch="$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name' 2>/dev/null || true)"
  if [[ -z "$default_branch" ]]; then
    default_branch="main"
  fi

  printf 'Default branch: %s\n' "$default_branch"
  printf 'Current branch: %s\n' "$current_branch"
  printf "\n"
  printf '%s\n' "Most likely cause:"
  printf '%s\n' "- package-preview.yml does not exist on remote default branch yet."
  printf "\n"

  if [[ "$current_branch" == "$default_branch" ]]; then
    printf 'Push current branch now and retry? Y/N: '
    read -r push_now
    if is_yes "$push_now"; then
      if git push -u origin "$current_branch"; then
        printf "\nRetrying workflow trigger...\n"
        if gh workflow run package-preview.yml --ref "$current_branch"; then
          preview_url="$(repo_preview_workflow_url)"
          printf "\n"
          printf '%s\n' "Remote package preview triggered."
          if [[ -n "$preview_url" ]]; then
            printf 'See workflow runs:\n%s\n' "$preview_url"
          else
            printf '%s\n' "See workflow runs in your GitHub Actions page."
          fi
        else
          printf "\n"
          log_err "Retry failed. Open Actions page and verify workflow file exists on default branch."
        fi
      else
        printf "\n"
        log_err "Push failed. Could not retry workflow trigger."
      fi
    fi
  else
    printf 'Switch to default branch %s and push workflow file first.\n' "$default_branch"
    printf '%s\n' "Then retry option [5]."
  fi

  pause_if_interactive
  return 0
}

menu_loop() {
  local choice vtype
  while true; do
    if [[ -t 1 ]]; then
      clear || true
    fi

    cat <<EOF
========================================================
                Sutu Release Helper
========================================================

 Current version: ${CURRENT_VERSION}

 Select release type:

 [1] Patch  : bug fixes    (${CURRENT_VERSION} -> ${NEXT_PATCH})
 [2] Minor  : new features (${CURRENT_VERSION} -> ${NEXT_MINOR})
 [3] Major  : breaking changes (${CURRENT_VERSION} -> ${NEXT_MAJOR})
 [4] Exit
 [5] Remote package preview (no release)

========================================================
EOF
    printf '\nSelect [1-5]: '
    read -r choice

    vtype=""
    case "$choice" in
      1) vtype="patch" ;;
      2) vtype="minor" ;;
      3) vtype="major" ;;
      4) return 0 ;;
      5)
        preview_build
        continue
        ;;
      *)
        printf '%s\n' "Invalid input."
        pause_if_interactive
        continue
        ;;
    esac

    if run_release_flow "$vtype"; then
      return 0
    fi
  done
}

main() {
  assert_command node || return 1
  assert_command npm || return 1
  assert_command git || return 1
  assert_command gh || log_warn "gh command not found. Option [5] will be unavailable."

  if ! compute_versions; then
    log_err "Failed to read version from package.json."
    return 1
  fi

  menu_loop
}

if ! main; then
  pause_if_interactive
  exit 1
fi
