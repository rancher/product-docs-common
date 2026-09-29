#!/bin/bash
# A script to copy or patch modified, staged or committed files from a source
# version directory to other specified version directories.
#
# If a target file exists, it will be patched. If it's new, it will be copied.
#
# Note: It does not handle moved, renamed or removed files.
#
# Usage:
#   ./backport_modules.sh              (syncs from detected source version to all found versions)
#   ./backport_modules.sh v2.11 v2.12  (syncs from detected source version to only v2.11 and v2.12)
#   ./backport_modules.sh --from next  (syncs from 'next' to all found versions)
#   ./backport_modules.sh --from community-docs/next/modules/ROOT (syncs specified module to all found versions)
#   ./backport_modules.sh --commit 2dde091 (syncs changes from a specific commit)
#   ./backport_modules.sh --help       (shows this help message)
#   ./backport_modules.sh --staged     (syncs only staged files)

# --- Color Definitions ---
COLOR_GREEN='\033[0;32m'
COLOR_RED='\033[0;31m'
COLOR_NC='\033[0m' # No Color

# Function to print a formatted message
print_message() {
  echo "=> $1"
}

# Function to print an error message
print_error() {
  echo -e "${COLOR_RED}Error: $1${COLOR_NC}"
}

# Function to check if a version name is valid
is_valid_version() {
  local version_name="$1"
  [[ "$version_name" == "v"* ]] || [[ "$version_name" =~ ^[0-9]+(\.[0-9]+)*$ ]] || [[ "$version_name" == "next" ]] || [[ "$version_name" == "latest" ]]
}

# Function to display usage information
show_usage() {
  echo "A script to sync modified, staged or committed files from a source version to other versions."
  echo ""
  echo "Usage: $(basename "$0") [options] [TARGET_VERSION...]"
  echo ""
  echo "Description:"
  echo "  This script finds all modified files in the source version's path"
  echo "  (e.g., community-docs/next/modules/ or versions/latest/modules/) and either copies them"
  echo "  (for new files) or applies a patch (for existing files) to the corresponding target version directories."
  echo ""
  echo "  Source and target versions are automatically detected from the 'community-docs', 'versions', or 'docs' directory."
  echo "  If specific target version numbers or paths are provided as arguments, the script will"
  echo "  only sync to those."
  echo ""
  echo "Note: It does not handle moved, renamed or removed files."
  echo ""
  echo "Options:"
  echo "  -h, --help           Show this help message and exit."
  echo "  -f, --from PATH/VER  Specify the source version name or path (e.g. 'next' or 'community-docs/next/modules/ROOT')."
  echo "  -c, --commit COMMIT  Specify a commit to sync changes from (mutually exclusive with --staged)."
  echo "  --staged             Only process files that are staged for commit."
  echo ""
  echo "Examples:"
  echo "  # Sync from detected source version to all default target versions"
  echo "  $(basename "$0")"
  echo ""
  echo "  # Sync from detected source version only to specific versions"
  echo "  $(basename "$0") v2.11 v2.12"
  echo ""
  echo "  # Sync changes from a specific commit"
  echo "  $(basename "$0") --commit 2dde091d3"
  echo ""
  echo "  # Sync from 'next' to all default target versions"
  echo "  $(basename "$0") --from next"
  echo ""
  echo "  # Sync from a specific module path"
  echo "  $(basename "$0") --from community-docs/next/modules/ROOT"
}


# --- Argument Parsing ---
FROM_ARG=""
SOURCE_VERSION_NAME="" # Default value (empty means autodetect)
SPECIFIED_SUBPATH=""
STAGED_ONLY=false
COMMIT_REF=""
COMMIT_HASH=""
POSITIONAL_ARGS=()
while [[ $# -gt 0 ]]; do
  key="$1"
  case $key in
    -h|--help)
      show_usage
      exit 0
      ;;
    -f|--from)
      if [[ -z "$2" || "$2" == -* ]]; then
        print_error "Option '$1' requires an argument."
        exit 1
      fi
      FROM_ARG="$2"
      shift # past argument
      shift # past value
      ;;
    -c|--commit)
      if [[ -z "$2" || "$2" == -* ]]; then
        print_error "Option '$1' requires an argument."
        exit 1
      fi
      COMMIT_REF="$2"
      shift # past argument
      shift # past value
      ;;
    --staged)
      STAGED_ONLY=true
      shift # past argument
      ;;
    -*) # Invalid option
      print_error "Invalid option '$1'"
      echo ""
      show_usage
      exit 1
      ;;
    *) # Positional argument (version)
      POSITIONAL_ARGS+=("$1") # save it in an array for later
      shift # past argument
      ;;
  esac
