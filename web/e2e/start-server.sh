#!/bin/sh
# Initialize test database, then start the dev server.
# Called by Playwright's webServer config.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEST_DATA="$SCRIPT_DIR/.test-data"

# Clean previous test data
rm -rf "$TEST_DATA"

# Create required directories
mkdir -p "$TEST_DATA/nginx"
mkdir -p "$TEST_DATA/data/nginx/conf.d"
mkdir -p "$TEST_DATA/data/nginx/stream.d"
mkdir -p "$TEST_DATA/data/nginx/auth"
mkdir -p "$TEST_DATA/data/logs"

# Create minimal mime.types
printf 'types {}\n' > "$TEST_DATA/nginx/mime.types"

# Initialize test database
DB_PATH="$TEST_DATA/db.sqlite" bun "$ROOT/init-db.mjs"

# Start the dev server
exec bun --bun run dev
