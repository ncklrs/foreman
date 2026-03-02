#!/bin/sh
# Foreman installer — download and install a pre-built release.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ncklrs/foreman/main/install.sh | sh
#
# Environment variables:
#   FOREMAN_VERSION     (optional) Specific version to install, e.g. "0.1.0"
#   FOREMAN_INSTALL_DIR (optional) Install directory (default: ~/.foreman)

set -e

REPO="ncklrs/foreman"
DEFAULT_INSTALL_DIR="$HOME/.foreman"
INSTALL_DIR="${FOREMAN_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
GITHUB_API="https://api.github.com"

# --- Helpers ---

info() {
  printf '  \033[1;34m>\033[0m %s\n' "$1"
}

error() {
  printf '  \033[1;31merror\033[0m: %s\n' "$1" >&2
  exit 1
}

warn() {
  printf '  \033[1;33mwarn\033[0m: %s\n' "$1" >&2
}

check_cmd() {
  command -v "$1" >/dev/null 2>&1
}

# --- Preflight checks ---

info "Foreman installer"

# Check required tools
check_cmd curl  || error "curl is required but not found"
check_cmd tar   || error "tar is required but not found"
check_cmd node  || error "Node.js is required but not found. Install Node.js >= 20 first."

# Check Node.js version >= 20
NODE_VERSION=$(node -p "process.versions.node" 2>/dev/null) || error "Failed to detect Node.js version"
NODE_MAJOR=$(printf '%s' "$NODE_VERSION" | cut -d. -f1)

if [ "$NODE_MAJOR" -lt 20 ] 2>/dev/null; then
  error "Node.js >= 20 is required (found v${NODE_VERSION})"
fi
info "Node.js v${NODE_VERSION} detected"

# --- Resolve version ---

if [ -n "${FOREMAN_VERSION:-}" ]; then
  VERSION="$FOREMAN_VERSION"
  info "Using specified version: v${VERSION}"
else
  info "Fetching latest version..."
  LATEST_JSON=$(curl -fsSL \
    -H "Accept: application/vnd.github.v3+json" \
    "${GITHUB_API}/repos/${REPO}/releases/latest" 2>/dev/null) \
    || error "Failed to fetch latest release from GitHub."

  # Extract tag_name (e.g., "v0.1.0") — strip leading "v"
  VERSION=$(printf '%s' "$LATEST_JSON" | grep -o '"tag_name":[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"v\{0,1\}\([^"]*\)".*/\1/')

  if [ -z "$VERSION" ]; then
    error "Could not determine latest version from GitHub API response"
  fi
  info "Latest version: v${VERSION}"
fi

ASSET_NAME="foreman-v${VERSION}.tar.gz"

# --- Find release asset download URL ---

info "Finding release asset..."
RELEASE_JSON=$(curl -fsSL \
  -H "Accept: application/vnd.github.v3+json" \
  "${GITHUB_API}/repos/${REPO}/releases/tags/v${VERSION}" 2>/dev/null) \
  || error "Release v${VERSION} not found. Check that the version exists."

# Extract the asset URL for the tarball
ASSET_URL=$(printf '%s' "$RELEASE_JSON" | grep -o "\"url\":[[:space:]]*\"${GITHUB_API}/repos/${REPO}/releases/assets/[0-9]*\"" | head -1 | sed 's/"url":[[:space:]]*"\(.*\)"/\1/')

# If grep-based extraction fails, try a simpler approach: find asset ID by name
if [ -z "$ASSET_URL" ]; then
  ASSET_ID=$(printf '%s' "$RELEASE_JSON" | grep -B5 "\"name\":.*${ASSET_NAME}" | grep '"id"' | head -1 | sed 's/.*"id":[[:space:]]*\([0-9]*\).*/\1/')
  if [ -n "$ASSET_ID" ]; then
    ASSET_URL="${GITHUB_API}/repos/${REPO}/releases/assets/${ASSET_ID}"
  fi
fi

if [ -z "$ASSET_URL" ]; then
  error "Could not find asset ${ASSET_NAME} in release v${VERSION}"
fi

# --- Download + extract ---

info "Downloading ${ASSET_NAME}..."
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

curl -fsSL \
  -H "Accept: application/octet-stream" \
  "$ASSET_URL" \
  -o "$TMP_DIR/$ASSET_NAME" \
  || error "Failed to download release asset"

info "Extracting to ${INSTALL_DIR}..."

# Remove previous installation if present
if [ -d "$INSTALL_DIR" ]; then
  warn "Removing previous installation at ${INSTALL_DIR}"
  rm -rf "$INSTALL_DIR"
fi

mkdir -p "$INSTALL_DIR"
tar -xzf "$TMP_DIR/$ASSET_NAME" -C "$INSTALL_DIR" --strip-components=1

# --- Verify ---

if [ ! -x "$INSTALL_DIR/bin/foreman" ]; then
  error "Installation failed: bin/foreman not found or not executable"
fi

INSTALLED_VERSION=$("$INSTALL_DIR/bin/foreman" --version 2>/dev/null || echo "unknown")
info "Installed foreman ${INSTALLED_VERSION}"

# --- PATH instructions ---

BIN_DIR="$INSTALL_DIR/bin"
ALREADY_IN_PATH=false

case ":$PATH:" in
  *":$BIN_DIR:"*) ALREADY_IN_PATH=true ;;
esac

if [ "$ALREADY_IN_PATH" = true ]; then
  info "foreman is already in your PATH"
else
  printf '\n'
  info "Add foreman to your PATH by adding one of these to your shell config:"
  printf '\n'

  SHELL_NAME=$(basename "${SHELL:-/bin/sh}")

  case "$SHELL_NAME" in
    zsh)
      printf '  # Add to ~/.zshrc\n'
      printf '  export PATH="%s:$PATH"\n' "$BIN_DIR"
      ;;
    bash)
      printf '  # Add to ~/.bashrc or ~/.bash_profile\n'
      printf '  export PATH="%s:$PATH"\n' "$BIN_DIR"
      ;;
    fish)
      printf '  # Add to ~/.config/fish/config.fish\n'
      printf '  set -gx PATH %s $PATH\n' "$BIN_DIR"
      ;;
    *)
      printf '  export PATH="%s:$PATH"\n' "$BIN_DIR"
      ;;
  esac

  printf '\n'
  info "Then restart your shell or run:"
  printf '  export PATH="%s:$PATH"\n' "$BIN_DIR"
fi

printf '\n'
info "Done! Run 'foreman --help' to get started."