done
# Restore positional arguments. After this, $@ will contain only the version names.
set -- "${POSITIONAL_ARGS[@]}"

# Ensure the script is run from the root of a Git repository
if [ ! -d .git ]; then
  print_error "This script must be run from the root of your Git repository."
  exit 1
fi

# Validate mutually exclusive options
if [ -n "$COMMIT_REF" ] && [ "$STAGED_ONLY" = true ]; then
  print_error "Options '--commit' and '--staged' are mutually exclusive."
  exit 1
fi

# Validate commit reference if provided
if [ -n "$COMMIT_REF" ]; then
  COMMIT_HASH=$(git rev-parse --verify --quiet "$COMMIT_REF^{commit}")
  if [ -z "$COMMIT_HASH" ]; then
    print_error "Invalid commit reference '$COMMIT_REF'."
    exit 1
  fi
fi

# --- Dynamic Version Detection ---
CANDIDATE_BASES=("community-docs" "versions" "docs")

EXISTING_BASES=()
for candidate in "${CANDIDATE_BASES[@]}"; do
  if [ -d "$candidate" ]; then
    EXISTING_BASES+=("$candidate")
  fi
done

if [ ${#EXISTING_BASES[@]} -eq 0 ]; then
  print_error "Could not find a 'community-docs', 'versions', or 'docs' directory."
  exit 1
fi

VERSIONS_DIR_BASE=""
staged_files_all=""

# Helper function to get all modified/added files across the repo
get_staged_files_all() {
  if [ -n "$COMMIT_HASH" ]; then
    git diff-tree --no-commit-id --name-only -r --diff-filter=AM "$COMMIT_HASH"
  elif [ "$STAGED_ONLY" = true ]; then
    git diff --name-only --diff-filter=AM --cached
  else
    git diff --name-only --diff-filter=AM HEAD
  fi
}

# Parse --from argument if provided
if [ -n "$FROM_ARG" ]; then
  clean_from="${FROM_ARG#./}"
  clean_from="${clean_from%/}"

  if [[ "$clean_from" == *"/"* ]]; then
    first_part=$(echo "$clean_from" | cut -d/ -f1)
    second_part=$(echo "$clean_from" | cut -d/ -f2)
    rest_part=$(echo "$clean_from" | cut -d/ -f3-)

    if [[ " ${CANDIDATE_BASES[*]} " =~ " ${first_part} " ]] || [ -d "$first_part" ]; then
      VERSIONS_DIR_BASE="$first_part"
      SOURCE_VERSION_NAME="$second_part"
      SPECIFIED_SUBPATH="$rest_part"
    elif is_valid_version "$first_part"; then
      SOURCE_VERSION_NAME="$first_part"
      SPECIFIED_SUBPATH="${second_part}${rest_part:+/$rest_part}"
    else
      print_error "Unrecognized path format for '--from $FROM_ARG'."
      exit 1
    fi
  else
    SOURCE_VERSION_NAME="$clean_from"
  fi

  if ! is_valid_version "$SOURCE_VERSION_NAME"; then
    print_error "'$SOURCE_VERSION_NAME' is not a valid version name."
    exit 1
  fi
fi

# Resolve VERSIONS_DIR_BASE if not already explicitly specified in --from
if [ -z "$VERSIONS_DIR_BASE" ]; then
  if [ ${#EXISTING_BASES[@]} -eq 1 ]; then
    VERSIONS_DIR_BASE="${EXISTING_BASES[0]}"
  else
    # Multiple candidate base directories exist on disk
    if [ -n "$SOURCE_VERSION_NAME" ]; then
      matching_bases=()
      for candidate in "${EXISTING_BASES[@]}"; do
        if [ -d "$candidate/$SOURCE_VERSION_NAME" ]; then
          matching_bases+=("$candidate")
        fi
      done

      if [ ${#matching_bases[@]} -eq 1 ]; then
        VERSIONS_DIR_BASE="${matching_bases[0]}"
      elif [ ${#matching_bases[@]} -gt 1 ]; then
        staged_files_all=$(get_staged_files_all)
        diff_bases=()
        for candidate in "${matching_bases[@]}"; do
          if echo "$staged_files_all" | grep -q "^$candidate/$SOURCE_VERSION_NAME/"; then
            diff_bases+=("$candidate")
          fi
        done

        if [ ${#diff_bases[@]} -eq 1 ]; then
          VERSIONS_DIR_BASE="${diff_bases[0]}"
        else
          print_error "Version '$SOURCE_VERSION_NAME' found in multiple directories: $(echo "${matching_bases[*]}"). Please specify the source path using --from (e.g., --from ${matching_bases[0]}/$SOURCE_VERSION_NAME/modules/ROOT)."
          exit 1
        fi
      else
        print_error "Version '$SOURCE_VERSION_NAME' not found in any docs directory ($(echo "${EXISTING_BASES[*]}")). Please specify the source path using --from."
        exit 1
      fi
    else
      # Autodetect from modified files
      if [ -n "$COMMIT_HASH" ]; then
        print_message "Attempting to detect source version from commit '$COMMIT_REF'..."
      elif [ "$STAGED_ONLY" = true ]; then
        print_message "Attempting to detect source version from staged files..."
      else
        print_message "Attempting to detect source version from modified files..."
      fi
      staged_files_all=$(get_staged_files_all)

      if [ -z "$staged_files_all" ]; then
        if [ -n "$COMMIT_HASH" ]; then
          print_error "No modified/added files found in commit '$COMMIT_REF'. Cannot detect source version."
        else
          print_error "No modified/staged files found. Cannot detect source version."
        fi
        exit 1
      fi

      detected_bases=()
      for candidate in "${EXISTING_BASES[@]}"; do
        if echo "$staged_files_all" | grep -q "^$candidate/"; then
          detected_bases+=("$candidate")
        fi
      done

      if [ ${#detected_bases[@]} -eq 0 ]; then
        if [ -n "$COMMIT_HASH" ]; then
          print_error "No modified/added files found inside '$(echo "${EXISTING_BASES[*]}" | tr ' ' '/')' in commit '$COMMIT_REF'. Cannot detect source version."
        else
          print_error "No modified/staged files found inside '$(echo "${EXISTING_BASES[*]}" | tr ' ' '/')'. Cannot detect source version."
        fi
        exit 1
      elif [ ${#detected_bases[@]} -gt 1 ]; then
        print_error "Multiple documentation base directories detected in changes: $(echo "${detected_bases[*]}"). Please specify source version manually using --from."
        exit 1
      else
        VERSIONS_DIR_BASE="${detected_bases[0]}"
      fi
    fi
  fi
fi

# Detect Source Version if not specified
if [ -z "$SOURCE_VERSION_NAME" ]; then
  if [ -z "$staged_files_all" ]; then
    if [ -n "$COMMIT_HASH" ]; then
      print_message "Attempting to detect source version from commit '$COMMIT_REF'..."
    elif [ "$STAGED_ONLY" = true ]; then
      print_message "Attempting to detect source version from staged files..."
    else
      print_message "Attempting to detect source version from modified files..."
    fi
    staged_files_all=$(get_staged_files_all)
  fi

  if [ -z "$staged_files_all" ]; then
    if [ -n "$COMMIT_HASH" ]; then
      print_error "No modified/added files found in commit '$COMMIT_REF'. Cannot detect source version."
    else
      print_error "No modified/staged files found. Cannot detect source version."
    fi
    exit 1
  fi

  # Extract unique versions from paths starting with VERSIONS_DIR_BASE
  raw_versions=$(echo "$staged_files_all" | grep "^$VERSIONS_DIR_BASE/" | cut -d/ -f2 | sort -u)
  detected_versions=$(for ver in $raw_versions; do
    if is_valid_version "$ver"; then
      echo "$ver"
    fi
  done)

  # Count how many versions were found
  version_count=$(echo "$detected_versions" | grep -cve '^\s*$')

  if [ "$version_count" -eq 0 ]; then
    if [ -n "$COMMIT_HASH" ]; then
      print_error "No modified/added files found inside '$VERSIONS_DIR_BASE/' in commit '$COMMIT_REF'. Cannot detect source version."
    else
      print_error "No modified/staged files found inside '$VERSIONS_DIR_BASE/'. Cannot detect source version."
    fi
    exit 1
  elif [ "$version_count" -gt 1 ]; then
    if [ -n "$COMMIT_HASH" ]; then
      print_error "Multiple source versions detected in commit '$COMMIT_REF': $(echo $detected_versions | tr '\n' ' '). Please specify source version manually using --from."
    else
      print_error "Multiple source versions detected in modified/staged files: $(echo $detected_versions | tr '\n' ' '). Please specify source version manually using --from."
    fi
    exit 1
  else
    SOURCE_VERSION_NAME=$(echo "$detected_versions" | tr -d '[:space:]')
    print_message "Detected source version: $SOURCE_VERSION_NAME"
  fi
fi

DEFAULT_TARGET_VERSIONS=()
print_message "Scanning subdirectories in '$VERSIONS_DIR_BASE'..."
for dir in "$VERSIONS_DIR_BASE"/*; do
  if [ -d "$dir" ]; then
    version_name=$(basename "$dir")
    # Filter out the source version and apply other conditions
    if [[ "$version_name" != "$SOURCE_VERSION_NAME" ]]; then
      if is_valid_version "$version_name"; then
        DEFAULT_TARGET_VERSIONS+=("$version_name")
      fi
    fi
  fi
done

# Update the source path with detected directories or specified subpath
if [ -n "$SPECIFIED_SUBPATH" ]; then
  clean_subpath="${SPECIFIED_SUBPATH%/}/"
  SOURCE_PATH="${VERSIONS_DIR_BASE}/${SOURCE_VERSION_NAME}/${clean_subpath}"
else
  SOURCE_PATH="${VERSIONS_DIR_BASE}/${SOURCE_VERSION_NAME}/modules/"
fi

if [ ${#DEFAULT_TARGET_VERSIONS[@]} -eq 0 ]; then
    print_error "No valid default target versions could be found."
    exit 1
fi
# --- End of Dynamic Version Detection ---


# Determine which versions to target
TARGET_VERSIONS=()
if [ "$#" -gt 0 ]; then
  # Use versions from command line arguments, but validate them first
  print_message "Validating specified target versions..."
  for requested_arg in "$@"; do
    clean_arg="${requested_arg#./}"
    clean_arg="${clean_arg%/}"
    if [[ "$clean_arg" == *"/"* ]]; then
      first_part=$(echo "$clean_arg" | cut -d/ -f1)
      second_part=$(echo "$clean_arg" | cut -d/ -f2)
      if [[ "$first_part" == "$VERSIONS_DIR_BASE" ]] || [[ " ${CANDIDATE_BASES[*]} " =~ " ${first_part} " ]]; then
        requested_version="$second_part"
      elif is_valid_version "$first_part"; then
        requested_version="$first_part"
      else
        requested_version="$second_part"
      fi
    else
      requested_version="$clean_arg"
    fi

    is_valid=false
    for valid_version in "${DEFAULT_TARGET_VERSIONS[@]}"; do
      if [[ "$requested_version" == "$valid_version" ]]; then
        is_valid=true
        break
      fi
    done

    if [ "$is_valid" = false ]; then
      print_error "Target version '$requested_arg' is not a valid version."
      print_message "Valid discovered versions are: ${DEFAULT_TARGET_VERSIONS[*]}"
      exit 1
    fi
    TARGET_VERSIONS+=("$requested_version")
  done
  print_message "Using specified target versions from command line."
else
  # Use default versions from the script
  TARGET_VERSIONS=("${DEFAULT_TARGET_VERSIONS[@]}")
  print_message "No versions specified, using dynamically detected default versions."
fi

print_message "Starting sync of files from '$SOURCE_VERSION_NAME'..."
print_message "Source path: $SOURCE_PATH"
print_message "Target versions: ${TARGET_VERSIONS[*]}"
echo "-----------------------------------------------------"

if [ -n "$COMMIT_HASH" ]; then
  # Get a list of files modified/added in the specified commit within the specified source path
  staged_files=$(git diff-tree --no-commit-id --name-only -r --diff-filter=AM "$COMMIT_HASH" -- "$SOURCE_PATH")
elif [ "$STAGED_ONLY" = true ]; then
  # Get a list of files staged for commit within the specified source path
  staged_files=$(git diff --name-only --diff-filter=AM --cached -- "$SOURCE_PATH"**)
else
  # Get a list of modified files (staged + unstaged) within the specified source path
  staged_files=$(git diff --name-only --diff-filter=AM HEAD -- "$SOURCE_PATH"**)
fi

if [ -z "$staged_files" ]; then
  if [ -n "$COMMIT_HASH" ]; then
    print_message "No modified/added files found in '$SOURCE_PATH' for commit '$COMMIT_REF'. Nothing to do."
  else
    print_message "No modified files found in '$SOURCE_PATH'. Nothing to do."
  fi
  exit 0
fi

# Loop through each staged file
while IFS= read -r file; do
  [ -z "$file" ] && continue
  file_exists=false
  if [ -n "$COMMIT_HASH" ]; then
    if git cat-file -e "$COMMIT_HASH:$file" 2>/dev/null; then
      file_exists=true
    fi
  elif [ -f "$file" ]; then
    file_exists=true
  fi

  if [ "$file_exists" = true ]; then
    echo
    print_message "Processing: $file"

    # Loop through each target version directory
    for version in "${TARGET_VERSIONS[@]}"; do
      # Construct the destination path by replacing the source version with the target version number
      dest_file="${file/#"$VERSIONS_DIR_BASE/$SOURCE_VERSION_NAME"/"$VERSIONS_DIR_BASE/$version"}"
      if [[ "$dest_file" == "$file" ]]; then
        dest_file="${file/$SOURCE_VERSION_NAME/$version}"
      fi

      # Get the directory part of the destination path
      dest_dir=$(dirname "$dest_file")

      # Either PATCH or COPY the file
      if [ -f "$dest_file" ]; then
        # File exists, so we create and apply a patch
        echo "  - Target exists: $dest_file. Attempting to apply patch..."

        # Create a temporary file for the diff
        patch_file=$(mktemp)

        # Generate the patch
        if [ -n "$COMMIT_HASH" ]; then
          git diff-tree --no-commit-id -p "$COMMIT_HASH" -- "$file" > "$patch_file"
        elif [ "$STAGED_ONLY" = true ]; then
          git diff --no-color --cached -- "$file" > "$patch_file"
        else
          git diff --no-color HEAD -- "$file" > "$patch_file"
        fi

        # Check if the patch file has content (i.e., if there are differences)
        if [ -s "$patch_file" ]; then
          if patch --dry-run -R -f -s "$dest_file" < "$patch_file" >/dev/null 2>&1; then
            echo "  - INFO: Changes are already applied in target."
          elif patch --batch -N --quiet --no-backup-if-mismatch "$dest_file" < "$patch_file"; then
            echo -e "  - ${COLOR_GREEN}SUCCESS: Patch applied.${COLOR_NC}"
          else
            echo -e "  - ${COLOR_RED}FAILED: Patch could not be applied. Manual merge required.${COLOR_NC}"
            echo "  - Check for a .rej file and review the changes in $dest_file manually."
          fi
        else
          echo "  - INFO: No differences found. File is already in sync."
        fi

        # Clean up the temporary patch file
        rm "$patch_file"
      else
        # File does not exist, so we copy it
        echo "  - Target is new. Copying file..."

        # Create the destination directory if it doesn't exist
        if [ ! -d "$dest_dir" ]; then
          mkdir -p "$dest_dir"
          echo "  - Created directory: $dest_dir"
        fi

        # Copy the source file to the destination
        if [ -n "$COMMIT_HASH" ]; then
          git show "$COMMIT_HASH:$file" > "$dest_file"
        else
          cp "$file" "$dest_file"
        fi
        echo "  - Copied to: $dest_file"
      fi
    done
  fi
done <<< "$staged_files"

echo "-----------------------------------------------------"
echo -e "=> ${COLOR_GREEN}Sync complete!${COLOR_NC}"
print_message "Note: The files are copied/patched but not staged for commit. Please review and 'git add' them manually."
