#!/usr/bin/env bash
set -euo pipefail

# Usage: ./update_version.sh <version>
# Example: ./update_version.sh 0.1.0
#
# Updates the version in package.json, commits, and creates a git tag.

if [ $# -ne 1 ]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 0.1.0"
  exit 1
fi

VERSION="$1"
TAG="v${VERSION}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Validate semver format
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$'; then
  echo "Error: version must be semver (e.g. 0.1.0, 1.0.0-beta.1)"
  exit 1
fi

# Check tag doesn't already exist
if git tag -l "$TAG" | grep -q "$TAG"; then
  echo "Error: tag $TAG already exists"
  exit 1
fi

# Update package.json
PACKAGE_JSON="$SCRIPT_DIR/web/package.json"
if [ ! -f "$PACKAGE_JSON" ]; then
  echo "Error: $PACKAGE_JSON not found"
  exit 1
fi

sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$PACKAGE_JSON"

echo "Updated $PACKAGE_JSON to $VERSION"
echo "Tag: $TAG"
echo ""
echo "Next steps:"
echo "  git add web/package.json"
echo "  git commit -m \"chore: bump version to $TAG\""
echo "  git tag $TAG"
echo "  git push origin main --tags"
