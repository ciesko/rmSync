#!/bin/bash
# ─────────────────────────────────────────────────────────────
# rmSync — Build & Run
#
# Usage:
#   chmod +x build.sh
#   ./build.sh                  # build macOS + run
#   ./build.sh --build-only     # build macOS, don't run
#   ./build.sh --run-only       # just run existing build
#   ./build.sh --dist           # macOS .dmg for sharing
#   ./build.sh --win            # build Windows portable .exe
#   ./build.sh --all            # build macOS + Windows
#   ./build.sh --clean          # remove all build artifacts
#   ./build.sh --help           # show this help
# ─────────────────────────────────────────────────────────────

set -e

# ─── Colors ───

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
DIM='\033[0;90m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${BLUE}▸${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
fail()  { echo -e "${RED}✗${NC} $1"; }
step()  { echo -e "\n${BOLD}── $1 ──${NC}"; }

# ─── Config ───

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/src"
DIST_DIR="$SCRIPT_DIR/dist"
APP_NAME="rmSync"

cd "$SRC_DIR"

BUILD_ONLY=false
RUN_ONLY=false
DIST=false
BUILD_WIN=false
BUILD_ALL=false
CLEAN=false

for arg in "$@"; do
  case $arg in
    --build-only) BUILD_ONLY=true ;;
    --run-only)   RUN_ONLY=true ;;
    --dist)       DIST=true ;;
    --win)        BUILD_WIN=true; BUILD_ONLY=true ;;
    --all)        BUILD_ALL=true; BUILD_ONLY=true ;;
    --clean)      CLEAN=true ;;
    --help|-h)
      echo "Usage: ./build.sh [options]"
      echo ""
      echo "  (default)        Check deps → build macOS → run"
      echo "  --build-only     Build macOS app, don't launch"
      echo "  --run-only       Launch existing build (skip build)"
      echo "  --dist           Build macOS .dmg for sharing"
      echo "  --win            Build Windows portable .exe (cross-compile)"
      echo "  --all            Build both macOS + Windows"
      echo "  --clean          Remove all build artifacts"
      echo ""
      echo "Output:"
      echo "  macOS  → dist/*.dmg  or  dist/mac-arm64/${APP_NAME}.app"
      echo "  Windows→ dist/*.exe"
      exit 0
      ;;
  esac
done

# ═══════════════════════════════════════════════════════════
# CLEAN
# ═══════════════════════════════════════════════════════════

if [ "$CLEAN" = true ]; then
  step "Cleaning"
  [ -d "$DIST_DIR" ]      && rm -rf "$DIST_DIR"      && ok "Removed dist/"
  [ -d dist ]             && rm -rf dist              && ok "Removed src/dist/"
  [ -d node_modules ]     && rm -rf node_modules      && ok "Removed node_modules/"
  [ -f package-lock.json ] && rm -f package-lock.json  && ok "Removed package-lock.json"
  echo ""
  ok "All clean."
  exit 0
fi

# ═══════════════════════════════════════════════════════════
# STEP 1: Check Prerequisites
# ═══════════════════════════════════════════════════════════

if [ "$RUN_ONLY" = false ]; then

step "Checking prerequisites"

# Node.js
if command -v node &>/dev/null; then
  NODE_MAJOR=$(node --version | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 18 ]; then
    ok "Node.js $(node --version)"
  else
    fail "Node.js $(node --version) is too old (need >= 18)"
    exit 1
  fi
else
  fail "Node.js not found. Install from https://nodejs.org"
  exit 1
fi

# npm
if command -v npm &>/dev/null; then
  ok "npm $(npm --version)"
else
  fail "npm not found"
  exit 1
fi

# Wine (only for Windows cross-compile)
if [ "$BUILD_WIN" = true ] || [ "$BUILD_ALL" = true ]; then
  if command -v wine64 &>/dev/null; then
    ok "Wine found (for Windows cross-compile)"
  else
    warn "Wine not found — Windows build may still work without it"
    info "Install if needed: brew install --cask wine-stable"
  fi
fi

# ═══════════════════════════════════════════════════════════
# STEP 2: Install Dependencies
# ═══════════════════════════════════════════════════════════

step "Installing dependencies"

if [ -d node_modules ] && [ -f node_modules/.package-lock.json ]; then
  if [ package.json -nt node_modules/.package-lock.json ]; then
    info "package.json changed — reinstalling…"
    npm install
  else
    ok "node_modules up to date"
  fi
