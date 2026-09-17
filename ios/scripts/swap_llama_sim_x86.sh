#!/bin/sh
# Debug + iOS-simulator + Intel-host only (DEV-001). Replaces the x86_64 slice
# of the embedded rnllama framework with the AVX2 build made by
# build_llama_sim_x86.sh from the same pinned llama.rn sources. Without that
# build present this phase does nothing. Device and Release builds are never
# touched: they keep the framework exactly as llama.rn ships it.
set -e
if [ "${CONFIGURATION}" != "Debug" ] || [ "${PLATFORM_NAME}" != "iphonesimulator" ]; then
  exit 0
fi
OVERRIDE="${SRCROOT}/.llama-sim/rnllama-x86_64"
EMBEDDED="${TARGET_BUILD_DIR}/${FRAMEWORKS_FOLDER_PATH}/rnllama.framework/rnllama"
if [ ! -f "${OVERRIDE}" ] || [ ! -f "${EMBEDDED}" ]; then
  exit 0
fi
case " $(lipo -archs "${EMBEDDED}") " in
  *" x86_64 "*) ;;
  *) exit 0 ;;
esac

TMP="${EMBEDDED}.namu-swap"
if [ "$(lipo -archs "${EMBEDDED}")" = "x86_64" ]; then
  cp "${OVERRIDE}" "${TMP}"
else
  lipo "${EMBEDDED}" -replace x86_64 "${OVERRIDE}" -output "${TMP}"
fi
mv -f "${TMP}" "${EMBEDDED}"
codesign --force --sign "${EXPANDED_CODE_SIGN_IDENTITY:--}" "${TARGET_BUILD_DIR}/${FRAMEWORKS_FOLDER_PATH}/rnllama.framework"
echo "note: simulator rnllama x86_64 slice replaced with the AVX2 development build"
