#!/usr/bin/env bash
set -euo pipefail

# Build a release tarball for distribution.
# Produces foreman-v{version}.tar.gz in the repo root.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

VERSION=$(node -p "require('./package.json').version")
STAGING="$REPO_ROOT/.release-staging"
TARBALL="foreman-v${VERSION}.tar.gz"

echo "==> Building foreman v${VERSION}"

# Clean previous artifacts
rm -rf "$STAGING" "$TARBALL"
mkdir -p "$STAGING/foreman"

# Step 1: Full install + compile
echo "==> Installing dependencies..."
npm ci --ignore-scripts

echo "==> Compiling TypeScript..."
npm run build

# Step 2: Copy runtime artifacts to staging
echo "==> Staging release files..."
cp -r dist "$STAGING/foreman/dist"

# Create a trimmed package.json (no devDependencies, no build scripts)
node -e "
  const pkg = require('./package.json');
  const trimmed = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    type: pkg.type,
    main: pkg.main,
    bin: pkg.bin,
    dependencies: pkg.dependencies,
    engines: pkg.engines
  };
  process.stdout.write(JSON.stringify(trimmed, null, 2) + '\n');
" > "$STAGING/foreman/package.json"

cp package-lock.json "$STAGING/foreman/package-lock.json"

# Step 3: Install production dependencies only
echo "==> Installing production dependencies..."
cd "$STAGING/foreman"
npm ci --omit=dev --ignore-scripts

# Step 4: Strip non-runtime files from node_modules to reduce size
echo "==> Stripping non-runtime files from node_modules..."
find node_modules -type f \( \
  -name "*.md" -o \
  -name "*.map" -o \
  -name "*.d.ts" -o \
  -name "*.d.ts.map" -o \
  -name "*.d.mts" -o \
  -name "LICENSE*" -o \
  -name "LICENCE*" -o \
  -name "CHANGELOG*" -o \
  -name "HISTORY*" -o \
  -name "CONTRIBUTING*" -o \
  -name "AUTHORS*" -o \
  -name ".npmignore" -o \
  -name ".eslintrc*" -o \
  -name ".prettierrc*" -o \
  -name "tsconfig.json" -o \
  -name "jest.config*" -o \
  -name "Makefile" \
\) -delete 2>/dev/null || true

# Remove native .node files (ssh2/cpu-features have JS fallbacks)
find node_modules -name "*.node" -delete 2>/dev/null || true

# Remove empty directories left behind
find node_modules -type d -empty -delete 2>/dev/null || true

# Step 5: Create bin wrapper (shell script avoids ESM/CJS concerns)
echo "==> Creating bin/foreman wrapper..."
mkdir -p bin
cat > bin/foreman << 'SHELL_WRAPPER'
#!/bin/sh
# Foreman CLI wrapper
FOREMAN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$FOREMAN_ROOT/dist/cli.js" "$@"
SHELL_WRAPPER
chmod +x bin/foreman

cd "$REPO_ROOT"

# Step 6: Create tarball
echo "==> Creating tarball ${TARBALL}..."
tar -czf "$TARBALL" -C "$STAGING" foreman

# Step 7: Report
SIZE=$(du -h "$TARBALL" | cut -f1)
echo "==> Built ${TARBALL} (${SIZE})"

# Cleanup staging
rm -rf "$STAGING"

echo "==> Done! Test with:"
echo "    tar xzf ${TARBALL} && foreman/bin/foreman --help"
