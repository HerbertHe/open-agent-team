#!/bin/bash
set -euo pipefail

# Usage: curl -fsSL https://oat.ibert.me/install.sh | bash

BOLD='\033[1m'
ACCENT='\033[38;2;64;156;255m'      # Blue accent
INFO='\033[38;2;136;146;176m'       # text-secondary #8892b0
SUCCESS='\033[38;2;0;229;204m'      # cyan-bright   #00e5cc
WARN='\033[38;2;255;176;32m'        # amber
ERROR='\033[38;2;230;57;70m'        # coral-mid     #e63946
MUTED='\033[38;2;90;100;128m'       # text-muted    #5a6480
NC='\033[0m' # No Color

NODE_MIN_MAJOR=22

ui_info() { echo -e "${MUTED}·${NC} $*"; }
ui_warn() { echo -e "${WARN}!${NC} $*"; }
ui_success() { echo -e "${SUCCESS}✓${NC} $*"; }
ui_error() { echo -e "${ERROR}✗${NC} $*"; }

echo -e "${ACCENT}${BOLD}"
echo "  🚀 Open Agent Team Installer"
echo -e "${NC}${INFO}  Declarative multi-agent orchestration.${NC}"
echo ""

# 1. Detect OS
OS="unknown"
if [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
elif [[ "$OSTYPE" == "linux-gnu"* ]] || [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
    OS="linux"
fi

if [[ "$OS" == "unknown" ]]; then
    ui_error "Unsupported operating system"
    echo "This installer supports macOS and Linux (including WSL)."
    echo "For Windows, use: iwr -useb https://oat.ibert.me/install.ps1 | iex"
    exit 1
fi
ui_success "Detected: $OS"

# 2. Check Node.js
if ! command -v node >/dev/null 2>&1; then
    ui_error "Node.js not found."
    echo "Please install Node.js v${NODE_MIN_MAJOR}+ before running this installer."
    echo "https://nodejs.org/"
    exit 1
fi

node_version=$(node -v 2>/dev/null || true)
node_major=$(echo "$node_version" | sed 's/^v//' | cut -d. -f1)

if [[ "$node_major" -lt "$NODE_MIN_MAJOR" ]]; then
    ui_error "Node.js ${node_version} found, but v${NODE_MIN_MAJOR}+ required."
    echo "Please upgrade Node.js and try again."
    exit 1
fi
ui_success "Node.js ${node_version} found"

# 3. Check npm
if ! command -v npm >/dev/null 2>&1; then
    ui_error "npm not found. Please ensure npm is installed."
    exit 1
fi

# 4. Install open-agent-team
ui_info "Installing open-agent-team package globally..."
if ! npm install -g open-agent-team@latest --silent; then
    ui_error "npm install failed. You might need to run this command with sudo if you lack permissions:"
    echo "  sudo npm install -g open-agent-team@latest"
    exit 1
fi
ui_success "Open Agent Team installed globally"

# 5. Check PATH and finish
if ! command -v oat >/dev/null 2>&1; then
    ui_warn "Installation complete, but 'oat' is not on your PATH."
    ui_info "Please ensure your npm global bin directory is in your PATH."
else
    oat_version=$(oat -v 2>/dev/null || oat --version 2>/dev/null || echo "latest")
    echo ""
    echo -e "${SUCCESS}${BOLD}Open Agent Team ($oat_version) is ready to use!${NC}"
    echo ""
    echo -e "${INFO}Quick start:${NC}"
    echo -e "  ${ACCENT}oat init${NC}    # Initialize team.json in current directory"
    echo -e "  ${ACCENT}oat start${NC}   # Start the orchestrator"
    echo ""
fi
