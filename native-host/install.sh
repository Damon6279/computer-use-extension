#!/bin/bash
# Install native messaging host for Computer Use Extension.
# Run after loading the extension in Chrome to get the extension ID.

set -e

EXTENSION_ID="${1}"
if [ -z "$EXTENSION_ID" ]; then
    echo "Usage: install.sh <EXTENSION_ID>"
    echo "  Get the ID from chrome://extensions after loading unpacked"
    exit 1
fi

NATIVE_HOST_NAME="com.computer-use.native"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_PATH="${PROJECT_DIR}/native-bridge.py"

# Ensure mac-use is available
if ! command -v mac-use &>/dev/null && ! [ -f ~/.local/bin/mac-use ]; then
    echo "ERROR: mac-use not found. Install it first:"
    echo "  ln -s ~/projects/mac-computer-use-mcp/mac-use.py ~/.local/bin/mac-use"
    exit 1
fi

# Ensure cliclick is available
if ! command -v cliclick &>/dev/null; then
    echo "ERROR: cliclick not found. Install: brew install cliclick"
    exit 1
fi

MANIFEST=$(cat <<MANIFEST
{
  "name": "${NATIVE_HOST_NAME}",
  "description": "Computer Use Chrome Extension Native Companion",
  "path": "${BRIDGE_PATH}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXTENSION_ID}/"
  ]
}
MANIFEST
)

# Install for main Chrome profile
MAIN_DIR="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "${MAIN_DIR}"
echo "${MANIFEST}" > "${MAIN_DIR}/${NATIVE_HOST_NAME}.json"
echo "✓ Installed to: ${MAIN_DIR}/${NATIVE_HOST_NAME}.json"

# Install for proxy-chrome profile (if exists)
PROXY_DIR="${HOME}/.proxy-chrome/NativeMessagingHosts"
if [ -d "${HOME}/.proxy-chrome" ]; then
    mkdir -p "${PROXY_DIR}"
    echo "${MANIFEST}" > "${PROXY_DIR}/${NATIVE_HOST_NAME}.json"
    echo "✓ Installed to: ${PROXY_DIR}/${NATIVE_HOST_NAME}.json"
fi

# Verify
# Compile Apple Vision OCR binary
echo ""
echo "Compiling Apple Vision OCR binary..."
xcrun -sdk macosx swiftc -o "${PROJECT_DIR}/ocr" -framework Cocoa -framework Vision "${PROJECT_DIR}/ocr.swift" 2>/dev/null
if [ -f "${PROJECT_DIR}/ocr" ]; then
    echo "✓ OCR binary compiled: ${PROJECT_DIR}/ocr"
else
    echo "⚠ OCR binary compilation failed. Install Xcode Command Line Tools: xcode-select --install"
fi

echo ""
echo "Testing native bridge..."
echo '{"id":"test1","type":"ping"}' | python3 "${BRIDGE_PATH}" 2>/dev/null || true
echo ""
echo "Install complete! Restart Chrome for changes to take effect."
