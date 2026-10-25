#!/bin/bash

set -euo pipefail

TODAY=$(date +%Y-%m-%d)

echo "Using revdate: $TODAY"

BASE_REF="${1:-origin/main}"

echo "Comparing against: $BASE_REF"

# Fetch changed .adoc files
FILES=$(git diff --name-only "$BASE_REF"...HEAD | grep '\.adoc$' || true)

if [ -z "$FILES" ]; then
  echo "No changed .adoc files found."
  exit 0
fi

echo "Changed files:"
echo "$FILES"

UPDATED=0

for file in $FILES; do
  if [ ! -f "$file" ]; then
    echo "Skipping missing file: $file"
    continue
  fi

  echo ""
  echo "Processing: $file"

  # Skip files without revdate
  if ! grep -q "^:revdate:" "$file"; then
    echo "  -> No :revdate: found. Skipping."
    continue
  fi

  # Skip already updated
  if grep -q "^:revdate: $TODAY$" "$file"; then
    echo "  -> Already updated."
    continue
  fi

  # Update revdate
  sed -i "s/^:revdate:.*/:revdate: $TODAY/" "$file"

  # Ensure page-revdate exists
  if grep -q "^:page-revdate:" "$file"; then
    sed -i "s/^:page-revdate:.*/:page-revdate: {revdate}/" "$file"
  else
    awk '
      BEGIN { inserted=0 }

      /^:revdate:/ {
        print
        print ":page-revdate: {revdate}"
        inserted=1
        next
      }

      { print }
    ' "$file" > "$file.tmp"

    mv "$file.tmp" "$file"
  fi

  echo "  -> Updated revdate"

  UPDATED=1
done

if [ "$UPDATED" -eq 0 ]; then
  echo "No files updated."
  exit 0
fi

echo ""
echo "Updated files:"
git diff --name-only