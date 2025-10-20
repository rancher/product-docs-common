#!/bin/bash
# Purpose: Update :revdate: lines in *.adoc files to today's date
# Usage: ./update_revdate.sh [--staged] [--git-add] [--verbose] [--help|-h]

set -euo pipefail

today=$(date +%Y-%m-%d)
staged_only=false
auto_git_add=false
verbose=false

# ANSI colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RESET='\033[0m'

show_help() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Updates ':revdate:' lines in *.adoc files to today's date (${today}).

Options:
  --staged     Only update files staged for commit (already added via 'git add').
  --git-add    Automatically 'git add' updated files after modification.
               Typically used together with --staged.
  --verbose    Show before/after diff snippets for each updated file.
  -h, --help   Show this help message and exit.

Examples:
  $(basename "$0")
      Update all modified and untracked .adoc files.

  $(basename "$0") --staged
      Update only staged .adoc files (no auto git add).

  $(basename "$0") --staged --git-add
      Update only staged .adoc files and re-stage them automatically.

  $(basename "$0") --verbose
      Show before/after :revdate: lines for each updated file.

For guidance on when to update ':revdate:' lines,
please refer to the SUSE Style Guide at:
https://documentation.suse.com/style/current/single-html/style-guide-adoc/index.html#sec-revinfo
EOF
}

# Parse args
if [[ $# -gt 0 ]]; then
  for arg in "$@"; do
    case "$arg" in
      --staged)
        staged_only=true
        ;;
      --git-add)
        auto_git_add=true
        ;;
      --verbose)
        verbose=true
        ;;
      -h|--help)
        show_help
        exit 0
        ;;
      *)
        echo -e "${RED}✗ Unknown option:${RESET} $arg"
        echo "Try '$(basename "$0") --help' for usage."
        exit 1
        ;;
    esac
  done
fi

# Collect target files
if $staged_only; then
  echo -e "${BLUE} Updating staged .adoc files only...${RESET}"
  mapfile -t files < <(git diff --cached --name-only --diff-filter=ACM | grep '\.adoc$' || true)
else
  echo -e "${BLUE} Updating modified and untracked .adoc files...${RESET}"
  mapfile -t modified < <(git ls-files --modified | grep '\.adoc$' || true)
  mapfile -t untracked < <(git ls-files --others --exclude-standard | grep '\.adoc$' || true)
  files=("${modified[@]}" "${untracked[@]}")
fi

# Deduplicate and clean up
files=($(printf "%s\n" "${files[@]}" | sort -u | grep -v '^$' || true))

if [[ ${#files[@]} -eq 0 ]]; then
  echo -e "${YELLOW}⚠ No matching .adoc files found.${RESET}"
  exit 0
fi

# Track updated files
updated_files=()

# Update revdate in each file
for file in "${files[@]}"; do
  if grep -q '^:revdate: ' "$file"; then
    before_line=$(grep '^:revdate: ' "$file" | head -n 1)
    sed -i "s/^:revdate: .*/:revdate: ${today}/" "$file"
    after_line=$(grep '^:revdate: ' "$file" | head -n 1)
    echo -e "${GREEN}✔ Updated:${RESET} $file"
    updated_files+=("$file")

    if $verbose; then
      echo "------"
      echo -e "${RED}Before:${RESET} ${before_line}"
      echo -e "${GREEN}After: ${RESET} ${after_line}"
      echo "------"
    fi
  else
    echo -e "${YELLOW}⚠ No ':revdate:' found in:${RESET} $file"
  fi
done

# Optionally git add updated files
if $auto_git_add && [[ ${#updated_files[@]} -gt 0 ]]; then
  echo -e "${BLUE} Adding updated files to git index...${RESET}"
  git add "${updated_files[@]}"
  echo -e "${GREEN}✔ ${#updated_files[@]} file(s) added to git.${RESET}"
fi

echo -e "${GREEN}✔ Done.${RESET}"