else
  info "Running npm install…"
  npm install
fi

ok "Dependencies ready"

# ═══════════════════════════════════════════════════════════
# STEP 3: Build
# ═══════════════════════════════════════════════════════════

step "Building"

# electron-builder outputs to src/dist by default (configured in package.json)
[ -d dist ] && rm -rf dist

if [ "$BUILD_ALL" = true ]; then
  info "Building macOS + Windows…"
  npx electron-builder --mac --win
elif [ "$BUILD_WIN" = true ]; then
  info "Building Windows portable .exe…"
  npx electron-builder --win
elif [ "$DIST" = true ]; then
  info "Building macOS .dmg…"
  npx electron-builder --mac dmg
else
  info "Building macOS app…"
  npx electron-builder --mac dir
fi

# Move build output to project root dist/
if [ -d dist ] && [ "$SRC_DIR/dist" != "$DIST_DIR" ]; then
  rm -rf "$DIST_DIR"
  mv dist "$DIST_DIR"
fi

# Clean intermediate artifacts
rm -f "$DIST_DIR/builder-effective-config.yaml" 2>/dev/null
rm -f "$DIST_DIR/builder-debug.yml" 2>/dev/null

ok "Build complete → dist/"

# ═══════════════════════════════════════════════════════════
# STEP 4: Show what was built
# ═══════════════════════════════════════════════════════════

step "Build output"
echo ""

find "$DIST_DIR" -maxdepth 1 -name "*.dmg" 2>/dev/null | sort | while read f; do
  SIZE=$(du -h "$f" | awk '{print $1}')
  echo -e "  ${GREEN}●${NC} macOS installer   ${GREEN}$f${NC}  ($SIZE)"
done

find "$DIST_DIR" -maxdepth 1 -name "*.exe" 2>/dev/null | sort | while read f; do
  SIZE=$(du -h "$f" | awk '{print $1}')
  echo -e "  ${GREEN}●${NC} Windows portable  ${GREEN}$f${NC}  ($SIZE)"
done

find "$DIST_DIR" -maxdepth 2 -name "*.app" -type d 2>/dev/null | sort | while read f; do
  SIZE=$(du -sh "$f" | awk '{print $1}')
  echo -e "  ${GREEN}●${NC} macOS app         ${GREEN}$f${NC}  ($SIZE)"
done

echo ""

fi # end of !RUN_ONLY

# ═══════════════════════════════════════════════════════════
# STEP 5: Run
# ═══════════════════════════════════════════════════════════

if [ "$BUILD_ONLY" = true ]; then
  step "Done"
  ok "Build complete. Run with: ./build.sh --run-only"
  exit 0
fi

step "Launching ${APP_NAME}"

# Kill any running instance so macOS launches the freshly-built version
if pgrep -f "${APP_NAME}.app" > /dev/null 2>&1; then
  info "Stopping running ${APP_NAME}…"
  pkill -f "${APP_NAME}.app" 2>/dev/null || true
  sleep 0.5
  ok "Stopped previous instance"
fi

APP_PATH=""
for candidate in \
  "$DIST_DIR/mac-arm64/${APP_NAME}.app" \
  "$DIST_DIR/mac/${APP_NAME}.app" \
  "$DIST_DIR/mac-x64/${APP_NAME}.app"; do
  if [ -d "$candidate" ]; then
    APP_PATH="$candidate"
    break
  fi
done

if [ -z "$APP_PATH" ]; then
  APP_PATH=$(find "$DIST_DIR" -name "${APP_NAME}.app" -type d 2>/dev/null | head -1)
fi

if [ -n "$APP_PATH" ] && [ -d "$APP_PATH" ]; then
  ok "Found: $APP_PATH"
  open "$APP_PATH"
else
  warn "No built .app found — running with Electron directly…"
  npx electron .
fi

echo ""
ok "Done."
echo ""
echo -e "${YELLOW}${BOLD}Note:${NC} If you get ${RED}EHOSTUNREACH${NC} when syncing, go to:"
echo -e "  ${BOLD}System Settings → Privacy & Security → Local Network${NC}"
echo -e "  and toggle ${BOLD}${APP_NAME}${NC} off then on again."
echo -e "  This happens because macOS ties the Local Network permission to the"
echo -e "  app binary, which changes on every rebuild."
