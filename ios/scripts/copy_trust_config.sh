#!/bin/sh
# Copies the three bundled trust files (SIG-001) into the app bundle.
# They are git-ignored and produced by
#   node model-release/dev/make-dev-bundle.mjs --model <gguf>     (internal)
# or by the release runbook (production).
# Debug tolerates absence: the app then reports the bundled descriptor as
# invalid. Release fails the build.
set -e
SRC="${SRCROOT}/Namu/NamuConfig"
DST="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}"
mkdir -p "${DST}"

for NAME in initial-descriptor.json release-keys.json known-bad.json; do
  if [ -f "${SRC}/${NAME}" ]; then
    cp -f "${SRC}/${NAME}" "${DST}/${NAME}"
  else
    # Never leave a stale copy from an earlier build in the bundle.
    rm -f "${DST}/${NAME}"
    if [ "${CONFIGURATION}" = "Release" ]; then
      echo "error: ${SRC}/${NAME} is missing; Release builds require all bundled trust files." >&2
      exit 1
    fi
    echo "warning: ${NAME} not found in ios/Namu/NamuConfig; run model-release/dev/make-dev-bundle.mjs (setup will report the bundled descriptor as invalid)."
  fi
done
