#!/bin/bash
# Purpose: A pre-commit Git hook to check whether :revdate: lines in staged
#          *.adoc files are updated to today's date and optionally call a
#          separate script update_revdate.sh to update them.
# Install by creating a symlink:
#          ln -s "$(git rev-parse --show-toplevel)/product-docs-common/scripts/recurring/pre_commit.sh" "$(git rev-parse --show-toplevel)/.git/hooks/pre-commit"
# Alternatively, copy the file:
#          cp "$(git rev-parse --show-toplevel)/product-docs-common/scripts/recurring/pre_commit.sh" "$(git rev-parse --show-toplevel)/.git/hooks/pre-commit"

# --- Configuration ---
# Find the root of the Git repository to build a reliable, absolute path.
GIT_ROOT=$(git rev-parse --show-toplevel)

# Define the update command as an array to handle options and spaces correctly.
# Add or remove options for your script here.
UPDATE_COMMAND=(
    "$GIT_ROOT/product-docs-common/scripts/recurring/update_revdate.sh"
    "--staged"
    "--verbose"
    "--git-add"
)

# --- Colors for terminal output ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

# Get the current date in YYYY-MM-DD format.
CURRENT_DATE=$(date +%Y-%m-%d)
echo "Checking for :revdate: $CURRENT_DATE in .adoc files..."

# Find all staged .adoc files.
STAGED_ADOC_FILES=$(git diff --cached --name-only --diff-filter=ACM | grep '\.adoc$')

# Array to hold files that need updating.
FILES_TO_FIX=()

# If no .adoc files are staged, exit successfully.
if [ -z "$STAGED_ADOC_FILES" ]; then
    echo -e "${GREEN}✔ No staged .adoc files to check. Proceeding with commit.${NC}"
    exit 0
fi

# Loop through each staged .adoc file.
for FILE in $STAGED_ADOC_FILES; do
    # Only flag files that have a revdate line but it is not today's date.
    # Uses extended regex (-E) to account for multiple whitespaces (\s+).
    if grep -q "^:revdate:" "$FILE" && ! grep -Eq "^:revdate:\s+$CURRENT_DATE" "$FILE"; then
        # If a revdate line exists AND it is outdated, add the file to the list.
        FILES_TO_FIX+=("$FILE")
    fi
done

# Check if we found any files that need fixing.
if [ ${#FILES_TO_FIX[@]} -ne 0 ]; then
    echo -e "\n${RED}Warning: Found outdated ':revdate:' in the following files:${NC}"
    for BAD_FILE in "${FILES_TO_FIX[@]}"; do
        echo -e "  - ${YELLOW}$BAD_FILE${NC}"
    done

    echo "" # Newline for spacing

    # Ask the user if they want to run the update script.
    # We redirect < /dev/tty to ensure this works correctly inside a Git hook.
    read -p "Do you want to run the update script to fix them now? (y/n) " -n 1 -r < /dev/tty
    echo "" # Move to a new line after user input.

    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "Running update script..."
        # Execute the command from the array.
        "${UPDATE_COMMAND[@]}"

        # Check the exit code of the update script. $? holds the exit code of the last command.
        if [ $? -ne 0 ]; then
            echo -e "\n${RED}Error:${NC} The update script failed. Please review its output, fix the issue, and try committing again."
            exit 1 # Fail the commit because the update script itself failed.
        else
            echo -e "\n${YELLOW}Action required:${NC} Files have been updated. Please review the files listed above and commit again."
            # Abort the commit so the user can stage the new changes.
            exit 1
        fi
    else
        # If user answers "no", show a warning but proceed with the commit.
        echo -e "${YELLOW}Warning:${NC} Proceeding with commit, but files still have an outdated ':revdate:'."
        # Allow the commit by exiting with a zero status code.
        exit 0
    fi
else
    echo -e "${GREEN}✔ All staged .adoc files have the correct :revdate:. Proceeding with commit.${NC}"
    # All files are okay, so allow the commit.
    exit 0
fi
