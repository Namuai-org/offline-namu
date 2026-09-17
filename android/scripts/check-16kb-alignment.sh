#!/usr/bin/env bash
# DEV-005 / T28: every native library in a built APK or AAB must support 16 KB pages.
#
#   android/scripts/check-16kb-alignment.sh [--release] <app.apk | app.aab>
#
# Checks, for every lib/<abi>/*.so inside the package:
#   1. ELF: every PT_LOAD segment has p_align >= 0x4000 (16384).
#      Tool order: llvm-readelf / readelf (PATH, then the NDK under ANDROID_NDK_HOME,
#      ANDROID_HOME/ndk), then llvm-objdump / objdump -p, then a built-in python3 ELF
#      parser so the script also works on machines without binutils or an NDK.
#   2. APK only: uncompressed .so entries start on a 16 KB boundary inside the ZIP.
#      `zipalign -c -P 16 -v 4` is used when a build-tools zipalign that knows -P exists;
#      otherwise the built-in python3 ZIP check is used. Compressed .so entries
#      (legacy packaging) are reported as a violation because Namu sets
#      useLegacyPackaging=false.
#   3. With --release: only arm64-v8a libraries may be present (DEV-001).
#
# Exit status: 0 = all good, 1 = at least one violation, 2 = usage/tool error.
# A 16 KB emulator run is still required in addition to this static check (D14).
set -euo pipefail

RELEASE=0
PACKAGE=""
for arg in "$@"; do
  case "$arg" in
    --release) RELEASE=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) PACKAGE="$arg" ;;
  esac
done
if [[ -z "$PACKAGE" || ! -f "$PACKAGE" ]]; then
  echo "usage: $0 [--release] <app.apk | app.aab>" >&2
  exit 2
fi
command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 2; }
command -v unzip >/dev/null 2>&1 || { echo "unzip is required" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/namu-16kb.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
VIOLATIONS=0
fail() { echo "VIOLATION: $*"; VIOLATIONS=$((VIOLATIONS + 1)); }

# ---- tool discovery ---------------------------------------------------------------------------
find_tool() {
  local name
  for name in "$@"; do
    if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return 0; fi
  done
  local root
  for root in "${ANDROID_NDK_HOME:-}" "${ANDROID_NDK_ROOT:-}" "${ANDROID_HOME:-}/ndk" "${ANDROID_SDK_ROOT:-}/ndk"; do
    [[ -n "$root" && -d "$root" ]] || continue
    for name in "$@"; do
      local hit
      hit="$(find "$root" -type f -name "$name" -path '*toolchains/llvm/prebuilt/*' 2>/dev/null | sort | tail -n 1)"
      if [[ -n "$hit" ]]; then echo "$hit"; return 0; fi
    done
  done
  return 1
}
READELF="$(find_tool llvm-readelf readelf greadelf || true)"
OBJDUMP="$(find_tool llvm-objdump objdump gobjdump || true)"
# NAMU_FORCE_PYTHON_ELF=1 skips external ELF tools (debugging aid / cross-check).
if [[ "${NAMU_FORCE_PYTHON_ELF:-0}" == "1" ]]; then READELF=""; OBJDUMP=""; fi
ZIPALIGN="$(command -v zipalign 2>/dev/null || true)"
if [[ -z "$ZIPALIGN" ]]; then
  for root in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}"; do
    [[ -n "$root" && -d "$root/build-tools" ]] || continue
    ZIPALIGN="$(find "$root/build-tools" -type f -name zipalign 2>/dev/null | sort | tail -n 1)"
    [[ -n "$ZIPALIGN" ]] && break
  done
fi

