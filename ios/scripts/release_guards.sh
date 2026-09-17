#!/bin/sh
# Release-only build guards (contract §1 and §4).
#  * NamuModelOrigin must be an https:// origin without a trailing slash.
#  * A development verification key (key_id "dev-…") must never ship.
set -e
if [ "${CONFIGURATION}" != "Release" ]; then
  exit 0
fi

case "${NAMU_MODEL_ORIGIN}" in
  https://*/*)
    echo "error: NAMU_MODEL_ORIGIN must be a bare origin (https://host) without a path or trailing slash." >&2
    exit 1
    ;;
  https://?*)
    ;;
  *)
    echo "error: Release builds require NAMU_MODEL_ORIGIN=https://<distribution-domain> (got '${NAMU_MODEL_ORIGIN}')." >&2
    exit 1
    ;;
esac

KEYS="${SRCROOT}/Namu/NamuConfig/release-keys.json"
if [ ! -f "${KEYS}" ]; then
  echo "error: ${KEYS} is missing; the release runbook must provide production trust files." >&2
  exit 1
fi
if /usr/bin/grep -Eq '"key_id"[[:space:]]*:[[:space:]]*"dev-' "${KEYS}"; then
  echo "error: release-keys.json contains a development key (key_id starts with dev-). Refusing to build Release." >&2
  exit 1
fi
