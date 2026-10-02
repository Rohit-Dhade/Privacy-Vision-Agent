#!/usr/bin/env bash
# ==============================================================================
# package_extension.sh
# Packages the Privacy Vision Agent extension into a production-ready ZIP archive
# for submission to the Google Chrome Web Store.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DIST_DIR="${EXTENSION_DIR}/dist"

echo "======================================================================"
echo "    PRIVACY VISION AGENT — CHROME WEB STORE PACKAGING SCRIPT         "
echo "======================================================================"

# 1. Validate manifest.json syntax and read version
MANIFEST_FILE="${EXTENSION_DIR}/manifest.json"
if [ ! -f "${MANIFEST_FILE}" ]; then
  echo "Error: manifest.json not found at ${MANIFEST_FILE}"
  exit 1
fi

VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${MANIFEST_FILE}', 'utf8')).version)")
NAME=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${MANIFEST_FILE}', 'utf8')).name)")

echo "[✓] Manifest valid: ${NAME} (v${VERSION})"

# 2. Syntax pre-flight check across all JavaScript files
echo "[*] Running pre-flight JavaScript syntax check..."
SYNTAX_ERRORS=0
for js_file in \
  "${EXTENSION_DIR}"/agent/*.js \
  "${EXTENSION_DIR}"/background/*.js \
  "${EXTENSION_DIR}"/content/*.js \
  "${EXTENSION_DIR}"/popup/*.js \
  "${EXTENSION_DIR}"/utils/*.js \
  "${EXTENSION_DIR}"/offscreen.js; do
  if [ -f "${js_file}" ]; then
    if ! node --check "${js_file}" >/dev/null 2>&1; then
      echo "  [FAIL] Syntax error in ${js_file}"
      SYNTAX_ERRORS=$((SYNTAX_ERRORS + 1))
    fi
  fi
done

if [ "${SYNTAX_ERRORS}" -gt 0 ]; then
  echo "Error: ${SYNTAX_ERRORS} syntax errors found. Aborting package build."
  exit 1
fi
echo "[✓] All JavaScript files passed syntax verification."

# 3. Create dist directory
mkdir -p "${DIST_DIR}"
ZIP_NAME="privacy-vision-agent-v${VERSION}.zip"
ZIP_PATH="${DIST_DIR}/${ZIP_NAME}"

# Clean previous build if exists
rm -f "${ZIP_PATH}"

# 4. Create ZIP archive excluding developer docs, tests, and git metadata
echo "[*] Archiving extension files to ${ZIP_NAME}..."

cd "${EXTENSION_DIR}"

zip -r "${ZIP_PATH}" \
  manifest.json \
  offscreen.html \
  offscreen.js \
  agent/ \
  background/ \
  content/ \
  icons/ \
  lib/ \
  models/ \
  popup/ \
  tools/ \
  utils/ \
  -x "*.git*" \
  -x "*.DS_Store" \
  -x "docs/*" \
  -x "scripts/*" \
  -x "dist/*" \
  -x "*.md" \
  -x "*~" \
  -x "*.swp" \
  -x "*.bak" >/dev/null

# 5. Output summary
ZIP_SIZE=$(du -h "${ZIP_PATH}" | awk '{print $1}')

echo "======================================================================"
echo "[SUCCESS] Chrome Web Store package created successfully!"
echo "  Archive: ${ZIP_PATH}"
echo "  Size:    ${ZIP_SIZE}"
echo "  Version: ${VERSION}"
echo "======================================================================"
echo "Next step: Upload this ZIP directly to the Chrome Web Store Developer Console:"
echo "https://chrome.google.com/webstore/devconsole"
echo "======================================================================"
