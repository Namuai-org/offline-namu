#!/bin/bash
# Development tool for INTEL Macs only.
#
# llama.rn 0.12.9 ships its iOS-simulator framework compiled with
# LM_GGML_CPU_GENERIC: portable C kernels with no SIMD. On an Apple-silicon Mac
# that is slow but usable; on an Intel Mac the 3.35B model needs minutes per
# answer. This script rebuilds the SAME pinned sources (node_modules/llama.rn,
# llama.cpp b10256) for the x86_64 simulator with the x86 kernels and AVX2, and
# leaves the result in ios/.llama-sim/ (git-ignored). The Debug-only build phase
# "Namu: simulator llama (Intel)" (swap_llama_sim_x86.sh) puts it into
# simulator app bundles. Device and Release builds never see it.
#
#   ios/scripts/build_llama_sim_x86.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
source_dir="$root/node_modules/llama.rn"
out="$root/ios/.llama-sim"
build="$out/build"

if [ "$(uname -m)" != "x86_64" ]; then
  echo "This Mac is not Intel; the stock arm64 simulator slice already uses NEON. Nothing to do."
  exit 0
fi
version="$(node -p "require('$source_dir/package.json').version")"
if [ "$version" != "0.12.9" ]; then
  echo "error: expected llama.rn 0.12.9 (STK-002), found $version" >&2
  exit 1
fi

simd_flags="-O3 -DNDEBUG -funroll-loops -mavx -mavx2 -mfma -mf16c -mbmi2"
arch_sources="$source_dir/cpp/ggml-cpu/arch/x86/quants.c;$source_dir/cpp/ggml-cpu/arch/x86/repack.cpp;$source_dir/cpp/ggml-cpu/arch/x86/cpu-feats.cpp"

mkdir -p "$build"
cmake -S "$source_dir/ios" -B "$build" -G "Unix Makefiles" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_SYSTEM_NAME=iOS \
  -DCMAKE_OSX_SYSROOT=iphonesimulator \
  -DCMAKE_OSX_ARCHITECTURES=x86_64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
  -DCMAKE_C_FLAGS="$simd_flags" \
  -DCMAKE_CXX_FLAGS="$simd_flags" \
  -DSOURCE_FILES_ARCH="$arch_sources"
cmake --build "$build" --target rnllama -j "${NAMU_BUILD_JOBS:-6}"

binary="$(find "$build" -path '*rnllama.framework*' -name rnllama -type f | head -1)"
if [ -z "$binary" ]; then
  echo "error: build produced no rnllama binary" >&2
  exit 1
fi
cp "$binary" "$out/rnllama-x86_64"
echo "$version $(shasum -a 256 "$out/rnllama-x86_64" | cut -d' ' -f1)" > "$out/rnllama-x86_64.stamp"
echo "built $out/rnllama-x86_64"
lipo -info "$out/rnllama-x86_64"
