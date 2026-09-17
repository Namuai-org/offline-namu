#!/usr/bin/env bash
# Release tool: fetch upstream font sources at pinned commits (D22, DS-003).
# Usage: tools/fonts/fetch.sh   (then run build_fonts.py inside the tools venv)
set -euo pipefail

GOOGLE_FONTS_COMMIT="a54f7446f84a1125ef6bf08baa46f3639e8905e0"
MATERIAL_ICONS_COMMIT="40a7a292a79d9394157e1ea24f83d52d5e17c556"

DEST="$(cd "$(dirname "$0")" && pwd)/upstream"
mkdir -p "$DEST"

fetch() { curl --fail --silent --show-error --location --max-time 600 -o "$2" "$1"; }

GF="https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/ofl/dmsans"
MI="https://raw.githubusercontent.com/google/material-design-icons/${MATERIAL_ICONS_COMMIT}"

fetch "${GF}/DMSans%5Bopsz%2Cwght%5D.ttf" "${DEST}/DMSans.ttf"
fetch "${GF}/OFL.txt" "${DEST}/DMSans-OFL.txt"
fetch "${MI}/variablefont/MaterialSymbolsRounded%5BFILL%2CGRAD%2Copsz%2Cwght%5D.ttf" "${DEST}/MSR.ttf"
fetch "${MI}/variablefont/MaterialSymbolsRounded%5BFILL%2CGRAD%2Copsz%2Cwght%5D.codepoints" "${DEST}/MSR.codepoints"
fetch "${MI}/LICENSE" "${DEST}/MSR-LICENSE.txt"

shasum -a 256 "${DEST}"/*
