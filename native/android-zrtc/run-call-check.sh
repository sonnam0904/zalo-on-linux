#!/usr/bin/env bash
set -euo pipefail
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ $# != 4 && $# != 5 ]]; then
  echo "Usage: bash run-call-check.sh NDK_DIR BIONIC_DIR APK_LIB_DIR OUTPUT_DIR [--compat-jni|--compat-audio|--compat-callbacks|--compat-voice]" >&2
  exit 2
fi
# The existing runner verifies the pinned binary hash and runtime dependencies.
mode=()
if [[ $# == 5 ]]; then
  case "$5" in
    --compat-jni|--compat-audio|--compat-callbacks|--compat-voice) mode=("$5");;
    *) echo "Unsupported diagnostic mode: $5" >&2; exit 2;;
  esac
fi
bash "$source_dir/run-probe.sh" "${@:1:4}"
ndk_dir=$(realpath "$1")
bionic_dir=$(realpath "$2")
apk_lib_dir=$(realpath "$3")
output_dir=$(realpath "$4")
compiler="$ndk_dir/toolchains/llvm/prebuilt/linux-x86_64/bin/x86_64-linux-android21-clang"
"$compiler" -g -Wall -Wextra -Werror "$source_dir/call-boundary.c" "$source_dir/compat-jni.c" "$source_dir/pcm-bridge.c" "$source_dir/call-events.c" "$source_dir/callback-probe.c" "$source_dir/voice-platform.c" \
  -o "$output_dir/call-boundary" -ldl
status=0
timeout 15 env -u LD_PRELOAD -u LD_AUDIT \
  LD_LIBRARY_PATH="$output_dir/platform:$apk_lib_dir:$bionic_dir" \
  "$bionic_dir/linker64" "$output_dir/call-boundary" "$apk_lib_dir/libzrtc.so" "${mode[@]}" \
  > "$output_dir/call-boundary.log" 2>&1 || status=$?
cat "$output_dir/call-boundary.log"
exit "$status"
