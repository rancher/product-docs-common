#!/bin/bash
# A script to copy or patch staged files from a source version
# directory to other specified version directories.
#
# If a target file exists, it will be patched. If it's new, it will be copied.
#
# Note: It does not properly handle moved, renamed or removed files.
#
# Usage:
#   ./backport_modules.sh              (syncs from detected source version to all found versions)
#   ./backport_modules.sh v2.11 v2.12    (syncs from detected source version to only v2.11 and v2.12)
#   ./backport_modules.sh --from next  (syncs from 'next' to all found versions)
#   ./backport_modules.sh --help       (shows this help message)

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
  echo "A script to sync staged files from a source version to other versions."
  echo ""
  echo "Usage: $(basename "$0") [options] [TARGET_VERSION...]"
  echo ""
  echo "Description:"
  echo "  This script finds all files staged with 'git add' in the source version's path"
  echo "  (e.g., versions/latest/modules/) and either copies them (for new files) or"
  echo "  applies a patch (for existing files) to the corresponding target version directories."
  echo ""
  echo "  Source and target versions are automatically detected from the 'versions' or 'docs' directory."
  echo "  If specific target version numbers are provided as arguments, the script will"
  echo "  only sync to those."
  echo ""
  echo "Note: It does not handle moved, renamed or removed files."
  echo ""
  echo "Options:"
  echo "  -h, --help           Show this help message and exit."
  echo "  -f, --from VERSION   Specify the source version name (autodetected if not specified)."
  echo ""
  echo "Examples:"
  echo "  # Sync from detected source version to all default target versions"
  echo "  $(basename "$0")"
  echo ""
  echo "  # Sync from detected source version only to specific versions"
  echo "  $(basename "$0") v2.11 v2.12"
  echo ""
  echo "  # Sync from 'next' to all default target versions"
  echo "  $(basename "$0") --from next"
}


# --- Argument Parsing ---
SOURCE_VERSION_NAME="" # Default value (empty means autodetect)
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
      SOURCE_VERSION_NAME="$2"
      shift # past argument
      shift # past value
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

# --- Dynamic Version Detection ---
VERSIONS_DIR_BASE=""
if [ -d "versions" ]; then
  VERSIONS_DIR_BASE="versions"
elif [ -d "docs" ]; then
  VERSIONS_DIR_BASE="docs"
else
  print_error "Could not find a 'versions' or 'docs' directory."
  exit 1
fi

# Detect Source Version if not specified
if [ -z "$SOURCE_VERSION_NAME" ]; then
  print_message "Attempting to detect source version from staged files..."
  
  # Get all staged files
  staged_files_all=$(git diff --name-only --cached)
  
  if [ -z "$staged_files_all" ]; then
    print_error "No staged files found. Cannot detect source version."
    exit 1
  fi

  # Extract unique versions from paths starting with VERSIONS_DIR_BASE
  detected_versions=$(echo "$staged_files_all" | grep "^$VERSIONS_DIR_BASE/" | cut -d/ -f2 | sort -u)
  raw_versions=$(echo "$staged_files_all" | grep "^$VERSIONS_DIR_BASE/" | cut -d/ -f2 | sort -u)
  detected_versions=$(for ver in $raw_versions; do
    if is_valid_version "$ver"; then
      echo "$ver"
    fi
  done)
  
  # Count how many versions were found
  version_count=$(echo "$detected_versions" | grep -cve '^\s*$')

  if [ "$version_count" -eq 0 ]; then
    print_error "No staged files found inside '$VERSIONS_DIR_BASE/'. Cannot detect source version."
    exit 1
  elif [ "$version_count" -gt 1 ]; then
    print_error "Multiple source versions detected in staged files: $(echo $detected_versions | tr '\n' ' '). Please specify source version manually using --from."
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

# Update the source path with detected directories.
SOURCE_PATH="${VERSIONS_DIR_BASE}/${SOURCE_VERSION_NAME}/modules/"

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
  for requested_version in "$@"; do
    is_valid=false
    for valid_version in "${DEFAULT_TARGET_VERSIONS[@]}"; do
      if [[ "$requested_version" == "$valid_version" ]]; then
        is_valid=true
        break
      fi
    done

    if [ "$is_valid" = false ]; then
      print_error "Target version '$requested_version' is not a valid version."
      print_message "Valid discovered versions are: ${DEFAULT_TARGET_VERSIONS[*]}"
      exit 1
    fi
  done
  TARGET_VERSIONS=("$@")
  print_message "Using specified target versions from command line."
else
  # Use default versions from the script
  TARGET_VERSIONS=("${DEFAULT_TARGET_VERSIONS[@]}")
  print_message "No versions specified, using dynamically detected default versions."
fi

print_message "Starting sync of staged files from '$SOURCE_VERSION_NAME'..."
print_message "Target versions: ${TARGET_VERSIONS[*]}"
echo "-----------------------------------------------------"

# Get a list of files staged for commit within the specified source path
staged_files=$(git diff --name-only --cached -- "$SOURCE_PATH"**)

if [ -z "$staged_files" ]; then
  print_message "No staged files found in '$SOURCE_PATH'. Nothing to do."
  exit 0
fi

# Loop through each staged file
while IFS= read -r file; do
  if [ -f "$file" ]; then # Check if the item is a file
    echo
    print_message "Processing: $file"

    # Loop through each target version directory
    for version in "${TARGET_VERSIONS[@]}"; do
      # Construct the destination path by replacing the source version with the target version number
      dest_file="${file/$SOURCE_VERSION_NAME/$version}"

      # Get the directory part of the destination path
      dest_dir=$(dirname "$dest_file")

      # Either PATCH or COPY the file
      if [ -f "$dest_file" ]; then
        # File exists, so we create and apply a patch
        echo "  - Target exists: $dest_file. Attempting to apply patch..."

        # Create a temporary file for the diff
        patch_file=$(mktemp)

        # Generate the patch from the staged changes only
        git diff --no-color --cached -- "$file" > "$patch_file"

        # Check if the patch file has content (i.e., if there are differences)
        if [ -s "$patch_file" ]; then
          if patch --quiet --no-backup-if-mismatch "$dest_file" < "$patch_file"; then
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
        cp "$file" "$dest_file"
        echo "  - Copied to: $dest_file"
      fi
    done
  fi
done <<< "$staged_files"

echo "-----------------------------------------------------"
echo -e "=> ${COLOR_GREEN}Sync complete!${COLOR_NC}"
print_message "Note: The files are copied/patched but not staged for commit. Please review and 'git add' them manually."