# Prints one line per PT_LOAD segment: the alignment in decimal.
load_alignments() {
  local so="$1" out=""
  if [[ -n "$READELF" ]]; then
    # "  LOAD  0x000000 0x... 0x... 0x... 0x... R E 0x4000" — the alignment is the last field.
    out="$("$READELF" -lW "$so" 2>/dev/null | awk '$1 == "LOAD" { print $NF }' || true)"
  fi
  if [[ -z "$out" && -n "$OBJDUMP" ]]; then
    # "    LOAD off 0x... vaddr 0x... paddr 0x... align 2**14"
    out="$("$OBJDUMP" -p "$so" 2>/dev/null | awk '$1 == "LOAD" { for (i = 1; i <= NF; i++) if ($i == "align") print $(i + 1) }' || true)"
  fi
  if [[ -n "$out" ]]; then
    local value
    while read -r value; do
      [[ -z "$value" ]] && continue
      if [[ "$value" == 2\*\** ]]; then echo $((1 << ${value#2\*\*})); else echo $((value)); fi
    done <<<"$out"
    return 0
  fi
  python3 - "$so" <<'PY'
import struct, sys
data = open(sys.argv[1], 'rb').read()
if data[:4] != b'\x7fELF':
    sys.exit('not an ELF file')
is64 = data[4] == 2
end = '<' if data[5] == 1 else '>'
if is64:
    phoff, = struct.unpack_from(end + 'Q', data, 0x20)
    phentsize, phnum = struct.unpack_from(end + 'HH', data, 0x36)
else:
    phoff, = struct.unpack_from(end + 'I', data, 0x1C)
    phentsize, phnum = struct.unpack_from(end + 'HH', data, 0x2A)
for i in range(phnum):
    base = phoff + i * phentsize
    p_type, = struct.unpack_from(end + 'I', data, base)
    if p_type != 1:  # PT_LOAD
        continue
    align, = struct.unpack_from(end + ('Q' if is64 else 'I'), data, base + (0x30 if is64 else 0x1C))
    print(align)
PY
}

# ---- 1. ELF segment alignment -------------------------------------------------------------------
unzip -q -o "$PACKAGE" '*.so' -d "$WORK/x" 2>/dev/null || true
LIBS=()
while IFS= read -r line; do LIBS+=("$line"); done < <(find "$WORK/x" -type f -name '*.so' | sort)
if [[ ${#LIBS[@]} -eq 0 ]]; then
  echo "No native libraries found in $PACKAGE" >&2
  exit 2
fi

echo "Package : $PACKAGE"
echo "ELF tool: ${READELF:-${OBJDUMP:-python3 (built-in parser)}}"
ABIS=""
for so in "${LIBS[@]}"; do
  rel="${so#"$WORK/x/"}"
  abi="$(basename "$(dirname "$so")")"
  case " $ABIS " in *" $abi "*) ;; *) ABIS="$ABIS $abi" ;; esac
  aligns="$(load_alignments "$so" || true)"
  if [[ -z "$aligns" ]]; then
    fail "$rel: no PT_LOAD segment could be read"
    continue
  fi
  min=0
  while read -r a; do
    [[ -z "$a" ]] && continue
    if [[ $min -eq 0 || $a -lt $min ]]; then min=$a; fi
  done <<<"$aligns"
  if [[ $min -lt 16384 ]]; then
    fail "$rel: PT_LOAD alignment $(printf '0x%x' "$min") < 0x4000"
  else
    echo "ok      : $rel (min LOAD align $(printf '0x%x' "$min"))"
  fi
done
echo "ABIs    :$ABIS"
if [[ $RELEASE -eq 1 ]]; then
  for abi in $ABIS; do
    [[ "$abi" == "arm64-v8a" ]] || fail "release package contains ABI $abi (only arm64-v8a is allowed, DEV-001)"
  done
fi

# ---- 2. ZIP alignment of uncompressed libraries (APK only) ---------------------------------------
case "$PACKAGE" in
  *.apk)
    ZIP_CHECKED=0
    if [[ -n "$ZIPALIGN" ]] && "$ZIPALIGN" 2>&1 | grep -q -- '-P'; then
      echo "zipalign: $ZIPALIGN -c -P 16 -v 4"
      if ! "$ZIPALIGN" -c -P 16 -v 4 "$PACKAGE" >"$WORK/zipalign.log" 2>&1; then
        grep -E 'BAD|FAILED' "$WORK/zipalign.log" | head -n 20 || true
        fail "zipalign -c -P 16 reported misaligned entries"
      fi
      ZIP_CHECKED=1
    fi
    # The python check always runs: it also catches compressed .so entries.
    if ! python3 - "$PACKAGE" "$ZIP_CHECKED" <<'PY'
import struct, sys, zipfile
path, zip_checked = sys.argv[1], sys.argv[2] == '1'
bad = 0
with zipfile.ZipFile(path) as z, open(path, 'rb') as raw:
    for info in z.infolist():
        if not (info.filename.startswith('lib/') and info.filename.endswith('.so')):
            continue
        if info.compress_type != zipfile.ZIP_STORED:
            print('VIOLATION: %s is compressed inside the APK (expected useLegacyPackaging=false)' % info.filename)
            bad += 1
            continue
        raw.seek(info.header_offset)
        header = raw.read(30)
        name_len, extra_len = struct.unpack('<HH', header[26:30])
        data_offset = info.header_offset + 30 + name_len + extra_len
        if zip_checked:
            continue  # zipalign already judged the offsets
        if data_offset % 16384 != 0:
            print('VIOLATION: %s starts at ZIP offset %d (not a multiple of 16384)' % (info.filename, data_offset))
            bad += 1
        else:
            print('ok      : %s ZIP offset %d' % (info.filename, data_offset))
sys.exit(1 if bad else 0)
PY
    then
      fail "ZIP alignment check failed"
    fi
    ;;
  *)
    echo "zipalign: skipped (not an APK; bundletool aligns the APKs it generates from an AAB)"
    ;;
esac

if [[ $VIOLATIONS -gt 0 ]]; then
  echo "FAILED: $VIOLATIONS violation(s)"
  exit 1
fi
echo "PASSED: all native libraries support 16 KB pages"
