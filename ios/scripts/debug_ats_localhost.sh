#!/bin/sh
# Debug-only App Transport Security exception (SEC-003, contract §1).
# The checked-in Info.plist allows no insecure loads at all. Internal Debug
# builds need cleartext to localhost only: Metro (8081) and the model fault
# server (NamuModelOrigin, 8787). Release builds are never touched.
set -e
if [ "${CONFIGURATION}" != "Debug" ]; then
  exit 0
fi
PLIST="${TARGET_BUILD_DIR}/${INFOPLIST_PATH}"
PB=/usr/libexec/PlistBuddy
[ -f "${PLIST}" ] || { echo "error: processed Info.plist not found" >&2; exit 1; }

"${PB}" -c "Delete :NSAppTransportSecurity:NSExceptionDomains" "${PLIST}" 2>/dev/null || true
"${PB}" -c "Add :NSAppTransportSecurity:NSExceptionDomains dict" "${PLIST}"
"${PB}" -c "Add :NSAppTransportSecurity:NSExceptionDomains:localhost dict" "${PLIST}"
"${PB}" -c "Add :NSAppTransportSecurity:NSExceptionDomains:localhost:NSExceptionAllowsInsecureHTTPLoads bool true" "${PLIST}"

# Opt-in for running a Debug build on a physical device against Metro on the
# LAN: xcodebuild NAMU_DEBUG_ALLOW_LOCAL_NETWORKING=YES
"${PB}" -c "Delete :NSAppTransportSecurity:NSAllowsLocalNetworking" "${PLIST}" 2>/dev/null || true
if [ "${NAMU_DEBUG_ALLOW_LOCAL_NETWORKING}" = "YES" ]; then
  "${PB}" -c "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true" "${PLIST}"
fi
